# Vijaya Stores — Research: why it is built this way

What the research says, and the decisions it led to. Sources are at the end: **S1–S21** are the
artifact, chat-UI and sandbox research done for design v4; **O1–O17** are older sources kept
because they are still true. Other documents refer to this file by section number
(`RESEARCH 1.2`, `RESEARCH 2.2` and so on), so keep the numbering stable.

Two kinds of claim are mixed in here and are kept apart on purpose: what **others reported**
(with a source) and what **we proved ourselves** (a test in this kit). Where a source was only a
search snippet it says so. Where nothing could be found, it says that too.

---

## Part 1 — Artifacts and sandboxing

### 1.1 What Claude's artifacts are, and how they are built

- Claude artifacts are "significant and self-contained, typically over 15 lines" content:
  dashboards, documents, interactive tools. They open in a side panel and are saved to an
  Artifacts tab. They are private until published. You edit by asking Claude. Paid plans can
  connect to apps and persist data. [S1]
- Anthropic describes them as **iframe sandboxes** with full-site process isolation plus strict
  CSPs that limit network access. Details of its postMessage design are not published. [S2b]
- Editing mechanics: Claude chooses "update" (an exact `old_str` → `new_str` replacement that
  must match exactly once), "rewrite" (full regeneration) or "create". Small edits are fast;
  complex refactors force a full rewrite. [S2]
- Willison's write-up of how Anthropic built artifacts, and his later Chromium/Firefox test of the
  CSP-in-iframe technique [S13], are the basis for our sandbox (1.5).

**Decision.** Our artifacts follow the same shape: model-written content shown beside the chat in a
sandboxed iframe (HTML plus a script for interactive pages; script-free Markdown "documents" for reports, SOPs and diagrams, see 1.6), versioned, editable by asking, saveable. They differ where the evidence below
says Claude's own version is weak: ours are **read-only** (they can only read through named read
tools and ask the host to open a form), their **numbers are never computed by model-written
code**, and their edits are **must-match patches with stored versions**. Spec: `docs/ARTIFACTS.md`.

### 1.2 Canvases that open unasked

- ChatGPT Canvas: the main forum complaint is that it opens automatically even when the user
  wants an inline answer; users say disabling it in settings does not reliably stop it, and the
  only workaround is repeating "respond inline, do not open Canvas". They ask for user-initiated
  activation. [S5]
- Critique of the chat box: chat maximises Norman's gulfs of execution and evaluation, and
  Canvas/Artifacts are described as GUI patterns retrofitted onto chat. [S6]
- Claude's own trigger rule (substantial, self-contained content) is the explicit guard against
  artifacts for tiny answers. [S1]

**Decision → we open an artifact only on request.** A single fact ("stock of 5kVA core?") is
answered in a sentence; a short table stays in the chat; an artifact opens only when the person
asks for a report, memo, SOP, diagram, chart, dashboard, comparison, what-if or long list. It is a hard rule in the
agent prompt and a code-level check, and the panel never opens over work in progress.

### 1.3 Editing failures: a patch that matches nothing is "acknowledged"

- When `old_str` matches nothing, the model was reported to get an "OK" with no error, so it
  claims changes that were never applied. [S3]
- Manual edits to a proposed diff are unknown to the model and get discarded. [S2]
- Regressions are a general complaint about LLM editing: Claude Code issue threads report it
  "silently reverts existing features when making unrelated changes" and "rewrites from scratch,
  breaking what worked". These are Claude Code, not the artifact panel, so this is indirect
  evidence only. [S4]

**Decision → must-match patches plus versions.** An edit is applied only if its `old` text
matches exactly once; otherwise the tool returns an error the model must handle, and nothing is
saved. Every successful edit makes a new stored version; the previous one stays one tap away
("Previous version", "Restore"). After every edit the fixed checks re-run (it renders; the
numbers still come from tools; the row count did not silently drop). See `docs/ARTIFACTS.md`.

### 1.4 LLM-built dashboards fail silently

