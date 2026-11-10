// herdr-pwa: a small server that shows herdr-core agents to a phone.
// It talks to herdr-core only through the `hc` CLI and listens on 127.0.0.1;
// put it on your tailnet with `tailscale serve`. Never expose it publicly:
// whoever has the token can type into your terminals.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 7690;
const HOST = process.env.HOST || "127.0.0.1";
const CONF = process.env.HERDR_PWA_HOME || path.join(os.homedir(), ".config", "herdr-pwa");
fs.mkdirSync(CONF, { recursive: true, mode: 0o700 });

// ---------- hc ----------

function findHc() {
  if (process.env.HC) return process.env.HC;
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "hc"),
    "/opt/homebrew/bin/hc",
    "/usr/local/bin/hc",
  ];
  return candidates.find((p) => fs.existsSync(p)) || "hc";
}
const HC = findHc();

function hc(args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(HC, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || err.message).toString().trim();
          return reject(Object.assign(new Error(msg || "hc failed"), { status: 502 }));
        }
        resolve(stdout.toString());
      });
  });
}

// ---------- secrets ----------

function readOrCreate(file, make, mode = 0o600) {
  const p = path.join(CONF, file);
  try { return fs.readFileSync(p, "utf8"); } catch {}
  const v = make();
  fs.writeFileSync(p, v, { mode });
  return v;
}

const TOKEN = readOrCreate("token", () => crypto.randomBytes(24).toString("base64url")).trim();

if (process.argv.includes("--print-url")) {
  console.log(`Token: ${TOKEN}`);
  console.log(`Open:  https://<your-mac>.<tailnet>.ts.net/#token=${TOKEN}`);
  process.exit(0);
}

function authorized(req, url) {
  const h = req.headers.authorization || "";
  const given = h.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- push ----------

let webpush = null;
let vapid = null;
try {
  webpush = (await import("web-push")).default;
  vapid = JSON.parse(readOrCreate("vapid.json", () => JSON.stringify(webpush.generateVAPIDKeys())));
  webpush.setVapidDetails("mailto:herdr-pwa@example.com", vapid.publicKey, vapid.privateKey);
} catch (e) {
  console.warn("push disabled:", e.message);
  webpush = null;
}

const SUBS_FILE = path.join(CONF, "subscriptions.json");
let subs = [];
try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8")); } catch {}
function saveSubs() {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), { mode: 0o600 });
}

async function push(payload) {
  if (!webpush || subs.length === 0) return;
  const body = JSON.stringify(payload);
  const dead = new Set();
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s, body, { TTL: 3600, urgency: "high", topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint);
      else console.warn("push failed:", e.statusCode || "", e.body || e.message);
    }
  }));
  if (dead.size) { subs = subs.filter((s) => !dead.has(s.endpoint)); saveSubs(); }
}

// ---------- live state from `hc events` ----------

const terminals = new Map(); // address -> raw terminal object
const clients = new Set();   // SSE responses
let broadcastTimer = null;

function view(t) {
  const st = t.status && typeof t.status === "object" ? t.status : null;
  return {
    address: t.address,
    title: t.title || null,
    where: t.labels?.where || null,
    space: t.labels?.["herdr.space"] || null,
    cwd: t.cwd || null,
    state: t.state,                     // live | finished
    status: st?.state || null,          // idle | working | done | blocked | error
    app: st?.app || null,
    msg: st?.msg || null,
    kind: st?.kind || null,             // permission | question | auth
    progress: st?.progress ?? null,
    program: t.foreground?.argv?.[0] ? path.basename(t.foreground.argv[0]) : null,
    parent: t.parent || null,
    since: t.status_ms || t.created_ms || null,
  };
}

function snapshot() {
  return [...terminals.values()]
    .filter((t) => t.state === "live" && !t.rm)
    .map(view);
}

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const data = `event: terminals\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }, 150);
}

function label(v) {
  return v.title || v.where || v.address;
}

function onChange(prev, next) {
  const before = prev?.status?.state;
  const after = next?.status?.state;
  if (!after || after === before || next.state !== "live") return;
  if (!["blocked", "done", "error"].includes(after)) return;
  const v = view(next);
  const verb = after === "blocked" ? "needs you" : after === "done" ? "finished" : "hit an error";
  push({
    title: `${label(v)} ${verb}`,
    body: [v.where && v.where !== v.title ? v.where : null, v.msg].filter(Boolean).join(" — ") || v.address,
    tag: v.address,
    url: `/#t=${encodeURIComponent(v.address)}`,
  });
}

