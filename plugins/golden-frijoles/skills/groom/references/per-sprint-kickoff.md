# Groom reference — the per-sprint kickoff (Stage 8b, the exception)

Loaded on demand from `SKILL.md` Stage 8. Moved here verbatim (ways-of-work-lean-pass S3.2); the escalate triggers in the sample now point at the ONE list in WAYS-OF-WORKING rather than restating it (S3.4).

### 8b — Per-sprint mode (the exception)
```
node "$GROOM/vendor/emit-kickoff.mjs" --epic <epic-slug> --sprint <N>
```
(from any project root on any host: `npx -y @golden-frijoles/kit emit-kickoff --epic <epic-slug> --sprint <N>`.)
Reads the epic README + that one `sprint-<N>.md` and substitutes the sprint-specific delta into
`vendor/templates/kickoff.md` (vendored from the kit's `templates/kickoff.md`).

**The documented shape below is the SSOT that generator reproduces — it's the fallback if the
script is unavailable, not the primary path:**

```
Read AGENTS.md, Roadmap/WAYS-OF-WORKING.md and Roadmap/LEARNINGS.md. Skim team memory.
Then read Roadmap/<NN-macro>/<epic-slug>/README.md and Roadmap/<NN-macro>/<epic-slug>/sprint-<N>.md.

You're building Sprint <N> of "<epic title>". Enter plan mode, confirm the plan as user stories with me,
then branch feat/<epic-slug> off latest main and build one story at a time per WAYS-OF-WORKING. If you're one
of several builders running in parallel, work in your own isolated `git worktree`, not the shared root
checkout.
Reuse before rebuild (see "What already exists"). Escalate rather than guess: stop and ask / hand back to
the planning tier on any trigger in the ONE list — WAYS-OF-WORKING → *Escalate, don't guess* — and default to
escalate when unsure. Commit per story with path-limited adds
(`git add <your files>` + `git commit -- <those paths>`, never `git add -A` — a shared worktree races the
index). Follow this project's own copy/localization conventions (see AGENTS.md). Add one api spec per testable story; name the
QA/smoke stage and state any browser smoke owed to me. When the deterministic gate (tsc + build + Playwright
api) is green, open a draft PR declaring the risk tier — and write the SPRINT SMOKE WALKTHROUGH (below) into
sprint-<N>.md before you call the sprint done.
```

The invariant preamble (line 1 of the prompt — the orientation reads + skim memory) is the same every
session; it stays in the prompt so a *fresh* builder session re-orients with zero prior context. Keep
the sprint-specific delta (this epic, this sprint, its reuse list, its risk) as the part that actually varies.