- dbt's 2026 benchmark: text-to-SQL scored 90.0% (Claude Sonnet 4.6) and 84.1% (GPT-5.3-Codex);
  a semantic layer scored 98.2% and 100%, and failed explicitly when out of scope instead of
  returning plausible wrong answers. Adding 3 minimal models lifted text-to-SQL by 25.5 points.
  It was 11 questions on one dataset and dbt sells semantic layers, so there is vendor bias. [S17]
- Basedash: hallucinations occur in generated SQL (joins, filters, metric definitions), in chart
  choice and in narrative text. The worst failure is silent: "a confident answer with a clean
  chart, derived from a subtly wrong query". Its mitigations: a semantic layer, showing the SQL and
  row counts, checking against validated baselines, descriptive not causal narrative, confirming
  ambiguous requests, human review before anything recurring. Also a vendor blog. [S18]
- AtScale (vendor) makes the same point: the same question on business data can return different
  answers across runs. **Snippet only; not fetched.** [S19]

**Decision → tool-computed numbers, a footer, truth tests.** Totals, stock levels, valuations and
averages come only from named server-side read tools (our "semantic layer"); the artifact
formats and charts what they return, using the host's helpers. Every artifact shows a footer
(data as of, tool names, row count). A truth-test suite runs on render (for example, report total
equals the ledger total; no unexplained negative) and shows a red banner on a mismatch. An
ambiguous request gets a one-line question rather than a guess. See `docs/ARTIFACTS.md`,
`docs/SAFETY.md`.

### 1.5 Sandbox security

What others recommend:

- Three layers for untrusted agent-written HTML. [S12]
  - `sandbox="allow-scripts"` (add `allow-forms` only if needed) **without** `allow-same-origin`:
    an opaque origin with no access to the parent DOM, cookies or storage. The sandbox alone does
    not block outbound fetches or image loads.
  - A **meta CSP** such as `default-src 'none'; img-src data: blob:`, enforced at parse time.
  - A **MessageChannel** port to the parent with an explicit allow-list.
- Never combine `allow-scripts` with `allow-same-origin`: the framed code could remove its own
  sandbox. Any origin added to the CSP allow-list becomes an exfiltration channel. A meta CSP
  cannot carry `frame-ancestors` or reporting. [S12]
- Willison tested Chromium and Firefox: JavaScript inside `sandbox="allow-scripts"` could not
  remove, change or replace a meta CSP, and it persisted through a `data:` URI navigation. [S13]
- postMessage pitfalls: [S14] missing origin checks; sloppy validation (`indexOf`, regex);
  wildcard `targetOrigin` leaks; `allow-popups` without `allow-popups-to-escape-sandbox` lets
  popups share the `null` origin; `e.source` can be null if the sender frame is removed right
  after posting. A sandboxed frame's origin is the string `"null"`, so **origin is useless as
  identity** — authenticate by `e.source === iframe.contentWindow` or by a MessageChannel port.
- OWASP LLM Top 10 (2025): LLM01 prompt injection; LLM05 improper output handling (treat model
  output as untrusted input; sanitise or encode it); LLM06 excessive agency (minimal functions
  and permissions, human approval for high-impact operations). [S15]
- **EchoLeak** (CVE-2025-32711, Microsoft 365 Copilot) was a zero-click exfiltration: a crafted
  email bypassed the injection classifier, reference-style Markdown links evaded redaction, an
  auto-fetched image URL carried the stolen data, and an allow-listed Teams preview endpoint got
  past the CSP. Lesson: the allow-listed host was the hole and rendered output was the channel. [S16]
- No public exploit of Claude's artifact sandbox itself turned up in our searches.

**Decision.** `sandbox="allow-scripts"` only (no same-origin, forms, popups, modals, downloads or
top-navigation); srcdoc with a meta CSP of `default-src 'none'` plus inline script and style; all
helpers bundled inline, no CDN allow-listed; a MessageChannel bridge with a method allow-list
(read tools by name, and "open form X with prefill"); the host identifies the sender by port and
`e.source`, never `e.origin`; artifact text is rendered with `textContent`; no write tool is
reachable from an artifact; prefilled values are untrusted input to the form, and the form's own
server-side validation and confirm step still apply. Spec and threat table: `docs/SAFETY.md`.

