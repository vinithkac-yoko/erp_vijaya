# Vijaya Stores — Artifacts, printouts and downloads

The chat is the whole product (INTERFACE.md). Two things open next to it:

- a **form**, to *do* something (record, issue, count, approve) — always a write tool's own form;
- an **artifact**, to *see* something big (a report, a memo, an SOP, a diagram, a chart, a dashboard, a what-if, a long list).

This file is the spec for artifacts. The sandbox that makes them safe is in `SAFETY.md`; the code that
implements both is in `reference/artifacts/` and is **tested in real Chromium** — port it, don't rewrite it.

Why it is built this way: `RESEARCH.md` Part 1 (Claude-style artifacts, sandboxing, LLM-dashboard reliability).

---

## 1. What an artifact is

An artifact is something the AI writes that opens in a locked sandbox next to the chat, like Claude's artifacts. It
comes in **two kinds**; the builder picks the kind, the person never has to:

| Kind | What it is | Use it for |
|---|---|---|
| **`document`** (VDoc, §1.4) | Markdown plus a small header that names the read tools it uses. **No script.** Our own renderer draws it. | Reports, memos, SOPs, explainers, write-ups, **diagrams** (flowcharts, process maps) — anything you read, print or send |
| **`page`** (§1.1–1.3) | An HTML fragment with a `<script>` that calls `vijaya.read` / `openForm` / `ui` / `fmt` | Interactive things: a what-if, filters, anything the person pokes at |

**Rule of thumb: reports, memos, SOPs, diagrams and explainers are documents; an interactive what-if or a page with
filters is a page.** Documents are safer (nothing the model wrote can run), export better (§10) and are the default.
Both kinds are checked, versioned, shared and sandboxed the same way; the rest of this file says "artifact" for both and
names the kind only where they differ.

A **page** is **a small web page written by the AI** — an HTML fragment with a `<script>`. It has three differences from
Claude's own artifacts that matter for a stores system (a document has the first and third too):

1. **The numbers never come from the AI.** The code calls named *read tools* (`vijaya.read('get_stock_value')`);
   the server answers from the ledger. The AI chooses what to show and how; it does not add up, convert or
   type any business figure. A host-provided kit (`vijaya.ui`, `vijaya.fmt`) formats everything.
2. **It can only look and point.** It cannot write, ever. A button may *open a form* (`vijaya.openForm`) — and that
   opens the same PendingAction form as everywhere else; the person still has to submit it.
3. **It is checked, versioned, and shared on purpose** — see §3 and §6.

### 1.1 What a page looks like in code

A body fragment, nothing else. No `<html>`, no CSS (the host supplies the Vijaya look), no libraries:

```html
<script>
(async () => {
  const ui = vijaya.ui;
  ui.heading('Below minimum');
  const r = await vijaya.read('list_reorder_alerts', {});
  if (!r.rows.length) { ui.callout('ok', 'Nothing is below its minimum level.'); return; }
  ui.stats([{ label: 'Materials short', value: r.rows.length }]);
  ui.table({
    columns: [
      { field: 'material', label: 'Material' },
      { field: 'onHand', label: 'On hand', format: 'qty', unitField: 'unit' },
      { field: 'shortfall', label: 'Short by', format: 'qty', unitField: 'unit' } ],
    rows: r.rows,
    rowButtons: [{ label: 'Make PO', onClick: (row) =>
      vijaya.openForm('create_purchase_order', { lines: [{ materialId: row.materialId, quantity: row.shortfall }] }) }],
  });
})();
</script>
```

Working examples (and hostile ones that must fail) are in `reference/artifacts/examples/`.

### 1.2 The API inside the sandbox for pages (all of it)

