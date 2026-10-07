"""
Source for prompts/tool-descriptions.json — the exact text the model sees for every tool.

Edit HERE, then run:  python3 prompts/build_tool_descriptions.py
The app loads the JSON into defineTool({ description, input: zod.describe(...) }).
A test (prompts/tool-descriptions.test.ts) checks it against the tool catalog and the artifact checker's
catalog, so a renamed tool or input can't silently drift.

How these are written (Anthropic tool-use guidance, adapted):
- Say what the tool does, WHEN to use it and when NOT to, what comes back, and the traps.
- Write tools: say plainly that calling one only OPENS A FORM; the user's submit is the change.
- Every input gets a description: what it is, the format, where the value comes from.
- Plain words, no internal jargon the model might repeat to the storekeeper.
"""
import json
import os

FORM = "Calling this opens the form for the user to check and submit; nothing is saved until they submit it. Pass everything you can work out and leave the rest for the form."
RATE = "Never fill in a rate yourself. If the user gave one, pass it; otherwise leave it empty (you may mention the last rate paid in your sentence, and pass it only if they say to use it)."
IDS = "Ids come from earlier read-tool results; never show them to the user."
NAMES = "Material names as returned by search_materials, e.g. [\"22 SWG Copper Wire\"]."
DATE = "Date as YYYY-MM-DD (Asia/Kolkata)."
DATE_REL = "Date as YYYY-MM-DD (Asia/Kolkata), or @today, @today-7d (days back), or @month (the first of this month)."

T = {}


def tool(name, kind, roles, description, inputs=None, agent=True):
    assert name not in T, name
    T[name] = {"kind": kind, "roles": roles, "agent": agent, "description": " ".join(description.split()), "inputs": inputs or {}}


SK_OW = ["STOREKEEPER", "OWNER"]
OW = ["OWNER"]
SK = ["STOREKEEPER"]

# ─────────────────────────────── 1. Materials ───────────────────────────────
tool("search_materials", "read", SK_OW, """
Find materials by part of their name. Matching ignores case, spaces and hyphens, so "ferrite core e30"
finds "Ferrite Core E-30" and "22swg wire" finds "22 SWG Copper Wire". Returns each material's name,
unit, stock type (STANDING or PER_JOB), quantity on hand and minimum level. Use it before creating a
material (to catch duplicates), to resolve what the user typed into an exact name, and before opening
any form that needs a material. An empty query lists all active materials.""",
     {"query": "Part of the material's name, as the user typed it. Empty = all active materials.",
      "stockType": "Optional filter: STANDING (kept in stock, has a minimum) or PER_JOB (bought for a job).",
      "includeInactive": "true to include deactivated materials. Default false."})

tool("get_material_balance", "read", SK_OW, """
Current stock of one or more materials: quantity with unit, average rate, stock value, minimum level,
and flags for negative stock and below-minimum. Use for "how much X do we have", before issuing, and
to explain a shortage. Answer with the quantity and unit in one sentence; give rates and values to the
owner only when relevant.""",
     {"materialIds": "Material ids from an earlier result. " + IDS,
      "materialNames": "Or material names. " + NAMES})

tool("get_movement_history", "read", SK_OW, """
Stock movements for a material or a job, newest first: date, type (receipt, issue, return, count
adjustment, opening, scrap, reversal), quantity with unit, rate, the job or document number, who did it
and whether it came from chat or a button, and the balance after. Use for "what happened to X", "what
did I issue this week", and to find the movement the owner wants to reverse. Paginated.""",
     {"materialId": "One material. " + IDS, "materialNames": "Or material names. " + NAMES,
      "jobId": "Only movements for this job. " + IDS, "from": "Start date. " + DATE + " Relative dates like @today-7d are allowed.",
      "to": "End date. " + DATE})

tool("create_material", "write", SK_OW, """
Opens the form to add a new raw material. ALWAYS call search_materials first: if something similar
exists ("Copper Wire 22 SWG" vs "22 SWG Copper Wire"), ask whether it's the same one before calling this —
duplicate materials are the fastest way the stock goes wrong. A material has exactly one unit, used
for buying and issuing, and the unit and stock type can never change later, so get them right.
STANDING materials need a minimum level. """ + FORM,
     {"name": "The material's name as the business writes it, e.g. \"22 SWG Copper Wire\". No supplier or city in the name.",
      "uom": "The one unit: NOS (pieces), KG, MTR (metres), LTR (litres), ROLL or SET.",
      "stockType": "STANDING (kept in stock, needs a minimum) or PER_JOB (bought only for a job).",
      "minimumLevel": "Reorder level in the material's unit. Required for STANDING; leave empty for PER_JOB.",
      "hsnCode": "HSN code, if the user has it.", "gstRate": "GST %, if the user has it (e.g. 18).",
      "isScrap": "true only for scrap materials such as copper offcuts.",
      "confirmNotDuplicate": "true only after the user has said a similar existing material is a different one."})