**What we proved ourselves in Chromium** (our tests, not a source; `reference/artifacts/host.test.ts`,
real Chromium through playwright-core):

- **(a)** Frames created from `srcdoc` **inherit the embedding page's CSP**. With a nonce-based
  page CSP the artifact's own scripts are blocked unless the host **stamps the nonce on the scripts
  inside the srcdoc**. So the embedding page must pass its nonce to the host.
- **(b)** Without `frame-src about:` on the **embedding page**, a hostile frame that navigates
  itself **does leak data** (reproduced in `host.test.ts`, the "WHY the header is mandatory" test).
  The meta CSP inside the frame cannot stop this on its own. The page header is therefore
  mandatory, not hardening.
- **(c)** A meta CSP **cannot be removed from inside** the frame; the in-frame attempts in our
  hostile examples failed. This agrees with [S13].
- **(d)** DNS prefetch and WebRTC are **not governed by CSP**, and we **could not prove them
  closed** in the proxied test container (the DNS-prefetch case is `examples/hostile/dns-prefetch.html`).
  We treat them as a **residual risk**, stated in `docs/SAFETY.md` §3, and reduce what is at stake
  rather than claim it is closed: an artifact is read-only, holds no secret, and can only read
  what the viewer's role already allows.

### 1.6 Documents, diagrams and exports (design v5)

This subsection is our own reasoning and tests, not a cited source; the sources for the sandbox are in 1.1 and 1.5.

- **Why a second kind.** Most of what the owner asks for is something to *read, print or send* (a report, a memo, an SOP, a
  flow diagram). That needs no script at all. So a **document** is Markdown plus named reads and bindings: the model writes
  no code, the server can parse the same text to check it and to export it, and the numbers are bindings, never typed.
  A **page** (script) stays for what is poked at: a what-if, filters. Claude's own artifacts let the model write code for
  everything; for a stores system the safest working default is to remove the code wherever the job does not need it.
- **Diagrams** use the open-source Mermaid library inside the same sandbox at `securityLevel: 'strict'`. Mermaid's own
  config can switch strictness off (`%%{init}`), and diagrams can carry `click` handlers and links, so the checker refuses
  those and the hostile tests run diagram text that skipped the checker (`documents.test.ts`).
- **Exports are a second attack surface** because database text lands in files other programs open. Our tests show the three
  that matter: a material named `![x](/etc/passwd)` can become a local-file image in Word if the text reaches pandoc as
  Markdown (so it is backslash-escaped and raw HTML is off); a cell beginning `=` runs as a formula in Excel and CSV (so
  text is neutralised and nothing is a live formula); and a headless browser asked to draw a page will make network requests
  the page asks for (so every request is refused and recorded, and a recorded request fails the export). Spec:
  `docs/ARTIFACTS.md` §10; proofs: `reference/artifacts/export.test.ts`.
- **Why on the server, as the downloader.** If the browser produced the file or sent the rows, a download could carry data
  the downloader's role may not see. The server re-reads through `runTool` with the downloader's session, so a download can
  never widen a role (SAFETY T11, T24).
- **Why the launcher is "top used".** The storekeeper's day is a few jobs repeated; the buttons he uses most should be the
  ones in front of him (see Part 2 on keyboard-first repetition), and the rest one tap away behind More. Role filtering
  happens before ordering so use can never surface a forbidden tool; shortcuts belong to the tool, not the position, so
  muscle memory survives a reorder.

---

## Part 2 — A chat-first interface for a low-literacy storekeeper

### 2.1 The articulation barrier, and why the chat is hybrid

- Nielsen's "articulation barrier": prompt-only interfaces demand strong written articulation.
  He cites OECD PIAAC to claim about half the population in wealthy countries, and more than 85%
  in Chile, Mexico and Turkey, are insufficiently articulate. These are his estimates, and he is
  an opinionated source. His fix is a hybrid: "GUIs show people what can be done", with buttons
  for common needs beside prose, as Grammarly does. [S7]
