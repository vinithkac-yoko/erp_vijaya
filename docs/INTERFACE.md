# Vijaya Stores — The interface (chat only) and design tokens

One screen: **the chat**. Forms open in it. Big things (artifacts, a large form, a printout) open in a panel beside
it. There are no fixed screens and no menu of screens. Rules below: **MUST** is non-negotiable; **SHOULD** is the
default unless there's a strong reason. The owner approved the look of `reference/prototype.html` (colours, stamps);
its old three-column layout is replaced by this file.

Research and sources: `RESEARCH.md` Part 2 (chat-first UI, lower literacy, keyboard) and Part 1 (artifact panels).

---

## 1. Who we design for

**Storekeeper (desktop, all day):** reads English but not fluently; finds things by position; types short with typos
and Tamil/Hindi words. One mistake that embarrasses him in front of the owner and he goes back to the notebook.

**Owner (Android phone, between other work):** wants the decision in front of him with the facts to make it, one tap to
act. Rarely does data entry; asks questions.

Consequences:
- **MUST** — the storekeeper's daily jobs need **zero typing to start**: a button opens the form. Free text is for
  questions and the unusual.
- **MUST** — never a blank prompt. Buttons above the input, a card on opening, chips after every answer.
- **MUST** — same task, same form, every time. A form never rearranges itself; it comes from the tool's form
  definition, not from the model.
- **MUST** — plain words (§9). If a label needs explaining, change the label.
- **MUST** — every change shows what will happen before it happens, in his units and names.