tool("update_material", "write", SK_OW, """
Opens the form to change a material's name, minimum level, HSN code or GST rate. It cannot change the
unit or stock type — if asked, explain that changing the unit would change the meaning of every past
quantity. """ + FORM,
     {"materialId": "The material to change. " + IDS, "name": "New name, only if renaming.",
      "minimumLevel": "New minimum level in the material's unit.", "hsnCode": "HSN code, as on the supplier's invoice.", "gstRate": "GST rate in %, e.g. 18."})

tool("deactivate_material", "write", SK_OW, """
Opens the form to deactivate a material that is no longer used. Only possible when its stock is
exactly zero; materials are never deleted, so history stays intact. """ + FORM,
     {"materialId": "The material. " + IDS, "reason": "Why it's no longer used, in the user's words."})

# ─────────────────────────────── 2. Parties ───────────────────────────────
tool("search_parties", "read", SK_OW, """
Find suppliers and customers by part of their name (ignoring case, spaces, punctuation and words like
"Pvt Ltd") or by GSTIN. Returns name, type (supplier, customer or both), city, GSTIN and phone. Always
call it before create_party, and before any purchase order, receipt or customer PO that names a
business, to get the exact saved name. Scrap buyers are customers.""",
     {"query": "Part of the business name, or a GSTIN.", "role": "Optional filter: SUPPLIER or CUSTOMER."})

tool("create_party", "write", SK_OW, """
Opens the form to add a supplier or customer (once, before any purchase order, receipt or customer PO
names it — those never create businesses themselves). Search first; if a similar name exists, ask
whether it's the same business. Put only the business name in `name` — "Sundaram Ferrites, Chennai" is
name "Sundaram Ferrites" and city "Chennai". If the business exists in the other role, the form adds
the role instead of creating a second record. """ + FORM,
     {"name": "Business name only — no city, no branch.", "role": "SUPPLIER, CUSTOMER or BOTH.",
      "gstin": "15-character GSTIN, if the user has it.", "city": "City or town, e.g. Chennai.", "state": "State, e.g. Tamil Nadu (decides the GST tax split on purchase orders).",
      "addressLine": "Street address, as the user gives it.", "pincode": "6-digit PIN code.", "phone": "Phone number, as given.", "email": "Email address, as given.",
      "confirmNotDuplicate": "true only after the user has said a similar existing business is a different one."})

tool("update_party", "write", SK_OW, """
Opens the form to change a supplier's or customer's details, or to add a role (a supplier who also
buys our scrap becomes BOTH). Roles are never removed. """ + FORM,
     {"partyId": "The business. " + IDS, "name": "New business name, only if it changed.", "gstin": "15-character GSTIN.",
      "city": "City or town.", "state": "State, e.g. Tamil Nadu.", "addressLine": "Street address, as given.", "pincode": "6-digit PIN code.", "phone": "Phone number, as given.",
      "email": "Email address, as given.", "addRole": "SUPPLIER or CUSTOMER, to add that role."})

tool("deactivate_party", "write", SK_OW, """
Opens the form to deactivate a supplier or customer no longer used. Not possible while they have open
purchase orders, customer POs or jobs; say which ones if so. """ + FORM,
     {"partyId": "The business. " + IDS, "reason": "Why, in the user's words."})

# ─────────────────────────────── 3. Customer POs, jobs, BOM ───────────────────────────────
tool("list_customer_pos", "read", SK_OW, """
Purchase orders our CUSTOMERS sent us, with PO number, customer, date and how many jobs run under each.
Use it to check whether a customer's PO is already recorded (an open PO keeps its number and each item
released is a new job), or to find a PO to put a job under. Not for orders we send suppliers.""",
     {"customerId": "One customer. " + IDS, "customerName": "A saved customer's name, as returned by search_parties."})

