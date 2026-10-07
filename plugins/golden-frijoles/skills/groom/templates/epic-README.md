---
status: scaffolded   # AUTHORITATIVE epic status (SSOT) — scaffolded | in-progress | shipped | archived. Set shipped at epic close.
phase: Shaping       # the executive ladder — Shaping | Locking architecture | Building | Verifying | In review | Shipped.
                     # WRITTEN at each cadence event, never inferred. Shipped = merged AND deployed.
slug: {{SLUG}}
title: {{TITLE_YAML}}
area: {{MACRO}}
risk: {{RISK}}
type: {{TYPE_KEY}}
sprints_total: {{SPRINTS_TOTAL}}
stories_total: {{STORIES_TOTAL}}   # the sum of every sprint's stories_total — keep it in step when a story is added
intent_match: {{INTENT_MATCH}}   # copied from the seed by scaffold-epic (intent-match); the reader at the lock may update it
quote_low_usd: {{QUOTE_LOW}}    # ≈ API $ — copied from the seed's `quote:` by scaffold-epic (finops); null = not quoted, never 0
quote_high_usd: {{QUOTE_HIGH}}
quote_basis: {{QUOTE_BASIS}}
hypothesis: {{HYPOTHESIS}}   # the result record — copied from the seed by scaffold-epic; null = no target (never an error)
target_metric: {{TARGET_METRIC}}   # which number: a North Star input key (grounded) or free text (not grounded)
target_from: {{TARGET_FROM}}   # from what, a number
target_to: {{TARGET_TO}}       # to what, a number
read_date: {{READ_DATE}}       # YYYY-MM-DD; null = 30 days after shipping, derived by the extract and never written back
verdict: null        # proven | disproven | unclear — stamped by `node scripts/epic-read.mjs --epic <slug> --write`
verdict_actual: null
verdict_evidence: null   # https:// link · north-star:<input>@YYYY-MM-DD · ab:<experiment> (unclear: the reason)
verdict_at: null
build_order: null    # integer position in the ONE global build sequence — the SSOT once the epic
                     # exists (the seed's value is only a fallback). Fill it in at the betting
                     # table; plain integers, no "#2a" suffixes. See 00-ideas/README.md → Ordering.
---

# Epic: {{TITLE}}

> **Area:** {{MACRO}} · **Risk:** {{RISK}} · **Class:** {{TYPE}} · **Scope seed:** [`00-ideas/seeds/{{SLUG}}.md`](../../00-ideas/seeds/{{SLUG}}.md)
<!-- Class (above) is the Stage-2 classification: Feature, Spike, Bug, or Chore — see SKILL.md's
     Stage 2 table; sourced from scaffold-epic.mjs's --type flag (a fixed 4-value enum, not free
     text — a longer description belongs in the Why section below, not here; this comment never names
     that heading literally, so an edit anchored on it cannot land inside the comment).
     Optional: if this epic was ALSO tagged with an archetype at grooming (see spike-role-archetypes.md),
     append " · **Archetype:** <Prototyper|Builder|Sweeper|Grower|Maintainer>" after Class. Omit entirely
     for the Builder default — untagged is fine.
     Scope-seed link: always points at seeds/ — lifecycle lives in the seed's `status:` frontmatter, not
     in a folder path (see 00-ideas/README.md). If this epic was scaffolded from a doc that has no seeds/
     entry, link that doc instead and migrate it to seeds/ when convenient — don't fabricate a seeds/ file
     that doesn't exist. -->

## Why
<!-- One paragraph: the outcome this epic delivers and for whom. Plain product language, no tech. -->

## Platform-first note
<!-- Does the platform's own system of record already model this? Which primitive backs it?
     (This project's AGENTS.md data-ownership rule.) -->

## What already exists (reuse, don't rebuild)
<!-- Concrete files / routes / primitives the platform-first reframe surfaced. -->
-

## Scope — stories
| Sprint | Story | Risk |
|---|---|---|
{{SPRINT_LIST}}

## Deploy order
<!-- Backend-first? Frontend degrade gracefully? Preview vs prod. -->

## Definition of Done (epic)
- [ ] All sprints merged to `main` + smoke-tested (gaps stated — `node scripts/owed-ledger.mjs` counts what is still owed)
- [ ] Each `sprint-N.md` has its smoke walkthrough (real URLs)
- [ ] This README marked ✅; every sprint status ticked with commit refs
- [ ] `RETROSPECTIVE.md` written
- [ ] Product poster (`Roadmap/README.md`) updated
- [ ] Team memory + `MEMORY.md` index updated
- [ ] Durable learnings promoted to `Roadmap/LEARNINGS.md` (dedupe — sharpen, don't append)
- [ ] **Kill-switch (only if one was planned at grooming — Stage 6b):** the flag slice shipped, the flag
      exists **in Golden Frijoles, in every env**, with the stated polarity, **and is ACTIVATED there** —
      `gf flags get <key>` must not print `—` in its PRODUCTION row. Creating a definition is not
      turning it on, and a flag that is synced but never activated serves compile-time defaults while
      every dashboard says it exists. *Verify-only — not a new gate; whether a high-risk epic needs one
      is decided at grooming, not here.*
- [ ] Feature branch deleted; **this README's frontmatter `status: shipped`** (the SSOT — the board & Notion derive from it; run `node scripts/build-order.mjs`)
