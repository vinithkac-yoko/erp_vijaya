# Vijaya Stores

Chat-first stores system for Vijaya Electronics. **Start every session by reading
`VIJAYA_CLAUDE_CODE_PROMPT.md`** and `docs/PROGRESS.md` (where you left off).

Non-negotiables (details in the prompt):
- Business data only through the Tool Gateway (`runTool`). No other code touches business tables.
- The agent never writes. Write tools create a PendingAction; only the user submitting the form
  executes it.
- Ledger guards live in Prisma migrations. The app refuses to start if a guard trigger is missing.
- Artifacts (a `document` in VDoc format, or a `page`) are sandboxed and read-only: numbers come from read tools; they
  can only open forms; never loosen the sandbox (`docs/SAFETY.md`); the embedding page must send `frame-src about:` and
  pass the nonce. A document has no model-written script.
- Downloads (PDF, Word, Excel, CSV, PNG, Markdown) are made on the server, re-reading data with the downloader's role;
  never accept rows or files from the browser. The launcher is top-used per user, role filter first.
- Tool descriptions come from `prompts/tool-descriptions.json`; edit `prompts/build_tool_descriptions.py`
  and regenerate. Printouts are fixed templates, never generated.
- The count sheet shows the System column (owner dropped blind counting).
- No generic table access, no internal codes or ids shown to users, no raw database errors shown.
- `docs/BUSINESS_FLOW.md` wins on any business question. If a rule is missing, ask Kasi.
- Keep `docs/TOOL_CATALOG.md` and `docs/AGENT_PROMPT.md` in sync with the code in the same commit.
- Stop at the end of each milestone and report to Kasi in plain words.

## Commands
- `pnpm dev` · `pnpm build` · `pnpm lint` · `pnpm typecheck`
- `pnpm test` (Vitest, needs Postgres; uses `.env.test`) · `pnpm e2e` (Playwright, run `pnpm build` first)
- `pnpm test:kit` (the kit's sandbox/export tests; needs Chromium via `CHROMIUM_PATH`, and `pandoc`)
- Local database: `postgresql://vijaya:vijaya@localhost:5432/vijaya` (dev) and `vijaya_test` (tests). See `.env.example`.
