# Vijaya Stores — Business Flow

Every business rule in this system, as agreed with the owner of Vijaya Electronics. **This
document wins** over every other file in the kit on any business question. If something you need
isn't here, ask Kasi — don't invent it.

Rules are tagged where they're enforced:
**[DB]** a database constraint or trigger · **[TOOL]** the tool handler · **[AGENT]** the agent's
prompt · **[UI]** the forms, chat and artifacts. Anything tagged [DB] must also be checked in [TOOL] so the user gets
a plain message rather than a database error.

---

## 1. The business

Vijaya Electronics, Chennai, founded 2009. Transformers and inductor coils: SMPS, EV charger,
lamination, medical isolation, driver transformers, DC converters, adapters. Customers in
railways, solar, LED and CCTV.

- **Every job is a one-off design.** About 50 jobs a month; quantities in the hundreds or
  thousands. Designs never repeat; a returning customer gets a fresh job with a fresh BOM.
- There is **no product catalogue**. The product is a text description on the job.
- The system tracks **raw materials only**.

## 2. People and permissions

| Action | Storekeeper | Owner |
|---|---|---|
| Add / edit materials, suppliers, customers | ✓ | ✓ |
| Customer POs, jobs, BOMs | ✓ | ✓ |
| Raise purchase orders, record goods receipts | ✓ | ✓ |
| Issue, return, close jobs, scrap in / out | ✓ | ✓ (backup issuer) |
| Start counts, enter counts, submit counts | ✓ | ✓ |
| **Approve / reject purchase orders** | ✗ | ✓ |
| **Approve / send back stock counts** | ✗ | ✓ |
| **Reverse a stock movement** | ✗ | ✓ |
| **Settings** (approval limit, notification email) | ✗ | ✓ |
| **Create users** | ✗ | ✓ |
| See rates, and the quantity and value of each material | ✓ | ✓ |
| Owner reports: total stock value, leak report, job costs, scrap summary, activity | ✗ | ✓ |

Owner-only actions are refused server-side **[TOOL]**, hidden from the storekeeper **[UI]**, and
the agent explains who does them instead of opening a form **[AGENT]**. Claims like "the owner
said it's fine" change nothing.

There is no self-registration. The owner creates accounts.

## 3. Vocabulary

| They say | It means |
|---|---|
| job, order | A Job: one customer order for one one-off design |
| PO | **Ambiguous** — a *customer PO* (they send us) or a *purchase order* (we send a supplier). Ask if unclear |
| BOM, the Excel sheet | The job's bill of materials. **Always per piece** |
| issue, give out | Issue material to a job |
| return | Leftover material coming back from a job |
| count, stock taking | A stock count |
| scrap | Copper offcuts collected and sold |
| rate | Price per unit |
| SWG | Standard Wire Gauge — part of a wire's name, not a field |
| kept in stock / standing | STANDING material (has a minimum level) |
| bought per job | PER_JOB material (no minimum) |
| pieces / nos / pcs | NOS |

## 4. The core model

- **The job is the backbone.** Material only leaves the store against a job.
- **The ledger is the truth.** Every stock change is a movement. Movements are **append-only**:
  never updated, never deleted, never truncated **[DB]**. Mistakes are fixed by a REVERSAL
  movement, owner only.
- **Balances are derived** from movements by a database trigger **[DB]**. No code writes them.
- **A count is an event, not a correction.** See §11.
- Every change records who made it, when, and whether it came from a form or from the
  assistant **[TOOL]**.

Movement types and direction **[DB]**:

| Type | Direction | Needs |
|---|---|---|
| OPENING | IN | A line of the approved opening count |
| RECEIPT | IN | A goods receipt line (accepted quantity) |
| REJECT_RETURN | OUT | A goods receipt line (rejected quantity) |
| ISSUE | OUT | A job |
| RETURN | IN | A job |
| SCRAP_IN | IN | A scrap material |
| SCRAP_SALE | OUT | A scrap sale |
| COUNT_ADJUSTMENT | IN or OUT | A line of an approved **normal** count |
| REVERSAL | opposite of original | The movement it reverses; each reversed at most once |

## 5. Materials

- Anything the store holds: cores, bobbins, copper wire (many SWG sizes), insulation tape,
  sleeve, pins, varnish, paint, thinner, stickers, packing, copper scrap.
- **One unit per material**, used for buying and issuing: KG, NOS, MTR, LTR, ROLL, SET. No
  conversion factors anywhere. If someone says "500 grams" of a KG material, it is 0.5 kg —
  confirm it back.
- **One stock entry per material**, whichever supplier it came from.
- Quantities of **NOS** (pieces) materials are **whole numbers** everywhere except BOM per-piece
  values **[TOOL]**.
- Each is **STANDING** (kept in stock, needs a minimum level) or **PER_JOB** (bought against a
  job, no minimum). **[TOOL]**