function startEvents() {
  const child = spawn(HC, ["events", "--json"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const snap = msg.terminals || msg.params?.terminals || msg.result?.terminals;
    if (Array.isArray(snap)) {
      // a snapshot (the first line, or after "missed"): replace without notifying
      terminals.clear();
      for (const t of snap) terminals.set(t.address, t);
      scheduleBroadcast();
      return;
    }
    // Changes: {"method":"event","params":{"terminal":"t1c","type":"status","data":{...}}}
    if (msg.method !== "event" || !msg.params?.terminal) return; // heartbeat, missed, ...
    const { terminal: addr, type, data = {} } = msg.params;
    if (type === "removed") {
      terminals.delete(addr);
      scheduleBroadcast();
      return;
    }
    const prev = terminals.get(addr);
    if (!prev) {
      // A terminal we haven't seen: take what the event carries, then fetch the whole record.
      terminals.set(addr, { address: addr, state: "live", ...data });
      hc(["get", addr, "--json"]).then((out) => {
        const full = JSON.parse(out);
        terminals.set(addr, { ...full, ...(terminals.get(addr)?.status ? { status: terminals.get(addr).status } : {}) });
        scheduleBroadcast();
      }).catch(() => {});
    } else {
      const next = { ...prev, ...data, status_ms: type === "status" ? Date.now() : prev.status_ms };
      if (data.labels) next.labels = { ...prev.labels, ...data.labels };
      terminals.set(addr, next);
      onChange(prev, next);
    }
    scheduleBroadcast();
  });
  child.stderr.on("data", (d) => console.warn("hc events:", d.toString().trim()));
  child.on("exit", (code) => {
    console.warn(`hc events exited (${code}); restarting in 2s`);
    setTimeout(startEvents, 2000);
  });
}

// ---------- http ----------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); }
      catch { reject(Object.assign(new Error("bad json"), { status: 400 })); }
    });
  });
}

// Only terminals herdr-core told us about, so nothing user-supplied reaches hc unchecked.
function knownTerminal(t) {
  if (typeof t !== "string" || !terminals.has(t)) {
    throw Object.assign(new Error("unknown terminal"), { status: 404 });
  }
  return t;
}

const KEY_RE = /^[a-z0-9]+(\+[a-z0-9]+)*$/i;

async function api(req, res, url) {
  const p = url.pathname;

  if (p === "/api/terminals" && req.method === "GET") return send(res, 200, snapshot());

  if (p === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...SECURITY_HEADERS,
    });
    res.write(`retry: 3000\nevent: terminals\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (p === "/api/read" && req.method === "GET") {
    const t = knownTerminal(url.searchParams.get("t"));
    const lines = Math.min(Math.max(Number(url.searchParams.get("lines")) || 300, 0), 3000);
    const text = await hc(["read", t, "--lines", String(lines)]);
    return send(res, 200, { text });
  }

  if (req.method !== "POST") return send(res, 404, { error: "not found" });
  const body = await readJson(req);

  if (p === "/api/send") {
    const t = knownTerminal(body.t);
    const text = String(body.text ?? "");
    if (!text.trim()) return send(res, 400, { error: "empty message" });
    const args = ["send", t, text];
    if (body.force) args.push("--force");
    await hc(args, { timeout: 60000 });
    return send(res, 200, { ok: true });
  }

  if (p === "/api/keys") {
    const t = knownTerminal(body.t);
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
    if (!keys.length || keys.length > 20 || !keys.every((k) => KEY_RE.test(k))) {
      return send(res, 400, { error: "bad keys" });
    }
    await hc(["keys", t, ...keys]);
    return send(res, 200, { ok: true });
  }

  if (p === "/api/interrupt") {
    const t = knownTerminal(body.t);
    const out = await hc(["interrupt", t], { timeout: 20000 });
    return send(res, 200, { ok: true, out: out.trim() });
  }

  if (p === "/api/push/key") {
    return send(res, 200, { key: webpush ? vapid.publicKey : null });
  }

  if (p === "/api/push/subscribe") {
    const s = body.subscription;
    if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) {
      return send(res, 400, { error: "bad subscription" });
    }
    subs = subs.filter((x) => x.endpoint !== s.endpoint);
    subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
    saveSubs();
    return send(res, 200, { ok: true });
  }

  if (p === "/api/push/unsubscribe") {
    subs = subs.filter((x) => x.endpoint !== body.endpoint);
    saveSubs();
    return send(res, 200, { ok: true });
  }

  if (p === "/api/push/test") {
    await push({ title: "herdr-pwa", body: "Notifications work.", tag: "test", url: "/" });
    return send(res, 200, { ok: true, devices: subs.length });
  }

  return send(res, 404, { error: "not found" });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "forbidden", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": rel === "/sw.js" ? "no-cache" : "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(req, url)) return send(res, 401, { error: "unauthorized" });
      return await api(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", "text/plain");
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
});

startEvents();
server.listen(PORT, HOST, () => {
  console.log(`herdr-pwa on http://${HOST}:${PORT}  (hc: ${HC}, push: ${webpush ? "on" : "off"})`);
  console.log(`token: run \`npm run token\` to print it`);
});
