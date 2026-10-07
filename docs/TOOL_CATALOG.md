# Vijaya Stores — Tool Catalog

Every operation the system can perform. Forms, Server Actions, the agent and artifacts all reach
business data **only** through these tools, via `runTool` (prompt §3.1). Artifacts can call **read tools
only** (`vijaya.read`) and can only *open* a write tool's form (`vijaya.openForm`) — never submit it.
The machine-readable slice the artifact checker uses is `reference/artifacts/catalog.ts`; in the app,
generate it from the real registry.

Conventions:
- **R** = read (runs immediately). **W** = write (needs a submitted PendingAction — prompt §3.3).
- **Roles:** `SK` storekeeper, `OW` owner. Every tool declares its roles explicitly.
- Read tools return **names and human numbers**, never internal codes; ids are returned only as
  values for pickers and links, never as labels.
- Every W tool: one transaction, one AuditEvent, errors mapped to `CODE: plain message`.
- *Follow-ups* run after a successful submit: listed read tools, then one or two sentences from
  the model, then offer chips (next form, pre-filled, **never with a rate**). Follow-ups only read;
  a failed follow-up shows nothing extra.
- Error codes listed are the business ones; validation (`INVALID_INPUT`), `FORBIDDEN_ROLE`,
  `NOT_FOUND` apply everywhere.

The exact text the model sees for each tool — its description and every input's description — is
in `prompts/tool-descriptions.json`. The app loads it into `defineTool`; a test keeps it in step
with this file.

Removed from v1 on purpose: `list_rows` (read any table), `register` (self-signup with a chosen
role), `login`/`whoami` as tools (the session handles identity; the agent is told the user's name
and role in its context).

---

## 1. Materials

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `search_materials` | R | SK OW | Find by part of a name (ignore case, spaces, hyphens: "ferrite core e30" → "Ferrite Core E-30"). Returns name, unit, stock type, quantity on hand. Empty query lists all active |
| `get_material_balance` | R | SK OW | Quantity + unit for one or more materials; average rate and value; minimum level and stock type; negative / below-minimum flags |
| `get_movement_history` | R | SK OW | Movements for a material or a job, newest first: type, quantity, rate, job/document number, who, when, from chat, a button or an artifact. Paginated |
| `create_material` | W | SK OW | Name, unit, stock type, minimum (STANDING only, required), HSN, GST, is-scrap |
| `update_material` | W | SK OW | Name, minimum level, HSN, GST. **Not** unit or stock type |
| `deactivate_material` | W | SK OW | Only with zero stock |

**create_material** — errors: `SIMILAR_MATERIAL_EXISTS` (returns the matches; the form offers
"this is a different material", which sets `confirmNotDuplicate`), `MATERIAL_EXISTS`, `MINIMUM_REQUIRED`.
**update_material** — `UNIT_LOCKED` explains why unit/stock type can't change.
**deactivate_material** — `MATERIAL_HAS_STOCK`.

## 2. Suppliers and customers

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `search_parties` | R | SK OW | By name (normalized), GSTIN; filter supplier / customer. Returns name, type, city, GSTIN, phone |
| `create_party` | W | SK OW | Name (no city), type SUPPLIER / CUSTOMER / BOTH, GSTIN, city, state, address, pincode, phone, email |
| `update_party` | W | SK OW | Change details; add a type (never remove) |
| `deactivate_party` | W | SK OW | Not while it has open POs, customer POs or jobs |

**create_party** — same normalized name → `PARTY_EXISTS`; same GSTIN → `PARTY_EXISTS`; existing
business, new type → adds the type (outcome `TYPE_ADDED`); similar name → `SIMILAR_PARTY_EXISTS`
until the user ticks "different business"; bad GSTIN → `INVALID_GSTIN`.
*Follow-ups:* offer "Raise a purchase order to them" (suppliers) / "Record a customer PO" (customers).

## 3. Customer POs, jobs, BOM

*Job cost fields* (`materialCost`, `costPerPiece`) in `list_jobs` / `get_job` are returned **only to the owner** (null for the storekeeper): job cost is an owner-only report (BUSINESS_FLOW).

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `list_jobs` | R | SK OW | Filter by status, customer, customer PO, date. Number, customer, product, qty, status, cost (closed) |
| `get_job` | R | SK OW | Customer, PO, product, qty, status, BOM lines (per piece, total, issued, returned), cost so far |
| `check_job_shortage` | R | SK OW | Per BOM line: needed (still to issue), in stock, short |
| `get_job_bom_variance` | R | SK OW | Planned vs used (issued − returned), difference, %, top-ups marked |
| `create_customer_po` | W | SK OW | Existing customer (picked), PO number, date. Existing (customer, number) → returns it (open-PO release) |
| `create_job` | W | SK OW | Customer, optional customer PO, product description, qty > 0, job date, due date, type PRODUCTION / SAMPLE (+ parent job) |
| `set_job_bom` | W | SK OW | Lines: material + **qty per piece**. Replaces the BOM. Only while status OPEN |
| `cancel_job` | W | SK OW | Only with nothing issued; reason required |

