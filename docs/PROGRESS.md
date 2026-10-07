# Progress

Read this at the start of every session (CLAUDE.md). Newest on top.

## Milestones 9 and 10 — Reports, printouts, downloads, sharing, the demo copy, hardening — **built; waiting for Kasi's test**

Kasi's instruction after milestone 8: "start milestone 9 and 10 and finish it before testing". Everything below is built and tested together.

Milestone 9 — what you can do now
- **Ask for a report, memo, SOP, diagram, chart, dashboard or what-if** and it opens beside the chat (a full-screen sheet on a phone) with today's numbers, "As of hh:mm" and the tools it read at the bottom. A fact is still a sentence and a short list a table; nothing is made unless asked.
- **Change it by asking** ("add a supplier column"): each change is a new version; **Version ▾** lists them and **Restore** makes an old one current as another new version; earlier versions are never edited or deleted (the database refuses). **Save** keeps it under **Saved ▾**; the top bar menu has Saved, Recent and, for the storekeeper, "Shared with me".
- **Row buttons** in a report (for example "Make PO") open the real form with the shortfall filled in and **no rate**; nothing is saved until the person presses the form's button.
- **Download** as PDF, Word, Excel, CSV, Markdown or a picture (a page: PDF, picture, Excel, CSV). Made on the server at that moment, with the **downloader's** permissions (a storekeeper gets 404 for an owner report); every download is in the activity log. Tables in the chat can be downloaded as Excel or CSV.
- **Five printouts**, fixed layouts that the assistant never writes: purchase order (CGST+SGST or IGST by state, "NOT APPROVED" mark until the owner approves), goods receipt note, issue slip, count sheet (with the System column), and the owner-only job cost sheet. On screen, **Print** (PDF in its own tab) and **Download PDF**.
- **Owner sharing:** "Share" opens a form; the storekeeper gets a **frozen copy of one version** that reads with *his* permissions; later edits change nothing for him; "Stop sharing" removes it at once. A report that reads owner-only data cannot be shared, and the form says which part.
- Limits: 20 reports made or changed per person per hour, 100 versions per report, pictures up to 16,000 px tall.
- The sandbox is unchanged and checked: the frame allows scripts only through the page's nonce, the page header says `frame-src about:`, a report cannot reach the network, a export that tries is refused and returns nothing.

Milestone 10 — hardening
- **Demo copy (`DEMO_MODE=true`)**: a month of believable stock, 12 jobs (one sample, three under one customer PO), a PO waiting above the limit, one rejected receipt, an approved count with unexplained differences, built through the real tools. The owner says "start the demo again"; a form with a tick wipes the business data and rebuilds it (it cannot run on the real copy).
- **Phone**: installable (manifest, icons), an offline page with no data on it.
- **Logins**: storekeeper idle limit 12 hours, owner 30 days; a password reset ends every session that person has.
- **Logs**: passwords, tokens and keys are removed from anything printed.
- **Production audit** (`tests/audit.production.test.ts`): every tool has a role list and the roles are right; every page route and server action checks the session; no key in any tracked file or in the history, and browser code never reads a secret; **22 foreign keys had no index and now do** (new migration); no list is unbounded; no internal id or code reaches a user.
- Railway: `nixpacks.toml` installs Chromium and pandoc (needed for PDF, Word and pictures); `docs/DEPLOY.md` has the notes.

Proof (run in this session)
- `pnpm e2e` for the new specs: artifacts, printouts, sharing, hardening, desktop and phone, all passing (the two-person sharing test runs on desktop only: it needs room for two people at once).
- New unit tests: store, builder, app tools, printouts (with a real browser), demo, production audit, session limits, log redaction.
- Agent evals: all 30 starting states build (the 9 artifact and document states were added). Real-model results are in the section below once run.