- Chat-only means users "have to guess what the system can do"; the remedy is structured
  affordances such as forms, buttons and scoped surfaces. [S6]
- Research on dedicated vs dynamic interfaces ("gulf of envisioning") concludes dedicated
  interfaces beat dynamic ones when tasks are well defined. [O5] The "hybrid trap" analysis warns
  that when chat and a GUI both handle the same task by different rules, users don't know which
  is "official": chat for exploration, a GUI for precise, repeatable, high-risk actions. [O6]

**Decision.** The chat is the whole app, but it is not a blank box: **launcher buttons** above the
input cover the daily tasks, and each opens a **form in the chat** (the same form the assistant
would bring). Typing is the fallback for questions. There is one set of rules for a write — the
tool's form and confirmation — whichever way it was reached. Spec: `docs/INTERFACE.md`.

### 2.2 Never a blank prompt; suggestion chips

- Adobe Experience Platform assistant study: over 35% of user queries were unrelated to the
  previous interaction in the session, and users struggle to formulate follow-ups.
  Context-aware proactive question suggestions beat a history-blind baseline on human-rated
  discoverability, relatedness and usefulness. It is the first empirical study of suggestions in
  a deployed enterprise assistant. [S8]
- We found **no** quantitative study of suggestion chips above the input in ERP chat. The
  evidence is [S8] plus Nielsen's argument [S7].

**Decision.** A persistent button row (Stock in, Issue, Stock check, Today's report, Low stock),
chosen from real use, plus two or three contextual follow-up chips after each answer, built from
what is on screen ("Issue for JOB-2627-0031"). The storekeeper's top five or six tasks need zero
typing.

### 2.3 Confirm before acting

- Microsoft's guidance puts checkpoints before decisions and before actions without clear
  ownership, so incomplete information does not "drive action". [S10]
- Business Central's payables-agent preview has a supervise-and-review step before posting.
  **Snippet only; not fetched.** [S11]
- Approvals need enough context to decide; "insufficient context" is the anti-pattern that turns
  review into a formality. Routing everything through approval causes reviewer fatigue and rubber
  stamps. [O7]
- Microsoft's 18 Guidelines for Human-AI Interaction map onto this product. [O8]

| Guideline | Here |
|---|---|
| G1/G2 Make clear what it can do, and how well | Launcher and chips; "not set up yet" answers; never pretend |
| G4 Show contextually relevant information | Chips change with what is pending |
| G8 Efficient dismissal | Every form and artifact closes with Esc; "Not now" |
| G9 Efficient correction | Every form editable before submit; reversals after |
| G10 Scope when in doubt | Ask once: per piece or total, which PO, which job |
| G11 Explain why | Follow-ups say why ("job 31 needs 982 cores") |
| G12 Remember recent interactions | Conversation history; "that job", "the same supplier" resolve |
| G16 Convey consequences | Every form shows what will change, before it changes |

- We found **no** public A/B data on confirm cards specifically.

**Decision.** Every write is a form with fields pre-filled from what the person said, followed by
a read-only summary (item, quantity, unit, location) that must be pressed before saving. The
assistant never writes. Only the owner's limit and counts reach the owner, so approvals stay
meaningful. After saving, a card offers Undo, implemented as a reversing ledger entry (owner only,
per `BUSINESS_FLOW.md` §16), never a delete. Undo patterns themselves had no source; that is design
judgement.

### 2.4 SAP Joule: readiness beats interface

- SAP Joule adoption is constrained by data and process readiness (harmonised master data,
  standardised processes), not by the UI. SAP's direction is "Spaces", dynamically generated task
  workspaces, and voice; prebuilt skills alone do not meet user needs. No hard adoption numbers
  were found. [S9]

**Decision.** Spend the effort on clean masters (one stock entry per material, duplicate-name
checks, parties picked not typed) and on a small set of purpose-built read tools. That is what
makes the assistant and the artifacts trustworthy; the interface is the smaller problem.

### 2.5 Lower literacy, targets, keyboard-first

- Low-literate users avoid complex functions; effective designs lean on voice, icons and symbols,
  and numeracy rather than text. [S20]
- WCAG 2.2 SC 2.5.8 sets a minimum target of 24×24 CSS px and points to 44 px (2.5.5) for
  important controls. [S21]
- Lower-literacy users read word by word, have a narrow field of view, miss anything outside the
  main text flow, lose their place when scrolling and struggle with spelling in search. Rewriting a
  site for them took success from 46% to 82% and task time from 22.3 to 9.5 minutes; higher-literacy
  users improved too. [O1] → Short labels, the important thing first, a single column, no moving
  text, search that tolerates spelling mistakes.
- Keyboard-first entry is what Indian back-office users know. TallyPrime's speed comes from the
  same key always doing the same thing, Enter moving to the next field and never reaching for the
  mouse; experienced users post 200+ vouchers an hour. The storekeeper's benchmark for "fast" is
  likely Tally or a register. [O2] → Enter moves forward, Esc cancels, the same shortcut opens the
  same form everywhere, and no mouse is required on forms or the count sheet.
- Speed: Nielsen's limits are 0.1 s (feels instant), 1 s (keeps the flow of thought), 10 s (limit
  of attention). [O3] → Forms render in under 1 s from data already loaded; the assistant streams
  its first words in under 2 s and says what it is doing ("Looking up job 31…"); an artifact build
  shows staged progress.