**create_customer_po** — unknown customer → `PARTY_NOT_FOUND` with suggestions; supplier-only
party → `PARTY_WRONG_ROLE`. *Follow-ups:* offer "Create a job for this PO".
**create_job** — SAMPLE without parent → `PARENT_REQUIRED`. *Follow-ups:* offer "Add the BOM".
**set_job_bom** — `JOB_NOT_OPEN` (offer a top-up issue instead), duplicate material →
`DUPLICATE_LINE`. Form shows a live read-only *Total needed* column; the confirmation lists every
line as *name — per piece → total*.
*Follow-ups (must):* run `check_job_shortage`. Short → list each short material with need / have /
short and offer "Raise a PO for the shortfall" (lines pre-filled with the shortfall, **rate
empty**). Nothing short → offer "Issue material now".

## 4. Purchasing

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `list_purchase_orders` | R | SK OW | Filter by status, supplier, material, date |
| `get_purchase_order` | R | SK OW | Lines with ordered / received, status, approvals, receipts |
| `get_purchase_price_history` | R | SK OW | Receipt rates per material, per supplier, by date; previous-rate comparison; observed lead time (PO date → receipt) |
| `create_purchase_order` | W | SK OW | Supplier (picked), lines (material, qty, **rate typed by the user**, HSN, GST), expected date, triggering job |
| `cancel_purchase_order` | W | SK OW | Only DRAFT / PENDING_APPROVAL / APPROVED with nothing received |
| `approve_purchase_order` | W | **OW** | PENDING_APPROVAL → APPROVED |
| `reject_purchase_order` | W | **OW** | PENDING_APPROVAL → REJECTED, reason required |

**create_purchase_order** — `PARTY_NOT_FOUND`, `PARTY_WRONG_ROLE`, `RATE_REQUIRED`, `EMPTY_PO`.
Reads the approval limit server-side; if the setting can't be read → **error**, never a default.
*Follow-ups (must):* PENDING_APPROVAL → "Waiting for the owner; you'll be told." Notify owner.
APPROVED → "Approved; can be sent to the supplier."
**approve / reject** — `NOT_PENDING`. Confirmation shows supplier, lines, total, triggering job.
*Follow-ups (must):* notify the storekeeper (approved, or rejected with the reason).

There is no PO line editing after approval. Changes = cancel and raise again.

## 5. Goods receipt

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `list_goods_receipts` | R | SK OW | By supplier, PO, material, date |
| `record_goods_receipt` | W | SK OW | Supplier (picked), optional PO, date, supplier invoice no. + date, DC no.; lines: material, PO line, received / accepted / rejected, rejection reason, rate, HSN, GST |

**record_goods_receipt** — `GRN_SPLIT_MISMATCH`, `REJECTION_REASON_REQUIRED`, `RATE_REQUIRED`,
`PO_NOT_APPROVED` (agent asks before opening the form; the form shows a warning and needs an extra
tick). Posts RECEIPT (accepted) and REJECT_RETURN (rejected); updates PO received quantities and
status. Form pre-fills from the PO: material and quantity still due. The PO rate is shown as a hint
beside the empty rate field — **never filled in**; the rate comes from the supplier's invoice.
*Follow-ups (must):* compare each rate with the previous receipt of that material — over 5% →
say it and notify the owner. Rejections → say what goes back. If the PO's job now has no
shortfall → offer "Issue material to JOB-…".

## 6. Issue, return, close

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `issue_material` | W | SK OW | Job; no lines = everything the BOM still needs; explicit lines for partial or **top-up** (marked) |
| `return_material` | W | SK OW | Job, lines: material + qty. Rate = current average, never entered |
| `close_job` | W | SK OW | Fixes material cost = issued − returned value |

**issue_material** — `JOB_REQUIRED`, `JOB_NOT_ISSUABLE` (closed/cancelled), `NOTHING_TO_ISSUE`
(already fully issued — never double-issues). Negative stock is allowed.
*Follow-ups (must):* any balance now negative → one sentence, notify owner. Any STANDING material
now below minimum → say it, notify owner and storekeeper, offer "Raise a PO for …" (qty = minimum −
balance, rate empty).
**return_material** — `NOT_ISSUED_TO_JOB`, `RETURN_EXCEEDS_ISSUE`.
*Follow-ups:* offer "Close JOB-…".
**close_job** — `JOB_ALREADY_CLOSED`. If anything was issued and nothing returned, the form asks
"Did any material come back?" with a required answer (the agent asks this in chat before opening).
*Follow-ups (must):* owner: state cost and cost per piece; storekeeper: say the job is closed (job cost is owner-only); any material > 5% over BOM → list it and notify
the owner.

