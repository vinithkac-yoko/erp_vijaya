# Vijaya Stores — build kit

Everything Claude Code needs to build Vijaya Stores from scratch.

## Start

1. Create a new **private** GitHub repo and push the contents of this kit (including the hidden
   `.claude/` folder).
2. Start a **Claude Code cloud session** on that repo.
3. Run `/reload-skills` — it should report the two design skills (impeccable, ui-ux-pro-max).
4. Send: **"Read VIJAYA_CLAUDE_CODE_PROMPT.md and start milestone 1."**
5. After milestone 1, Claude Code will walk you through connecting Railway, click by click.
   Have your Anthropic API key ready for the `ANTHROPIC_API_KEY` variable.

At the end of each milestone it stops and tells you what to test. The tests are in
`docs/ACCEPTANCE_TESTS.md`, with the sections for each milestone listed at the top.

## What's inside

| File | For |
|---|---|
| `VIJAYA_CLAUDE_CODE_PROMPT.md` | The build instructions: architecture, stack, milestones, deployment |
| `CLAUDE.md` | Rules Claude Code reloads in every session |
| `PRODUCT.md` | Users, purpose, brand — the brief the design skill reads |
| `docs/BUSINESS_FLOW.md` | Every business rule agreed with the owner |
| `docs/TOOL_CATALOG.md` | Every operation the system can do |
| `docs/AGENT_PROMPT.md` | The assistant's instructions |
| `docs/INTERFACE.md` | The chat-only interface: layout, top-used launcher buttons with More, forms in chat, count sheet, Download menu, phone, keyboard |
| `docs/ARTIFACTS.md` | Claude-style artifacts: documents (reports, SOPs, diagrams) and pages, sandboxed and read-only; versions, sharing, the five printouts, exports to PDF, Word, Excel, CSV, PNG and Markdown |
| `docs/SAFETY.md` | Threats and the test that proves each one |
| `docs/RESEARCH.md` | Research behind artifacts, sandboxing and the chat-first UI, with sources |
| `prompts/` | The artifact builder's prompt and every tool's model-facing description |
| `docs/ACCEPTANCE_TESTS.md` | What you'll type to test, and what must happen |
| `reference/` | The old system's schema and database rules, the approved prototype, and tested code for the artifact sandbox, document renderer, checkers, exports and launcher (`reference/artifacts/`) |
| `evals/` | Automatic checks for the assistant's behaviour (141 cases) |
| `.claude/skills/` | Design skills |
