# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js 15 (App Router), TypeScript, Prisma, PostgreSQL 16, Tailwind v4, shadcn/ui, Anthropic API,
deployed on Railway. Installable as a PWA. Full detail in `VIJAYA_CLAUDE_CODE_PROMPT.md` §2.

## Users

- **Storekeeper** — runs the raw-material store at Vijaya Electronics. Receives material from
  suppliers, inspects it, gives it out to jobs, takes back leftovers, collects copper scrap, counts
  stock. Works at a **desktop computer** in the store office all day. Reads English but is **not
  highly educated**; types short, with typos and Tamil or Hindi words mixed in ("wire evlo
  irukku", "isue wier to job 31"). He finds things by where they are on the screen, not by
  reading, so the buttons above the chat never move. He is the user the whole system depends on: if he stops entering receipts the same day,
  the system is worthless and the notebook comes back.
- **Owner** — runs the company. Approves purchase orders above his limit and every stock count.
  Watches material cost per job and where stock is disappearing. Uses an **Android phone** most of
  the day and a laptop sometimes. Wants answers, not screens (he asks; the assistant answers in a sentence, a table or an artifact): "what needs me?", "where is my stock
  leaking?", "what did job 31 cost?". Also covers for the storekeeper when he is away.

Nobody else uses it.

## Product Purpose

Vijaya Stores replaces the store's notebook and the Excel BOM sheet with a stores system you can
talk to. It tracks raw materials only: what comes in, what goes out to each job, what comes back,
and what is lost.

The owner's real problem, in his words: when his people couldn't explain a gap in stock, they
overwrote the notebook, and the gap disappeared. He counts often because he can't trust the
numbers, and he still can't find the leak.

Success means:
- Every receipt, issue and return is entered the same day, by the storekeeper, without help.
- A stock count can never overwrite anything. Every difference is kept, with its reason or as
  "unexplained", and the owner can see the pattern month after month.
- The owner knows the true material cost of every job.
- Over time, the owner counts less, because the numbers can be trusted.

## Positioning

A stores system where **the chat is the whole app** and that **cannot be quietly corrected**. The stock history is
append-only and enforced by the database itself; the only way stock changes to match a count is
an owner-approved count, and every difference stays on record. Daily work starts from launcher buttons above the chat input, which open forms in the chat; anything
big (a report, memo, SOP, diagram, chart, dashboard) opens as a Claude-style artifact beside the chat — sandboxed and
read-only, able only to open forms — and downloads as PDF, Word, Excel, CSV, a picture or Markdown. The launcher shows each person's most-used buttons first. The owner can share a frozen version with the storekeeper. Five
fixed printouts leave the building. There are no fixed screens and no menu of screens. The assistant
can do anything a form can, but it can never change data on its own — every change is a form the
person submits.

## Operating Context

- Vijaya Electronics, Chennai, founded 2009. Makes transformers and inductor coils (SMPS, EV
  charger, lamination, medical isolation, driver transformers, DC converters) for railways,
  solar, LED and CCTV customers.
- **Every job is a one-off design** made to a customer's order. About 50 jobs a month,
  hundreds to thousands of pieces each. Designs never repeat; there is no product catalogue.
- Some customers send an **open PO**: the same PO number, new items added one at a time after
  the previous one is delivered. Each release is a new job.
- The BOM arrives per job as an Excel sheet, **quantities per piece**. All material is issued
  at once at job start. Leftovers come back at the end. About 2% of pieces get reworked, needing
  a little extra material.
- Purchasing is purely reactive: a BOM shows a shortage, a written PO goes to the supplier.
  POs above an approval limit (set by the owner) wait for him.
- Every receipt is inspected; rejected material goes back to the supplier.
- Copper offcuts are collected and sold to scrap buyers.
- Stock is currently in a notebook. **Go-live is a one-time opening count** of about 200
  materials, with the rate for each taken from its last purchase invoice.
- Valuation is weighted average. Rates are visible to both users.

## Capabilities and Constraints

- Two roles only: storekeeper and owner. Only the owner approves purchase orders and counts,
  reverses mistakes, changes settings and creates users.
- Raw materials only. Not in v1: production stages, finished goods, QC records, batch or lot
  traceability, quotations, invoicing, dispatch, accounts/Tally, GST filing, non-job issues,
  write-offs, voice input.
- English only on screen. The assistant understands Tamil/Hindi words mixed into English.
- One unit per material, used for buying and issuing. No unit conversions.
- Stock may go negative (paperwork lags the floor); it is flagged, never blocked.
- Terminology the users use: job, BOM, issue / give out, return, count / stock taking, scrap,
  rate, SWG (part of a wire's name), "kept in stock" vs "bought per job".
- Internal codes and ids are never shown to anyone. Job, PO, GRN and count numbers are fine.

## Brand Commitments

- Name: **Vijaya Stores** (for Vijaya Electronics).
- The owner approved the look of `reference/prototype.html`: warm paper, ink, copper, the
  transformer rating-plate header and rubber-stamp confirmations. That direction is binding;
  its layout is superseded by `docs/INTERFACE.md`, which also holds the tokens.
- Voice: short, plain, respectful. Says what happened and what to do next. Never jargon, never
  blame.

## Evidence on Hand

- Business rules confirmed with the owner: `docs/BUSINESS_FLOW.md`.
- The approved prototype: `reference/prototype.html`.
- Acceptance prompts written from real usage: `docs/ACCEPTANCE_TESTS.md`.
- Material names used in testing are real kinds of material at Vijaya (22 SWG copper wire,
  Ferrite Core E-30, bobbins, insulation tape, varnish, paint, thinner, stickers, copper scrap).
  Quantities, rates, customer and supplier names in the demo data are illustrative, not real.
- There are no testimonials, metrics or real customer data. Don't invent any.

## Product Principles

1. **The record is never rewritten.** Mistakes are corrected by new entries, and every
   difference stays visible. Nothing in the product offers a way around this.
2. **Design for the storekeeper first.** Same task, same layout, every time. If he can do it
   unassisted, everyone can.
3. **The assistant proposes; the person decides.** Every change is a form someone submits.
4. **Show names and numbers people use on paper.** Never a code, an id or an error string.
5. **Answer the question with the smallest thing that does it.** A sentence, a short table, a
   form, an artifact (only when asked for something that needs one), a printout or a download — in
   that order of preference.

## Accessibility & Inclusion

- WCAG 2.1 AA in both light and dark themes.
- Storekeeper forms and count sheet: 16px minimum body text, large click targets, full keyboard use, no information carried by colour alone.
- Owner view: usable one-handed on an Android phone; approvals reachable with the thumb.
- `prefers-reduced-motion` respected.