tool("list_jobs", "read", SK_OW, """
Jobs with number, customer, product description, pieces, status, dates and (for closed jobs) material
cost. Filter by status, customer, customer PO or dates. Use to find "job 31" (match the end of the
number), to see open work, or as an artifact's job list. Job numbers like JOB-2627-0031 are fine to show.""",
     {"status": "OPEN, MATERIAL_ISSUED, IN_PRODUCTION, COMPLETED, CLOSED or CANCELLED.", "customerId": "One customer. " + IDS,
      "customerPoId": "Jobs under one customer PO. " + IDS, "from": "Job date from. " + DATE, "to": "Job date to. " + DATE})

tool("get_job", "read", SK_OW, """
One job in full: customer, customer PO, product, pieces, status, and every BOM line with per-piece
quantity, total needed, issued and returned, plus material cost so far. Read it before opening the
issue, return or close form, so your sentence can list what will happen with quantities and units.""",
     {"jobId": "The job. " + IDS})

tool("check_job_shortage", "read", SK_OW, """
For each BOM line of a job: still needed, in stock, and short — all with units. Use after a BOM is
set, before issuing, and when asked "is job 31 short of anything". If something is short, offer a
purchase order for the shortfall (quantities filled in, rate empty).""",
     {"jobId": "The job. " + IDS})

tool("get_job_bom_variance", "read", SK_OW, """
Planned (BOM) versus actually used (issued − returned) per material for a job, with the difference and
percentage; top-up issues are marked. Use when the owner asks whether a job used more than planned.""",
     {"jobId": "The job. " + IDS})

tool("create_customer_po", "write", SK_OW, """
Opens the form to record a purchase order a CUSTOMER sent us (not one we send a supplier — if "PO" is
ambiguous, ask which). The customer must already be saved. If the same customer and PO number exist
(an open PO released item by item), the existing one is reused and you should offer a new job under
it. """ + FORM,
     {"customerName": "The saved customer's exact name from search_parties.", "number": "The customer's PO number as printed on it.",
      "poDate": "The customer PO's date. " + DATE})

tool("create_job", "write", SK_OW, """
Opens the form for a new job. Every job is a one-off design: even "same as last time" is a new job
that needs its own BOM — never copy one. A sample/prototype is its own job of type SAMPLE linked to the
main job. After it's saved, offer to add the BOM. """ + FORM,
     {"customerId": "The customer. " + IDS, "customerPoId": "The customer PO it belongs to, if any. " + IDS,
      "productDescription": "What is being made, in the user's words, e.g. \"230V/12V 50VA transformer\".",
      "quantity": "Number of pieces (whole number, more than 0).", "jobDate": "Job date. " + DATE,
      "dueDate": "Due date, if given. " + DATE, "type": "PRODUCTION (default) or SAMPLE.",
      "parentJobId": "For a SAMPLE: the main job. " + IDS})

tool("set_job_bom", "write", SK_OW, """
Opens the form to set a job's bill of materials. Quantities are ALWAYS PER PIECE; the form shows the
total for the whole job. If a number sounds like a total ("9.2 kg of wire for this job"), ask whether
it is per piece or for all pieces BEFORE calling this. Wire per piece is usually grams: 18.4 g is
0.0184 kg. In your sentence, list every line as "name — per piece → total", e.g. "22 SWG Copper Wire
18.4 g each → 9.2 kg". Only possible before anything is issued; after that, extra material is a top-up
issue. Replaces the whole BOM. """ + FORM,
     {"jobId": "The job. " + IDS, "lines": "One line per material.",
      "lines[].materialId": "The material. " + IDS,
      "lines[].qtyPerPiece": "Quantity PER PIECE in the material's own unit (kg, not grams)."})

tool("cancel_job", "write", SK_OW, """
Opens the form to cancel a job. Only possible when nothing has been issued to it; otherwise explain
that material must be returned first. """ + FORM,
     {"jobId": "The job. " + IDS, "reason": "Why it's cancelled, in the user's words."})

# ─────────────────────────────── 4. Purchasing ───────────────────────────────
tool("list_purchase_orders", "read", SK_OW, """
Purchase orders we sent suppliers: number, supplier, date, status (DRAFT, PENDING_APPROVAL, APPROVED,
PARTIALLY_RECEIVED, RECEIVED, CANCELLED, REJECTED), total, expected date and the job that triggered it.
Filter by status, supplier, material or dates.""",
     {"status": "One status, e.g. APPROVED.", "supplierId": "One supplier. " + IDS, "materialId": "POs containing this material. " + IDS,
      "from": "PO date from. " + DATE, "to": "PO date to. " + DATE})