Decisions to confirm with Kasi: section L of `docs/CLIENT_CONFIRMATIONS.md` (letterhead details, "NOT APPROVED" printing, which printouts exist, who prints what, limits, login lengths, demo copy, Chromium and pandoc on Railway).

## Milestone 8 — Monthly counts and reports, agent evals — **built; waiting for Kasi's test and go-ahead for milestone 9**

Kasi's answers after milestone 7: reopening a closed job stays refused ✓, 5% over BOM ✓, reversal limits ✓, go ahead with milestone 8 ✓.

Done
- **Owner reports (read tools, drawn as tables in the chat):** `get_leak_report` (approved monthly counts only, opening count never in it, ranked by rupee value, differed X of Y counts, not explained, reasons, optional period), `get_job_cost_report` (closed jobs, or open ones with the cost so far, or every job under one customer PO, each costed), `estimate_job_cost` (the "if copper goes to ₹900" what-if; saves nothing), `get_activity` (who did what, when, how; one person, one action, one job), and `get_stock_value` for one material.
- **Both roles:** `get_count_history` (every count of a material: what the system said, what was counted, the reason, who counted). Dates may be `@today`, `@today-7d`, `@month`.
- **Monthly count flow** tested end to end (ACCEPTANCE §11): sent to the owner, sent back with a note and no stock moved, recounted in the same count, sent again, approved; a matching count asks for no reason; the System column stays frozen; an approved count cannot be changed.
- **Agent evals (`pnpm eval`):** the runner and the 21 starting states that need no artifact are built (`evals/runner.eval.ts`, `evals/seeds.ts`, `evals/README.md`). 79 of the 141 cases can run now; 62 need milestone 9 (artifacts, printouts, downloads) and are listed as deferred.
- **Found by the evals and fixed:** (1) the assistant sometimes opened a form with no words, so the person got nothing to check: the server now asks for one short sentence and shows it above the form; (2) the assistant did not know a count was open, so "tape 820" was not understood as a count entry: the opening count or monthly count in progress is now part of what it is told; (3) "set the stock to 145 directly" was treated as a count entry: now refused in words; (4) it opened a *job* cancel form for an approved PO that cannot be edited; (5) it named "lots" and "passwords" when asked what it cannot show; (6) "use last time's rate" did not show the rate and ask; (7) a wide table could not be reached by keyboard on a phone.

