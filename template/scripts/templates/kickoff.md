Start by pushing this sprint's branch, before anything else — it is what moves the card to Building on the board:
`git switch -c {{BRANCH}} {{BASE}} && git push -u origin {{BRANCH}}` (stacked on the previous sprint; branch from
`origin/main` instead once that sprint has merged. Resuming? `git switch {{BRANCH}}`).

Read AGENTS.md, Roadmap/WAYS-OF-WORKING.md and Roadmap/LEARNINGS.md. Skim team memory.
Then read Roadmap/{{MACRO}}/{{SLUG}}/README.md and Roadmap/{{MACRO}}/{{SLUG}}/sprint-{{N}}.md.

You're building Sprint {{N}} of "{{EPIC_TITLE}}". Enter plan mode, confirm the plan as user stories with me,
then build one story at a time per WAYS-OF-WORKING. If you're one of
several builders running in parallel, work in your own isolated `git worktree`, not the shared root checkout.
Reuse before rebuild (see "What already exists"). Escalate rather than guess: stop and hand back on any trigger in
the ONE list, WAYS-OF-WORKING → *Escalate, don't guess* — default to escalate when unsure. Commit per story with path-limited adds
(`git add <your files>` + `git commit -- <those paths>`, never `git add -A` — a shared worktree races the
index). Follow this project's own copy/localization conventions (see AGENTS.md). Add one api spec per testable story; name the
QA/smoke stage and state any browser smoke owed to me. When the deterministic gate (tsc + build + Playwright
api) is green, open a draft PR declaring the risk tier, then flip it ready-for-review — and write the SPRINT
SMOKE WALKTHROUGH (below) into sprint-{{N}}.md before you call the sprint done.
Review (WAYS-OF-WORKING → Review & merge): CI always; then run
`node scripts/review-route.mjs --builder <who-wrote-it> <PR#>` and take what it prints — one external
general pass, a security lens when the changed paths trigger it, and the fresh `verifier` subagent, in
the scope `scripts/review-config.json` sets. A family never reviews its own diff, so don't pick `--agent`
by hand; a capped family is routed past with `--exclude <family>`, and if only one can run it runs both
prompts and you say so in the PR body. You merge your own PR on a green gate once findings are resolved.

Dispatch (the strongest model, this session, is the orchestrator): keep the plan, the shared surface (CI,
`package.json`, lint config, a lib module many stories import), money, auth, migrations, tenancy, high-risk
stories and every merge. A story with a clear acceptance check, no shared surface and risk low or medium goes to
a Sonnet-class builder in its own worktree, with a brief naming the story, the files, the checks to run and
"commit, do not push". Re-derive the result yourself (the diff, the tests); never trust the builder's final
message. After one failed attempt, take the story back. The Plan gate's Crew block is the plan; the
retrospective records what happened. Where things stand, at any time: `refine/references/checkpoint.md`.

Sprint {{N}} of "{{EPIC_TITLE}}" — "{{SPRINT_TITLE}}" — stories:
{{STORY_LIST}}