tool("get_purchase_order", "read", SK_OW, """
One purchase order: supplier, lines with ordered and received quantities and rates, status, approval,
and the receipts against it. Use before a receipt (to know what's still due) or when asked about a
PO.""",
     {"purchaseOrderId": "The PO. " + IDS, "number": "Or the PO number, e.g. PO-2627-0015."})

tool("get_purchase_price_history", "read", SK_OW, """
Rates paid per material per receipt, by supplier and date, with the previous rate and the % change,
and the observed lead time (PO date to receipt). Use for "what did we pay last time", rate trends,
supplier comparisons, and to work out lead times when the owner asks. Suggest a past rate only as a
question; never put it in a form unasked.""",
     {"materialId": "One material. " + IDS, "materialNames": "Or material names. " + NAMES,
      "supplierId": "One supplier. " + IDS, "from": "From date. " + DATE, "to": "To date. " + DATE})

tool("create_purchase_order", "write", SK_OW, """
Opens the form for a purchase order to a supplier. The supplier must already be saved (if not, say so
and open create_party first). Usually raised for a job's shortfall: fill the lines with the short
quantities. """ + RATE + """ The form reads the approval limit itself: above it, the PO waits for the
owner; at or below, it is approved at once — tell the storekeeper which happened after submit. """ + FORM,
     {"supplierName": "The saved supplier's exact name.", "lines": "One line per material.",
      "lines[].materialId": "The material. " + IDS, "lines[].quantity": "Quantity in the material's unit.",
      "lines[].rate": "Rate per unit in ₹, ONLY if the user gave it. Otherwise leave empty.",
      "lines[].hsnCode": "HSN code, if known.", "lines[].gstRate": "GST %, if known.",
      "expectedDate": "When the supplier will deliver, if the user said. " + DATE,
      "triggeredByJobId": "The job this PO is for, if any. " + IDS})

tool("cancel_purchase_order", "write", SK_OW, """
Opens the form to cancel a purchase order that has had nothing received. There is no editing a PO
after approval — a change means cancel and raise a new one. """ + FORM,
     {"purchaseOrderId": "The PO. " + IDS, "reason": "Why, in the user's words."})

tool("approve_purchase_order", "write", OW, """
OWNER ONLY. Opens the approval form for one purchase order waiting for approval; the form shows the
supplier, lines, total and the job it's for. One PO per form — never approve several at once. If the
storekeeper asks for this, don't call it: say the owner approves it and it's waiting for him. """ + FORM,
     {"purchaseOrderId": "The PO. " + IDS})

tool("reject_purchase_order", "write", OW, """
OWNER ONLY. Opens the form to reject a purchase order waiting for approval; a reason is required and
goes to the storekeeper. """ + FORM,
     {"purchaseOrderId": "The PO. " + IDS, "reason": "Why it's rejected — the storekeeper will read this."})

# ─────────────────────────────── 5. Goods receipt ───────────────────────────────
tool("list_goods_receipts", "read", SK_OW, """
Goods receipts: number, date, supplier, supplier invoice number, and per material received, accepted
and rejected quantities with units and the rate. Filter by supplier, PO, material or dates.""",
     {"supplierId": "One supplier. " + IDS, "purchaseOrderId": "One PO. " + IDS, "materialNames": "Materials. " + NAMES,
      "from": "Receipt date from. " + DATE, "to": "Receipt date to. " + DATE})

tool("record_goods_receipt", "write", SK_OW, """
Opens the form to receive goods into stock. Every delivery is inspected: received = accepted +
rejected; only accepted goes into stock; rejected goes back and needs a reason. Pre-fills from the PO
when given. Capture the supplier's invoice number and date when he has them. If the PO isn't approved
yet, ask once before calling this. """ + RATE + " " + FORM,
     {"supplierId": "The supplier. " + IDS, "purchaseOrderId": "The PO being received against, if any. " + IDS,
      "receiptDate": "Date received (today or earlier, never future). " + DATE,
      "supplierInvoiceNo": "Supplier's invoice number.", "supplierInvoiceDate": "Supplier's invoice date. " + DATE,
      "supplierDcNo": "Supplier's delivery challan number.", "lines": "One line per material delivered.",
      "lines[].materialId": "The material. " + IDS, "lines[].purchaseOrderLineId": "The PO line. " + IDS,
      "lines[].receivedQty": "Quantity that arrived, in the material's unit.", "lines[].acceptedQty": "Quantity accepted after inspection.",
      "lines[].rejectedQty": "Quantity rejected (received − accepted).", "lines[].rejectionReason": "Why it was rejected.",
      "lines[].rate": "Rate per unit in ₹ from the supplier's invoice, ONLY if the user gave it.",
      "lines[].hsnCode": "HSN code from the invoice, if given.", "lines[].gstRate": "GST rate in % from the invoice, if given."})

