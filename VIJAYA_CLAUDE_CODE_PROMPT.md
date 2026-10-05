# Vijaya Stores — Claude Code Build Prompt

> **Setup:** push the contents of `vijaya-kit.zip` to a new private GitHub repo, start a Claude Code
> cloud session on it, run `/reload-skills`, then send: *"Read VIJAYA_CLAUDE_CODE_PROMPT.md and
> start milestone 1."*

---

## 0. Read this first

You are building **Vijaya Stores**: a chat-first stores and inventory system for Vijaya
Electronics, a transformer and inductor coil manufacturer in Chennai. It replaces a notebook and
an Excel sheet. Kasi (the person you work with) is the product owner. He does not write the code;
you do. He tests every milestone against the business flow.

This is a **rebuild from scratch**. A first version exists (`github.com/sanjaysagar12/dynamic_ui`)
and its **business rules are correct and battle-tested** — every one of them is captured in the
docs in this kit. Its **architecture is not**: five separate services, two databases, guards
applied by hand, prompts drifting from code. Do not copy its code or structure. §14 lists exactly
what went wrong so you don't repeat it.

**The product in one sentence:** *the chat is the whole app.* Forms open in the chat (from buttons above the
input, or because the assistant brought one). Anything big — a report, a memo, an SOP, a diagram, a chart, a dashboard — opens as an
**artifact** beside the chat, like Claude's artifacts, and downloads as PDF, Word, Excel, CSV, a picture or Markdown. There are **no fixed screens and no menu of screens**.

**Files in this kit — read all of them before writing code:**