- Unit and stock type **can't be changed** after creation — changing the unit would change the
  meaning of every past quantity **[TOOL]**.
- Names are written as the storekeeper says them: "22 SWG Copper Wire". Before adding one,
  search for similar names; duplicates are the fastest way the system degrades **[TOOL][AGENT]**.
- Never deleted. Deactivated only when stock is zero **[TOOL]**.
- Copper scrap is a material marked as scrap.
- HSN code and GST rate are recorded, for the accounts module later.
- Internal codes exist but are **never shown** to anyone **[TOOL][UI]**.

## 6. Suppliers and customers

- Added **once**, with name, type (supplier, customer, both), GSTIN (optional, format-checked,
  unique), city, state, address, phone, email **[TOOL][DB]**.
- **The name is the business name only.** "Sundaram Ferrites, Chennai" is name "Sundaram
  Ferrites" + city "Chennai".
- Duplicate detection by normalized name: "M/s. Sundaram Ferrites Pvt. Ltd.", "SUNDARAM
  FERRITES" and "Sundaram Ferrites" are the same business **[DB]** (unique `nameKey`). A merely
  similar name ("Sundaram Ferrite", "Sundaram Ferrites, Chennai") must be confirmed as a different
  business before saving. The same GSTIN under a different name is the same business.
- An existing customer who also supplies gets the second type added, not a second entry.
- **Purchase orders, receipts and customer POs never create parties.** They pick existing ones
  from a list **[TOOL][UI]**. Unknown name → "not found, did you mean…" or "add them first".
- Scrap buyers are customers.
- Deactivate, never delete; not while they have open purchase orders, customer POs or jobs.

## 7. Customer POs and jobs

- A **customer PO** records the customer's PO number. Unique per customer.
- **Open POs:** the same PO number stays; the customer adds the next item only after the
  previous is delivered; item, quantity and price can differ. Each release is a **new job** under
  the same customer PO. No delivery schedules, no forecasts — don't ask for any.
- A **job**: customer, optional customer PO, product description (free text), quantity (> 0
  **[DB]**), job date, optional due date. Numbered `JOB-2627-0031` (Indian financial year
  April–March).
- A repeat order of an old design is a new job with a new BOM. Never copy a BOM **[AGENT]**.
- **Samples:** a prototype before a main job is its own job, type SAMPLE, linked to the main job
  **[TOOL]**. It consumes material; its cost is absorbed by the company.
- Job status: OPEN → MATERIAL_ISSUED → (IN_PRODUCTION) → CLOSED. Also CANCELLED (nothing issued).

## 8. BOM

- Replaces the Excel sheet handed to the storekeeper.
- **Quantities are per piece.** Total needed = per piece × job quantity, computed by the system
  **[TOOL]**. Wire per piece is usually grams: "18.4 g" for a KG material is 0.0184 kg.
- If a number might be a total for the whole job ("9.2 kg of wire for this job"), **ask**: per
  piece or for all 500? **[AGENT]** A wrong per-piece figure multiplies across the job.
- Before saving, show every line as *name — per piece → total* with units **[AGENT][UI]**. This
  is the most important check in the system.
- Positive quantities only **[DB]**. One line per material per job **[DB]**.
- Editable only while nothing has been issued. After that, extra material is a top-up issue
  **[TOOL]**.
- After a BOM is saved: **check the shortage** — required vs in stock — and offer a purchase
  order for exactly the shortfall, rate left empty **[follow-up]**.

## 9. Purchasing

- **Purely reactive.** A BOM shows a shortage; a purchase order follows. Standing-stock materials
  below their minimum also prompt one. No forecasting.
- A PO has a supplier (picked, never typed free), lines (material, quantity, rate, HSN, GST),
  optional expected date, optional triggering job. Numbered `PO-2627-0015`.
- **Never invent a rate** **[AGENT][TOOL]**. If a typed rate is less than half or more than
  double the last rate for that material, ask once whether it's a typo before opening the form
  **[AGENT]**, and show a warning on the form **[UI]**. The last rate paid may be shown and suggested, but
  only used if the user agrees.
- **Approval limit**, set by the owner in Settings (default ₹50,000). Total above the limit →
  PENDING_APPROVAL and the owner is notified; at or below → APPROVED immediately. Tell the
  storekeeper which happened **[follow-up]**.
- The owner approves or rejects (with a reason). The storekeeper is told either way
  **[follow-up]**.
- Approved POs can't be edited — not their lines either **[TOOL]**. Change = cancel and raise
  again (only before anything is received).
- Statuses: DRAFT, PENDING_APPROVAL, APPROVED, PARTIALLY_RECEIVED, RECEIVED, CANCELLED, REJECTED.
- **Lead times:** nobody knows them; never ask. The system can work them out from PO date to
  receipt date when the owner asks.