# ─────────────────────────────── 6. Issue, return, close ───────────────────────────────
tool("issue_material", "write", SK_OW, """
Opens the form to give out material to a job. All material is normally issued at once at job start:
for "issue for job 31" pass only the job (no lines) — that issues everything the BOM still needs — and
read the job first so your sentence lists what will go out with quantities and units. Pass lines only
for a partial issue or a marked top-up (rework). Every issue needs a job; non-job use isn't set up.
Stock may go negative — that's allowed. It never issues twice what's already issued. """ + FORM,
     {"jobId": "The job. " + IDS, "lines": "Only for a partial or top-up issue; leave out to issue the whole outstanding BOM.",
      "lines[].materialId": "The material. " + IDS, "lines[].quantity": "Quantity in the material's unit.",
      "lines[].topUp": "true for extra material beyond the BOM (rework)."})

tool("return_material", "write", SK_OW, """
Opens the form for leftover material coming back from a job. Goes back in at the current average rate;
the user never enters a rate. Can't return more than was issued to that job. """ + FORM,
     {"jobId": "The job. " + IDS, "lines": "One line per material returned.", "lines[].materialId": "The material. " + IDS,
      "lines[].quantity": "Quantity returned, in the material's unit.", "note": "Optional note in the user's words."})

tool("close_job", "write", SK_OW, """
Opens the form to close a job and fix its material cost (issued − returned). If anything was issued,
first ask what came back, if anything — never assume nothing; the form also asks. After it closes,
state the cost and cost per piece. """ + FORM,
     {"jobId": "The job. " + IDS, "nothingReturned": "true only when the user has said nothing came back."})

# ─────────────────────────────── 7. Scrap ───────────────────────────────
tool("record_scrap_in", "write", SK_OW, """
Opens the form to add collected scrap (copper offcuts) to a scrap material's stock, optionally against
the job it came from. """ + FORM,
     {"materialId": "The scrap material. " + IDS, "quantity": "Quantity in its unit.", "jobId": "The job it came from, if known. " + IDS})

tool("record_scrap_sale", "write", SK_OW, """
Opens the form to record scrap sold to a scrap buyer (a saved customer). Selling more than is on hand is
allowed and flagged. """ + RATE + " " + FORM,
     {"materialId": "The scrap material. " + IDS, "buyerId": "The buyer (a customer). " + IDS, "quantity": "Quantity sold, in the scrap material's unit.",
      "rate": "Sale rate per unit in ₹, ONLY if the user gave it.", "saleDate": "Sale date. " + DATE, "invoiceNo": "Invoice number, if any."})

tool("get_scrap_summary", "read", OW, """
OWNER ONLY. Per scrap material for a period: collected, sold, on hand and sale value, by job where known.
Use when the owner asks whether scrap sold matches scrap collected.""",
     {"from": "From date. " + DATE, "to": "To date. " + DATE})

# ─────────────────────────────── 8. Counts ───────────────────────────────
tool("list_counts", "read", SK_OW, """
Stock counts with number, date, type (opening or normal), status and progress (counted of total).""",
     {"status": "DRAFT, PENDING_APPROVAL (with the owner), APPROVED or REJECTED (sent back to recount)."})

tool("list_count_lines", "read", SK_OW, """
A count's lines by material: system quantity (frozen when the count started), counted quantity, difference,
reason, and for the opening count the rate and invoice. Both roles see the system quantity; the owner
dropped blind counting, so say it plainly when asked. Defaults to the count in progress.""",
     {"stockCountId": "The count. Default: the one in progress. " + IDS, "onlyUnfinished": "true for lines still to count or missing a rate."})

tool("start_stock_count", "write", SK_OW, """
Opens the form to start a stock count, which freezes every material's system quantity at that moment.
The opening count (go-live) happens once, before any other stock is recorded; if one is in progress,
continue it instead of starting another. After it starts, offer to open the count sheet. """ + FORM,
     {"countDate": "Date of the count. " + DATE, "isOpening": "true only for the one-time go-live count.",
      "materialIds": "Only these materials (a partial count). Leave out for all. " + IDS})