| Call | Does |
|---|---|
| `vijaya.read(tool, input)` | Runs a **read tool** as the *viewer* (their role), returns `{ rows, … }`. The tool name must be a string literal. |
| `vijaya.openForm(tool, prefill)` | Asks the host to open a **write tool's form** in the chat, pre-filled. Never submits. Rates are stripped server-side. |
| `vijaya.ui.heading / text / callout / stats / table / chart / button` | Draws. `table` takes `columns[{field,label,format,unitField}]` with format `qty \| inr \| number \| percent \| date`, and optional `rowButtons`. `chart` takes `type: 'bar' \| 'line'`, `rows`, `x`, `y`, optional `series` (a field to split by), `format`. |
| `vijaya.fmt.inr / num / pct / qty / date` | Indian grouping (₹1,15,791), units, `2 Oct 2026`. |
| `vijaya.ready` | A promise that resolves with `{ user, theme }` (the viewer's role and light/dark). |

That is the whole surface. No `fetch`, no storage, no cookies, no DOM tricks that leave the frame, no clipboard, no
downloads, no window. Everything in `vijaya.ui` writes with `textContent`, so a material called
`<img onerror=…>` is just text. A table column on an internal field (`id`, `code`, `*Id`) throws — ids never appear.

### 1.3 What the host draws (the artifact cannot touch it)

A footer under every artifact — **"As of 10:42 · list_reorder_alerts · 2 rows"** — written by the host from what the
artifact *actually* read. An artifact cannot hide or fake it. Above it, a small toolbar: **Refresh · Version ▾ ·
Save · Download ▾ · Share (owner)**. **Download ▾** lists the formats for the artifact's kind (§10).

### 1.4 The document kind (VDoc)

A **VDoc** is plain text: a header that names the reads, then Markdown with a few special pieces. The model writes no
JavaScript. The server parses the *same text* to check it (§3) and to export it (§10), and our renderer
(`host/docrender.js`, using `host/vdoc.cjs`) draws it **inside the same sandbox** as a page, with the same footer and toolbar.

Header (between `---` lines): `title:` and `reads:`, one named read per line as `name: tool {json input}`. A document **may
have no reads** (an SOP, an explainer, a diagram); a page may not.

In the text:

| Piece | Written as | Notes |
|---|---|---|
| Normal Markdown | `# ## ###` headings, paragraphs, `**bold**`, `*italic*`, `` `code` ``, `-` and `1.` lists, `>` quote, `---`, plain pipe tables | **No HTML, no links, no images** (a checker error) |
| A number or text from a read | `{{value.total\|inr}}`, `{{alerts.count}}`, `{{job.name}}` | Format after `\|`: `inr num pct qty date text`. **Numbers are only ever bindings, never typed** |
| A table | fenced block `vtable`: `{"from","columns":[{field,label,format,unitField}],"rowButtons":[{label,tool,prefill}]}` | `prefill` may use `$row.field` (e.g. `"quantity":"$row.shortfall"`). Row buttons open a form, same rules as page buttons |
| A chart | `vchart`: `{"from","type":"bar\|line","x","y","series?","format","title"}` | |
| Headline numbers | `vstats`: `[{"label","from","path","format"}]` | |
| A diagram | fenced block `mermaid` | flowcharts, sequence diagrams and the like; drawn with the `mermaid` library at `securityLevel: 'strict'` |

The example, `reference/artifacts/examples/good/stock-report.vdoc`:

````
---
title: Stock position
reads:
  alerts: list_reorder_alerts {}
  value: get_stock_value {}
---
This is where the store stands today. **{{alerts.count}}** materials are below their minimum level, and the stock is worth {{value.total|inr}}.

## Below minimum

```vtable
{"from":"alerts","columns":[{"field":"material","label":"Material"},{"field":"onHand","label":"On hand","format":"qty","unitField":"unit"},{"field":"shortfall","label":"Short by","format":"qty","unitField":"unit"}],"rowButtons":[{"label":"Make PO","tool":"create_purchase_order","prefill":{"lines":[{"materialId":"$row.materialId","quantity":"$row.shortfall"}]}}]}
```

## Value by material

```vchart
{"from":"value","type":"bar","x":"material","y":"value","format":"inr","title":"Stock value by material"}
```

```vstats
[{"label":"Total value","from":"value","path":"total","format":"inr"},{"label":"Materials short","from":"alerts","path":"count","format":"num"}]
```
````

A read-less example with a diagram (`examples/good/receiving-sop.vdoc`) is a title, a `mermaid` flowchart, a numbered list and
a `>` note. The ~5 MB mermaid bundle is injected into the sandbox **only when a document has a diagram**.

What stays the same as a page: the model never computes, ids never show (`id`, `code`, `*Id` are refused in bindings,
columns and charts), empty and error states are real, the footer is written by the host from what was actually read.

---

## 2. When the AI makes an artifact — and when it must not

An artifact is made **only when the person asks for something that is a report, memo, SOP, diagram, chart, dashboard,
comparison, what-if or long list**. It is never made to answer a question. (ChatGPT Canvas opening by itself is the most-complained-about
canvas behaviour — `RESEARCH.md` 1.2.) Smallest output first:

| Ask | Output |
|---|---|
| A fact — "stock of 0.5 mm copper?" | **A sentence.** |
| A short list — "which jobs are open?" (≤ ~10 rows, ≤ 5 columns) | **An inline table** in the chat. |
| "I received…", "issue…", "count…", "new PO" | **A form** (a write tool; PendingAction). |
| "Report on…", "write up…", "SOP for…", "draw the flow of…", "chart…", "dashboard…", "compare…", "list all…" (many rows) | **A document** (§1.4) |
| "What if copper goes to 900?", "let me filter by supplier" (the person will poke at it) | **A page** (§1.1) |
| "Print the PO", "pick list", "count sheet" | **A printout** (fixed template, §9). |
| "Give me this as PDF / Word / Excel", "send me the report" | **A download** (§10) — the format the person names |

If a request fits two rows, give the smaller one and offer the bigger as a chip ("Chart this?"). If the request is
ambiguous in a way that changes the numbers (which period? which unit?), **ask one short question** instead of
guessing. The owner may also say "keep it simple" / "put it in the chat" — respected for the conversation.

A *code-level* guard backs the prompt: `make_artifact` is refused with a plain message if the previous turn's
request was a single-fact read and the person did not say report/chart/dashboard/what-if.

---

## 3. Making and changing an artifact

Two agent tools (not business data; they live in the app layer):

- `make_artifact({ request, kind? })` — `request` is the person's ask in plain words plus anything the agent clarified;
  `kind` (`page` | `document`) is optional — the builder chooses by the rule in §1 when it is left out.
- `edit_artifact({ artifactId, request })` — a change to an existing one (the kind stays the same).

Both call the **artifact builder**, a *separate* model call (`prompts/ARTIFACT_BUILDER.md`, which has a PAGE mode and a
DOCUMENT mode) that is given:

- the request;
- **only the read tools the viewer's role may use** — name, inputs, and the output fields it may display (from
  `reference/artifacts/catalog.ts`, generated from the real registry);
