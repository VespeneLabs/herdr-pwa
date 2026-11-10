"use strict";

const $ = (id) => document.getElementById(id);
const ORDER = [
  ["blocked", "Needs you"],
  ["done", "Done"],
  ["working", "Working"],
  ["idle", "Idle"],
  [null, "Terminals"],
];

const state = {
  token: load("herdr-pwa.token"),
  terminals: [],
  open: null,          // address shown in detail
  stream: null,
  readTimer: null,
  reading: false,
  wrap: load("herdr-pwa.wrap") !== "0",
};

function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

// ---------- api ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${state.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout("That token was not accepted."); throw new Error("unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------- stream ----------

function connect() {
  if (state.stream) state.stream.close();
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  state.stream = es;
  es.addEventListener("terminals", (e) => {
    $("conn").className = "conn live";
    const prev = state.terminals.find((t) => t.address === state.open);
    state.terminals = JSON.parse(e.data);
    renderList();
    if (state.open) {
      const now = state.terminals.find((t) => t.address === state.open);
      renderDetailHeader();
      if (!prev || !now || prev.status !== now.status || prev.msg !== now.msg) readScreen();
    }
  });
  es.onerror = async () => {
    $("conn").className = "conn down";
    // EventSource can't see status codes; check the token once.
    try { await api("/api/terminals"); } catch {}
  };
}

// ---------- list ----------

function rel(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function groupOf(t) {
  if (t.status === "error") return "blocked";
  return ORDER.some(([k]) => k === t.status) ? t.status : null;
}

function name(t) { return t.title || t.where || t.address; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function row(t, child) {
  const b = el("button", `row${child ? " child" : ""}`);
  b.type = "button";
  b.addEventListener("click", () => { location.hash = `t=${encodeURIComponent(t.address)}`; });
  b.append(el("span", `dot ${t.status || "none"}`));
  const body = el("div", "body");
  const top = el("div", "top");
  top.append(el("span", "name", name(t)), el("span", "time", rel(t.since)));
  body.append(top);
  const where = [t.where && t.where !== name(t) ? t.where : null, t.app || t.program, t.address].filter(Boolean).join(" · ");
  body.append(el("div", "where", where));
  if (t.msg) body.append(el("div", "msg", t.msg));
  b.append(body);
  return b;
}

function renderList() {
  const root = $("groups");
  root.replaceChildren();
  const byParent = new Map();
  const top = [];
  const addrs = new Set(state.terminals.map((t) => t.address));
  for (const t of state.terminals) {
    if (t.parent && addrs.has(t.parent)) {
      if (!byParent.has(t.parent)) byParent.set(t.parent, []);
      byParent.get(t.parent).push(t);
    } else top.push(t);
  }
  let any = false;
  for (const [key, title] of ORDER) {
    const items = top.filter((t) => groupOf(t) === key).sort((a, b) => (b.since || 0) - (a.since || 0));
    if (!items.length) continue;
    any = true;
    const g = el("section", "group");
    g.append(el("h3", null, `${title} · ${items.length}`));
    const cards = el("div", "cards");
    for (const t of items) {
      cards.append(row(t));
      for (const c of byParent.get(t.address) || []) cards.append(row(c, true));
    }
    g.append(cards);
    root.append(g);
  }
  if (!any) root.append(el("p", "empty", "No live terminals."));
  const needs = top.filter((t) => groupOf(t) === "blocked").length;
  document.title = needs ? `(${needs}) Herdr Agents` : "Herdr Agents";
  if ("setAppBadge" in navigator) (needs ? navigator.setAppBadge(needs) : navigator.clearAppBadge()).catch?.(() => {});
}

// ---------- detail ----------

function current() { return state.terminals.find((t) => t.address === state.open); }

function renderDetailHeader() {
  const t = current();
  if (!t) {
    $("d-title").textContent = state.open;
    $("d-sub").textContent = "Not running anymore";
    $("d-status").replaceChildren(el("span", "dot none"), el("span", "txt", "Finished or removed"));
    return;
  }
  $("d-title").textContent = name(t);
  $("d-sub").textContent = [t.where !== name(t) ? t.where : null, t.app || t.program, t.address].filter(Boolean).join(" · ");
  const label = { blocked: "Needs you", error: "Error", done: "Done", working: "Working", idle: "Idle" }[t.status] || "Terminal";
  const txt = [label, t.kind, t.progress != null ? `${t.progress}%` : null, t.msg].filter(Boolean).join(" — ");
  $("d-status").replaceChildren(el("span", `dot ${t.status || "none"}`), el("span", "txt", txt));
  $("msg").placeholder = t.status === "blocked" ? "Answer (or use the keys)" : "Message";
}

async function readScreen() {
  if (!state.open || state.reading) return;
  state.reading = true;
  const pre = $("screen");
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  try {
    const { text } = await api(`/api/read?t=${encodeURIComponent(state.open)}&lines=400`);
    const clean = text.replace(/\s+$/, "");
    if (pre.textContent !== clean) {
      pre.textContent = clean;
      if (atBottom || !pre.dataset.loaded) pre.scrollTop = pre.scrollHeight;
      pre.dataset.loaded = "1";
    }
  } catch (e) {
    if (e.message !== "unauthorized") pre.textContent = `Could not read: ${e.message}`;
  } finally {
    state.reading = false;
  }
}

function openDetail(addr) {
  state.open = addr;
  $("list").hidden = true;
  $("detail").hidden = false;
  $("screen").textContent = "Loading…";
  delete $("screen").dataset.loaded;
  renderDetailHeader();
  readScreen();
  clearInterval(state.readTimer);
  // The screen of a working agent changes without status events; refresh while visible.
  state.readTimer = setInterval(() => {
    if (document.visibilityState === "visible" && current()?.status !== "idle") readScreen();
  }, 2500);
}

function closeDetail() {
  state.open = null;
  clearInterval(state.readTimer);
  $("detail").hidden = true;
  $("list").hidden = false;
  renderList();
}

function route() {
  if (!state.token) return showLogin();
  const m = location.hash.match(/^#t=(.+)$/);
  if (m) openDetail(decodeURIComponent(m[1]));
  else closeDetail();
}

// ---------- actions ----------

async function sendMessage(e) {
  e.preventDefault();
  const box = $("msg");
  const text = box.value.trim();
  if (!text || !state.open) return;
  const t = current();
  $("send-btn").disabled = true;
  try {
    await api("/api/send", { t: state.open, text, force: t?.status === "blocked" });
    box.value = "";
    autosize();
    setTimeout(readScreen, 400);
  } catch (err) {
    toast(err.message);
  } finally {
    $("send-btn").disabled = false;
  }
}

async function pressKey(key) {
  if (!state.open) return;
  try {
    await api("/api/keys", { t: state.open, keys: [key] });
    setTimeout(readScreen, 250);
  } catch (err) { toast(err.message); }
}

async function interrupt() {
  if (!state.open) return;
  try {
    const r = await api("/api/interrupt", { t: state.open });
    if (r.out) toast(r.out.split("\n")[0]);
    setTimeout(readScreen, 400);
  } catch (err) { toast(err.message); }
}

function autosize() {
  const box = $("msg");
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
}

// ---------- notifications ----------

function b64ToBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function refreshNotifyUi() {
  const note = $("menu-note");
  const btn = $("notify-btn");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.hidden = true;
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    note.textContent = ios && !navigator.standalone
      ? "For notifications: Share → Add to Home Screen, then open Herdr from the home screen."
      : "This browser can't receive push notifications.";
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  btn.textContent = sub ? "Turn off notifications" : "Turn on notifications";
  $("test-btn").hidden = !sub;
  note.textContent = sub ? "You'll be notified when an agent needs you or finishes." : "";
}

async function toggleNotifications() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await api("/api/push/unsubscribe", { endpoint: existing.endpoint });
      await existing.unsubscribe();
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Notifications were not allowed."); return; }
      const { key } = await api("/api/push/key");
      if (!key) { toast("Push is off on the server."); return; }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      await api("/api/push/subscribe", { subscription: sub.toJSON() });
      toast("Notifications on.");
    }
  } catch (err) { toast(err.message); }
  refreshNotifyUi();
}

