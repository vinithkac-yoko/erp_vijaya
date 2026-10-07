# Vijaya Stores — things to confirm with the owner

For the demo. Every choice we made, or assumed, that is really the owner's call. Nothing here is hidden in the code:
if the owner says "change it", it is a small change.

**How to use it:** go through the list top to bottom. For each, read the "What we did" line aloud, then tick the owner's
answer. If he wants a change, write it in the last column. We keep this file up to date: new decisions are added at the
bottom of each milestone's section.

- ✅ = Kasi already agreed. The owner should still hear it once.
- ❓ = nobody has agreed yet. **These are the important ones.**

Last updated: after milestone 7 (section J).

---

## A. Money and stock — the rules that decide the numbers

| # | Status | The question | What we did | Why | Owner says |
|---|---|---|---|---|---|
| A1 | ❓ | **Stock goes negative, then a delivery arrives.** (Paper work is late: 5 kg goes out before the first receipt is written down.) What is the average price afterwards? | When stock was zero or below zero, the new average is **simply the price on the delivery**. Example: 5 kg out first, then 10 kg arrives at ₹100 → average ₹100. | The plain formula would give ₹200 here, which is wrong. | ☐ OK ☐ Change: |
| A2 | ❓ | **Goods rejected on inspection.** How should they show in the stock history? | The history shows **both**: a receipt for everything that arrived, and a "sent back to supplier" entry for the rejected part. Stock ends up the same either way. | He said the history must show what happened. | ☐ OK ☐ Only the accepted part, one line, with the rejection noted on the receipt |
| A3 | ❓ | **Opening stock and count corrections cannot be reversed.** If a count was wrong, the *next count* fixes it. | Reversal is refused for these two. All other mistakes: owner reverses with a reason. | The count was already approved by the owner. | ☐ OK ☐ Allow reversal: |
| A4 | ✅ | When material goes out to a job, what price is it valued at? | The **current average price**. Nobody types it, and the database refuses any other price. Returns come back at the current average too. | Stops anyone changing a job's cost by typing a different rate. | ☐ OK ☐ Change: |
| A5 | ✅ | Can stock go negative? | **Yes.** It is allowed, the owner is told, never blocked. | "If we block it, people learn to lie." | ☐ OK ☐ Change: |
| A6 | ✅ | A stock count, once the owner approves it. | Final. Nobody can edit it. Counts and their lines can **never be deleted**. While a count waits for the owner, the storekeeper can't change it either. If the owner sends it back, the storekeeper can fix the same count. | The owner's problem was people overwriting the notebook. | ☐ OK ☐ Change: |
| A7 | ✅ | Only **one opening count, ever.** | A second one is refused by the database. | A second would let someone reset all stock to any number without a difference showing. | ☐ OK ☐ Change: |
| A8 | ✅ | A material that is kept in stock needs a **minimum level**. | Yes, required. Bought-per-job materials have none. | Needed for low-stock alerts. | ☐ OK ☐ Change: |
| A9 | ❓ | **Who sees which money.** | Both people see rates and each material's value. These reports are **owner only**: total stock value, leak report, job cost, scrap summary, activity. | Kit assumption. | ☐ OK ☐ Storekeeper may also see: |

## B. People, login and security

| # | Status | The question | What we did | Why | Owner says |
|---|---|---|---|---|---|
| B1 | ✅ | How do people log in? | **Email and password.** If the storekeeper has no email, we can use a short name instead. | Simple. | ☐ OK ☐ Change: |
| B2 | ✅ | How long does a login last? | **7 days**, then they log in again. Can be shorter. | Owner's phone is used between other work. | ☐ OK ☐ Shorter for the store PC: |
| B3 | ✅ | Wrong passwords. | After **5 wrong tries** from one place for one person: locked for **15 minutes**. The message never says whether the email or the password was wrong. | Stops guessing. | ☐ OK ☐ Change: |
| B4 | ✅ | Password reset. | **Only the owner** can set a new password for someone (a form). Minimum 10 characters. | There is no email reset in version 1. | ☐ OK ☐ Change: |
| B5 | ✅ | Can anyone sign themselves up? | **No.** The owner creates every login. | Security. | ☐ OK ☐ Change: |
| B6 | ❓ | The first two logins. | We create an **Owner** and a **Storekeeper** login when the system is first started. The names and emails are placeholders until you tell us the real ones. Passwords are generated and shown once, or you choose them. | Needed to start. | Owner's name & email: ____________  Storekeeper's: ____________ |

