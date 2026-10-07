# Progress

Read this at the start of every session (CLAUDE.md). Newest on top.

## Milestone 2 — Ledger core — **built, waiting for Kasi's go-ahead for milestone 3**

Kasi's answers to the milestone 1 questions: login by email ✓, 7-day sessions ✓, owner can reset passwords (a form, milestone 3) ✓,
brand line ✓, Railway deploys `main` ✓, go ahead with milestone 2 ✓. (A real Railway login check is still not confirmed.)

Done
- **Schema** (`prisma/schema.prisma`): everything in `reference/schema.prisma` except the dormant `Lot`, plus `PendingAction`,
  `Conversation`, `Message`, `AgentRun`, `Artifact`, `ArtifactVersion`, `ArtifactShare`. `AuditEvent` gained `openedFrom`,
  `pendingActionId`, `artifactId`, `artifactVersion`. Materials got a unique `nameKey` (like parties), so a duplicate is refused by the database too.
- **Every guard is in a migration** (`prisma/migrations/*_ledger_guards`), so a plain `prisma migrate deploy` on an empty database gives them all:
  append-only ledger and audit log (UPDATE, DELETE and TRUNCATE all refused; the demo reset gets one transaction-local switch),
  immutable artifact versions, the weighted-average trigger with the running balance on every row, every CHECK, the count guards
  (no blanks, one opening count, approved is final, lines freeze when the count is with the owner, system quantity frozen, counts
  are never deleted), a reversal must mirror its original, and the five views.
- **Where I tightened the reference rules** (each is already stated in BUSINESS_FLOW §4/§11/§14; none is a new business rule):
  the database, not the caller, sets the rate of every OUT, RETURN, COUNT_ADJUSTMENT and OPENING; a count line posts once, with exactly
  its quantity and direction; RECEIPT/REJECT_RETURN need a receipt line, SCRAP_SALE a scrap sale, REVERSAL its original;
  guard triggers fire before the balance trigger (PostgreSQL fires them in name order, so the balance trigger is `trg_stock_movement_apply`).
- **One rule I had to decide** (BUSINESS_FLOW §20, question 5): a receipt after the stock went negative averages at the incoming rate.
  The literal formula turns 10 kg at ₹100 into ₹200 after a negative balance.
- **Boot check** (`src/server/guards.ts`, `src/instrumentation.ts`): 15 triggers, 13 CHECKs and 5 views must exist and be switched on.
  Missing or **disabled** → the process exits with code 1 and says which. `/api/health` reports the same.
- **Tool Gateway** (`src/server/tools/`): `defineTool` (refuses a tool that is not in the catalog, has no roles, or disagrees with the catalog;
  its text always comes from `prompts/tool-descriptions.json`), `Registry` (role-filtered lists), `runTool` (unknown tool refused, role from the
  session, input validated and unknown keys stripped, writes need a form the user submitted, one transaction with one audit event, secrets scrubbed
  from the audit, every failure turned into a named code and a plain sentence), `numbers.ts` (FY document numbers, atomic).
- **PendingAction** (`pending.ts`): launcher/agent/artifact origins, `sanitizePrefill` on the server (ported), an artifact can only open everyday
  forms, 15-minute life, a newer form for the same tool in the same chat replaces the older, "Not now", housekeeping.
- **Error table** (`src/server/errors.ts`): every constraint, unique index and trigger code has plain words; raw database text never leaves.
- Names (`src/lib/names.ts`) and financial year (`src/lib/fy.ts`) helpers; the launcher's catalog moved to `src/lib/catalog.ts`.
- The production tool registry is **empty on purpose**: real tools start in milestone 3. The gateway is proven with test tools that use real catalog names.

Proof (all run in this session)
- `pnpm test`: **144 tests, 17 files**, real Postgres. Highlights: 800 → 850 → 850 → 850 → 880; opening stock ₹1,15,791; 25 simultaneous issues each see the
  true balance; every CHECK says something plain; a fresh `migrate deploy` has every guard and the boot check catches a dropped, disabled or missing one;
  the coverage test walks every constraint in the database and every `RAISE`; a double-clicked form saves exactly once; a failed save keeps nothing and leaves the form open.
  Mutation-checked: deleting an error entry or renaming a trigger makes the right tests fail.
- `pnpm e2e`: 31 browser tests (desktop + Pixel 7) from a freshly migrated database.
- `pnpm test:kit`: 200/200.
- Rehearsed the Railway start on an empty database: migrate → seed → start → health shows 33 guards; with a guard switched off the app exits (code 1) and nothing listens; it starts again when the guard is back.

Things to know
- The test database is **rebuilt from nothing on every run** (and refuses any database not named `*_test`). That caught a real trap: importing
  `@prisma/client` loads the dev `.env` first, so `.env.test` must override (`tests/helpers/env.ts`).
- Prisma refused `migrate reset` from an AI session without Kasi's explicit consent, so the container's dev database was left alone; nothing depends on it.
- Not done yet, on purpose: notifications on negative stock, the follow-up engine, the real tools (milestone 3 onward).

Questions for Kasi (BUSINESS_FLOW §20, items 5 and 6)
1. A receipt after negative stock: average at the incoming rate (what I built) — confirm.
2. Rejected goods in the ledger: RECEIPT of everything received + REJECT_RETURN of the rejected part (my assumption) or RECEIPT of the accepted part only — needed before milestone 6.

Next: milestone 3 — agent + forms: streaming chat, role-filtered tools, form cards from PendingActions, launcher buttons and chips, the opening card,
follow-ups, conversation history, kill switch; master-data tools (materials, parties, users incl. owner password reset, settings).
Needs `ANTHROPIC_API_KEY` in the session for the agent (ask Kasi).

## Milestone 1 — Foundation — built; the live-URL login check is still to be confirmed by Kasi

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