tool("submit_count_line", "write", SK_OW, """
Opens the form for one counted line. Normal count: if the count differs, offer a recount first; if he
stands by it, ask for a reason ONCE (spillage, extra wastage, missing, entry error, or don't know). "I
don't know" = UNEXPLAINED — accept it at once and never ask again; never turn "maybe spillage" into a
reason. Opening count: quantity plus the rate from the last purchase invoice (invoice number optional),
no reason. """ + RATE + " " + FORM,
     {"stockCountLineId": "The line. " + IDS, "countedQty": "What was physically counted, in the material's unit.",
      "reasonCode": "Normal counts only: SPILLAGE, EXTRA_WASTAGE, MISSING, ENTRY_ERROR or UNEXPLAINED. Only what the user said.",
      "notes": "Optional note in the user's words.", "unitRate": "Opening count only: rate from the last purchase invoice, ONLY if the user gave it.",
      "sourceInvoiceNo": "Opening count: that invoice's number, if given.", "sourceInvoiceDate": "Opening count: that invoice's date. " + DATE})

tool("save_count_sheet", "write", SK_OW, """
Saves many count lines at once from the count sheet form. Used by the count sheet form, not by the
assistant — in chat, use submit_count_line.""",
     {"stockCountId": "The count being edited on the count sheet.", "lines": "The lines edited on the count sheet."}, agent=False)

tool("submit_stock_count", "write", SK_OW, """
Opens the form to send a finished count to the owner. Refused while any line is uncounted (or, for the
opening count, any material with stock has no rate) — say which. Stock doesn't change until the owner
approves. """ + FORM,
     {"stockCountId": "The count. " + IDS})

tool("approve_stock_count", "write", OW, """
OWNER ONLY. Opens the form to approve a submitted count. Normal count: each difference becomes a count
adjustment at the current average rate. Opening count: each material with stock goes in at its
invoice rate. If the storekeeper asks for this, don't call it; say the owner approves counts. """ + FORM,
     {"stockCountId": "The count. " + IDS})

tool("reject_stock_count", "write", OW, """
OWNER ONLY. Opens the form to send a count back to the storekeeper with a note (e.g. "recount the
bobbins"). No stock moves. """ + FORM,
     {"stockCountId": "The count. " + IDS, "rejectionNote": "What to recount or fix — the storekeeper will read this."})

tool("get_leak_report", "read", OW, """
OWNER ONLY. Per material across approved monthly counts (never the opening count): how many times it
differed out of how many counts, the total short, what that is worth at today's average rate, how many
differences were not explained, and the reasons given; ranked by rupee value. Use it for "where is my stock
leaking", "which materials keep going missing" (look at how often each differed) and "how many unexplained
differences this month" (from @month). It only reads approved counts. State facts and numbers only: never
guess who is responsible, and say plainly that the system cannot tell who, if asked.""",
     {"from": "Counts from this date. " + DATE_REL, "to": "Counts up to this date. " + DATE_REL, "materialNames": "Only these materials. " + NAMES})

tool("get_count_history", "read", SK_OW, """
Every time one material was counted, newest first: the system quantity at the time, what was counted, the
difference, the reason, who counted it and which count it was. Nothing is ever overwritten. Use it for
"show the bobbin count history" and "who counted the bobbins". Both roles may see the system quantity.""",
     {"materialNames": "The material. " + NAMES, "materialId": "The material. " + IDS})

# ─────────────────────────────── 9. Corrections ───────────────────────────────
tool("reverse_movement", "write", OW, """
OWNER ONLY. Opens the form to reverse one stock movement with an opposite movement (the original stays
in history). A reason is required. Opening stock and count adjustments can't be reversed — the next
count corrects them. If the storekeeper asks, say the owner does reversals. """ + FORM,
     {"movementId": "The movement, from get_movement_history. " + IDS, "reason": "Why, in the owner's words."})

# ─────────────────────────────── 10. Approvals, notifications, reports ───────────────────────────────
tool("list_pending_approvals", "read", OW, """
OWNER ONLY. Purchase orders and counts waiting for him, each with what he needs to decide: amount,
supplier or count, the job it's for, biggest differences, and how long it has waited.""")

tool("list_notifications", "read", SK_OW, """
The user's own notifications, unread first (approvals done, POs rejected, stock below minimum, rate
jumps). Never anyone else's.""",
     {"unreadOnly": "true for unread only."})