| File | What it is | Authority |
|---|---|---|
| `VIJAYA_CLAUDE_CODE_PROMPT.md` | This file: architecture, stack, milestones, rules | How to build |
| `PRODUCT.md` | Users, purpose, brand, design principles (impeccable's brief format) | Who it's for |
| `docs/BUSINESS_FLOW.md` | Every business rule, agreed with the owner | **Wins on any business question** |
| `docs/TOOL_CATALOG.md` | Every operation the system can perform, plus the artifact tools | The contract |
| `docs/AGENT_PROMPT.md` | The chat agent's system prompt, ready to load | Agent behaviour |
| `docs/INTERFACE.md` | The chat-only interface: layout, launcher, forms in chat, count sheet, phone, keyboard, tokens | How it looks and behaves |
| `docs/ARTIFACTS.md` | What an artifact is (document or page), the VDoc format, when to make one, builder, versions, sharing, printouts, exports | Artifacts |
| `docs/SAFETY.md` | Threat model: what stops each bad thing and which test proves it | Security |
| `docs/RESEARCH.md` | Why the interface, artifacts and safety are designed this way, with sources | Background |
| `prompts/ARTIFACT_BUILDER.md` | The artifact builder's system prompt + repair message | Artifact building |
| `prompts/tool-descriptions.json` | The exact text the model sees for every tool and input (generated from `build_tool_descriptions.py`) | Tool text — load it, don't rewrite it |
| `docs/ACCEPTANCE_TESTS.md` | The prompts Kasi will type, and what must happen | Definition of done |
| `reference/schema.prisma` | v1's schema — the data model is right; start from it | Data model |
| `reference/inventory_guards.sql` | v1's database invariants — **all must survive** | Ledger safety |
| `reference/prototype.html` | Look-and-feel prototype the owner approved (its layout is superseded by INTERFACE.md; its colours and stamps stay) | Visual direction |
| `reference/artifacts/` | **Tested** artifact host (sandbox), checker, prefill sanitiser, launcher, catalog, examples. Hostile tests run in real Chromium | Port this |
| `evals/` | Agent eval cases + tested assertion engine; you build the runner | Agent tests |
| `.claude/skills/` | `impeccable` and `ui-ux-pro-max` design skills | Design process |

If two documents disagree, **BUSINESS_FLOW.md wins**, then this file, then the rest. If something
isn't covered, **ask Kasi** — never invent a business rule.

---

## 1. What success looks like

1. The storekeeper does his whole day — receive material, issue to jobs, take returns, count stock,
   raise a PO — by pressing a **button above the chat input** (a form opens in the chat) or by typing in plain
   English (with Tamil/Hindi words mixed in). He never sees an internal code, a database error, or accounting jargon.
2. The owner opens the app on his phone, sees a card with what needs his approval, approves in one tap, and asks
   questions like *"where is my stock leaking?"* or *"what did job 31 cost?"* and gets a straight answer, a
   short table, or an artifact.
3. **Nothing can corrupt the ledger** — not a bug, not the agent, not someone in the database console.
   Stock history is append-only; every change is traceable to a person.
4. Anything they ask for that is a **report, memo, SOP, diagram, chart, dashboard, comparison, what-if or long list**
   the assistant builds as an **artifact** beside the chat, numbers straight from the ledger, changeable by asking,
   versioned, saveable, and — for the owner — shareable with the storekeeper (a frozen copy he can't change). Reports,
   documents and diagrams are **documents** (Markdown with named reads and Mermaid diagrams, no model-written script);
   interactive what-ifs are **pages**. Any of them downloads as **PDF, Word, Excel, CSV, a picture or Markdown**
   (formats by kind), made on the server with the downloader's own role.
5. The assistant picks the **smallest right output** — a sentence, a short table, a form, an artifact (document or page), a
   printout, a download — and **never opens an artifact unless asked for something that needs one**.
6. Anything that leaves the building (a PO for the supplier, a pick list, a count sheet) prints from a fixed template.
7. It is **secured and doesn't misbehave**: the AI has no write power, artifacts run in a sandbox that holds even
   if their code is hostile, roles are enforced in one place, and there's a kill switch. `docs/SAFETY.md` lists each
   threat and the test that proves it.

---

## 2. Stack

Same as BuildFlow — one app, one database, one deploy.

- **Next.js 15** (App Router, React Server Components, Server Actions), **TypeScript strict**.
- **Prisma** + **PostgreSQL 16** on **Railway**. `schema.prisma` is the source of truth for tables;
  SQL that Prisma can't express (triggers, CHECKs, views) lives in **Prisma migrations** too —
  never in a file someone runs by hand.
- **Tailwind CSS v4** + **shadcn/ui** (Radix primitives), **lucide-react** icons.
- **Anthropic API** via `@anthropic-ai/sdk`, streaming, tool use, structured output, prompt caching. Model from env
  `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`); the artifact builder may use `ANTHROPIC_BUILDER_MODEL`.
- **Zod** for every input. **TanStack Table** for the count-sheet grid. (Charts inside artifacts come from the
  host's own `vijaya.ui.chart`; there is no chart library.)
- Auth: own session cookie (`iron-session`), bcrypt passwords. No third-party auth.
- **Vitest** (unit + integration against a real Postgres), **Playwright** (e2e, and the artifact sandbox tests).
- **pnpm**. PWA manifest so the owner can add it to his Android home screen.

No Supabase, no microservices, no second database, no separate translation model, no voice in v1.

---

## 3. Architecture

```
Browser (one screen)
 ├─ Top bar: Saved ▾ · Chats ▾ · user
 ├─ Chat ───────► /api/chat (streaming) ───► Agent runtime ──┐
 │    • launcher: buttons above the input                    │
 │    • form cards (PendingAction), inline tables            ▼
 ├─ Panel (right / phone sheet): artifact │ expanded form │ printout
 │     │  Server Actions (submit a form) ─────────────►  Tool Gateway ──► Prisma ──► Postgres
 │     │                                                  (the ONLY door)           (guards, triggers, views)
 │     └─ Artifact host ─ sandboxed iframe ─ MessageChannel (read | openForm) ─► Tool Gateway (read only)
```

### 3.1 The Tool Gateway — the only door to business data

`src/server/tools/` holds one file per operation in `docs/TOOL_CATALOG.md`. Each tool exports:

```ts
defineTool({
  name: 'issue_material',
  kind: 'write',                       // 'read' | 'write'
  roles: ['STOREKEEPER', 'OWNER'],     // REQUIRED on every tool — no default
  description: d.description,          // from prompts/tool-descriptions.json — never inline text
  input: z.object({ ... }),
  form: { ... },                       // write tools: how the form renders
  handler: async (ctx, input) => { ... },
  followUps?: (ctx, input, result) => FollowUp[],   // see 3.4
})
```

`runTool(session, name, input, opts)` is the **single function** through which every form, every Server Action,
the agent, and every artifact reaches business data. It:

1. Looks up the tool; **rejects unknown names**.
2. Checks the role **from the session, server-side**. Never from the request body, never from anything the
   model or an artifact says.
3. Validates input with Zod; **strips unknown keys**.
4. For `write` tools: requires a valid `confirmation` (see 3.3). No confirmation → rejected.
5. Runs the handler inside **one Prisma transaction**, writing **one `AuditEvent`** in the same
   transaction (actor user, `actorType` HUMAN or AGENT, `agentRunId`, `openedFrom` chat | launcher | artifact | agent,
   tool name, before/after).
6. Translates every database error into a **named code + plain-English message** (§3.7). A raw
   Postgres message must never reach a screen or the model.
7. Returns `{ ok: true, data } | { ok: false, code, message }`.

Rules:
- **No generic table access.** There is no `list_rows`, no "query any table", no schema
  introspection exposed to the agent or to artifacts. Every read is a purpose-built tool that
  returns names, never ids-as-labels, never internal codes.
- **No self-registration.** Users are created by the owner (`create_user`) or the seed.
- Nothing outside `src/server/tools/` imports the Prisma client for business tables. Enforce it
  with an ESLint `no-restricted-imports` rule.

### 3.2 The database is the last line of defence

Start from `reference/schema.prisma` and `reference/inventory_guards.sql`. All of these must exist
**after a plain `prisma migrate deploy` on an empty database** — put them in a migration:

- Append-only ledger: UPDATE/DELETE on `stock_movements` and `audit_events` raise; so does
  TRUNCATE, except inside the demo reset (§7). Same for `artifact_versions` (immutable).
- `apply_stock_movement` trigger: weighted average, running balance stamped on every movement,
  balance row locked `FOR UPDATE`. Balances are **derived**; no code writes `stock_balances`.
- Every CHECK: positive quantities, GRN split adds up, count difference = counted − system,
  movement direction matches type, ISSUE/RETURN need a job, COUNT_ADJUSTMENT and OPENING need an
  approved count line, opening rate > 0.
- Count guards: COUNT_ADJUSTMENT only from an approved normal count; OPENING only from the single
  approved opening count; a count can't leave DRAFT with blanks; only one opening count ever.
- Views: `v_balance_integrity`, `v_material_leak` (excludes the opening count; only real
  differences count as unexplained), `v_job_material_cost`, `v_bom_vs_actual`, `v_reorder_alerts`.

Then:
- **Boot check:** on server start, query `pg_trigger` for the guard triggers. If any is missing,
  **refuse to start** and log which. An app running on an unguarded database must fail loudly.
- **Test:** a test runs `migrate deploy` on an empty database and asserts every trigger, CHECK and
  view exists.
- Use Prisma's default enum names (`"MovementType"`). Compare enums in SQL with plain string
  literals, never `::lowercase_casts`.
- Drop the dormant `Lot` model from v1. Unused tables are just a leak risk.

### 3.3 Confirmation is structural, not a prompt instruction

**The agent can never write.** When the model calls a write tool, the runtime does **not** run
it. Instead it creates a `PendingAction` row:

```
PendingAction { id, userId, toolName, proposedInput (json), origin: LAUNCHER | AGENT | ARTIFACT,
                agentRunId, status: OPEN | SUBMITTED | CANCELLED | EXPIRED, expiresAt (15 min), createdAt }
```

…and the chat shows the tool's **form, pre-filled**, as a card. `proposedInput` always passes through
`sanitizePrefill(tool, input, origin)` (`reference/artifacts/prefill.ts`) **on the server**: unknown or oversized
values and every **rate** are dropped when the origin is the agent or an artifact, and the launcher passes nothing.
A form with suggested values shows an "assistant filled this in" badge. Only when **the logged-in user
submits that form** does a Server Action call `runTool(session, toolName, editedInput,
{ confirmation: pendingActionId })`. The gateway checks the pending action belongs to this user,
is OPEN, unexpired, and for the same tool, then marks it SUBMITTED in the same transaction.

Opening a new form for the same tool in the same conversation **cancels** the earlier open one
("issue for job 31… actually job 32").

This removes, by construction, three v1 failures: an agent that "confirms" by itself, a stale
"ok" three turns later executing an old change, and a double-click writing twice.

**Launcher buttons use the same path**: pressing *Receive stock* creates a PendingAction (origin LAUNCHER, empty
input) and shows the form card. **An artifact can only open a form** (`vijaya.openForm`) — it cannot submit one.
After a submit the **server** draws the "Saved: …" card from the audit row; the model cannot claim a save.

### 3.4 The agent runtime

`src/server/agent/` — one agent, no router, no second model for chat.

- **System prompt:** `docs/AGENT_PROMPT.md`, loaded at build time, with prompt caching on the
  system prompt + tool definitions.
- **Tools offered:** only those whose `roles` include the user's role, plus the app tools (§3.5). The storekeeper's
  agent never sees `approve_*`, `reverse_movement`, `update_setting`, `share_artifact`. (It must still *answer*
  "who approves?" — the prompt covers that.)
- **Read tools** run immediately via `runTool`; results stream back to the model, wrapped as **data** (SAFETY §4),
  and render in the chat (small tables inline) or in an artifact (anything big, when asked).
- **Write tools** create a PendingAction and end the model's turn with the form card shown.
- **After a submit:** the server runs the tool's `followUps` — deterministic read tools (shortage
  after a BOM, rate change after a receipt, min-level after an issue, variance after closing) —
  then asks the model for **one or two sentences** plus **chips** (next form to open, never with a rate; or an
  "ask" chip). Spec per tool: `docs/TOOL_CATALOG.md` → *Follow-ups*.
- **Contextual chips after every answer** (2–3), so there is never a blank prompt (INTERFACE §5).
- **Language:** English mixed with Tamil/Hindi; Claude reads it directly. Replies in simple English.
- **Conversations** are stored in the database (`Conversation`, `Message`, `AgentRun`) with the user, tool calls and
  results, and any artifact or pending action produced. They survive reloads and devices.
- **Limits and the kill switch:** max 8 tool calls per turn; 60 s turn timeout; per-user daily token budget;
  `AGENT_ENABLED=false` turns the assistant off while **forms, printouts and approvals keep working**.

### 3.5 Artifacts

Full specification in `docs/ARTIFACTS.md`; the sandbox and its proofs in `docs/SAFETY.md`; tested reference code in
`reference/artifacts/` (host, checker, prefill, launcher, catalog); the builder's prompt in
`prompts/ARTIFACT_BUILDER.md`. In short:

- An artifact has one of **two kinds** (`Artifact.kind`: `DOCUMENT` | `PAGE`; ARTIFACTS §1):
  - a **document** is a **VDoc**: Markdown plus a header of named reads, `{{name.path|fmt}}` bindings and fenced
    `vtable` / `vchart` / `vstats` / `mermaid` blocks. **No model-written script**: our renderer (`docrender.js`) draws it
    in the same sandbox; the mermaid bundle (~5 MB) is injected only when there is a diagram (`securityLevel: 'strict'`).
    Reports, memos, SOPs, explainers and diagrams are documents (the default).
  - a **page** is **AI-written HTML + a script** for interactive things (a what-if, filters).
  Both run in `<iframe sandbox="allow-scripts" srcdoc>` with a strict meta CSP and talk to the app over **one
  MessageChannel port** with two methods: `read(tool, input)` (read tools only, **as the viewer**) and
  `openForm(tool, prefill)`. A page uses a host-provided kit (`vijaya.ui`, `vijaya.fmt`); a document uses bindings, so
  neither formats or computes business numbers.
- The agent has the app tools `make_artifact`, `edit_artifact`, `open_artifact`, `list_artifacts`, `open_printout`
  (TOOL_CATALOG §A) plus the owner-only write tools `share_artifact` / `unshare_artifact`. `make_artifact` runs the
  **builder** (a separate model call with a DOCUMENT mode and a PAGE mode, given only the viewer's read tools, never row
  data), then the **server-side checker** (`checkDoc` for a document, `checkArtifact` for a page), with up to 3 repairs.
  `ArtifactVersion.source` holds the VDoc text or the page HTML.
- **Only when asked.** Artifacts are for reports, memos, SOPs, diagrams, charts, dashboards, comparisons, what-ifs and
  long lists; a fact is a sentence and a short list is an inline table (ARTIFACTS §2; evals).
- **Versions** (immutable, Restore), **patch edits whose `old` text must match exactly once in the source**, **Save**, and **owner-only
  Share of a frozen version** to the storekeeper, refused if it uses an owner-only tool (ARTIFACTS §3, §5, §6).
- **Page requirements** (miss one and it is unsafe or silently broken — ARTIFACTS §12): the embedding page
  sends `frame-src about:`; the nonce is passed to `mountArtifact`; `runRead` goes through `runTool`; `onOpenForm`
  goes through `sanitizePrefill` → PendingAction.
- What-ifs ("if copper goes to ₹900…") use the `estimate_job_cost` read tool; the model never does the sums.

### 3.6 Printouts and exports

- **Printouts** are five fixed, code-owned templates with the Vijaya letterhead (`purchase-order` with GSTINs,
  HSN and the CGST+SGST / IGST split; `goods-receipt-note`; `issue-slip` = pick list; `count-sheet` with an empty
  Counted column; `job-cost-sheet`, owner). Rendered server-side to PDF. The model can open them, never generate them.
  ARTIFACTS §9.
- **Exports** (`reference/artifacts/export.ts`, ARTIFACTS §10): a **document** → PDF, Word, Excel, CSV, PNG, Markdown; a
  **page** → PDF, PNG, Excel, CSV; a table in the chat → Excel/CSV. Made **on the server**, re-reading every tool with the
  **downloader's role** (a storekeeper cannot download owner data). PDF/PNG by headless Chromium with every network request
  refused and recorded (a leak fails the export); Word by **pandoc** from resolved Markdown with all database text
  backslash-escaped; Excel by **exceljs** with real numbers, ₹ Indian grouping and no live formulas; CSV neutralises
  `= + - @`; PNG ≤ 16,000 px tall. Audited. Nothing is emailed. Needs `pandoc` and a Chromium (`CHROMIUM_PATH`) on the
  server; `exceljs` and `mermaid` are dependencies. The five printouts stay for letterhead paper.

### 3.7 Errors

One table, `src/server/errors.ts`: every CHECK, trigger exception and Prisma code maps to
`{ code, message }`, e.g. `chk_grn_split → GRN_SPLIT_MISMATCH: "Accepted and rejected must add up
to what was received."` Triggers raise with a `CODE:` prefix so mapping is exact. A test walks
every constraint in the database and fails if one has no mapping.

---

## 4. Users and roles

Two roles. That's all Vijaya has.

| | Storekeeper | Owner |
|---|---|---|
| Device | Office desktop, English, not highly educated | Android phone + laptop |
| Daily work | Receipts, issues, returns, counts, raising POs, adding materials/parties | Approvals, questions, reports, artifacts |
| Approve POs / counts, reverse movements, settings, users | ✗ | ✓ |
| Issue / return (owner is the backup storekeeper) | ✓ | ✓ |
| Sees rates and each material's value | ✓ (agreed) | ✓ |
| Owner reports (stock value total, leak, job cost, scrap, activity) | ✗ | ✓ |
| Makes artifacts for himself | ✓ (storekeeper tools only) | ✓ |
| Shares an artifact with the other role | ✗ | ✓ (frozen version; never an owner-only one) |
| Notifications | In-app | In-app + email |

The role is decided by the session. Hide owner-only controls from the storekeeper, **and** reject them
server-side.

---

## 5. The interface — chat only

Full spec: `docs/INTERFACE.md`. In short, **there are no fixed screens**:

- **Top bar:** logo · **Saved ▾** (saved and shared artifacts) · **Chats ▾** · the user.
- **Chat** in the centre. On opening, the first thing is an **opening card** drawn by deterministic read tools
  (owner: *3 waiting for you · 2 below minimum · [Review approvals]*; storekeeper: *today's open jobs · receipts
  expected · below minimum*). It is not model text.
- **Launcher above the input** (`reference/artifacts/launcher.ts`): form buttons — *Receive stock, Issue to a job,
  Return, Count stock, New PO, New job* (Alt+R/I/T/C/P/J, 44 px+, icon + word) — and "ask" chips — *Low stock,
  Open jobs, Stock today*, and for the owner *Waiting for me (n)*, *Stock value*. **Top used first, per user**: ordered by
  that user's own use (from `AuditEvent` `openedFrom: LAUNCHER` and chip taps) after the role filter, defaults for new
  users and ties; **at most 4 form buttons and 4 chips visible, the rest behind More ▾**; *Continue count* pinned first while
  a count is in progress; keyboard shortcuts stay with the tool even behind More. Built from the role and use, never by the
  model. The form buttons work with the assistant off.
- **Form cards** appear in the chat (pre-filled, "assistant filled this in" badge when relevant). Big forms — the
  **count sheet** (200 rows, keyboard-first, autosave) and a multi-line PO — **expand into the right panel**.
- **Panel / phone sheet:** artifacts, expanded forms, printouts. Never opens by itself over a form someone is filling.
- **Approvals** are cards in the chat (and the "Waiting for me" chip); approve / send back in one tap.
- **Reports, memos, SOPs and diagrams** are document artifacts with **Download ▾** (PDF, Word, Excel, CSV, picture,
  Markdown); **short lists** are inline tables; stock, jobs and suppliers are asked for
  ("Stock today" chip → inline table; "Show all suppliers" → artifact if long).
- Every write goes through the same tool form wherever it opens from.

---

## 6. Data model

Start from `reference/schema.prisma`. Keep: User, Party (with `nameKey` duplicate detection and
unique GSTIN), Setting, NumberSeries (per Indian FY: `JOB-2627-0031`), AuditEvent, Notification,
Attachment, Material, StockBalance, StockMovement, PurchaseOrder(+Line), GoodsReceipt(+Line),
CustomerPo, Job, JobBomLine, StockCount, StockCountLine (with `unitRate`, `sourceInvoiceNo`,
`sourceInvoiceDate`), ScrapSale.

Add: `PendingAction`, `Conversation`, `Message`, `AgentRun`, `Artifact`, `ArtifactVersion`, `ArtifactShare`
(ARTIFACTS §8). Remove: `Lot`. (Kit v3's `Page`, `PageVersion`, `PagePin` are **not** used — there are no pages.)

Change:
- Every user-facing record has a human number or a name. Internal `code` fields (MAT-0001) stay
  internal — **no read tool returns them**.
- `AuditEvent.actorType` is AGENT when the change came from an agent-proposed pending action,
  HUMAN otherwise; `openedFrom` and `agentRunId` set accordingly.
- Notifications have a recipient **user**, and the follow-up that creates them decides who: the
  storekeeper hears about recounts and approvals, the owner about pending approvals, negative
  stock, rate jumps, below-minimum, and job over-use.

---

## 7. Demo data and go-live

Two seeds, chosen by env:

- **`DEMO_MODE=true`** — a realistic finished month for demos: the 9 materials and parties in
  `docs/ACCEPTANCE_TESTS.md`, an approved opening count with invoice rates, ~12 jobs across the 4
  customers (one open PO with 3 releases, one sample job), POs including one above the limit,
  receipts with one rejection and one rate jump, issues/returns/top-ups, scrap in and out, and one
  approved monthly count with a few UNEXPLAINED differences so the leak report has a story. A **Reset demo data**
  action (the owner asks for it in chat; DEMO_MODE only; a confirm form) wipes and reseeds. Because the ledger is
  append-only, the reset uses `TRUNCATE`, so add a **statement-level `BEFORE TRUNCATE` trigger** on `stock_movements`
  and `audit_events` that raises unless `current_setting('vijaya.allow_reset', true) = 'on'`. Only the reset Server
  Action sets that (`SET LOCAL`, inside its transaction), and only when `DEMO_MODE=true`.
- **Go-live** (`DEMO_MODE=false`) — two users, the approval limit, no stock. The first stock
  activity must be the opening count.

---

## 8. Design

- Visual direction: `reference/prototype.html`, which the owner approved — warm paper, ink,
  copper (wound wire), rubber-stamp confirmations. Tokens in `docs/INTERFACE.md` (contrast checked, light + dark)
  and `reference/artifacts/host/tokens.css` (the same tokens inside artifacts). The skill's own palette
  suggestion does not fit; use ours.
- The count sheet **shows the System column** (blind counting was dropped by the owner).
- Process, with the skills in `.claude/skills/`:
  - **ui-ux-pro-max** — look things up (`python3 .claude/skills/ui-ux-pro-max/scripts/search.py
    "<query>" --domain ux|chart|...`). Use it for chat, form, data-table and chart patterns.
  - **impeccable** — **fixed passes only**, or it will polish forever:
    1. **Shape** the two hero surfaces before building them: the chat + launcher + panel, and the count sheet.
    2. **One critique + audit round** at milestone 9.
    3. **One final polish** at milestone 10.
- `PRODUCT.md` is impeccable's brief and is already complete — **don't run impeccable's `init`
  interview**. Keep it updated if anything changes.

---

## 9. Testing

- **Unit + integration (Vitest):** against a real Postgres (never mocks for the ledger). One test
  file per tool: happy path, every precondition, role rejection, audit row written, error code
  mapping. DB tests for every guard (weighted average sequence 800 → 850 → 850 → 850 → 880,
  append-only, count guards, concurrency).
- **Integrity:** every integration test ends with `v_balance_integrity` returning zero rows.
- **Security tests:** the whole of `reference/artifacts/` (§ below), plus tool-registry checks (every tool has
  `roles`), a test that the storekeeper's tool list contains no owner tool, response-header checks
  (`frame-src about:`), and the download/share role tests listed in `docs/SAFETY.md` §2.
- **E2E (Playwright):** the go-live opening count, a job end to end (job → BOM → shortage → PO → approval →
  receipt → issue → return → close), a monthly count with a send-back, an artifact (a document with a diagram, and a
  page) made, edited, restored, saved, shared, refreshed and **downloaded in every format** (open the PDF, Word and
  Excel files and check the numbers; a storekeeper's download of an owner document is refused), **truth tests**
  (every rendered number equals the read tool's result) and each printout opened as PDF. Desktop for the storekeeper, Pixel 7 viewport for the owner.
- **Agent evals (`pnpm eval`):** the cases, checks and assertion engine are already built and tested in `evals/`
  (one case per ★ prompt in `docs/ACCEPTANCE_TESTS.md`, including §31 output routing and §32 safety/injection).
  You build the runner described in `evals/README.md`. Not part of CI (costs money); run at milestones 8 and 10 and
  whenever the prompt or a tool description changes.
- **Kit tests:** `cd reference/artifacts && npm install && npm run test:kit` runs the artifact checker, document
  (VDoc) checker, prefill, top-used launcher, the exports and **the sandbox in real Chromium**, plus the eval-kit and prompt/tool-description consistency tests.
  Port them into the app and keep them passing; point the consistency tests at the real tool registry.

---

## 10. Milestones

Work in order. At the end of each: run all tests, commit, push, update `docs/PROGRESS.md`, and
**stop** — tell Kasi in plain words what's ready, what to test (the matching rounds in
`docs/ACCEPTANCE_TESTS.md`), and anything you decided that he should confirm.

1. **Foundation** — Next.js app, auth, two roles, seeded users, design tokens, the shell (top bar, chat, panel;
   mobile sheet; launcher row with disabled buttons), response headers (CSP incl. `frame-src about:` with nonces),
   `/api/health`, Railway deploy (§11). *Stop: Kasi confirms login on the live URL.*
2. **Ledger core** — schema, migrations **including every guard**, boot check, Tool Gateway,
   audit, error mapping, number series, PendingAction + `sanitizePrefill`. DB guard tests ported and passing.
3. **Agent + forms** — chat with streaming, role-filtered tools, the PendingAction form cards in the chat, the
   launcher buttons and ask chips, the opening card, follow-up engine and contextual chips, conversation history,
   kill switch. Master-data tools: materials, parties, users, settings.
4. **Opening count** — the count sheet form (expanded in the panel) and the opening flow (BUSINESS_FLOW).
   *This is go-live; it must be solid before anything else moves stock.*
5. **Jobs** — customer POs, jobs, samples, BOM with live totals, shortage check.
6. **Purchasing** — POs with the approval limit, approval cards in the chat, goods receipts with
   inspection, price history, notifications (in-app; email to owner).
7. **Issue, return, close, scrap, reversal** — including negative stock, top-ups, job cost.
8. **Monthly counts + reports** — count with reasons, send-back and resend, the leak report,
   job cost, BOM vs actual, scrap reconciliation, reorder alerts (all as read tools answering in chat
   as sentences or inline tables). **Run agent evals.**
9. **Artifacts, documents, diagrams, exports, printouts, launcher** — port `reference/artifacts/`: the host in the panel
   (page and document kinds, the renderer, diagrams), the builder (`prompts/ARTIFACT_BUILDER.md`, DOCUMENT and PAGE modes,
   structured output, `checkDoc` / `checkArtifact`, 3 repairs), versions/Restore, patch edits, Save, owner Share/Unshare,
   the five printouts, **exports in every format** (PDF, Word, Excel, CSV, PNG, Markdown; server-side, downloader's role),
   the **top-used launcher with More**, rate limits, **hostile, export and truth tests in CI** (`CHROMIUM_PATH`, `pandoc`).
   **Run agent evals §16, §21, §31, §32.** impeccable critique + audit pass.
10. **Hardening** — demo seed + reset, PWA, e2e suite, full agent evals, the production-readiness audit
    (`docs/SAFETY.md` §6: permissions on every tool, error mapping coverage, headers, indexes, unpaginated lists,
    secrets, DNS/WebRTC re-check), impeccable final polish.

---

## 11. Deployment and environment

**Cloud session environment**
- PostgreSQL: if it isn't installed, `apt-get install -y postgresql`. Start it with
  `service postgresql start`, create a `vijaya` database and user, and write `DATABASE_URL` to
  `.env` (gitignored). Run migrations, seed, tests and Playwright against it.
- Playwright: `pnpm exec playwright install --with-deps chromium`. The artifact sandbox and export tests need it (set
  `CHROMIUM_PATH` to it); the Word export also needs `pandoc` (`apt-get install -y pandoc`). If blocked, skip, say so,
  and keep the tests in the repo.
- Agent evals need `ANTHROPIC_API_KEY`; if it isn't set in the session, ask Kasi.

**Railway** (commit as `railway.json`):
- Build: `pnpm install --frozen-lockfile && prisma generate && next build`
- Start: `prisma migrate deploy && pnpm db:seed:if-empty && next start -p $PORT`
  (`db:seed:if-empty` seeds only when there are no users.)
- Health check: `/api/health` — checks the database **and** that every guard trigger exists.
- Volume at `/data` for attachments (`UPLOAD_DIR=/data/uploads`).
- Env vars Kasi sets in the dashboard: `DATABASE_URL` (reference to the Postgres plugin),
  `SESSION_SECRET` (32+ chars), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `AGENT_ENABLED`, `AGENT_DAILY_TOKENS`,
  `DEMO_MODE`, `APP_URL`, `UPLOAD_DIR`, and optionally `SMTP_URL` + `NOTIFY_FROM` for owner emails.
- Railway deploys this session's branch on every push. **After milestone 1**, write
  `docs/DEPLOY.md` and tell Kasi, click by click, what to do in Railway — including the branch
  name. Wait for him to confirm the live URL works before milestone 2. Don't use the Railway CLI.

---

## 12. Working rules

- Ask Kasi when a business rule is missing. Don't invent one; write the question in your
  milestone summary if it can wait.
- Plain words in everything a user sees. The storekeeper is the hardest user to design for; if it
  works for him, it works.
- Money: `Decimal`, never float. Rupees in Indian grouping (₹1,15,791). Quantities always with units.
- Dates: store UTC, display `Asia/Kolkata`. Financial year April–March.
- Keep `docs/BUSINESS_FLOW.md`, `docs/TOOL_CATALOG.md` and `docs/AGENT_PROMPT.md` in sync with the
  code. If you change a tool, change the catalog in the same commit.
- Never loosen the sandbox to make an artifact work. If an artifact needs something the sandbox forbids, the
  answer is a new **read tool**, not a new permission.
- Commit small, with clear messages. Never commit secrets.

---

## 13. Out of scope for v1

Quotations, invoicing, dispatch, accounts/Tally, GST filing, production stages and WIP, finished
goods, QC records, batch/lot traceability, machine productivity, non-job issues, write-offs,
voice input, multiple companies, **fixed screens or a menu of screens, AI-built screens that become part of the
product**. (Letterhead paper — PO, GRN, issue slip, count sheet, job cost sheet — still goes through the five printouts; any
artifact downloads as PDF, Word, Excel, CSV, PNG or Markdown.) The agent says plainly that these aren't
set up yet (`docs/AGENT_PROMPT.md` → Not tracked).

---

## 14. What went wrong before — don't repeat it

| Problem | Consequence | Rule now |
|---|---|---|
| Guards in a hand-applied SQL file, not migrations | A fresh database silently had no ledger protection | Guards in migrations + boot check + test (§3.2) |
| Five services, two databases, gateway + screen server + two agent services + router + translator | Prompts drifted from code; every change touched four places | One app, one database, one agent (§2, §3) |
| Generic `list_rows` tool over any table | Storekeeper could read password hashes, settings, hidden tables | Purpose-built read tools only (§3.1) |
| `register` honoured a caller-supplied role | Anyone could create an owner account | Owner creates users; no self-registration |
| "Confirmed" was a flag the caller set | A screen or agent could write without the user agreeing | PendingAction submitted by the user (§3.3) |
| Agent system prompt was one generic line for weeks | None of the business rules reached the model | `docs/AGENT_PROMPT.md` is loaded and tested by evals |
| POs and receipts created suppliers from free text | Duplicates, GSTIN dropped | Parties created once; pickers only |
| Opening count posted at the zero average | All opening stock valued ₹0 | Opening count carries invoice rates |
| Opening count counted as differences | Leak report would open with 200 false leaks | Excluded from the leak report |
| "Recount needed" went to the owner who rejected it | Storekeeper never told | Notifications have a decided recipient (§6) |
| Dropdowns showed uuids; notifications showed material ids | Unusable for the storekeeper | Read tools return names; test for leaked ids |
| Every action logged as HUMAN | Owner couldn't see what the agent did | actorType + agentRunId + openedFrom (§6) |
| Nothing happened after a form was submitted | No shortage check after BOM | Follow-up engine (§3.4) |
| Leak report counted matching lines as "unexplained" | Inflated the owner's headline number | Only real differences count |
| Leak report had no tool | "Where is my stock leaking?" unanswerable | `get_leak_report` in the catalog |
| No TRUNCATE guard | One statement could wipe the whole ledger | Statement-level TRUNCATE trigger (§7) |
| Generated screens were HTML pages in the product (v1) | Different look every time; one bad generation could break a screen or skip confirmation | **No AI-built screens in the product.** Artifacts are sandboxed, read-only, and open forms rather than write |
| Declarative page specs + a menu of screens (kit v2/v3) | A second UI language to build, review and repair; the owner asked for Claude-style artifacts instead | Dropped: chat + forms + artifacts (this kit) |
| A translation model in front of the agent | Could "correct" names, change numbers | No translation; Claude reads mixed language directly |