## 2. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Vijaya Stores        Saved ▾   Chats ▾                       Ravi ▾  ☾  │  top bar (copper coil line)
├──────────────────────────────────────┬───────────────────────────────────┤
│ Chat                                 │ Panel (only when something is open)│
│  ┌ opening card ───────────────┐     │  artifact │ expanded form │       │
│  │ 3 waiting for you …         │     │  printout                         │
│  └─────────────────────────────┘     │  [toolbar: Refresh · v3 ▾ ·       │
│  user: low stock?                    │   Save · Download ▾ · Share]      │
│  assistant: 2 below minimum [table]  │                                   │
│  ┌ form card: Receive stock ───┐     │  ……………………………………………………………………      │
│  └─────────────────────────────┘     │  As of 10:42 · list_… · 2 rows    │
│  [chip] [chip] [chip]                │                                   │
│  [Receive stock][Issue][Count][New PO][More ▾]  ← top 4 used + More       │
│  [Low stock][Open jobs][Stock today][Waiting for me 3]   ← top 4 chips    │
│  [ type here …………………………………… ] [send]                                 │
└──────────────────────────────────────┴───────────────────────────────────┘
```

- **Desktop ≥ 1280 px:** chat flexible (min 420 px, max reading width 720 px); panel 45% when open.
- **768–1279 px:** the panel overlays the chat from the right.
- **< 768 px (owner's phone):** chat full-screen; the panel is a **full-screen sheet with a clear "Back to chat"**; the
  launcher is a horizontally scrolling row; form cards are full-width; buttons at thumb height.
- **MUST** — the panel **never opens by itself over a form someone is filling.** An artifact the person asked for
  opens it; a card "📊 Below minimum · v1 — Open" is always in the chat as the fallback. (Auto-opening canvases are the
  most-complained-about behaviour — RESEARCH 1.2.)
- Top bar: **Saved ▾** (saved artifacts, and "Shared with me" for the storekeeper), **Chats ▾** (history, new chat),
  the user menu (theme, sign out). Nothing else. No rail, no tab bar.

## 3. The launcher (buttons above the input)

Source of truth: `reference/artifacts/launcher.ts` (tested). Built from the **role** and the person's **own use**, never by
the model.

| Button | Kind | Opens | Keys |
|---|---|---|---|
| Receive stock | form | `record_goods_receipt` | Alt+R |
| Issue to a job | form | `issue_material` | Alt+I |
| Return | form | `return_material` | Alt+T |
| Count stock | form | `start_stock_count` → the count sheet | Alt+C |
| New PO | form | `create_purchase_order` | Alt+P |
| New job | form | `create_job` | Alt+J |
| Low stock | ask | "What is below its minimum level?" — badge: how many | |
| Open jobs | ask | "Show the open jobs." | |
| Stock today | ask | "Show stock on hand." | |
| Waiting for me (owner) | ask | "What is waiting for my approval?" — badge: how many | |
| Stock value (owner) | ask | "Make a stock value report." | |

**Top used first, per person.** `launcherFor(role, { countInProgress, usage })` orders the buttons and chips by how often
*this user* has used them. Usage is counted on the server from the audit log (`AuditEvent` rows with `openedFrom: LAUNCHER`)
and from chip taps (`ask:<label>`).

- **At most 4 form buttons and 4 chips are visible.** The rest sit behind **More ▾** (one for forms, one for chips), in the
  same top-used order. Nothing is removed; it is one tap further.
- **The role filter comes first, then the ordering.** Usage can never surface a button the role may not use: a storekeeper's
  count of "Stock value" taps is ignored because he never has that chip.
- **New users and ties keep the default order** (the table above): Receive, Issue, Return, Count, New PO, New job. So the
  first day looks the same for everyone and settles into each person's habits after that.
- **"Continue count" is pinned first** while a count is in progress, whatever the usage.
- **Keyboard shortcuts belong to the tool, not the position.** Alt+R is always Receive, even when Receive has moved behind
  More (`allFormsFor(role)`). Shortcuts are shown on the button and in the "?" sheet.
- The order may change between days, never *during* a conversation (it is read when the chat opens), so a button does not
  move under his finger.

- **MUST** — form buttons: icon + short word, **≥ 44 px** on phone and ≥ 36 px on desktop, with the shortcut shown
  on the button (desktop). They create a PendingAction (origin LAUNCHER, **no prefill**) and show the form card.
- **MUST** — form buttons work when the assistant is off (`AGENT_ENABLED=false`) or the API is down.
- **MUST** — ask chips send a canned message; they never leave the input blank or auto-submit a write.
- Owner-only chips are not rendered for the storekeeper (and the server would refuse anyway).
- **Phone:** the launcher is one horizontally scrolling row (forms, then chips); **More ▾** is the last item and opens a
  bottom sheet with the remaining buttons at full width.

## 4. The opening card

The first message of a new chat is a card drawn by **deterministic read tools** (not model text), so it is instant and
cannot be wrong:

- **Owner:** *"3 waiting for you · 2 below minimum"* with **[Review approvals]** (opens the approval cards in the
  chat) and **[Low stock]**. If there is nothing: *"Nothing is waiting for you."*
- **Storekeeper:** *"4 open jobs · 1 delivery expected today · 2 below minimum"* with the three buttons that answer
  each. A count in progress shows **[Continue count]**.

## 5. After every answer: contextual chips

- **MUST** — after every assistant reply, 2–3 chips that fit what just happened ("Chart this?", "Make a PO for these",
  "Show job 31"). After a form is saved, the chips are the **follow-ups** (TOOL_CATALOG → Follow-ups): the next form,
  pre-filled but **never with a rate**, or a question.
- Chips are single-tap. They either send a message or open a form. They are never destructive.
- Why: a study of a deployed enterprise assistant found over 35% of questions were unrelated to the one before and
  context-aware suggestions beat history-blind ones (RESEARCH 2.2).

## 6. Forms in the chat

One form definition per tool, rendered the same way everywhere it appears.

- A **form card** appears in the chat, pre-filled with what the person said or the button's defaults. The card
  has the primary action labelled with the verb ("Give out material", "Add to stock", "Send to owner", "Approve"),
  never "Submit". After submit it collapses to a one-line **stamp** with the document number ("✓ ISSUED · ISS-…").
- **Big forms expand into the panel** with "Open larger": the **count sheet** (§7) and a multi-line PO or goods
  receipt. Expanding doesn't change the form, only its room.
- Labels above fields, unit inside the field suffix (`kg`). Pickers for materials, suppliers, customers, jobs:
  type-ahead on names with the unit or city as secondary text; spelling-tolerant ("ferite core e30" finds Ferrite
  Core E-30) and shows what it matched. **Never** an id, never a code, never free text for a party.
- **Rate fields are never pre-filled.** If a last rate exists it shows as a hint under the field: "Last paid ₹812/kg ·
  Chennai Copper Wires · 12 Sep".
- When the assistant (or an artifact) suggested values, a small **"assistant filled this in — check it"** badge shows,
  and every suggested field is editable.
- Live computed fields are read-only and look different: BOM *Total needed*, PO line amount, GRN *accepted +
  rejected = received*, PO total vs the approval limit ("Above your limit — goes to the owner").
- Validation inline, in plain words. Submit once: the button disables and shows progress.
- **Not now** dismisses a form (cancels the PendingAction). Opening the same form again replaces the old one.
- **Approvals** are form cards too: what it is, the money, why it exists ("Job 31 needs 982 cores"), and for counts the
  biggest differences. Two actions: **Approve** / **Send back** (asks for a note, with quick picks).
- Inline cards in the chat have at most two actions; anything longer opens in the panel.
- After a save, the **server** draws the confirmation from the audit row. Wrong entry? The owner can reverse it
  (a reversing entry, never a delete); the storekeeper is told plainly that the owner does that.

## 7. The count sheet (the one large form)

The count sheet is the **start_stock_count / submit_count_line** form expanded into the panel (on desktop it takes the
panel at full width and the chat collapses to a slim drawer so he can still ask "what's left?").

- Columns: **Material · Unit · System · Counted · Difference · Reason**. The System quantity is frozen when the count
  starts and **shown** (blind counting was dropped by the owner). Difference is computed, coloured *and* signed;
  Reason appears only when different ("Don't know" first, as an equal choice).
- **Opening count:** Material · Unit · Counted · **Rate ₹** · Invoice no. (optional). No System, Difference or Reason.
  Rate is required and typed.
- **MUST** — keyboard-first: Enter moves down, Tab moves right, numbers only in number cells. Autosaves each row
  with a quiet "Saved"; works over several days.
- Filter: "Not counted yet", "Different", "Missing rate". Progress: "147 of 200".
- "Send to owner" disabled until complete, with the reason shown ("12 materials not counted").
- 200 rows with no lag: virtualised (TanStack Table). The paper version is the `count-sheet` printout.

## 8. Artifacts in the panel

Spec: `ARTIFACTS.md`. Interface rules:

- Opens **only on request**. A card in the chat says what it is and its version; one tap opens it (when no form is open it opens by itself, because they asked).
- A **document** (report, memo, SOP, diagram) reads like a clean page: title, paragraphs, tables, charts, flow diagrams. A
  **page** is for things to poke at (what-if, filters). The person is never asked which; the assistant picks.
- Toolbar (host-drawn, the artifact can't change it): **Refresh · Version ▾ (with Restore) · Save ★ · Download ▾ ·
  Share (owner only)**. Footer (host-drawn): **As of 10:42 · tools · rows**.
- **Download ▾** lists the formats **for this kind** (ARTIFACTS §10):
  - a **document**: PDF · Word · Excel · CSV · Picture (PNG) · Markdown;
  - a **page**: PDF · Excel · CSV · Picture (PNG).
  Items that cannot work are shown greyed with the reason ("Excel — there is no table in this"). One tap downloads; the
  button shows "Preparing…" while the server makes the file (PDF/Word/picture can take a few seconds) and "Couldn't make
  that file. Try again." on failure. A picture longer than 16,000 px says "Too long for one picture — PDF?".
- **Filenames** are plain and dated: `stock-position-2026-10-02.pdf`, `.docx`, `.xlsx`, `.csv`, `.png`, `.md`. No ids.
- The file has **the numbers as of the moment of download, for the person who downloads** (a storekeeper's file never has
  the owner's numbers). The PDF is A4 without the toolbar or buttons.
- It looks like the app: the sandbox gets our tokens (`reference/artifacts/host/tokens.css`) and the `vijaya.ui` kit
  (documents use our own renderer on the same tokens), so an artifact can't look different from the app.
- Phone: full-screen sheet, tables scroll sideways below 600 px (first column fixed), charts keep their table equivalent;
  diagrams scale to the width and can be pinched. **Download ▾** opens a bottom sheet with large rows; the file goes to the
  phone's Downloads / share sheet so the owner can send it by WhatsApp or mail from there.
- Each artifact loads and fails on its own: "Couldn't load that — **Try again**". Empty states are sentences, not blanks.
- After one is made, the reply ends with at most one offer ("Save it?"). If the person named a format, the file is offered at once.

## 9. Words

| Say | Don't say |
|---|---|
| Give out material | Issue transaction, post issue |
| Add to stock | Receipt posting |
| Leftovers back to store | Return movement |
| Count didn't match | Variance |
| Don't know | Unexplained (in buttons; fine in the owner's report) |
| Send to owner | Submit for approval |
| Waiting for the owner | Pending approval status |
| Rate | Unit cost |
| Couldn't find that — check the spelling | Not found / 404 / null |

- Numbers people use on paper (JOB-2627-0031, PO-2627-0015) are fine. Internal codes and ids never appear anywhere —
  chat, tooltips, errors, URLs the user sees, artifacts, printouts, downloads.
- Rupees ₹1,15,791. Dates 12 Sep 2026. Times 10:42 (24-hour, as in the footer).
- **MUST** — about a 6th-grade reading level on buttons, cards and forms; 8th-grade in the assistant's answers: short
  common words, one idea per sentence. (NN/g: rewriting for lower-literacy readers raised task success from 46% to 82%.)
- **MUST** — the most important thing first; single-column forms; no moving or auto-scrolling text.

## 10. Keyboard first (his benchmark is Tally or a register)

- **MUST** — Enter moves to the next field; Ctrl+Enter submits; Esc closes the form or panel; `/` focuses the chat box.
- **MUST** — the same shortcut always opens the same thing: **Alt+R** Receive, **Alt+I** Issue, **Alt+T** Return,
  **Alt+C** Count, **Alt+P** New PO, **Alt+J** New job — **even when the launcher has moved that button behind More** (§3).
  Shown on the buttons and in a "?" sheet.
- **MUST** — no task the storekeeper does daily requires the mouse.

## 11. Chat basics

- User messages right, ink fill; assistant messages left on surface with a copper left border.
- Tool results render as components (inline table, stat card), never as JSON or a pasted list. Inline table: ≤ ~10 rows,
  ≤ 5 columns; more than that is an artifact (if asked) or "Showing 10 of 43 — want the full list as a report?"
- While a read tool runs, a quiet status ("Looking up job 31…"); never a spinner without words.
- Errors read as a sentence with a next step. No codes, no red walls. If the assistant is off: *"The assistant is off.
  The buttons above still work."*
- Links and images from data are never rendered.

## 12. Design tokens

All pairs contrast-checked (WCAG 2.1 AA, 4.5:1 text). Use the tokens; never raw hex in components. The same tokens
are in `reference/artifacts/host/tokens.css` (light + dark) for artifacts.

### Light (default)

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `--paper` | `#F4F0E6` | App background | — |
| `--surface` | `#FFFDF8` | Cards, panel, inputs | — |
| `--surface-sunk` | `#ECE7DC` | Table header | — |
| `--line` | `#D6CDB8` | Borders, dividers | (non-text) |
| `--ink` | `#1B2A38` | Primary text | 14.4 on surface |
| `--ink-soft` | `#4B5C6B` | Secondary text | 6.8 |
| `--ink-faint` | `#66727F` | Hints, timestamps — **on surface only, never on paper** | 4.8 (4.3 on paper ✗) |
| `--copper` | `#A8571E` | Primary action fill, links | 5.1 as text; white on it 5.2 |
| `--copper-deep` | `#8A4516` | Copper text at small sizes, hover | 7.0 |
| `--copper-wash` | `#F1E3D3` | Selected rows, chips | — |
| `--alert` | `#A63A2E` | Negative stock, rejected, destructive | 6.3 |
| `--alert-wash` | `#F4DFDA` | Alert backgrounds | — |
| `--confirm` | `#2F6148` | Approved, matched, success text | 7.1 |
| `--confirm-wash` | `#DEEBE3` | Success backgrounds | — |
| `--attention` | `#8A5A00` | Below minimum, pending | 5.8 |