- for a page: the `vijaya.ui` / `vijaya.fmt` API (§1.2); for a document: the VDoc format (§1.4); and good examples of each;
- for `edit_artifact`: the current code or VDoc text.

It returns `{ kind, title, source }` (new) or `{ patches: [{ old, new }], summary }` (edit), via structured output.
`source` is the page's HTML fragment or the document's VDoc text; the server stores it as `source` (§8).

**Then the server, not the model, decides if it is good.** For a **page** that is `checkArtifact`
(`reference/artifacts/artifact-check.ts`):

- forbidden APIs (network, storage, parent/top, navigation, forms, eval, workers, innerHTML, aliasing `vijaya`, …);
- every tool name is a **literal**, exists, is allowed for the role, and is the right kind (`read` vs `openForm`);
- at least one `vijaya.read` — *no data, no artifact*;
- **no business numbers typed into the page or into strings in the script** (`₹…`, `…kg`) — a heuristic; the real controls are the
  builder prompt, tools-computed numbers and the truth tests (a checker can't prove code doesn't compute) and **no rate in an `openForm` prefill**;
- size ≤ 60 KB.

For a **document** it is `checkDoc(source, role)` in the same file:

- the text parses and validates (`DOC_INVALID`): header closed, JSON blocks valid, every binding, table, chart and stat
  names a declared read, formats known, no id-like fields (`id`, `code`, `*Id`);
- every **read in the header** is a real tool, allowed for the role, and a read tool (`TOOL_UNKNOWN`, `TOOL_NOT_ALLOWED`,
  `TOOL_WRONG_KIND`) — a document may have none;