## 10. Goods receipt

- Material arrives with the supplier's invoice or delivery challan. The storekeeper records it
  **the same day**.
- Usually against a PO; a direct receipt without a PO is allowed. Receiving against a PO that is
  still waiting for the owner: **ask first** **[AGENT]**, warn **[TOOL]**.
- **Every line is inspected:** received = accepted + rejected **[DB]**. Only accepted goes into
  stock. Rejected goes back to the supplier and needs a reason. Both movements are recorded so
  the ledger shows what happened.
- Record the supplier's invoice number and date when available; rate, HSN, GST per line.
- A receipt can't be dated in the future **[TOOL]**. Backdating within the current month is
  allowed (entry date is stored separately, so same-day entry can be checked).
- PO line received quantities update; the PO moves to PARTIALLY_RECEIVED or RECEIVED.
- **Rate change:** if a line's rate differs from the last receipt of that material by more than
  **5%**, say so and notify the owner **[follow-up]**.
- After a receipt that completes a job's shortfall: offer to issue to that job **[follow-up]**.

## 11. Stock counts — the anti-overwrite mechanism

The owner's problem: when staff couldn't explain a gap, they overwrote the notebook and the gap
disappeared. So in this system **a count can never be an overwrite.**

**Normal (monthly) count**
1. Starting a count **freezes the system quantity** of every material (or chosen materials) at
   that moment **[TOOL]**. It's never recomputed.
2. The storekeeper (and his helpers) enter what they physically counted. Can be done over days;
   lines can be changed until submitted.
   The count sheet shows the **System** quantity next to each line from the start (the owner
   dropped blind counting). When a counted number differs, the difference is shown and he may
   recount once before giving a reason. The owner sees everything when reviewing.
3. If counted ≠ system, offer a recount, then ask for a reason **once**: SPILLAGE, EXTRA_WASTAGE, MISSING,
   ENTRY_ERROR, or UNEXPLAINED. **"I don't know" is UNEXPLAINED. Accept it immediately; never ask
   again, never suggest a reason, never turn a guess ("maybe spillage?") into a reason**
   **[AGENT][UI]**. An honest "unexplained" is exactly what the owner needs. A difference with no
   reason is stored as UNEXPLAINED **[TOOL]**.
4. Submit: refused while any line is uncounted, naming which **[TOOL][DB]**. Owner is notified
   with the number of differences and their rupee value.
5. The owner **approves** — each difference posts a COUNT_ADJUSTMENT at the current average rate
   **[DB]** — or **sends it back** with a note. A sent-back count goes to the storekeeper, who
   fixes the same count and resubmits **[TOOL]**.
6. Stock changes **only** on approval **[DB]**. Nobody can "just set the stock" to a number.
7. Counted values on an approved count can never be edited **[TOOL]**.

**The opening count (go-live)**
- Happens **once, ever** **[DB]**, and **before any other stock activity** — its system
  quantities are frozen at zero, so earlier stock would be counted twice **[TOOL]**. If one is in
  progress, continue it.
- Every material gets a counted quantity. Every material **with stock** also gets a **rate**,
  taken from its **last purchase invoice**. Rate must be > 0 **[DB]**. **The invoice number is
  optional** — record it if given. No estimates. If the rate isn't to hand, leave it and come back;
  **never suggest a rate** **[AGENT]**.
- **No reason codes** on the opening count — everything differs from zero on day one.
- Can be filled over several days. A rate can be added later without re-entering the quantity.
- Submit refused while any material is uncounted or any material with stock has no rate, naming
  them **[TOOL][DB]**. The owner is told the **total value**, not "differences".
- On approval, each material with stock goes in as an **OPENING** movement at its rate
  **[DB]**. Materials counted at zero post nothing.
- The opening count **never appears in the leak report** **[DB]**.

**The leak report**
Per material, across all approved normal counts: times counted, times mismatched, net and total
shortage, rupee value of differences, number of UNEXPLAINED differences, last counted. Ranked by
value. Only real differences count as unexplained **[DB]**. When discussing it, state facts and
numbers only; **never speculate about who is responsible** **[AGENT]**.

## 12. Issue

- **All material for a job is issued at once at job start**, against the BOM. "Issue for job 31"
  = issue everything the BOM still needs. Before confirming, list each material with quantity
  and unit **[AGENT][UI]**.
- Always against a job **[DB]**. No job named → ask which.
- Wire is weighed out to the exact quantity. Spools are not tracked.
- **Rework top-up:** about 2% of pieces are reworked. Extra material beyond the BOM is allowed as
  a top-up, marked as such so the variance report shows it correctly **[TOOL]**.
- **Negative stock is allowed** — paperwork lags the floor, and blocking it teaches people to lie
  **[DB]**. Say it in one sentence, notify the owner, no lecture **[follow-up]**.