## 7. Scrap

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `record_scrap_in` | W | SK OW | Scrap material, qty, optional job |
| `record_scrap_sale` | W | SK OW | Scrap material, buyer (customer, picked), qty, rate, invoice no., date |
| `get_scrap_summary` | R | OW | Per scrap material, for a period: collected, sold, on hand, sale value; by job where known |

**record_scrap_in** — `NOT_SCRAP_MATERIAL`. **record_scrap_sale** — selling more than on hand is
allowed and flagged. *Follow-ups:* scrap left in stock; flag over-sale.

## 8. Stock counts

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `list_counts` | R | SK OW | Counts with status, type (opening / normal), date, progress |
| `list_count_lines` | R | SK OW | A count's lines by material name: system quantity (frozen at start), counted, difference, reason, rate, invoice, what's still missing. Defaults to the count in progress |
| `start_stock_count` | W | SK OW | Date, opening yes/no, optional subset of materials. Freezes system quantities |
| `submit_count_line` | W | SK OW | One line: counted qty (optional if only adding a rate), reason (normal counts), rate + invoice no. + date (opening only) |
| `save_count_sheet` | W | SK OW | Many lines at once, from the count sheet form (expanded in the panel). Same rules as `submit_count_line`, one transaction |
| `submit_stock_count` | W | SK OW | Send to the owner. Also resends a sent-back count |
| `approve_stock_count` | W | **OW** | Normal: COUNT_ADJUSTMENT per difference at current average. Opening: OPENING per material with stock at its rate |
| `reject_stock_count` | W | **OW** | Send back with a note |
| `get_leak_report` | R | OW | `v_material_leak` (opening excluded), filter by period/material, ranked by value |

Rules (full detail in BUSINESS_FLOW §11):
- **Counts show the system quantity** (the owner chose that): `list_count_lines` returns
  `systemQty` (frozen when the count started), `countedQty` and `difference` to both roles, and the
  count sheet and the printed count sheet show the System column. Differences are checked by the
  owner on approval and over time by the leak report.
- **start** — opening: `OPENING_IN_PROGRESS`, `OPENING_ALREADY_DONE`, `OPENING_NOT_FIRST` (stock
  already recorded).
- **submit_count_line / save_count_sheet** — editable when the count is DRAFT or sent back;
  otherwise `COUNT_LOCKED` ("with the owner" / "already approved"). Rate fields on a normal count
  → `RATE_NOT_ALLOWED`. Opening: reason always null. Normal: difference with no reason →
  UNEXPLAINED; the agent never re-asks. Rate must be > 0.
- **submit_stock_count** — `COUNT_INCOMPLETE` naming uncounted materials, or (opening) materials
  with stock but no rate.
- **approve** — `NOT_PENDING`; opening with stock recorded since it started → `OPENING_NOT_FIRST`.
  Status flips to APPROVED **before** movements are inserted, in the same transaction (the guard
  trigger checks it).

*Follow-ups:*
- `start_stock_count` → offer "Open the count sheet". Opening: explain quantity + rate from the
  last invoice, invoice number optional, can take several days.
- `submit_stock_count` → normal: number of differences and rupee value; opening: number of
  materials and **total value**. Stock unchanged until approval. Notify owner.
- `approve_stock_count` (must) → notify storekeeper; normal: offer "See the leak report";
  opening: "Opening stock is in at invoice rates. The system is live."
- `reject_stock_count` (must) → notify the **storekeeper** with the note.

## 9. Corrections

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `reverse_movement` | W | **OW** | Opposite movement, reason required. Confirmation shows material, qty, job, original date, balance after |

`ALREADY_REVERSED`; reversing an OPENING or COUNT_ADJUSTMENT → `NOT_REVERSIBLE` (counts are
corrected by a later count). *Follow-ups:* new balance; notify the storekeeper.

## 10. Approvals, notifications, reports

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `list_pending_approvals` | R | OW | POs and counts waiting, with the summary needed to decide |
| `list_notifications` | R | SK OW | Own notifications only, unread first |
| `mark_notifications_read` | W | SK OW | Own only. **UI action only** (a Server Action when the person opens their notifications); the agent is never offered it, so "the agent never writes" has no exception |
| `list_reorder_alerts` | R | SK OW | STANDING materials below minimum (`v_reorder_alerts`) |
| `get_stock_value` | R | OW | Total and per material / category of stock value |
| `estimate_job_cost` | R | OW | What-if: open jobs' material cost now vs. if one material's rate changed (`materialNames`, `newRate`). Same costing as the report; nothing is saved |
| `get_job_cost_report` | R | OW | `v_job_material_cost` for a period: per job cost, per piece, issued vs returned |
| `get_activity` | R | OW | Audit events: who, what, when, from chat (agent), a button or an artifact. Filter by user, tool, date |