- **numbers only as bindings**: no typed `₹…` or `…kg` in the prose, labels or diagrams (`LITERAL_NUMBER`);
- **no HTML** (`HTML_IN_DOC`) and **no links** (`LINK_IN_DOC`);
- **row buttons** name a write tool that is in `ARTIFACT_OPENABLE_FORMS`, with **no rate** in the prefill (`RATE_IN_OPENFORM`);
- **mermaid** blocks are refused if they contain script, `click`, `href`, `%%{init}`, `<img>`/`<iframe>`, event handlers, or are
  over 6000 characters;
- size ≤ 60 KB (`TOO_BIG`).

It also reports `reads`, `forms`, `ownerOnly` and `usesMermaid`. `canShareDoc(source)` refuses sharing when any read or
row-button form is owner-only, exactly like `canShare` for pages.

If it fails, the exact messages go back to the builder; **up to 3 repairs**; then the person sees "I couldn't build
that — here's what I can show instead" with the nearest inline table. A failure never opens a broken panel.

### 3.1 Edits are patches that must match

Claude's own artifact editor has a known failure: an edit that matches nothing is acknowledged as done
(`RESEARCH.md` 1.3). Ours cannot do that:

- every `old` string must appear **exactly once** in the current code (for a document: **in the VDoc text**), else the patch is rejected with
  `PATCH_NO_MATCH` and the builder retries (3×, then a full rewrite is allowed);