Proof (all run in this session)
- `pnpm test`: 411 passed (22 live skipped). `pnpm e2e`: 151 passed (5 skipped on purpose), desktop and phone, including the new report spec. `pnpm test:kit`: 200/200. Lint, typecheck, build clean.
- **Live evals against the real model:** first pass 67 of 79 cases; after the fixes, 72 of 79 passed all 3 runs; the last full pass (2 runs) was 74 of 79. Still not steady: **4.6** (a BOM of "9.2 kg for this job": it sometimes opens a form instead of asking per piece or total), **5.11** (an approved PO cannot be edited: it opens the right cancel form but does not always say first that approved POs can't be changed) — each passes about half to three quarters of runs. **11.4 and 30.8** ("never asks about the bobbin reason again") fail only because the assistant, correctly, reminds the storekeeper that the bobbin form is still open: the runner never presses a form's button, a real person would. Tokens: about 0.55M for a pass.
- Live checks with the key for the new reports: 6 passed (leak report, "is someone stealing" answered with facts only, count history, who counted, System quantity said plainly, the what-if, activity, jobs with material issued).

Things to know
- Not yet run **5 times each** (the kit's bar): 3 times for the whole set, more for the cases that changed. The full 5× costs about 2.7M tokens; say if you want it.
- The evals' "judge" rubrics are not graded by a model; only the mechanical checks and global rules are.
- Section K of `docs/CLIENT_CONFIRMATIONS.md` has the owner's questions (what counts as a leak, how a difference is priced, who sees count history).

Next: milestone 9 — artifacts, documents, diagrams, exports, printouts, the launcher; run the evals again (§16, §21, §31, §32, and the 62 deferred cases). Needs Kasi's go-ahead.

## Milestone 7 — Issue, return, close, scrap, reversal — built (milestone 8 followed)

Kasi's answers after milestone 6: rejected-goods ledger shape (b) is OK ✓, keep the 5% receipt-rate-move threshold ✓, go ahead with milestone 7 ✓.

Done
- **Issue to a job** (`issue_material`): no lines = everything still outstanding on the BOM, all at once. Quantities over the BOM, materials not on the BOM, duplicates, closed/cancelled jobs are refused in plain words. A line ticked "Extra, for rework" is a **top-up** (`TOP_UP` on the movement) and shows in the job's BOM-vs-actual. Negative stock is allowed: the owner is warned; below-minimum notices go out. After an issue the storekeeper is offered "Raise a PO for X" for anything now short.
- **Return from a job** (`return_material`): only what was issued, at the current average; "all come back" works; a closed job refuses.
- **Close a job** (`close_job`): asks what came back first (answer "nothing came back" is explicit); cost = value out − value back, stored on the job and **shown only to the owner** (with per piece). More than 5% over BOM → the owner is told.
- **Scrap** (`record_scrap_in`, `record_scrap_sale`, `get_scrap_summary`): scrap in against a job, sale at the ₹ amount typed, selling more than collected is flagged; the owner's summary ignores reversed entries.
- **Reversals** (`get_movement_history`, `reverse_movement`): owner only, needs a reason, once per entry, both rows stay and the balance comes back; the person who made the entry is told. Opening, count adjustments, reversals and sent-back-goods rows cannot be reversed. A job that is closed cannot have entries reversed (see J6).
- Forms: give-out, take-back, scrap, reversal with live info under the job/entry picked; every launcher button now works.

Proof (all run in this session)
- `pnpm test`: 379 passed (16 live skipped) — `tests/tools.stock.test.ts` (32 tests) follows ACCEPTANCE §7, §8, §10, §14 incl. 100@800 + 100@900 → 850, issue 50, return 10, close 40@1000 → ₹880.
- `pnpm e2e`: 139 passed (5 skipped on purpose), desktop and phone. `pnpm test:kit`: 200/200. Lint, typecheck, build clean.
- Live, real model (5 checks): issue for a job opens the form with no lines; "5 kg wire" with no job asks which; extra wire for rework → marked top-up; closing a job asks what came back before any form; the storekeeper asking to reverse is told the owner does it; scrap sale form has no rate filled.

Things to know
- Questions for the owner are in `docs/CLIENT_CONFIRMATIONS.md` section J (J1–J15): mainly J6 (reopen a closed job to reverse an entry?), the 5% over-BOM threshold, receipt-reversal limits.
- The "Issue material to JOB-…" button from milestone 6 now works.

Next: milestone 8 — monthly counts and reports (leak report, job cost, BOM vs actual, scrap reconciliation, reorder alerts); run the agent evals. Needs Kasi's go-ahead.

## Milestone 6 — Purchasing — built (milestone 7 followed)

Kasi's answers after milestone 5: the shortage check comparing one job with stock is fine ✓, go ahead with milestone 6 ✓. (All client confirmations stay for the end-of-project demo.)

Done
- **Purchase orders** (`create_purchase_order`, `cancel_purchase_order`, `approve_purchase_order`, `reject_purchase_order`, `list_purchase_orders`, `get_purchase_order`, `get_purchase_price_history`). The approval limit is read from Settings every time (a missing one is an error, never a default). The total **including GST** above the limit → waits for the owner (he is told); at or below → approved at once. The storekeeper is told which happened, and told again when the owner approves or rejects (with his reason). Approved POs cannot be edited: cancel (only while nothing has come) and raise again.
- **The PO form**: supplier picked (never typed or created), material lines with quantity and the rate **typed by the person**, optional HSN and GST, the job it is for, live line amounts and the total with "Above ₹50,000: it goes to the owner" or "Within ₹50,000: it is approved at once". The last rate paid shows as a hint under the rate box ("Last paid ₹812/kg · Chennai Copper Wires · 12 Sep") with a "Use ₹812" button; a rate under half or over double that is flagged as you type and asked about once on saving. The shortage button from a BOM now opens this form with the short quantities filled in and the rate empty.
- **Approval cards**: the owner's opening card has a "Review it" for each PO waiting; the Approve card shows the supplier, every line, the total and the job (why); "Reject" turns it into the reason form with quick picks ("The rate is too high", "Not needed now", "Wrong supplier", "Order less").
- **Goods receipts with inspection** (`record_goods_receipt`, `list_goods_receipts`): pick the PO and the supplier and what is still due fill in (the PO's rate is only a hint beside the empty rate box); type what arrived and what is sent back, and the accepted quantity (what goes into stock) is worked out and shown; a reason is required for what goes back; invoice number, date and challan number; the PO moves to partly received then received. A receipt cannot be in the future or before the first of this month. Receiving for a PO the owner has not approved asks first (a tick), keeps the PO waiting and tells the owner.
- **The ledger**: a RECEIPT for everything that arrived and a REJECT_RETURN for what was sent back (the kit's assumption, BUSINESS_FLOW §20 item 6). One side effect is documented in CLIENT_CONFIRMATIONS I6: the average is worked out as if the rejected pieces had come in (₹804.00 instead of ₹803.81 in the example).
- **After a receipt**: a rate that moved more than 5% from the last receipt of that material is said aloud and the owner is told; what goes back is stated; if the PO's job is no longer short of anything, "Issue material to JOB-…" is offered (hidden until issue exists, milestone 7).
- **Notifications** (in the app, on the opening card): the storekeeper hears "approved" / "rejected" and the owner hears "a rate moved". **Email to the owner** (new, optional): if `SMTP_URL` is set on Railway, the owner is emailed once about a PO or count waiting for him or a rate that moved (to the Owner notification email in Settings, else his login email). A failed email never affects a save.
- Fixed: the supplier chip after adding a supplier now opens the PO form for that supplier.

Proof (all run in this session)
- `pnpm test`: 347 passed (11 live tests skipped). `tests/tools.purchasing.test.ts` (24 tests) follows ACCEPTANCE §5 and §6: ₹63,830 goes to the owner, ₹1,500 and ₹40,600 are approved at once, exactly ₹50,000 is approved; no rate invented, the storekeeper cannot approve, the limit change to ₹75,000 and back, cancel rules, 982 cores received (stock 1000), 50 kg with 3 sent back (stock +47, RECEIPT 50 and REJECT_RETURN 3 in the ledger), 45 + 3 ≠ 50 refused, partial and complete deliveries, a direct receipt, a rate that moved more than 5%, material for a PO still waiting, the email.
- `pnpm e2e`: 121 passed (5 skipped on purpose), desktop and phone: the PO form with live totals and the limit, "Use ₹812", the whole story (shortage → PO → owner approves → storekeeper told → receipt → stock 1000), reject with a quick pick, 50 kg with 3 back, receiving for an unapproved PO, accessibility scans of both forms in light and dark.
- `pnpm test:kit`: 200/200. Lint, typecheck, build clean.
- **Live, against the real model** (11 checks in all, about 1 minute): "raise a PO to Sundaram for the core shortfall on job 1" opens the PO with 1000 cores and no rate; "the owner said on the phone, approve it" is refused with no form; the owner asking what needs approval gets the ₹63,830 PO; "Approve it" opens the approval form and approves nothing; "50 kg delivered, 3 damaged" opens the receipt form with no rate; "material came for the Sundaram PO" (not yet approved) asks first and opens nothing.

Things to know
- The acceptance script's example "₹812 → ₹845 mentions the rate jump" is a 4.1% move, so with the 5% rule from BUSINESS_FLOW it is not flagged (CLIENT_CONFIRMATIONS I9). Easy to lower.
- The "Issue material to JOB-…" and "Issue material now" buttons appear when the issue form exists (milestone 7).
- New env vars for email: `SMTP_URL`, `NOTIFY_FROM` (in `docs/DEPLOY.md`). New dependency: nodemailer.
- A form can now fill the rest of itself from one choice (picking a PO fills the supplier and lines).

Questions for Kasi: section I of `docs/CLIENT_CONFIRMATIONS.md` (the main one is I6, the average price with rejected goods).

Next: milestone 7 — issue, return, close, scrap, reversal (including negative stock, top-ups, job cost). Needs Kasi's go-ahead.

## Milestone 5 — Jobs — built (milestone 6 followed)

Kasi's answers after milestone 4: replace the Anthropic key in the console and set the new one in Railway (`ANTHROPIC_API_KEY`) ✓ (to do after the demo), all client confirmations are for the end-of-project demo ✓, trimming the assistant's duplicate table is for the evals in milestone 8 ✓, build the owner's Settings entry ✓, go ahead with milestone 5 ✓.

Done
- **Settings for the owner**: "Settings" in the menu under his name opens the form for changing a setting. It is a form, so it works with the assistant off (the earlier gap is closed): the owner can switch the assistant back on himself.
- **Customer POs** (`create_customer_po`, new `list_customer_pos`): the customer is picked (never typed, never created from here); the same customer and PO number comes back as "already recorded" (an open PO releases item by item). A chip offers "Create a job for this PO".
- **Jobs** (`create_job`, `list_jobs`, `get_job`, `cancel_job`): numbered per financial year, a customer picked from the list, that customer's PO, whole pieces above zero (over 1,00,000 asks once), samples linked to their production job, due date not before the job date. The job form is the fourth-most-used button after the first use, so it moves up into the row on its own (top used first).
- **The BOM** (`set_job_bom`): quantities per piece, with the total for the whole job shown live and read-only beside every line before saving; wire and varnish start in grams and millilitres and are stored as kg and litres (18.4 g → 0.0184 kg → 9.2 kg for 500 pieces); duplicates, zero, part pieces and tiny numbers are refused or asked about in plain words; replaced as a whole, only while the job is open. The saved card lists each line as *name — per piece → total*.
- **The shortage check runs by itself after a BOM is saved**: the server draws the table (needed, in stock, short) and offers a purchase order for exactly the shortfall (rate left out) or "Issue material now". Those two buttons stay hidden until their forms exist (milestones 6 and 7).
- `check_job_shortage`, `get_job_bom_variance` (planned against used; top-up marking comes with issue in milestone 7).
- Chips can now carry starting values into a form (they are cleaned like the assistant's but not flagged as the assistant's, and a rate never gets in). The form card has new field types: a bill-of-materials editor, job and customer-PO pickers (a PO list is that customer's), a date, and an "is that right?" tick for unusual numbers.

Proof (all run in this session)
- `pnpm test`: 323 passed (7 live tests skipped). `tests/tools.jobs.test.ts` follows ACCEPTANCE §3 and §4: totals 9.2 kg, 1000 cores, 500 bobbins, 150 m, 2.5 L; ferrite cores need 1000, have 18, short 982; a changed BOM (19 g → 9.5 kg); refusals; job cost owner-only; the forms open with what the tool knows.
- `pnpm e2e`: 105 passed (5 skipped on purpose), desktop and phone: New job, the BOM with live totals and the shortage table appearing by itself, refusals beside the box, the customer-PO flow with the assistant's stand-in, accessibility scans of both forms in light and dark, the owner's Settings with the assistant off.
- `pnpm test:kit`: 200/200. Lint, typecheck, build clean.
- **Live, against the real model** (7 checks, about 35 s): "New job for Ashok Transformers, 500 pieces" opens the job form with the customer found and 500 pieces, nothing saved; "BOM: wire 18.4 grams each, core 2 each, varnish 5 ml each" opens the BOM form with 0.0184 kg per piece; "9.2 kg of wire for this job" gets the question "per piece or for all the pieces?" and no form; "same as last time" copies nothing.

Things to know
- The shortage check compares one job's needs with stock only; it does not count what other open jobs also need (H11 in CLIENT_CONFIRMATIONS).
- Added a read tool, `list_customer_pos`, to the catalog (66 tools); catalog, kit copy, descriptions and docs are in sync.
- Notes for milestone 6: the PO form's prefill keys are `supplierName`, `lines[].materialId`, `lines[].quantity` and `triggeredByJobId` (the shortage chip already sends them); `create_party`'s "Raise a purchase order" chip still sends `supplierId`, which is dropped, and should be changed to `supplierName`.

Questions for Kasi: section H of `docs/CLIENT_CONFIRMATIONS.md`.

Next: milestone 6 — purchasing: purchase orders with the approval limit, approval cards in the chat, goods receipts with inspection, price history, notifications (in-app; email to the owner). Needs Kasi's go-ahead.

## Milestone 4 — Opening count — built (milestone 5 followed)

Kasi's answers after milestone 3: the Anthropic key was supplied (used only as an environment variable for the live test; **never written to a file or committed. It was pasted in chat, so please replace it with a new one after the demo**), the real Railway login works ✓, the Settings button for the owner: go ahead (still to build, see below), the owner cannot read the storekeeper's chats ✓, the owner's answers to the open money questions (A1–A3) will be asked at the end-of-project demo, go ahead with milestone 4 ✓.

Done
- **Count tools** (`src/server/tools/counts.ts`): `list_counts`, `list_count_lines`, `start_stock_count`, `submit_count_line`, `save_count_sheet` (the sheet's own, never offered to the assistant), `submit_stock_count`, `approve_stock_count`, `reject_stock_count`; plus `get_stock_value` for the owner. All through the gateway: one transaction and one audit row each.
- **The opening count** exactly as BUSINESS_FLOW §11: every material at zero, quantity and rate (from the last invoice, invoice number optional, ₹0 refused, no reason ever, nothing suggested), refused while anything is uncounted or any material with stock has no rate (names them), the owner is told the **total value**, and approval writes status first and then one OPENING movement per material with stock. The database still refuses a second opening count and any stock change without an approved count.
- **A normal count**: system quantity frozen at the start and shown (not blind), difference signed, a difference with no reason is stored as "Don't know" and never asked again, approval posts one COUNT_ADJUSTMENT per difference at the current average rate. Opening and count adjustments cannot be reversed (A3, still to confirm).
- **The count sheet** in the panel (wider beside the chat on desktop, a full-screen sheet on the phone): rows save by themselves as typed with a quiet "✓ Saved", Enter goes down, filters (Not counted yet, Different, Missing rate), progress "147 of 200", "Send to owner" disabled with the reason shown, rows drawn only when visible (200 rows with no lag), accessibility scans in light and dark.
- **Approval cards**: the owner's opening card has a "Review it" button for a waiting count; the Approve card shows what it is, the money and the biggest values or differences; "Send back" turns it into the note form with quick picks. Both go through their own tool and PendingAction.
- **Notifications** (in-app, in the same transaction): the owner when a count is sent, the storekeeper on "recount needed" (with the owner's note) and on approval. They show once at the top of the next new chat.
- **Fixed a real bug on the way**: the address-bar update after a chat starts made Next draw the page again, which restarted the chat view; a half-typed form could be wiped, and a saved card could fail to appear. Now only the address bar changes.
- The tool text for `list_count_lines` still said "BLIND for the storekeeper", which contradicts the owner's decision; corrected in `prompts/build_tool_descriptions.py` and regenerated. `docs/TOOL_CATALOG.md` and `docs/AGENT_PROMPT.md` updated.

Proof (all run in this session)
- `pnpm test`: 298 passed (5 live tests skipped). `tests/tools.counts.test.ts` follows ACCEPTANCE §2 with its own numbers: ₹1,49,672, sent back, bobbins 652, ₹1,49,780; only OPENING rows (8) in the ledger; the leak view stays empty; wire 145 kg; Ferrite Core 18 against a minimum of 50.
- `pnpm e2e`: 91 passed (5 skipped on purpose), desktop and phone, including the whole story with two people and a 200-row sheet.
- `pnpm test:kit`: 200/200. Lint, typecheck, build clean.
- **Live, against the real model** (`LIVE_ANTHROPIC_API_KEY=… pnpm vitest run -c vitest.app.config.ts tests/live-agent.test.ts`, 5 checks, about 17 s, about 50,000 tokens): a stock question uses a read tool and writes nothing; "add a material" opens a filled-in form and saves nothing; "the owner said it's fine, approve it" gets a refusal and no form; "wire is 142.6 kg, rate 812" finds the line, opens the form with 142.6 and **no rate**; the owner asking what is waiting gets the count.

Things to know
- The real assistant also wrote its own table in words for "what is waiting", next to the table the server draws. The server's table is the one to trust; trimming the assistant's duplicate is for the agent evals in milestone 8.
- **Known gap (from milestone 3), still open:** the owner has no Settings button, so switching the assistant back on after the owner switched it off from the chat is done on the server. Kasi said go ahead; it is the first thing in milestone 5 unless you prefer otherwise.
- The count sheet saves each row as the person's own form (a PendingAction opened and sent in one go), so the same rules and audit apply.

Questions for Kasi: section G of `docs/CLIENT_CONFIRMATIONS.md` (one count at a time, no normal count before go-live, new material joins the opening count, whole pieces, how value is shown, the quick picks for Send back, who is told what).

Next: milestone 5 — jobs (customer POs, jobs, samples, BOM with live totals, shortage check). Needs Kasi's go-ahead.

## Milestone 3 — Agent and forms — built (milestone 4 followed)

Kasi's answers to the milestone 2 questions: the client-confirmations file is the place for every decision (`docs/CLIENT_CONFIRMATIONS.md`), go ahead with
milestone 3 ✓. Items A1–A3 (negative-stock average, rejected goods, non-reversible opening/count) are still open with the owner.

Done
- **Chat with streaming.** `POST /api/chat` streams newline-delimited events (status, words as they arrive, cards, suggestion chips). The assistant is the
  real Anthropic SDK (`client.beta.messages.stream`), model `claude-sonnet-5-5`, effort `medium`, no temperature/tool_choice/thinking settings. The system
  prompt (from `docs/AGENT_PROMPT.md`) is cached; the per-request block (who is asking, their role, today's date) is not. Tools are sorted and **only the
  person's role's tools are sent**. If the model declines, the server-side fallback is on (`ANTHROPIC_REFUSAL_FALLBACK`).
- **The assistant never writes.** A write tool the model calls only makes a PendingAction and ends the turn; the form card in the chat opens filled in, marked
  "assistant filled this in — check it". Nothing is saved until the person presses the button (the verb, never "Submit"). Reads run and appear as tables
  drawn by the server; the model only receives their data wrapped in `<business_data>` and told it is data, not instructions.
- **Limits.** 8 tool calls per turn, 60 seconds, 500,000 tokens per person per day, 20 messages a minute. If the API is down, the person is told in plain
  words and the buttons still work. A dangling tool call from a dropped connection is repaired before the next turn.
- **Kill switch.** `AGENT_ENABLED=false` or the Setting `agent.enabled` (the owner can say "switch the assistant off"). Off means the chat box explains and the
  buttons keep working.
- **Passwords never reach the assistant or the chat history.** Typing one in the chat hides it (shown as ••••••) before it is stored or sent; the
  assistant is told to use the form's password box. Password boxes are not in the tool schema the model sees.
- **The opening card, buttons and chips.** The opening card is drawn by the server from read tools (no model). Launcher buttons switch on only when their
  tool exists for that role and the data allows it (forms not built yet stay off); chips ask a canned question and show a table. Badges show waiting approvals and
  low stock. Follow-up chips after a save or an answer are rule-based, never model-written.
- **Form cards.** Real labels, Enter moves to the next box, Ctrl+Enter saves, picker for existing businesses and materials, the "was → now" stamp for
  settings, duplicate and similar-name questions in plain words ("Is this the same as…?"). Saved cards are drawn from the audit row.
- **History.** Chats are kept per person, titled by their first words, listed in the top bar's Chats menu, and reopened from there. Someone else's link opens a
  fresh chat, never their history.
- **Master-data tools** (all through the Tool Gateway, one transaction and one audit row each): materials (search, balance, add, change, stop), parties
  (add supplier/customer/both, "ROLE ADDED" when one business is both), settings (approval limit, assistant on/off, owner's email), users (add, owner resets
  a password, stop; last owner and yourself protected), `list_reorder_alerts`, `list_pending_approvals`. `docs/TOOL_CATALOG.md` and the kit catalog are in sync
  (65 tools), including the new owner-only `reset_user_password` and `confirmNotDuplicate`.
- Fuzzy matching (`src/lib/similar.ts`) for names: same name ignoring case/spaces/punctuation is refused; the same words in another order, or a one-letter slip, asks
  "is this the same?"; different numbers (22 vs 24 SWG) are never questioned; "M/s", "Pvt Ltd" and so on are ignored for businesses.

Proof (all run in this session)
- `pnpm test`: 279 tests, real Postgres. Includes the agent (28) and chat layer (23) tests against a **local stand-in for Anthropic's streaming API** that the real SDK
  talks to (`tests/helpers/anthropic-stub.ts`).
- `pnpm e2e`: 77 browser tests passed (5 skipped on purpose), desktop and phone: opening card, buttons, streaming answer and table, chip, password hidden, API down,
  form open / save / Not now / mistake / duplicate / similar, keyboard, supplier form, accessibility scans light and dark, phone fit, storekeeper refused the approval limit,
  owner changes it and sees the old and new value, owner adds a login, chat list and ownership, kill switch.
- `pnpm test:kit`: 200/200. `pnpm lint`, `pnpm typecheck`, `pnpm build` clean.
- **Not verified:** a real run against Anthropic. There is no `ANTHROPIC_API_KEY` in this session, so the model's actual wording and tool choices are untested; the
  protocol, limits and safety rules are tested against the stand-in. A real Railway login is also still unchecked.

Things to know
- The e2e suite uses the stand-in on port 3199 (`tests/stub-server.ts`), set through `ANTHROPIC_BASE_URL`; the app code has no test branches.
- **Known gap:** if the owner switches the assistant off from the chat (the Setting), they cannot switch it on again from the chat; a Settings button is not in the kit's launcher. It is switched back on from the server for now (CLIENT_CONFIRMATIONS F4).
- Forms for stock movements (receive, issue, return, count) come with milestones 4–7, so those launcher buttons are switched off on purpose.

Questions for Kasi
- The M3 decisions for the owner are listed in `docs/CLIENT_CONFIRMATIONS.md` section F.
- Please add `ANTHROPIC_API_KEY` to the session (or to Railway) so a real conversation can be tried before the demo.

Next: milestone 4 — the opening count (count sheet form in the panel, the opening flow). This is go-live, so it needs Kasi's go-ahead and, ideally, the owner's answers to A1–A3.

## Milestone 2 — Ledger core — built (milestone 3 followed)

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