// ---------- login ----------

function showLogin(err) {
  if (state.stream) { state.stream.close(); state.stream = null; }
  $("list").hidden = true;
  $("detail").hidden = true;
  $("login").hidden = false;
  $("login-error").hidden = !err;
  $("login-error").textContent = err || "";
}

function logout(err) {
  state.token = null;
  save("herdr-pwa.token", null);
  showLogin(err);
}

async function login(token) {
  state.token = token;
  try {
    await fetch("/api/terminals", { headers: { Authorization: `Bearer ${token}` } }).then((r) => {
      if (r.status === 401) throw new Error("That token was not accepted.");
      if (!r.ok) throw new Error(`Server error ${r.status}`);
    });
  } catch (e) {
    state.token = null;
    return showLogin(e.message);
  }
  save("herdr-pwa.token", token);
  $("login").hidden = true;
  connect();
  route();
  refreshNotifyUi();
}

// ---------- boot ----------

function boot() {
  document.body.addEventListener("touchstart", () => {}, { passive: true }); // :active on iOS

  const fromHash = location.hash.match(/^#token=([\w-]+)$/);
  if (fromHash) {
    history.replaceState(null, "", location.pathname);
    state.token = fromHash[1];
  }

  $("login-form").addEventListener("submit", (e) => { e.preventDefault(); login($("token-input").value.trim()); });
  $("menu-btn").addEventListener("click", () => { $("menu").hidden = !$("menu").hidden; refreshNotifyUi(); });
  $("logout-btn").addEventListener("click", () => logout());
  $("notify-btn").addEventListener("click", toggleNotifications);
  $("test-btn").addEventListener("click", async () => {
    try { const r = await api("/api/push/test", {}); toast(`Sent to ${r.devices} device(s).`); } catch (e) { toast(e.message); }
  });
  $("back-btn").addEventListener("click", () => {
    if (history.length > 1 && location.hash) history.back(); else location.hash = "";
  });
  $("wrap-btn").addEventListener("click", () => {
    state.wrap = !state.wrap;
    save("herdr-pwa.wrap", state.wrap ? "1" : "0");
    $("screen").classList.toggle("wrap", state.wrap);
  });
  $("screen").classList.toggle("wrap", state.wrap);
  $("send-form").addEventListener("submit", sendMessage);
  $("msg").addEventListener("input", autosize);
  $("msg").addEventListener("keydown", (e) => {
    // Hardware keyboard: Enter sends, Shift+Enter is a new line.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover: hover)").matches) {
      e.preventDefault();
      $("send-form").requestSubmit();
    }
  });
  $("keys").addEventListener("click", (e) => {
    const k = e.target.closest("button[data-key]")?.dataset.key;
    if (k) pressKey(k);
  });
  $("interrupt-btn").addEventListener("click", interrupt);
  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.token) {
      if (!state.stream || state.stream.readyState === EventSource.CLOSED) connect();
      if (state.open) readScreen();
    }
  });
  setInterval(() => { if (!$("list").hidden) renderList(); }, 30000); // relative times

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (state.token) login(state.token); else showLogin();
}

boot();