- after applying, the **whole artifact is re-checked** (`checkArtifact` or `checkDoc`), and its set of read tools (a document's header reads) may not silently shrink — if the
  builder dropped a read it must say so in `summary`, which is shown to the person ("Removed the scrap table.");
- the person sees `summary` as the message, and the new version is live at once.

### 3.2 Versions

Every make/edit is a **new version** (`ArtifactVersion`, immutable, with the request in plain words and who/what made
it). **Version ▾** lists them ("v3 · 10:42 · 'show only copper'"); **Restore** makes an old one current as a *new*
version (nothing is deleted). All versions are kept for as long as the artifact is.

---

## 4. Where artifacts open

- **Desktop:** the right panel, beside the chat. Never auto-expands over a form the person is filling. The chat
  message that made it carries a card "📊 Below minimum · v1 — Open".
- **Phone:** a full-screen sheet with a **Back** button; the chat is still there underneath.
- It opens **only** on the person's request, and only if no form is open; otherwise the chat card is shown and the person
  taps it. Never as a side effect.
- `openForm` from an artifact is limited to everyday work forms (receipt, issue, return, PO, job, count start, scrap,
  new material/party) — never admin or approval forms — and is throttled (SAFETY §3).

---

## 5. Saving, finding, deleting

- **Save** (a star in the toolbar) keeps an artifact under **Saved** (top-bar menu). Unsaved artifacts stay in their
  conversation and are found by scrolling or "Show me the stock report from yesterday".
- Opening a saved artifact **re-runs it with live data** — only the code is stored, never the numbers. The footer's
  "As of" always says when.
- The agent finds them: `list_artifacts` / `open_artifact` ("open my reorder report").
- **Delete** (in Saved) archives it; the owner can see the audit trail. Nothing is physically removed while it is shared.

---

## 6. Sharing — owner to storekeeper, on purpose

The owner may share one artifact with the storekeeper. Rules, all enforced in code:

1. Sharing is **a write tool with a form** (`share_artifact`, owner only; PendingAction like any write). The form
   shows the title, the **version being shared**, and who gets it.
2. The storekeeper gets **a frozen copy of that version**. If the owner edits later, the storekeeper's copy does **not**
   change until the owner shares the newer version ("Update the storekeeper's copy"). The storekeeper sees
   "Shared by Kasi · version 2 · 2 Oct".
3. **Refused if the artifact uses any owner-only tool** (stock value total, leak, job cost, scrap, activity) —
   `canShare()` in `artifact-check.ts`. The message says which tool, and the agent offers to make a version without it.
4. The shared artifact runs with the **storekeeper's role**: every `vijaya.read` is re-checked by `runTool` for *his*
   role. Sharing can never widen what he can see.
5. The storekeeper **cannot share, publish or edit** a shared artifact. He can make his own artifacts for himself.
6. The owner can **unshare** at any time (`unshare_artifact`, owner only). It disappears from the storekeeper's Saved.
7. Share and unshare are in the audit log.

(There are no "menu screens" to publish. Daily work is the form buttons; a shared artifact is how the owner gives the
storekeeper a standing report.)

---

## 7. Keeping the numbers honest

LLM dashboards fail *silently*: a confident chart from a subtly wrong query (`RESEARCH.md` 1.4). So:

- **Reads are named server tools** with fixed meaning (`get_stock_value`, `list_reorder_alerts`, …). The model cannot
  write SQL or pick a table.
- **The model does not compute.** `estimate_job_cost` does what-ifs on the server. Anything the artifact needs
  summed already comes as a `total` field or a stats row.
- **The footer** (§1.3) says what was read and when.
- **Truth tests** (`reference/artifacts/host.test.ts`; you extend them with the seeded DB): for each golden artifact,
  Playwright opens it and compares **every rendered number** with the same read tool's result. The kit's version
  proves the pipeline with fixtures; yours proves it with real tools at milestone 9.
- **Empty and error states are real:** "Nothing is below its minimum level." — never a blank panel. A failed read shows
  "Couldn't load that. Try again." with a Refresh button, never a stack trace.

---

## 8. Artifact data model

```
Artifact        { id, ownerId, conversationId, title, kind: 'PAGE' | 'DOCUMENT', status: ACTIVE | ARCHIVED, savedAt?, currentVersionId, createdAt }
ArtifactVersion { id, artifactId, n, source, request, summary, madeBy: AGENT | RESTORE, checkReport (json), createdAt }   // immutable
ArtifactShare   { id, artifactId, versionId, toUserId, sharedById, sharedAt, revokedAt? }
```

`source` is text — the page's HTML fragment, or the document's VDoc text, according to `Artifact.kind` — and is re-checked
(`checkArtifact` / `checkDoc`) every time it is opened for a different role. The kind never changes after creation. The Postgres role the app uses
cannot `UPDATE` an `ArtifactVersion` (trigger, like the ledger).

---

## 9. Printouts (fixed, never generated)

Anything that **leaves the building or goes to the shop floor** prints from one of five **code-owned templates** with
the Vijaya letterhead. The model can *open* them; it can never write or change them.

| Template | For | Roles | Notes |
|---|---|---|---|
| `purchase-order` | the supplier | both | GSTINs, HSN, CGST+SGST **or** IGST by state, signature block; a "NOT APPROVED" mark unless the PO is approved |
| `goods-receipt-note` | the file | both | accepted / rejected split, invoice number |
| `issue-slip` | the shop floor | both | pick list for a job: material, quantity, unit, location |
| `count-sheet` | the counter | both | one row per material with a **System** column and an empty **Counted** column |
| `job-cost-sheet` | the owner | owner | material cost per job and per piece |

(The count sheet shows the system quantity again — blind counting was dropped by the owner.)

Rendered server-side to PDF (React-PDF or Playwright print), opened in the panel with **Print** and **Download PDF**.
`checkPrintRequest()` enforces the role. A chat message "Print the PO for Sundaram" opens the PO printout directly.

## 10. Downloads and exports

**Any table in the chat, and any artifact, can be downloaded.** The formats depend on the kind
(`FORMATS_BY_KIND` in `reference/artifacts/export.ts`):

| Kind | Formats |
|---|---|
| `document` | **PDF · Word (docx) · Excel (xlsx) · CSV · PNG · Markdown (md)** |
| `page` | **PDF · PNG · Excel · CSV** (the Excel/CSV come from the tables on screen) |

The person asks in words ("send me this as PDF", "give me the report in Word") or uses **Download ▾** in the toolbar
(INTERFACE.md §5). The assistant offers the format the person names; if none is named it offers PDF for something to read,
Excel for a table. A format the kind does not have is refused in plain words ("A page can't be downloaded as Word. PDF?").

**Rules, all enforced in code (`exportArtifact`):**

1. **Made on the server, never from the browser.** The server re-reads every read the artifact makes (a document's header
   reads; a page is run again in the headless browser and its `vijaya.read` calls are answered) through `runTool` **with the
   downloader's role**. It never accepts rows or a rendered file from the browser. The file is never older than the footer says.
2. **The downloader's role decides.** A storekeeper who downloads a shared artifact gets only what *he* may see; one that
   reads an owner-only tool is refused ("This isn't available to you.") and the server is never asked for the data. The
   export cannot be used to get around a role. The source is re-checked (`checkDoc` / `checkArtifact`) for that role first.
3. **PDF and PNG** are drawn by **headless Chromium** from the same sandbox page the person sees, in **print** mode (buttons
   and the toolbar are hidden), with **every network request refused and recorded** — if anything tried to leave, the export
   **fails** (`LEAK`) and nothing is returned. A4, with margins. The path to Chromium is `CHROMIUM_PATH`.
4. **Word** is made by **pandoc** from the document's resolved Markdown: bindings are replaced by the real formatted numbers,
   **all database and author text is backslash-escaped** (so a material named `![x](/etc/passwd)` stays text and pulls in no
   file) and raw HTML is off (`-gfm-raw_html`). Charts and diagrams are inserted as **PNG pictures** taken from the rendered page.
5. **Excel** is made by **exceljs** with **real numbers** (not text), ₹ with Indian lakh/crore grouping, quantity unit
   formats (`#,##0.### "kg"`), one sheet per table and per chart's data; **no cell is ever a live formula**. **CSV** is one table (the first, or
   `table: n`); a cell that starts with `=` `+` `-` `@` is neutralised with a leading `'`.