### Dark

| Token | Hex |
|---|---|
| `--paper` | `#121A22` |
| `--surface` | `#1B2530` |
| `--surface-sunk` | `#243241` |
| `--line` | `#34465A` |
| `--ink` | `#ECE7DC` |
| `--ink-soft` | `#A8B3BE` |
| `--ink-faint` | `#93A1AE` |
| `--copper` | `#E0995C` |
| `--copper-deep` | `#F0B27F` |
| `--copper-wash` | `#3A2B20` |
| `--alert` | `#F08A7E` |
| `--alert-wash` | `#3B2522` |
| `--confirm` | `#7CC4A0` |
| `--confirm-wash` | `#1F3329` |
| `--attention` | `#E6B45A` |

Theme follows the device by default, with a toggle stored per user.

### Type, shape, motion

- **IBM Plex Sans** for UI and body; **IBM Plex Mono** for numbers in tables, quantities, document numbers;
  **Space Grotesk** for titles and the brand only. Body 16 px minimum on forms. Numbers right-aligned, tabular, unit in
  a lighter weight: `142.6 kg`. (Inside artifacts: system fonts only — the sandbox loads no fonts.)
- Radius 4 px (cards, inputs), 999 px (chips). Borders over shadows; one soft shadow for the panel.
- Motion 150–200 ms, ease-out; only for panel open/close, row highlight, toast. Respect `prefers-reduced-motion`.
- Brand moments, sparingly: the copper coil line in the top bar; the dashed rubber **stamp** on a completed
  confirmation ("✓ ISSUED", "✓ APPROVED BY OWNER").

