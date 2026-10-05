# Progress

Read this at the start of every session (CLAUDE.md). Newest on top.

## Milestone 1 — Foundation — **built, waiting for Kasi to confirm login on the live URL**

Done
- Next.js 15 (App Router) + TypeScript strict + Tailwind v4 + Prisma 6 / Postgres. pnpm. One app, one database.
- Auth: email + password, bcrypt (cost 12), sealed `iron-session` cookie (7 days). The role is read from the database on every
  request, never from the cookie. A deactivated user is logged out at once. No self-registration.
  Login is rate limited (5 misses per person per place per 15 minutes; 30 per place) and gives one message for
  "wrong password / unknown email / deactivated" so nobody can discover which emails exist.
- Two seeded users (owner, storekeeper) from `SEED_*` variables; strong passwords generated and printed once when none
  are given. `db:seed:if-empty` never touches existing users.
- Shell: top bar (coil line, Saved ▾, Chats ▾, ?, user menu with theme and Log out), chat column with the opening card,
  launcher row (role filtered, ported from `reference/artifacts/launcher.ts`, all buttons switched off), a disabled
  chat box, and the panel (beside the chat ≥ 1280 px, overlay 768–1279 px, full-screen sheet with "Back to chat" on a phone).
  The "?" shortcuts list is the first thing that opens in the panel.
- Design tokens from INTERFACE §12, light and dark, theme remembered per user. Fonts are self-hosted (fontsource).
- Response headers on every page: CSP with a fresh nonce per request and **`frame-src about:`**, no outside hosts anywhere,
  nosniff, frame deny, referrer policy, permissions policy, DNS prefetch off, HSTS over https.
- `/api/health`: config, database and guard-trigger check (503 when anything is wrong). `instrumentation.ts` refuses to start
  when a guard is missing. The guard list is empty until milestone 2 adds the ledger.
- ESLint rule: `@prisma/client` and `@/server/db` can only be imported from `src/server/{tools,auth}`, `health`, `guards`, `prisma/`, tests.
- `railway.json` and `docs/DEPLOY.md`.

Proof (all run in this session)
- `pnpm test`: 31 unit and integration tests, real Postgres (headers, middleware, passwords, rate limit, login, health, env, launcher).
- `pnpm e2e`: 31 browser tests in real Chromium, desktop 1440×900 and Pixel 7 (login, wrong password, logout, role-specific
  launcher, panel on desktop and phone, theme, CSP header + nonce + no browser violations, axe WCAG 2.1 AA in light and dark).
- `pnpm test:kit`: 200/200 kit tests (sandbox in real Chromium, exports with pandoc).
- Rehearsed the Railway start command on an empty database: migrate → seed → restart (seed is a no-op) → `/api/health` 200.
- Not verified here: an actual Railway deploy (no Railway access from this session).

Decisions to confirm with Kasi
1. Login is by **email**. If the storekeeper has no email, we can switch to a short username.
2. Sessions last **7 days**. Shorter is safer on the shared office PC.
3. There is **no "change my password" or "reset password" yet** (TOOL_CATALOG only has `create_user`). Suggested: the owner
   can reset anyone's password from a form in milestone 3.
4. The top bar says **Vijaya Stores** with *Vijaya Electronics* underneath, instead of the prototype's *Inventory Terminal*.
5. Seed names and emails are placeholders (`owner@vijaya.local`); set the real ones in Railway before the first deploy.

Next: milestone 2 — ledger core (schema, migrations with every guard, boot check, Tool Gateway, audit, error mapping,
number series, PendingAction + `sanitizePrefill`). Needs Kasi's go-ahead after the live login check.

## Before milestone 1

- Kit unpacked into the repo, kit tests 200/200.