tool("mark_notifications_read", "write", SK_OW, """
Marks the user's own notifications as read. Done by the app when the person opens their notifications; not for you to call.""",
     {"notificationIds": "Which ones; leave out for all. " + IDS}, agent=False)

tool("list_reorder_alerts", "read", SK_OW, """
STANDING materials below their minimum level: on hand, minimum and shortfall, with units. Offer a
purchase order for the shortfall (rate empty).""")

tool("get_stock_value", "read", OW, """
OWNER ONLY. Total stock value and value per material at average rates (quantity times average rate). Name materials to get
only those, e.g. "value of copper wire in stock".""",
     {"materialNames": "Only these materials. " + NAMES})

tool("estimate_job_cost", "read", OW, """
OWNER ONLY. What-if: the material cost of the jobs not yet closed at today's average rates, against the same
with one material's rate changed — e.g. copper at ₹900/kg. Same costing as the job cost report. Nothing is
saved and no price changes anywhere. Use it for "what if copper goes to…" questions and in what-if artifacts.
Never do the sums yourself.""",
     {"jobIds": "Only these jobs; leave out for all open jobs. " + IDS, "materialNames": "The material whose rate changes. " + NAMES,
      "newRate": "The rate to try, in ₹ per unit. This is a what-if input, not a price."})

tool("get_job_cost_report", "read", OW, """
OWNER ONLY. Material cost per job: pieces, cost (value issued less value returned) and cost per piece. By
default the jobs closed in the period; set includeOpen for open jobs too (their cost so far), which is also
how to see every job under one customer PO, each costed separately.""",
     {"from": "From (closed on or after; job date when includeOpen). " + DATE_REL, "to": "To. " + DATE_REL, "customerId": "One customer. " + IDS,
      "customerPoId": "Only jobs under this customer PO, from list_customer_pos. " + IDS, "includeOpen": "true to include jobs that are not closed yet."})

tool("get_activity", "read", OW, """
OWNER ONLY. Who did what and when, newest first, and whether it was done through the chat assistant, a
form, a button or an artifact. Filter by person, kind of action, date or one job (every change to that job).
Use it for "everything the agent did today" (from @today) and "all changes to job 31".""",
     {"userId": "One person. " + IDS, "from": "From. " + DATE_REL, "to": "To. " + DATE_REL, "tool": "One kind of action, e.g. issue_material.", "jobId": "Only changes to this job. " + IDS})

# ─────────────────────────────── 11. Settings and users ───────────────────────────────
tool("list_settings", "read", SK_OW, """
Settings. The owner sees all of them; the storekeeper sees only the purchase approval limit.""")

tool("update_setting", "write", OW, """
OWNER ONLY. Opens the form to change a setting such as the purchase approval limit. If the storekeeper
asks, say only the owner changes it. """ + FORM,
     {"key": "The setting's key, e.g. po.approval_limit.", "value": "The new value, e.g. 50000 for a ₹50,000 approval limit."})

tool("list_users", "read", OW, """
OWNER ONLY. People who can log in: name, role, active. Never passwords.""")

tool("create_user", "write", OW, """
OWNER ONLY. Opens the form to add a login. The owner types the initial password in the form; never put
a password in the chat or in this call. """ + FORM,
     {"name": "The person's full name.", "login": "Email or username.", "role": "STOREKEEPER or OWNER."})

tool("reset_user_password", "write", OW, """
OWNER ONLY. Opens the form to set a new password for someone who forgot theirs. The owner types the new
password in the form; never put a password in the chat or in this call. """ + FORM,
     {"userId": "The person. " + IDS})

tool("deactivate_user", "write", OW, """
OWNER ONLY. Opens the form to stop a person logging in. The last active owner can't be deactivated.
""" + FORM,
     {"userId": "The person. " + IDS})

# ─────────────────────────────── A. Artifacts, printouts, downloads ───────────────────────────────
tool("list_artifacts", "app", SK_OW, """
The user's saved and recent artifacts and, for the storekeeper, the ones the owner shared with him.
ALWAYS call this before make_artifact when someone asks for a report, chart or dashboard: if one
already does the job, open it with open_artifact and say so instead of building a duplicate.""",
     {"query": "Words from the title or what it shows, e.g. \"copper\" or \"below minimum\"."})

tool("open_artifact", "app", SK_OW, """
Opens a saved, recent or shared artifact beside the chat. It runs again with live numbers when opened.""",
     {"artifactId": "The artifact's id from list_artifacts or the panel. " + IDS})