## 13. Charts (inside artifacts)

- Bar for comparisons, line for trends over time; donut only for 2–5 parts of a whole (not in the kit yet — use a bar).
  No 3D, no gradients, no dual axes. Title says the finding or the question ("Where stock went missing this quarter");
  axes have units; values formatted (₹, kg).
- Palette from the tokens: copper, ink-soft, confirm, attention, alert — **never more than 5 series**; beyond that, a table.
- Every chart has its table nearby (the artifact usually has both).
- Diagrams (flowcharts, process maps) are Mermaid inside a document: keep them to what fits on a phone width (about 8 boxes
  across); long processes are drawn top-to-bottom.

## 14. Accessibility

- WCAG 2.1 AA in both themes; visible copper focus ring everywhere; the whole app works by keyboard.
- Targets ≥ 44 px on phone, ≥ 36 px on desktop for launcher buttons, ≥ 24 px minimum anywhere (WCAG 2.2 SC 2.5.8).
- Status never by colour alone (icon + text + sign). Screen-reader labels on icon buttons.
- `prefers-reduced-motion` respected.

## 15. Speed budgets

| What | Budget | If slower |
|---|---|---|
| Typing, switching, expanding a form | 0.1 s | — |
| Opening a form from a button | 0.5 s | Skeleton, no spinner |
| Assistant's first words | 2 s | "Looking up job 31…" status |
| Answer with tools | 10 s | Step-by-step status |
| Making an artifact | 10–20 s typical | Staged: Building → Checking → Ready |
| Opening a printout | 2 s | Skeleton of the A4 page |

## 16. Tables (inline and in artifacts)

- Text left, numbers right in a tabular font; header aligned like its column. Thin row dividers, no zebra. Sticky header.
- Negative quantities in alert colour **with a minus sign**; below-minimum with an icon and text, not colour alone.
- Owner tables show value columns. Row buttons appear on hover and keyboard focus.