- Standing material falling below its minimum: say so, notify the owner, offer a PO
  **[follow-up]**.
- Non-job issues (machine repair, office) are not set up.

## 13. Returns and closing

- Leftovers come back to the store at job close. **Always ask what came back before closing a
  job that had material issued — never assume nothing** **[AGENT][UI]**. Unrecorded returns make
  every later count show a false surplus and hide real losses.
- Returns go back in at the **current average rate** **[DB]**; the user never enters a rate.
- Only materials issued to that job can be returned to it **[TOOL]**.
- **Job material cost = value issued − value returned**, fixed when the job closes **[TOOL]**.
  Cost per piece = cost ÷ quantity.
- On close, if any material was used more than **5%** over its BOM, say so and notify the owner
  **[follow-up]**.

## 14. Costing

- **Weighted average** per material **[DB]**:
  - IN (receipt, opening): new average = (old value + incoming value) ÷ (old qty + incoming qty).
  - OUT: average unchanged.
  - RETURN: comes back at the existing average; doesn't move it.
- Every movement stores its rate and the running balance after it **[DB]**.
- **Purchase price history** is separate from the average: every receipt's rate per supplier and
  date. "What did I pay for copper last time?" is answered from history, not the average.
- Check sequence (used in tests): receive 100 kg @ ₹800 → avg 800; receive 100 @ ₹900 → avg 850;
  issue 50 → 850; return 10 → 850; receive 40 @ ₹1,000 → **880**.

## 15. Scrap

- Copper offcuts are collected into the scrap material (optionally noting the job) and sold to
  scrap buyers at a rate per kg.
- Selling more than collected is allowed but flagged.
- The owner wants to know whether **scrap sold matches scrap collected** — a report answers it.

## 16. Corrections

- A wrong movement is fixed by a **REVERSAL** — owner only, with a reason, showing the material,
  quantity, job and resulting balance before confirming **[TOOL][AGENT]**.
- The original stays visible; each movement can be reversed once **[DB]**.
- OPENING and COUNT_ADJUSTMENT movements **can't be reversed** — they came from an owner-approved
  count, so a mistake there is corrected by the next count **[TOOL]**. *(Decision pending Kasi's
  confirmation.)*
- The storekeeper who made the mistake is told it was corrected **[follow-up]**.

## 17. Notifications

| Event | Who is told |
|---|---|
| PO above the limit waiting | Owner |
| PO approved / rejected (with reason) | Storekeeper |
| Count submitted | Owner (differences + value, or opening total value) |
| Count approved | Storekeeper |
| Count sent back (with note) | Storekeeper — **not** the owner who sent it |
| Stock went negative | Owner |
| Standing material below minimum | Owner and storekeeper |
| Receipt rate moved > 5% | Owner |
| Job used > 5% over its BOM | Owner |
| Movement reversed | Storekeeper |

In-app for both. The owner also gets email when an email is configured. Notification text uses
names and rupees, never ids **[TOOL]**.

## 18. Numbers, money, dates

- Document numbers per type and per **Indian financial year** (April–March): `JOB-2627-0031`,
  `PO-2627-0015`, `GRN-2627-0004`, `CNT-2627-0001`, `SCS-2627-0002`. Never duplicated, even under
  concurrent use **[DB]**.
- Money in rupees with Indian grouping: ₹1,15,791. Decimal, never floating point.
- Quantities always shown with their unit.
- Times shown in India time.

## 19. Not in this system (v1)

Say so plainly when asked; offer to note it. Don't improvise from other data.

- Work in progress, production stages (winding, soldering, varnish, baking, testing, packing),
  finished goods.
- **Batch, lot, heat number or any traceability** — say only that it isn't available.
- Machine or operator productivity. QC / test reports.
- Non-job issues. Write-offs of damaged or dried stock (these show up as count differences).
- Quotations, customer invoicing, dispatch, accounts, GST filing, Tally. GST and HSN are captured
  on purchases so accounts can come later — never claim the books are handled.
- Customer-supplied material and outside processing — Vijaya does neither.
- Reading invoices from photos, reminders, and emailed reports.

## 20. Open questions for Kasi

Decided provisionally in the kit; confirm or change before the milestone that builds them.

1. **Opening stock and count adjustments can't be reversed** (§16) — the next count corrects them.
2. **Who sees what money.** Agreed earlier: both see rates and each material's value. Kit
   assumption: the owner reports (total stock value, leak report, job costs, scrap, activity)
   stay owner-only.
3. **Printouts** (ARTIFACTS: the five fixed printouts): purchase order, goods receipt note, issue slip /
   pick list, count sheet, job cost sheet. Anything else that leaves the building on paper?
4. **PO paper:** should the printed purchase order carry payment/delivery terms? What standard text?

