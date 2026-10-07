# Vijaya Stores — things to confirm with the owner

For the demo. Every choice we made, or assumed, that is really the owner's call. Nothing here is hidden in the code:
if the owner says "change it", it is a small change.

**How to use it:** go through the list top to bottom. For each, read the "What we did" line aloud, then tick the owner's
answer. If he wants a change, write it in the last column. We keep this file up to date: new decisions are added at the
bottom of each milestone's section.

- ✅ = Kasi already agreed. The owner should still hear it once.
- ❓ = nobody has agreed yet. **These are the important ones.**

Last updated: after milestone 2. Milestone 3 decisions are added when it is built (see the end).

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

## F. Added in milestone 3

*(filled in when milestone 3 is built)*