6. **PNG** is limited to **16,000 px** tall; longer than that the person is told "too long for one picture — PDF?".
7. **Markdown** is the resolved text, with the diagram source in a `mermaid` fence.
8. A document with no table cannot be Excel/CSV, and says so in plain words.
9. **Filename:** `<title-as-slug>-<YYYY-MM-DD>.<ext>`, e.g. `stock-position-2026-10-02.pdf`.
10. Every download is **audited** (who, which artifact and version, format, role).

**Printouts (§9) are separate:** the five code-owned templates (PO, GRN, issue slip, count sheet, job cost sheet) stay the
way to put something on paper with the letterhead; this section is for artifacts. The sandbox still has no
`allow-downloads` and no `allow-modals`: the file is made and offered by the **app**, not by the artifact.

Nothing is ever emailed from the app except the owner's notification email. (This section replaces v4's statement that
there is no PNG/PDF of artifacts.)

---

## 11. Limits

| Thing | Limit |
|---|---|
| Artifact source (page HTML or VDoc text) | 60 KB |
| One diagram | 6,000 characters |
| PNG export | 16,000 px tall |
| Reads per artifact per 10 s | 20 (host) — the server rate-limits per user as well |
| One read result | 2 MB |
| One bridge request | 20 KB |
| Builder repairs | 3 |
| Artifacts built per user per hour | 20 (cost guard) |
| Versions per artifact | 100; at the limit the assistant offers to save a copy as a new artifact (versions are never deleted) |

## 12. What the app must do around the host (don't skip)

1. Send **`Content-Security-Policy: … frame-src about:`** on the page that embeds artifacts — without it a hostile
   artifact can leak data by navigating itself (the kit **proves** this: `host.test.ts` → "WHY the header is mandatory").
2. If the page uses **CSP nonces** (Next.js does), pass the nonce to `mountArtifact({ nonce })`: a `srcdoc` frame
   *inherits* the page's CSP, and without the nonce the artifact's inline script is blocked.
3. Wire `runRead` to a Server Action that calls `runTool(session, tool, input)` — **never** trust the host's allow-list
   alone; `runTool` re-checks the role.
4. Wire `onOpenForm` to `createPendingAction(tool, sanitizePrefill(tool, prefill, 'artifact'))` and show the form card.
5. Run the **truth tests** and **hostile tests** in CI — including `documents.test.ts` and `export.test.ts`.
6. Wire the export route to `exportArtifact({ kind, source, role, format, runRead })` where `runRead` is `runTool` with the
   **downloader's** session; install `pandoc` and a Chromium on the server and set `CHROMIUM_PATH`.
7. Ship the `mermaid` npm package with the host assets (the host injects it only for documents that have a diagram).