- Data tables: left-aligned text, right-aligned numbers in a tabular font, thin dividers rather
  than zebra stripes, a sticky header, urgent or recent first, details beside the table, remembered
  sort. [O4]
- Inline cards in chat should have at most two actions and no deep navigation; anything
  multi-step opens full-screen. [O9]
- Consistency over cleverness: muscle memory forms only when a layout never changes, which is why
  the launcher row and the five printouts are fixed.

**Decision.** Storekeeper path: buttons with an icon and a short word, 44 px or larger; numeric
keypads; pick-lists from the existing masters instead of free text; Tab and Enter move between
fields, Enter goes to the confirm step, Esc cancels; a keyboard shortcut per launcher button shown
on the button; short plain sentences with units; never colour alone for low or OK stock. Voice stays
on the roadmap, not in v1 (it fits [S20], but is out of scope).

---

## Part 3 — Why we dropped declarative page specs and menu screens

**This was the owner's decision**, taken after the v3 design (declarative page specs, a menu of
published screens, and fixed screens) was written. His reasoning, and ours:

- **Two UI languages double the review and repair surface.** v3 had a JSON page spec with its own
  catalog, validator, repair loop and publish flow, *and* fixed screens, *and* the chat. Every
  change meant checking two ways of drawing the same thing.
- The storekeeper's real need is met by the launcher and forms in the chat. A menu of screens made
  the interface larger without making his day easier.
- Claude-style artifacts (1.1) already give the owner the "show me" part, and the evidence in 1.3
  and 1.4 is addressed directly (must-match patches, tool-computed numbers) rather than by
  constraining the format.
- The v3 rule "a generated screen cannot weaken a write rule" is kept in a simpler form: an
  artifact cannot write at all, and can only ask the host to open the tool's own form.

**Considered, not used** (sourced material kept for reference):

- *Declarative UI.* Google **A2UI** has agents send JSON that names components from a pre-approved
  catalog rather than code, to reduce UI injection risk [O10]; Vercel **json-render** calls its
  version "guardrailed", where the AI can only use components in your catalog [O11]; CopilotKit
  recommends declarative for dynamic dashboards and reports, and controlled UI for mission-critical
  screens [O12].
- *Odoo views.* Odoo defines every screen as a declarative view: fields bind to the model, buttons
  call named server methods, `invisible`/`readonly`/`required` are conditional expressions, and
  `groups` restricts by role [O13]. Airbnb's Ghost Platform is the server-driven-UI precedent [O14].
