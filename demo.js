// Demo data for `npm run demo`: made-up agents, so you can try the app
// (and take screenshots) without herdr-core. Nothing here touches a terminal.

const now = Date.now();
const ago = (min) => now - min * 60_000;

function term(address, { title, where, status, msg, kind, progress, parent, cwd, program, mins }) {
  return {
    address,
    title,
    labels: { where },
    cwd,
    state: "live",
    status: status ? { app: "claude-code", state: status, msg, kind, progress } : null,
    foreground: { argv: [program || (status ? "claude" : "zsh")] },
    parent: parent || null,
    status_ms: ago(mins),
    created_ms: ago(mins + 30),
  };
}

export const terminals = [
  term("t4", {
    title: "Checkout refactor", where: "acme-shop / checkout", status: "blocked", kind: "permission",
    msg: "Run the database migration?", cwd: "~/code/acme-shop", mins: 1,
  }),
  term("t9", {
    title: "Flaky login test", where: "acme-shop / auth", status: "working",
    msg: "Running the e2e suite with retries off", progress: 60, cwd: "~/code/acme-shop", mins: 3,
  }),
  term("t9a", {
    title: "Explore session handling", where: "acme-shop / auth", status: "working",
    msg: "Reading src/auth/session.ts", parent: "t9", cwd: "~/code/acme-shop", mins: 2,
  }),
  term("t12", {
    title: "Dark mode for settings", where: "design-system / theming", status: "working",
    msg: "Updating token tables in the docs", cwd: "~/code/design-system", mins: 7,
  }),
  term("t7", {
    title: "Release notes 2.4", where: "docs / release", status: "done",
    msg: "Draft ready in CHANGELOG.md", cwd: "~/code/docs", mins: 12,
  }),
  term("t2", {
    title: "Bump dependencies", where: "api / deps", status: "done",
    msg: "All 412 tests pass", cwd: "~/code/api", mins: 48,
  }),
  term("t5", {
    title: "Rate limiter design", where: "api / limits", status: "idle", cwd: "~/code/api", mins: 180,
  }),
  term("t3", { title: "dev server", where: "acme-shop / checkout", program: "vite", cwd: "~/code/acme-shop", mins: 95 }),
];

const screens = {
  t4: `> Move the checkout totals into a pure function
  and cover it with tests.

● I'll pull the totals logic out of CheckoutPage
  so it can be tested on its own.

● Read(src/checkout/CheckoutPage.tsx)
  ⎿  Read 214 lines

● Write(src/checkout/totals.ts)
  ⎿  Wrote 48 lines to src/checkout/totals.ts

● Write(src/checkout/totals.test.ts)
  ⎿  Wrote 96 lines

● Bash(npm test -- totals)
  ⎿  PASS  src/checkout/totals.test.ts
       ✓ sums line items (3 ms)
       ✓ applies promos before tax (1 ms)
       ✓ never goes below zero (1 ms)
       ✓ rounds tax to cents (1 ms)
     Tests: 4 passed, 4 total

● The orders table stores totals too, so the new
  rounding needs a migration for older rows.

╭───────────────────────────────────────────────╮
│ Bash command                                  │
│                                               │
│   npm run db:migrate -- --name totals-round   │
│   Apply the totals rounding migration         │
│                                               │
│ Do you want to proceed?                       │
│ ❯ 1. Yes                                      │
│   2. Yes, and don't ask again for this        │
│   3. No, tell Claude what to change (esc)     │
╰───────────────────────────────────────────────╯`,

  t9: `> The login e2e test fails about 1 in 5 runs on CI. Find out why.

● I'll start a helper to map how sessions are created while I reproduce it.

● Task(Explore session handling)
  ⎿  Running in t9a…

● Bash(npx playwright test login --repeat-each 20 --retries 0)
  ⎿  Running 20 tests using 4 workers
     ✓ 12 passed
     ✘  1 failed: login › redirects to dashboard (timeout 5000ms)
     … running`,

  t7: `> Draft the 2.4 release notes from the merged PRs.

● Bash(gh pr list --state merged --base main --search "merged:>2026-10-01")
  ⎿  38 pull requests

● Write(CHANGELOG.md)
  ⎿  Updated CHANGELOG.md with 41 additions

● Release notes for 2.4 are drafted in CHANGELOG.md: 6 features,
  11 fixes and 2 deprecations, grouped by area, each linking its PR.`,
};

export async function hc(args) {
  const [cmd, t] = args;
  if (cmd === "read") {
    return screens[t] || `$ npm run dev\n\n  VITE v6.0.0  ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/\n`;
  }
  if (cmd === "interrupt") return "Interrupted (demo)";
  return ""; // send, keys: accepted and ignored
}
