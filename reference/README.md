# Reference files

`schema.prisma`, `inventory_guards.sql` and `prototype.html` come from v1
(`github.com/sanjaysagar12/dynamic_ui`, commit `fd5ec62`, 2 Oct 2026). **Reference, not code to
copy.** `artifacts/` is new for design v4 and is tested.

- `schema.prisma` — the data model is right; start from it. Changes for v2 are listed in the
  prompt §6 (drop `Lot`; add PendingAction, Conversation, Message and the artifact tables).
- `inventory_guards.sql` — every trigger, CHECK and view must survive, **inside a Prisma
  migration** (in v1 it was applied by hand — the biggest v1 risk). Add the TRUNCATE guard
  (prompt §7).
- `prototype.html` — the clickable prototype the owner approved. Visual direction only (colours,
  rating-plate header, stamps). Its **layout is superseded by `docs/INTERFACE.md`**; its behaviour
  (typing "yes" to confirm) is superseded by the form-button rule; its count sheet shows the
  System column, as the owner now wants.
- `artifacts/` — the tested artifact sandbox and its helpers. Port it; don't redesign it.
  - `host/host.js` — the host: sandboxed iframe, meta CSP, MessageChannel bridge, nonce stamping.
  - `host/bootstrap.js` — runs inside the frame; the only door out is the bridge.
  - `host/uikit.js`, `host/tokens.css` — the helpers and tokens artifacts use (tables, charts, INR).
  - `artifact-check.ts` — static checkers: `checkArtifact` for pages (no literal numbers, no forbidden APIs) and
    `checkDoc` / `canShareDoc` for documents (VDoc: reads, bindings, no HTML/links, hostile diagrams refused).
  - `host/vdoc.cjs`, `host/docrender.js` — the VDoc parser/validator/Markdown resolver and the renderer that draws a
    document (and Mermaid diagrams) inside the sandbox; no model-written script.
  - `export.ts` — downloads: PDF, Word, Excel, CSV, PNG, Markdown, made on the server with the downloader's role
    (needs Chromium via `CHROMIUM_PATH` and `pandoc`).
  - `prefill.ts` — sanitises "open form X with prefill" values (untrusted input).
  - `launcher.ts` — the launcher per role, top-used first per user, 4 buttons + 4 chips visible and the rest behind More.
  - `catalog.ts` — which read tools and forms an artifact may reach.
  - `examples/good/`, `examples/hostile/` — artifacts (`.html` pages, `.vdoc` documents) that must pass, and ones that must be stopped.
  - `artifacts.test.ts` — checker, prefill, catalog and launcher tests.
  - `documents.test.ts`, `export.test.ts` — documents and diagrams (parser, checker, Chromium) and every export format.
  - `host.test.ts` — runs the hostile examples in **real Chromium** (via playwright-core).
  - Run: `cd reference/artifacts && npm install && npm test`
  - Known limit: DNS prefetch and WebRTC could not be proven closed in the proxied test container;
    see `docs/SAFETY.md` §3 and `docs/RESEARCH.md` 1.5.