tool("make_artifact", "app", SK_OW, """
Builds an artifact that opens beside the chat with live numbers. ONLY when the user asks for a report,
memo, SOP, diagram, chart, dashboard, comparison, what-if or a long list (more than ~10 rows or 5 columns).
NOT for a single fact (say it), a short list (show a table in the chat), a change of data (open the form),
or the fixed printouts (open_printout). Two kinds: a document (reports, memos, SOPs, flow diagrams,
explainers; downloads as PDF, Word, Excel, CSV, picture or Markdown) and a page (an interactive what-if or
filters). Leave kind out and the builder chooses. It can only look and point: it reads data and can open a
form, never save. Never put figures you worked out into the request; the numbers come from the system.
Returns the title, a one-line summary and anything it couldn't include.""",
     {"request": "What the artifact is for, in plain words, including any period, materials, jobs or suppliers, and any buttons wanted (e.g. \"Materials below minimum with a Make PO button on each row\"). Do not include numbers you calculated.",
      "kind": "Optional: document or page. document for something to read, print or send (report, memo, SOP, diagram); page only if the user will interact with it (what-if, filters). Leave out to let the builder choose."})

tool("edit_artifact", "app", SK_OW, """
Changes an artifact the user made, a document or a page — "make it a bar chart", "add a supplier column",
"add a step to the flow". It becomes a new
version at once and earlier versions can be restored. A copy the owner shared with the storekeeper does
not change. Never make a new artifact for a change to an existing one.""",
     {"artifactId": "The artifact's id from the panel or list_artifacts. Default: the one open beside the chat.",
      "request": "The change, in the user's words plus anything you worked out. No calculated numbers."})

tool("open_printout", "app", SK_OW, """
Opens a printable document with the Vijaya letterhead, ready to print or save as PDF: purchase-order
(to send the supplier; only approved POs print without a "not approved" mark), goods-receipt-note,
issue-slip (the pick list for a job; printing issues nothing), count-sheet (with an empty Counted
column) and job-cost-sheet (owner only). These are the only printouts. There is no tax invoice, delivery
challan or quotation: say invoicing and dispatch aren't set up.""",
     {"template": "purchase-order, goods-receipt-note, issue-slip, count-sheet or job-cost-sheet.",
      "with": "What to print: {\"purchaseOrder\": id} | {\"receipt\": id} | {\"job\": id} | {\"count\": id}. " + IDS})

tool("share_artifact", "write", OW, """
OWNER ONLY. Opens the form to share one frozen version of an artifact with the storekeeper. His copy does
not change until the owner shares a newer version. Refused if the artifact uses owner-only data (stock
value total, leak, job cost, scrap, activity): say which part and offer a version without it. """ + FORM,
     {"artifactId": "The artifact. " + IDS, "version": "Optional: the version number to share. Default: the current one."})

tool("unshare_artifact", "write", OW, """
OWNER ONLY. Opens the form to stop sharing an artifact with the storekeeper; it disappears from his
Saved. """ + FORM,
     {"artifactId": "The artifact. " + IDS})

tool("download_data", "app", SK_OW, """
Makes a file to download. Use it when the user says "as PDF", "in Word", "in Excel", "as CSV", "as a picture",
"as Markdown", "send me this", "for the accountant". Give the format the user named. A document artifact can
be pdf, docx, xlsx, csv, png or md; a page artifact pdf, png, xlsx or csv; a table in the chat xlsx or csv.
The file is made by the server with the user's own role, so it never includes anything they can't see.
The system can't email or send it: the user downloads it and sends it himself. For the letterhead
printouts (purchase order and so on) use open_printout instead.""",
     {"format": "pdf, docx, xlsx, csv, png or md. Must be one this kind of artifact has (see above).", "source": "For a table: {\"tool\": a read tool, \"input\": {...}}, the same as you'd call it.",
      "artifactId": "Or an artifact: its id, to download it. Default: the one open beside the chat.",
      "title": "File name in plain words, e.g. \"Copper receipts\". The date is added."})


out = {
    "version": 1,
    "generatedFrom": "prompts/build_tool_descriptions.py — edit that, not this file",
    "tools": T,
}
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "tool-descriptions.json"), "w") as f:
    json.dump(out, f, indent=1, ensure_ascii=False)
    f.write("\n")
print(f"{len(T)} tools written")