## 11. Settings and users

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `list_settings` | R | SK OW | Owner: all settings. Storekeeper: the approval limit only (the PO form shows it anyway) |
| `update_setting` | W | **OW** | Known keys only, validated by type |
| `list_users` | R | OW | Name, role, active |
| `create_user` | W | **OW** | Name, email or username, role, initial password |
| `reset_user_password` | W | **OW** | A new password for someone who forgot theirs (min 10 characters). The owner types it in the form |
| `deactivate_user` | W | **OW** | Never the last active owner |

Tools that need a setting read it server-side; they never take it from the caller.

## A. Artifact, printout and download tools (see `docs/ARTIFACTS.md`)

These are **app tools**: they store and open artifacts; they are not business data. An artifact reads
business data only through the R tools above, **as the viewer**, via `vijaya.read` → `runTool`.

| Tool | Kind | Roles | Purpose |
|---|---|---|---|
| `list_artifacts` | — | SK OW | The user's saved and recent artifacts, and (storekeeper) those shared with him, by words in the title. Use before building a new one |
| `open_artifact` | — | SK OW | Open a saved, recent or shared artifact in the panel (re-runs it with live data) |
| `make_artifact` | — | SK OW | Build an artifact from a plain-words request. Input `request` and optional `kind` (`page` \| `document`; left out, the builder picks: reports, memos, SOPs, diagrams, explainers → `document`; interactive what-if or filters → `page`). Only when the person asked for a report, memo, SOP, diagram, chart, dashboard, comparison, what-if or long list. The builder returns `kind`, `title` and `source` (page HTML or VDoc text); runs `checkArtifact` or `checkDoc` (3 repairs). Opens the result |
| `edit_artifact` | — | SK OW (own artifacts) | Change an artifact (page or document) via validated patches whose `old` text must match exactly once in the current `source`; new version, live at once, same kind. Shared copies are unchanged |
| `open_printout` | — | SK OW (`job-cost-sheet`: OW) | Open a printout: `purchase-order`, `goods-receipt-note`, `issue-slip`, `count-sheet`, `job-cost-sheet`. Fixed templates; the model never writes them |
| `share_artifact` | W | **OW** | Share one frozen version with the storekeeper. Form shows the title, the version and who gets it. **Refused** if the artifact uses an owner-only tool |
| `unshare_artifact` | W | **OW** | Stop sharing; it disappears from the storekeeper's Saved |
| `download_data` | — | SK OW | A file of a table or of an artifact. Formats: for a `document` artifact **pdf, docx, xlsx, csv, png, md**; for a `page` **pdf, png, xlsx, csv**; for a table in the chat xlsx or csv. Made on the server; re-reads the data with the **downloader's** role (a storekeeper cannot download owner data). Offered as a button (Download ▾); the agent offers the format the person names |

Save (★), Delete (archive) and Restore-version are **UI actions** by the person (Server Actions on their
own artifacts, audited), not agent tools.

`make_artifact` / `edit_artifact` return the checker's codes (`TOOL_NOT_ALLOWED`, `RATE_IN_OPENFORM`,
`LITERAL_NUMBER`, `PATCH_NO_MATCH`, …) only after the builder's 3 repair tries; they then return plain words
for the agent to relay and an inline table as the fallback. Forms opened from an artifact are ordinary
PendingActions (origin ARTIFACT, `sanitizePrefill` applied), audited with `openedFrom: artifact` and the
artifact id + version. `open_printout` and `download_data` are audited (who, artifact and version, format).

`download_data` fails with plain words, never a stack trace: a format the kind doesn't have ("A page can't be downloaded
as Word"), no table for xlsx/csv, a picture over 16,000 px ("too long for one picture — PDF?"), or an export where the
sandbox saw a network attempt (blocked, nothing returned). See ARTIFACTS §10.

## B. Launcher buttons (no model involved)

The buttons above the chat input (INTERFACE §3, `reference/artifacts/launcher.ts`) create a PendingAction for
`record_goods_receipt`, `issue_material`, `return_material`, `start_stock_count`, `create_purchase_order`,
`create_job` with **no prefill** (origin LAUNCHER). They work when the assistant is off. Which of them are visible
(top 4, the rest behind More) is the person's own use, counted from the `AuditEvent` rows with `openedFrom: LAUNCHER`,
after the role filter.