## C. What each person can do

| # | Status | The question | What we did | Owner says |
|---|---|---|---|---|
| C1 | ✅ | Who approves purchase orders, approves/sends back counts, reverses a movement, changes settings, creates logins? | **Owner only.** The storekeeper's assistant refuses, and does not open a form. "The owner said it's fine" changes nothing. | ☐ OK ☐ Change: |
| C2 | ✅ | PO approval limit. | **₹50,000** to start. Above it, the PO waits for the owner. Only the owner changes it. | ☐ OK ☐ Change limit: |
| C3 | ✅ | The owner as a back-up storekeeper. | The owner can do everything the storekeeper does. | ☐ OK ☐ Change: |

## D. What it looks like

| # | Status | The question | What we did | Owner says |
|---|---|---|---|---|
| D1 | ✅ | The top bar. | "Vijaya Stores" with "Vijaya Electronics" underneath (the prototype said "Inventory Terminal"). | ☐ OK ☐ Change: |
| D2 | ✅ | Light and dark. | Follows the phone or PC by default. Each person can choose, and it is remembered. | ☐ OK ☐ Change: |
| D3 | ✅ | Chat, buttons above the input, forms in the chat. No menu of screens. | As in the approved prototype and the kit. | ☐ OK ☐ Change: |
| D4 | ❓ | **Anything else that goes to paper?** | Five printouts: purchase order, goods receipt note, issue slip (pick list), count sheet, job cost sheet. | ☐ OK ☐ Add: |
| D5 | ❓ | **Should the printed purchase order carry payment and delivery terms?** | Not yet. We need the standard wording if yes. | ☐ No ☐ Yes, wording: |

## E. Putting it online

| # | Status | The question | What we did | Owner says |
|---|---|---|---|---|
| E1 | ✅ | Where does it run? | On **Railway**, one app and one database. It updates when we push to the `main` branch. | ☐ OK ☐ Change: |
| E2 | ❓ | Backups. | Railway keeps daily database backups. We should **test a restore once before go-live**. | ☐ OK |
| E3 | ❓ | Who pays for and owns the Railway account and the AI key? | Not decided. | Account owner: ____________ |

---

## F. Added in milestone 3 — the assistant, masters and logins

