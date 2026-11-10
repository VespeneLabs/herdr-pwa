# herdr-pwa

**Watch and answer your [Herdr](https://herdr.dev) coding agents from your phone.**

A small Node server on your Mac follows herdr-core live and serves a
home-screen web app. Check which agents need you, read what they did, reply,
answer a permission prompt or stop one, from the couch, without opening a
laptop. No account, no cloud, no relay: your phone talks to your own machine.

> Unofficial. Not affiliated with Herdr. Built for the Herdr desktop app
> (`herdr-app`) and herdr-core (`hc`).

## Features

- **Live agent list**, grouped into **Needs you**, **Done**, **Working** and
  **Idle**, with each agent's space and tab, what it's doing right now, and how
  long ago its status changed. Updates arrive within a fraction of a second.
  Sub-agents show under the agent that started them; plain shells go under
  **Terminals**.
- **Read any agent's screen**, refreshing while it works, with optional line
  wrapping.
- **Reply** to an agent, as if you'd typed it in its terminal.
- **Key bar** for prompts and dialogs: Esc, Enter, arrows, Tab, Shift-Tab,
  1/2/3, and **Stop** (the agent's interrupt key).
- **Push notifications** when an agent needs you, finishes or hits an error,
  and an icon badge with how many need you (over HTTPS, see below).
- **Installable** as a home-screen app, with light and dark themes.
- **Works with any agent herdr-core knows about** (Claude Code, Codex, …):
  nothing to install into the agents.

## How it works

```
iPhone (Safari / home-screen app)
   │  HTTPS via Tailscale, or HTTP on your Wi‑Fi
   ▼
herdr-pwa  (Node, on your Mac)
   │  hc events --json   live status changes
   │  hc read / send / keys / interrupt
   ▼
herdr-core  →  your agents' terminals
```

The server keeps one `hc events` stream open and pushes changes to the page
over Server-Sent Events. It only ever calls the `hc` CLI, without a shell.
Notifications use standard Web Push (VAPID), sent from your Mac straight to
Apple's or Google's push service.

## Requirements

- macOS or Linux with [Herdr](https://herdr.dev) and herdr-core (`hc`) running
- Node.js 20+
- For notifications: HTTPS, most easily with [Tailscale](https://tailscale.com),
  and iOS 16.4+ with the app added to the Home Screen

## Quick start

```sh
git clone https://github.com/VespeneLabs/herdr-pwa.git
cd herdr-pwa
npm install
npm start          # listens on 127.0.0.1:7690
npm run token      # prints the token the phone asks for
```

Then reach it from your phone in one of two ways.

### Option A: Tailscale (recommended)

Private to your devices, works anywhere, HTTPS, notifications.

```sh
tailscale serve --bg 7690     # https://<your-mac>.<tailnet>.ts.net
tailscale serve status        # shows the URL
```

### Option B: Same Wi‑Fi, no extra software

```sh
HOST=0.0.0.0 npm start
```

Open `http://<your-mac-ip>:7690` on the phone (`ipconfig getifaddr en0` shows
the IP). This uses plain HTTP: no notifications or badge, the token travels
unencrypted, and anyone on the network can reach the page (they still need
the token). Use it at home only, never on shared Wi‑Fi.

### On the iPhone

1. Open the URL in Safari.
2. Share → **Add to Home Screen**, then open **Herdr** from the Home Screen.
3. Paste the token. The home-screen app has its own storage, separate from
   Safari, so paste it there too.
4. ⋯ → **Turn on notifications**, then **Send a test notification**.

### Run it in the background (macOS)

```sh
scripts/install-launchagent.sh                 # starts at login, restarts if it dies
HOST=0.0.0.0 scripts/install-launchagent.sh    # same, reachable on your Wi‑Fi
scripts/install-launchagent.sh --uninstall
```

Logs go to `~/Library/Logs/herdr-pwa.log`.

## Using it

- Tap an agent to see its screen. While an agent is working, herdr-core
  returns only its visible screen; the full history comes back once it stops.
- **Message** pastes your text and presses Enter. For an agent that needs you,
  it's sent even though the agent is blocked, so for permission prompts prefer
  the keys: `1`/`2`/`3`, arrows and `⏎`.
- **Stop** interrupts the agent.
- With a hardware keyboard, Enter sends and Shift-Enter starts a new line.

## Security

**Anyone with the token can type into your terminals, which means running
commands as you.** Treat it like an SSH key.

- By default the server listens on `127.0.0.1` only. Use Tailscale (`serve`,
  never `funnel`) or `HOST=0.0.0.0` on a network you trust. Don't port-forward
  it to the internet.
- The token is 192 random bits in `~/.config/herdr-pwa/token` (mode 600) and
  is compared in constant time. To rotate it, delete the file and restart;
  every device then needs the new one.
- Only terminals herdr-core reports can be addressed, key names are validated,
  request bodies are size-limited, and `hc` runs without a shell.
- The page ships a strict Content-Security-Policy and no third-party code.

Found a problem? Please open an issue, or for anything sensitive, contact the
maintainers privately first.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `7690` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on (`0.0.0.0` for your Wi‑Fi) |
| `HC` | found automatically | Path to the `hc` binary |
| `HERDR_PWA_HOME` | `~/.config/herdr-pwa` | Token, push keys and subscriptions |

## Troubleshooting

- **"hc events exited" in the log**: herdr-core isn't running or `hc` isn't
  found. Start Herdr, or set `HC=/path/to/hc`.
- **No "Turn on notifications" button**: the page isn't on HTTPS, or isn't
  opened from the Home Screen (iOS only allows push for home-screen apps).
- **Statuses look stale after the Mac sleeps**: reopen the app; it reconnects
  when it comes back to the foreground.

## Project layout

```
server.js                    HTTP server, hc events follower, Web Push
public/                      the web app (plain HTML/CSS/JS, no build step)
scripts/install-launchagent.sh
```

## License

[MIT](LICENSE)