- *Open-ended UI needs heavy machinery.* MCP Apps requires sandboxed iframes, a default CSP with
  `connect-src 'none'`, a double-iframe proxy on a separate origin for web hosts, auditable
  JSON-RPC messages, and lets hosts require user consent for UI-initiated tool calls [O15]. We
  took the sandbox, the CSP and the audited bridge, and skipped the double-iframe proxy because our
  artifacts hold no secret and cannot write; see `docs/SAFETY.md`.
- *Generation cost.* Google's Generative UI (Gemini 3 Pro writing HTML) "can sometimes take a
  minute or more" [O16], which is why artifacts are for requests that need them (1.2).
- *Generated UI vs chat.* In a study of generative interfaces against a chat baseline, people
  preferred the generated UI 84% of the time overall, 93.8% for data analysis and visualisation and
  87.5% for business operations, but only 50.8% win to 41.1% loss in real-user testing [O17].
  Generate UI for data-heavy answers, not everything — consistent with 1.2.

---

## Part 4 — Why blind counting was dropped

**This was the owner's decision.** In v3 the count sheet, the printed sheet and the assistant hid
a material's system quantity until the counter had entered his own number, then showed the
difference and offered a recount.

**What we gave up** (old evidence, kept short): counters who can see the expected quantity tend to
write it down rather than count it; blind counts hide it until the count is entered, then show the
difference and allow a recount [O18, O19]. That was the reason for the rule, since Vijaya's problem
was gaps disappearing because someone wrote down what the book said. Blind counting is a
widely used inventory practice, and dropping it makes that one failure easier. It was a trade of
that safeguard for a simpler sheet and a simpler assistant.

**What now carries the weight:**

- The count sheet shows a **System** column from the start.
- A count is still never an overwrite: the system quantity is frozen at the start, every
  difference needs a reason or is stored as UNEXPLAINED, and stock changes only when the owner
  approves (`BUSINESS_FLOW.md` §11).
- **The owner reviews the differences** at approval, and the **leak report** ranks materials by
  the value of their differences over time, so a counter who just copies the System column shows up
  as a material that never differs, against a store that is otherwise noisy. This is our
  reasoning, not a finding from a source.

---

## Sources