| # | Status | The question | What we did | Owner says |
|---|---|---|---|---|
| F1 | ✅ | **The approval limit's name and start.** | One setting, **₹50,000** at the start. Only the owner can change it, by asking the assistant; the screen shows what it was and what it is now. | ☐ OK ☐ Change: |
| F2 | ❓ | **What the owner can change from the chat.** | Three things only: the PO approval limit, the assistant on/off, and the email that gets the owner's notices. Nothing else is a setting. | ☐ OK ☐ Also: |
| F3 | ❓ | **The assistant: how much may one person use?** | At most **8 steps** for one question, **60 seconds**, **20 messages a minute**, and a daily allowance of **500,000 tokens** per person (a long day of chatting is about a fifth of that). Past the allowance the buttons keep working and the assistant says so. | ☐ OK ☐ Change allowance: |
| F4 | ❓ | **The off switch for the assistant.** | The owner can say "switch the assistant off" in the chat, or we can turn it off on the server. Either one switches it off for everyone; the buttons keep working. **Gap:** once it is off, the chat box is off too, so the owner cannot switch it back on from the chat. For now we switch it back on from the server. | ☐ OK for now ☐ Add a **Settings** button the owner can always press: |
| F5 | ✅ | **Passwords typed in the chat.** | The assistant never sees or keeps one. If someone types a password into the chat, it is hidden at once (shown as ••••••) and they are told to use the form's password box. | ☐ OK ☐ Change: |
| F6 | ✅ | **Login names.** | A login must be a real-looking email. Minimum password **10 characters**. | ☐ OK ☐ Change: |
| F7 | ✅ | **Passwords and the owner.** | The owner can set a new password for anyone. The **last owner**, and **yourself**, cannot be stopped from using the system. | ☐ OK ☐ Change: |
| F8 | ❓ | **Stopping a material.** | Allowed only when its stock is **exactly zero**. A stopped material is not deleted; the history stays. | ☐ OK ☐ Change: |
| F9 | ❓ | **Stopping a supplier or customer.** | Not allowed while there are open purchase orders, customer orders or jobs for them. | ☐ OK ☐ Change: |
| F10 | ❓ | **Same material typed twice.** | A name that is the same apart from capitals, spaces or punctuation is **refused**. The same words in another order ("Copper Wire 22 SWG" / "22 SWG Copper Wire") or a one-letter slip gets the question **"Is this the same as…?"** before it is added. Different numbers (22 vs 24 SWG) are **never** questioned. | ☐ OK ☐ Change: |
| F11 | ❓ | **Same business typed twice.** | "M/s", "Pvt Ltd", "Private Limited", "& Co" and similar are ignored when comparing names. A very similar name asks the same question. One business can be both supplier and customer: adding the other role shows "ROLE ADDED" on the same record. | ☐ OK ☐ Change: |
| F12 | ❓ | **GSTIN.** | If one is typed, it is checked for the right shape (15 characters). We do not check it with the government site. | ☐ OK ☐ Change: |
| F13 | ✅ | **Unit and stock type of a material.** | Cannot be changed once the material exists (the history was counted in that unit). Make a new material if it was wrong. | ☐ OK ☐ Change: |
| F14 | ✅ | **Suggestion buttons after an answer.** | Chosen by fixed rules (for example after adding a supplier, "Add its first purchase order" once that exists). They are never written by the assistant. | ☐ OK ☐ Change: |
| F15 | ✅ | **Chat history.** | Each person sees only their own chats, titled by their first words. The owner cannot read the storekeeper's chats. Chats are kept for now (we can set a clean-up period). | ☐ OK ☐ Owner may read all: ☐ Delete after ___ days |
| F16 | ❓ | **Whose key and bill for the assistant.** | The Anthropic key is set on Railway. Cost depends on use; the daily allowance (F3) is the brake. See E3 for who pays. | Who pays: ____________ |

---

## G. Added in milestone 4 — the opening count and stock counts

