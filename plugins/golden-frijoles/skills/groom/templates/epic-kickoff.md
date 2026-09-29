Build this epic in ONE orchestrated run: "{{EPIC_TITLE}}" ({{SPRINT_COUNT}} sprints, risk {{RISK}}).
Docs: Roadmap/{{MACRO}}/{{SLUG}}/README.md and {{SPRINT_FILE_LIST}}. The sprint files are integration, review
and rollback boundaries inside this run, not separate sessions.

The process is Roadmap/WAYS-OF-WORKING.md → *Epic-mode builds*, *Review & merge* and *Escalate, don't guess*,
under AGENTS.md. Read those, the epic docs, and the Roadmap/LEARNINGS.md entries that touch this area. Start
with `node scripts/session-resume.mjs`.

Non-negotiable for this run:
1. **Lock first.** Write `D1…Dn` and each sprint's build contract into the epic README, verified against
   live code and live data, before any builder starts. Scope the live system disproves gets corrected out loud.
2. **Stack** `feat/{{SLUG}}` → `-s2` → …, one PR per sprint, merged in order. Worktree or in place: decide
   per *Epic-mode builds*.
3. **Review** every PR through `node scripts/review-route.mjs --builder <who-wrote-it> <PR#>` (one general
   pass, plus the security lens when the paths trigger it); each finding is fixed or answered before merge.
4. **Merge on green** — pre-authorized, except a new category of production mutation: ask that once.
5. **Done means shipped** — deployed and verified live, each sprint's smoke walkthrough in its sprint file,
   then the epic Definition of Done.
{{EPIC_RULES}}
## Sprints

{{SPRINT_BREAKDOWN}}