**Artifacts, chat UI, sandbox (design v4)**
- S1 [What are artifacts and how do I use them — Claude Help Center](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- S2 [Claude.ai's quiet revolution in artifact editing — HyperDev](https://hyperdev.matsuoka.com/p/claudeais-quiet-revolution-in-artifact)
- S2b [How Anthropic built Artifacts — Simon Willison](https://simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts)
- S3 [How Claude web is broken — Bram Cohen](https://bramcohen.com/p/how-claude-web-is-broken)
- S4 Claude Code issues: [silently reverts existing features](https://claudeissues.com/issue/69898-bug-claude-silently-reverts-existing-features-when-making-unrelated-changes-no-s) and [rewrites from scratch](https://claudeissues.com/issue/48315-claude-ignores-existing-working-code-and-rewrites-from-scratch-breaking-what-wor)
- S5 [Canvas opens automatically — OpenAI community](https://community.openai.com/t/canvas-opens-automatically-how-to-prevent-that/1055091)
- S6 [The chat box isn't a UI paradigm, it's what shipped — UX Collective](https://uxdesign.cc/the-chat-box-isnt-a-ui-paradigm-it-s-what-shipped-96e931d92769)
- S7 [Prompt-driven AI UX hurts usability — Jakob Nielsen](https://jakobnielsenphd.substack.com/p/prompt-driven-ai-ux-hurts-usability)
- S8 [Proactive question suggestions in an enterprise assistant (arXiv 2412.10933)](https://arxiv.org/html/2412.10933v1)
- S9 [SAP Joule and AI readiness — ERP Today](https://erp.today/sap-joule-enterprise-execution-ai-readiness/)
- S10 [Design Copilot boundaries and checkpoints — Microsoft](https://support.microsoft.com/en-us/microsoft-365-copilot/design-copilot-boundaries-and-checkpoints)
- S11 [Use the Payables Agent — Sparkrock, Business Central](https://help.sparkrock.com/en-US/files/business-central/use-payables-agent.html) (**snippet only**, not fetched)
- S12 [Browser sandbox for agent-generated HTML — agentpatterns.ai](https://www.agentpatterns.ai/security/browser-sandbox-agent-generated-html/)
- S13 [Test CSP iframe escape — Simon Willison](https://simonwillison.net/2026/apr/3/test-csp-iframe-escape)
- S14 [postMessage vulnerabilities — HackTricks](https://book.hacktricks.xyz/pentesting-web/postmessage-vulnerabilities)
- S15 [OWASP Top 10 for LLMs 2025 — Oligo](https://www.oligo.security/academy/owasp-top-10-llm-updated-2025-examples-and-mitigation-strategies)
- S16 [EchoLeak, CVE-2025-32711 (arXiv 2509.10540)](https://arxiv.org/pdf/2509.10540)
- S17 [Semantic layer vs text-to-SQL, 2026 — dbt](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026)
- S18 [Hallucinations in AI BI tools — Basedash](https://www.basedash.com/blog/hallucinations-in-ai-bi-tools-where-they-happen-and-how-to-prevent-them)
- S19 [Why ChatGPT gives different answers on business data — AtScale](https://www.atscale.com/blog/why-chatgpt-gives-different-answers-business-data/) (**snippet only**, not fetched)
- S20 [Low-literate users research — Microsoft Research](https://www.microsoft.com/en-us/research/?p=167992)
- S21 [WCAG 2.2 Target Size (Minimum) — W3C](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

**Older sources, still used**
- O1 [NN/g — Lower-literacy users: writing for a broad consumer audience](https://www.nngroup.com/articles/writing-for-lower-literacy-users/)
- O2 [TallyPrime — keyboard-first design for fast data entry](https://tallysolutions.com/business-guides/tallyprime-keyboard-first-design-fast-data-entry/)
- O3 [NN/g — Response times: the 3 important limits](https://nngroup.com/articles/response-times-3-important-limits)
- O4 [Pencil & Paper — Enterprise data table UX patterns](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables)
- O5 [Bridging the Gulf of Envisioning (arXiv 2309.14459)](https://arxiv.org/pdf/2309.14459)
- O6 [Conversational UI and AI agents: the hybrid trap — Mark Webb](https://markswebb.com/insights/conversational-ui-ai-agents-hybrid-trap/)
- O7 [AWS Well-Architected Agentic AI Lens — human-in-the-loop](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec04-bp02.html)
- O8 [Microsoft — Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf)
- O9 [OpenAI Apps SDK — UI guidelines](https://developers.openai.com/apps-sdk/concepts/ui-guidelines)
- O10 [Introducing A2UI — Google Developers Blog](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/)
- O11 [json-render README — Vercel Labs](https://cdn.jsdelivr.net/gh/vercel-labs/json-render@main/README.md)
- O12 [CopilotKit — Generative UI overview](https://docs.showcase.copilotkit.ai/concepts/generative-ui-overview)
- O13 [Odoo — View architectures](https://www.odoo.com/documentation/19.0/developer/reference/user_interface/view_architectures.html)
- O14 [InfoQ — Airbnb's server-driven UI (Ghost Platform)](https://www.infoq.com/news/2021/07/airbnb-server-driven-ui/)
- O15 [SEP-1865: MCP Apps](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) and the [MCP Apps draft specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)
- O16 [Google Research — Generative UI](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)
- O17 [Generative Interfaces for Language Models (arXiv 2508.19227)](https://arxiv.org/html/2508.19227v2)
- O18 [Uphance — Blind inventory counting](https://uphance.com/blog/blind-inventory-counting/)
- O19 [MangoApps — Blind cycle count sheet](https://www.mangoapps.com/templates/tasks/blind-cycle-count-sheet)
- Also used for printouts and downloads (see `docs/ARTIFACTS.md`): [Metabase — Exporting results](https://www.metabase.com/docs/latest/questions/exporting-results), [Odoo — Build PDF reports](https://www.odoo.com/documentation/18.0/developer/tutorials/pdf_reports.html), [AI Accountant — Purchase order format under GST](https://www.aiaccountant.com/blog/purchase-order-format-62597)