| # | Status | The question | What we did | Owner says |
|---|---|---|---|---|
| G1 | ✅ | **The opening count: quantity and rate.** | Every material gets a counted quantity; every material **with stock** also gets a rate from its **last purchase invoice**. The invoice number is optional. A rate of ₹0 is refused. Nobody (and not the assistant) estimates a rate. Material counted at zero needs no rate. | ☐ OK ☐ Change: |
| G2 | ✅ | **The sheet shows the System column.** | On a normal count the storekeeper sees what the system expects next to what he counts, and the difference, signed. (The owner dropped blind counting.) The opening count has no System column: everything starts at zero. | ☐ OK ☐ Change: |
| G3 | ❓ | **One count open at a time.** | While a count is in progress, sent back, or waiting for the owner, no second count can start. "Count stock" takes the storekeeper back to the same sheet. | Why: two counts at once would post the same difference twice. ☐ OK ☐ Change: |
| G4 | ❓ | **No normal count before go-live.** | A normal count is refused until the opening count is approved. | ☐ OK ☐ Change: |
| G5 | ❓ | **A new material while the opening count is still being filled.** | It is added to the count automatically (with nothing counted), so it cannot be forgotten. | ☐ OK ☐ Ask each time: |
| G6 | ❓ | **Pieces, rolls and sets must be whole numbers.** | "2999.5 pieces" is refused. Kilograms, metres and litres take decimals (to 4 places). | ☐ OK ☐ Change: |
| G7 | ✅ | **A difference with no reason.** | Saved as "Don't know" (UNEXPLAINED) straight away and never asked again. The reason box starts on "Don't know" and the storekeeper can pick another. Nobody suggests a reason. | ☐ OK ☐ Change: |
| G8 | ❓ | **How a normal count's value is shown to the owner.** | "3 materials differ: ₹4,230 short, ₹180 over". Each difference is valued at the material's **current average rate**. The three biggest differences show on the approval card. | ☐ OK ☐ Change: |
| G9 | ❓ | **Send back.** | The owner sends a count back with a note. One tap on a quick pick ("Please recount all of it", "Something looks too low/high", "A rate looks wrong") fills it, or he types. The storekeeper sees the note on the sheet and fixes the **same** count. | ☐ OK ☐ Other quick picks: |
| G10 | ✅ | **While a count is with the owner.** | The storekeeper can look at the sheet but not change it. The owner can send it back if it needs a fix. | ☐ OK ☐ Change: |
| G11 | ❓ | **Who is told what.** | Owner: "count waiting" when it is sent. Storekeeper: "recount needed" (with the owner's note) or "approved". It shows once, at the top of the next new chat, and is then marked read. Email to the owner comes with purchasing (milestone 6). | ☐ OK ☐ Change: |
| G12 | ❓ | **If any stock is recorded after the opening count started.** | Approving it is refused ("it would count that stock twice"); the owner sends it back. Starting an opening count when stock already exists is refused too. | ☐ OK ☐ Change: |
| G13 | ❓ | **Count date.** | May be today or earlier, never in the future. | ☐ OK ☐ Change: |
| G14 | ❓ | **Who may count.** | Storekeeper and owner both (the owner as back-up). Only the owner approves or sends back. | ☐ OK ☐ Change: |
| G15 | ❓ | **Stock value.** | "What is my total stock value?" is owner only (see A9). It uses each material's running average. | ☐ OK ☐ Storekeeper may see: |

---

## H. Added in milestone 5 — customers' POs, jobs and the BOM

| # | Status | The question | What we did | Owner says |
|---|---|---|---|---|
| H1 | ✅ | **A repeat order is a new job with a new BOM.** | Nothing is ever copied from an old job. "Same as last time" still asks for the BOM. | ☐ OK ☐ Change: |
| H2 | ✅ | **BOM quantities are per piece.** | The total for the whole job is worked out and shown before saving. If a number sounds like a total ("9.2 kg for this job") the assistant asks first. | ☐ OK ☐ Change: |
| H3 | ❓ | **Grams and millilitres on the BOM form.** | Wire and varnish lines start in grams and millilitres (how the shop says it); the system keeps kilograms and litres. 18.4 g is stored as 0.0184 kg and the total shows in kg. | ☐ OK ☐ Change: |
| H4 | ❓ | **Pieces per piece.** | A BOM line for pieces (cores, bobbins) must be a whole number: "2.5 cores each" is refused and asks about the unit. | ☐ OK ☐ Change: |
| H5 | ❓ | **"Unusual" numbers are asked once.** | More than **1,00,000 pieces** on a job, or less than **0.0001** (kg, L, m) per piece on a BOM line, shows "Is that right?" with a tick. | ☐ OK ☐ Limits: |
| H6 | ❓ | **A customer PO.** | Unique per customer (any capital or spacing counts as the same). A second entry of the same number says "already recorded" and adds nothing. Each item released under an open PO is its own job. | ☐ OK ☐ Change: |
| H7 | ❓ | **Job date.** | Today by default; any date may be typed. A due date cannot be before the job date. | ☐ OK ☐ Change: |
| H8 | ✅ | **A sample is its own job** linked to the production job it comes before (a sample of a sample is refused). Its cost is the company's. | | ☐ OK ☐ Change: |
| H9 | ❓ | **Changing the BOM.** | Allowed only while nothing has been issued to the job; it replaces the whole BOM. After that, extra material is a top-up issue. | ☐ OK ☐ Change: |
| H10 | ❓ | **Cancelling a job.** | Only while nothing has been issued, with a reason, and not while a sample job still hangs under it. The job stays in the list as "Cancelled". | ☐ OK ☐ Change: |
| H11 | ❓ | **The shortage check.** | After a BOM is saved the system compares what the job still needs with what is in stock (it does not count what other open jobs also need) and offers a purchase order for the shortfall. | ☐ OK ☐ Also count other jobs: |
| H12 | ❓ | **Settings for the owner.** | The owner has "Settings" in the menu under his name. It is a form, so it works even when the assistant is off. | ☐ OK ☐ Change: |

---

## I. Added in milestone 6 — purchasing and receiving

| # | Status | The question | What we did | Owner says |
|---|---|---|---|---|
| I1 | ✅ | **The approval limit.** | Read from Settings every time (₹50,000 to start). A PO **above** it waits for the owner; **at or below** is approved at once. The storekeeper is told which happened. The limit is compared with the total **including GST**. | ☐ OK ☐ Change: |
| I2 | ✅ | **Rates are typed, never invented.** | The form shows the last rate paid as a hint with a "Use ₹812" button; nobody and nothing fills a rate in. | ☐ OK ☐ Change: |
| I3 | ❓ | **A rate far from the last one.** | Under **half** or over **double** the last rate paid for that material: the form asks "is that right?" once. | ☐ OK ☐ Limits: |
| I4 | ❓ | **Approved POs cannot be edited.** | Cancel it (only while nothing has come) and raise it again. | ☐ OK ☐ Change: |
| I5 | ✅ | **The owner approves or rejects, one at a time,** with what he needs on the card: supplier, every line, the total, the job. A rejection needs a reason; quick picks: "The rate is too high", "Not needed now", "Wrong supplier", "Order less". | | ☐ OK ☐ Other picks: |
| I6 | ❓ | **Rejected goods in the ledger.** (A2, the same question) | A receipt posts a RECEIPT for **everything that arrived** and a REJECT_RETURN for what was sent back. Stock ends right. **One side effect: the average price is worked out as if the rejected pieces had come in. Example: 100 kg at ₹800 in stock, 50 kg arrive at ₹812 and 3 kg go back: this way the average is ₹804.00; "accepted only" gives ₹803.81.** The other way posts only the accepted quantity and notes the rejection on the receipt. | ☐ (b) as built ☐ (a) accepted only: |
| I7 | ❓ | **A receipt's date.** | Today or earlier, never the future, and not before the **first of this month**. | ☐ OK ☐ Change: |
| I8 | ❓ | **Material arriving for a PO the owner has not approved.** | Allowed after a tick ("has it really arrived?"); the PO stays waiting for him and he is told. | ☐ OK ☐ Not allowed: |
| I9 | ❓ | **A rate that moved after a receipt.** | More than **5%** from the last receipt of that material: the storekeeper is told, and so is the owner. (The acceptance script's example, ₹812 to ₹845, is 4.1%, so at 5% it would not be flagged.) | ☐ 5% ☐ Lower: ___% |
| I10 | ❓ | **Email to the owner.** | If email is set up on Railway, the owner gets an email for: a PO or a count waiting, a rate that moved. Only him. It goes to the "Owner notification email" in Settings. | Which address: ____________ |
| I11 | ❓ | **Over-delivery.** | If more arrives than was ordered it is received as it is (no stop). The PO shows as received. | ☐ OK ☐ Warn / refuse: |
| I12 | ❓ | **Who may receive stock or raise a PO.** | Storekeeper and owner both. | ☐ OK ☐ Change: |

---

## J. Added in milestone 7 — giving out, taking back, closing, scrap, corrections

| # | Status | The question | What we did | Owner says |
|---|---|---|---|---|
| J1 | ✅ | **Material is given out all at once, against the BOM.** | "Issue for job 31" gives out everything the BOM still needs, once; a second press finds nothing left. The form lists each material with its quantity and unit before anything is given out. | ☐ OK ☐ Change: |
| J2 | ❓ | **Extra material (rework).** | More than the BOM needs, or a material that is not on the BOM, can only go out ticked **"Extra, for rework"**. It is marked in the history and shown as "extra" when the owner asks whether a job used more than planned. | ☐ OK ☐ Change: |
| J3 | ✅ | **Stock may go below zero.** | It is allowed, recorded, said in one sentence, and the owner is told. Nobody is blocked or lectured. | ☐ OK ☐ Change: |
| J4 | ❓ | **A standing material falling below its minimum.** | Said, and the **owner and the other storekeepers** are told. A "Raise a PO for …" button offers the shortfall (no rate). Told only when this issue is the one that crosses the minimum. | ☐ OK ☐ Also tell the one who gave it out: |
| J5 | ✅ | **Returns.** | Go back in at the **current average price** (never typed). Only what is out with that job can come back. | ☐ OK ☐ Change: |
| J6 | ❓ | **After a job is closed.** | Nothing can be returned to it or reversed on it, because its cost is fixed. If something was forgotten, there is no way to add it yet. | ☐ OK ☐ Allow the owner to reopen a job: |
| J7 | ✅ | **Closing a job asks what came back.** | If material went out and none came back, the form asks "Did any material come back?" and needs "Nothing came back" ticked. Never assumed. | ☐ OK ☐ Change: |
| J8 | ❓ | **A job with nothing given out cannot be closed.** | It says to cancel it instead. | ☐ OK ☐ Change: |
| J9 | ❓ | **Who sees what a job cost.** | The **owner** is shown the material cost and the cost per piece when a job closes. The storekeeper is told the job is closed and that the cost is in the owner's report. | ☐ OK ☐ Storekeeper may see: |
| J10 | ❓ | **A job that used too much.** | When a job closes, any material used more than **5% over** its BOM is said and the owner is told. | ☐ 5% ☐ Change to ___%: |
| J11 | ❓ | **A sample job.** | Closes like any job; its saved card says its cost stays with the company. Reports will show it separately. | ☐ OK ☐ Change: |
| J12 | ❓ | **Scrap.** | Only a material marked as scrap takes scrap. Scrap comes in at no value. A sale is to one of your customers, with the rate typed, never in the future. Selling more than collected is recorded and **flagged**. The owner's "scrap sold against collected" shows collected, sold, on hand and the sale value. | ☐ OK ☐ Change: |
| J13 | ❓ | **Corrections (reversals).** | **Owner only**, with a reason. Both rows stay. Can be reversed: an issue, a return, scrap in, a scrap sale, and a whole receipt. Cannot: opening stock and count adjustments (the next count corrects them), a reversal, goods sent back, a receipt that had part sent back, anything on a closed job. Once per entry. | ☐ OK ☐ Change: |
| J14 | ❓ | **At what price a reversal comes back.** | An entry that took stock out comes back at the price it went out at. An entry that brought stock in is taken out at the current average. | ☐ OK ☐ Change: |
| J15 | ❓ | **Who is told of a reversal.** | The person who made the entry, with the owner's reason, at the top of their next new chat. | ☐ OK ☐ Also all storekeepers: |
