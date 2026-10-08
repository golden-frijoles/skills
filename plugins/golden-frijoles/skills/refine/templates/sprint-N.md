---
epic: {{SLUG}}
sprint: {{N}}
title: {{SPRINT_TITLE_YAML}}
risk: {{RISK}}
phase: Shaping
stories_total: 1
stories:
  - id: S{{N}}.1
    title: "<title>"
    as_a: "a <role>"
    i_want: "<capability>"
    so_that: "<outcome>"
    risk: {{RISK}}
    status: planned
---
# {{TITLE}} — Sprint {{N}}: {{SPRINT_TITLE}}

**Status:** ⬜ not started

## Stories
<!-- One block per story. Thinnest shippable slice first.
     Each story ALSO has an entry in the frontmatter `stories:` list above — that entry is what tools
     read (the build view, build-state.mjs); the prose below is what people read. Add both, and keep
     `stories_total` (here and in the epic README) equal to the number of entries.
     Story `status:` is planned | in-progress | done. The sprint's `phase:` is the executive ladder
     (Shaping | Locking architecture | Building | Verifying | In review | Shipped), WRITTEN at each
     cadence event. Name the story in each commit subject (`S{{N}}.1 …`): that is how the build view
     knows which story is in flight.
     Keep the heading shape `### Story {{N}}.M — <title>` (this is what the status board counts).
     When a story ships, append ✅ + its commit ref to the heading, e.g.
       ### Story {{N}}.1 — <title> ✅ `abc1234`
     Note: the epic README frontmatter `status:` is the AUTHORITATIVE epic status; this ✅ marker only
     feeds the cosmetic per-sprint progress count, so a format slip can't mis-state shipped/not-shipped. -->

### Story {{N}}.1 — <title>
**As a** <role>, **I want** <capability>, **so that** <outcome>.
**Acceptance:** <plain-language checks the product owner can run>
**Risk:** {{RISK}}

## Sprint QA
- **api spec(s):** <which testable story → which `e2e/*.spec.ts`>
- **browser smoke owed:** <no · or: yes, to the product owner — name the money/auth step>
- **deterministic gate:** `tsc --noEmit` + `npm run build` + Playwright `api` green before merge

## Sprint {{N}} — Smoke walkthrough (do these in order)
Env: production · https://<your-domain>   (or the preview URL while testing pre-merge)

1. Go to https://<your-domain>/<page-or-path>
   → <observable expected result>
2. In <the relevant authed area>, go to https://<your-domain>/<authed-path>
   → <observable expected result>
3. (money path — owed to <product owner> by name) <the money-path steps for your project> using a
   test-mode payment credential.
   → <observable expected result>

<!-- Delete whichever pre-filled steps don't apply to this sprint; add more using the same shape
     (real clickable URL + one observable result). Flag any money/auth/checkout step by name —
     those are owed to your project's product owner (an automated browser smoke can't fully cover
     them). -->

If any step fails, note the step number + what you saw — that's the bug report.
