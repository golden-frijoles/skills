<!--
  SOURCE FILE. `Roadmap/WAYS-OF-WORKING.md` is RENDERED from this plus `Roadmap/fill-ins.yml`:

      node scripts/render-ways-of-working.mjs            # write it
      node scripts/render-ways-of-working.mjs --check    # CI: fail if the rendered file drifted

  Edit THIS file for anything every project shares, and `fill-ins.yml` for anything one project's own.
  Rendering twice with no source change is a byte-for-byte no-op (ways-of-work-lean-pass S3.5).
-->
# Ways of Working

How {{fill:product_owner}} and Claude (builder) ship product together. Small slices, plan first, ship
the moment each slice works — and each slice is a piece of the final product, never a test of it.

{{fill:operating_posture}}

## Roles and the unit of work

The **product owner** sets direction, approves plans, tests each shipped slice and makes the consequential
calls (architecture forks, infra, money). **Claude** researches, proposes the plan as user stories,
builds, verifies, ships and documents.

Everything is sliced into **user stories** — the smallest independently testable, shippable value: *As a
\<role\>, I want \<capability\>, so that \<outcome\>*, plus **acceptance checks the product owner can
run**. Stories roll up into sprints, sprints into an epic, epics into a macro-section. Before building,
check whether existing features plus communication already deliver the outcome — surface that lighter
path first; `groom` gates on it (Stage 2.5).

## The cadence

```
Plan → branch + scaffold docs → build story → verify → QA/smoke → PR → review → merge (= deploy) → close
```

1. **Plan.** Non-trivial work goes through plan mode as user stories, approved before code, naming its
   QA/smoke stage. {{fill:design_is_scope}}
2. **Branch + scaffold.** One branch per epic (`feat/<slug>`, or `fix/…`, `chore/…`) off the latest
   `main`, in each repo you touch. Scaffold the epic `README.md` + `sprint-N.md` *before* any code, so
   the product owner sees scope as it grows, and keep them current (✅ ticks, commit refs).
3. **Build one story at a time.** Reuse before rebuild. Commit per story, **path-limited**.
4. **Verify + QA.** The deterministic gate — typecheck, lint, build, the suite — is green **before**
   merge, run by the building agent, not only by CI. {{fill:deploy_rail}}
5. **PR → review → merge.** Declare a risk tier, run the review the policy asks for, resolve or answer
   every finding, merge on green. **Merging to `main` is the production deploy.** Delete the branch.
6. **Close.** Sprint close: the sprint-wrap summary. Epic close: the Definition of Done below.

## Epic-mode builds — the default for a scaffolded epic

A whole epic in one orchestrated session is the normal unit of work; sprint docs are integration and
rollback boundaries *inside* it (a per-sprint session stays valid for a one-sprint epic, or when a sprint's
outcome genuinely changes the next one's scope). Six things make it work, and the first is the leverage:

1. **Lock the architecture before any builder starts** — numbered decisions `D1…Dn` in the epic README
   plus a per-sprint **"Build contract (locked by the architect before the builder started)"**, each
   verified **against live code and live data**. Builders *cite* them; a paraphrased contract drifts
   permissive. The lock must **disprove scope** (an acceptance criterion describing a guard, table or flag
   the live system lacks is fiction — saying so is a success), **query the live data** (row counts decide
   what is safe: a schema fork that is free while a table is empty is only free then), **name every
   deviation** in the README, and **say where each contract lives, once** — import the rule, never
   restate it.
2. **Stack the branches** — `feat/<slug>` → `-s2` → `-s3`, one PR per sprint (a single PR only when the
   sprints don't split along a review boundary), merged in order; sprints share hot files, so stack or
   pay. **Never delete a base branch while a stacked PR is open** — GitHub closes that PR for good.
   **Where to build is the orchestrator's call:** switch branches in place when you are the only session
   in the checkout and run one builder; take your own `git worktree` when another session shares it
   (planning sessions commit `Roadmap/` docs there) or builders run in parallel. Name the branch
   `<type>/<slug>[-s<N>][-words]` either way — the build view resolves it, and lists other worktrees.
3. **Route models by risk, invert for review** — the contract-defining sprint to the stronger model, the
   mechanical ones to the faster, the riskiest PR's fresh reviewer to the strongest; state the routing in
   the epic README. Findings route back to the original builder, whose context makes fixes cheap.
4. **Merges are pre-authorized on green** in a named run: that removes the round-trip, not the gate or the
   review layers, and never extends to a new category of production mutation (TLS/IAM/secrets, money or
   entitlement writes, a new external dependency) — name those in one focused question.
5. **Generate the kickoff, don't compose it** — `node skills/groom/emit-epic-kickoff.mjs --epic <slug>`
   (the `groom` skill) reads the epic README and every sprint file and prints the orchestrator prompt.
   Hand-composing it is how the architecture lock gets summarised away and the review policy silently
   reverts to whatever the composing agent remembered.
6. **Derive state, journal intent** — at session start run `node scripts/session-resume.mjs` (it ships in
   the template's `scripts/`; a project spawned from it has both scripts): it
   re-derives branches, worktrees, open PRs and migration drift live across the project's repos and leads
   with what is surprising. Journal each locked decision with `node scripts/session-note.mjs --kind
   decision "<text>"` — one intent line, nothing derived. A killed worker's agent is resumed with a
   one-paragraph state recap (its actual `git status`/`diff`), not re-spawned cold.

*Done* means **shipped**, not merged: a merged PR that has not deployed, a migration written but not
applied, a flag that exists only in code are none of them done. With a migration: apply it **before**
merging, verify live, merge, then confirm the deploy succeeded.

## Betting & appetite

Appetite is denominated in **sessions** — with agents the binding constraints are product-owner attention
and session context. Fixed appetite, variable scope.

| Appetite | Buys | Circuit breaker |
|---|---|---|
| **S** | one builder session; fixed scope (a bug, a chore, a clear story) | escalate-don't-guess — no hard breaker |
| **M** | one wave: an architect session + builder fan-out + review rounds | appetite exhausted → stop, back to shaping |
| **L** | a multi-wave epic | per-wave: each wave is re-bet at the boundary |

Four rules: **an exhausted bet returns to shaping**, never extends in flight; **nothing reaches
`status: queued` without an `appetite:` and an `underwritten_by:` wave**; **bets are placed at wave
boundaries** into `Roadmap/bets/<wave>.md`, three lines each, recording what they displaced; and **uphill
work stays on the strongest model**. Not every ask earns the betting table — `groom` sorts shaped bets
from fixed scope (appetite S, straight to a builder) and reactive/ops work. Why it works this way:
[`references/shapeup/`](https://github.com/golden-frijoles/skills/blob/main/template/references/shapeup/README.md).

## Review & merge

The deterministic gate is the gate. Everything else is judgment, and it is reads that answer **different
questions** — not more reviewers of the same kind.

```
CI (deterministic gate)            — does it build, typecheck, pass the suite?   BLOCKS merge
  → fresh pr-reviewer subagent     — context independence: did not hold the diff
  → one external cross-family pass — family independence: different blind spots
  → + a lean security lens         — when the diff touches a security path
  → the builder merges on green
```

**Which PRs**: `scripts/review-config.json` → `reviewScope` — `every-pr` (all non-trivial PRs;
`--skip-trivial` drops docs-only and tiny diffs) or `security-paths-only`. The **security lens** is
triggered by a `securityPaths` glob or a `risk: high` body in either scope — paths, not judgement, so a
builder can add it but never skip it. {{fill:review_scope_note}}

**Who reviews** is printed by `node scripts/review-route.mjs --builder <who> <PR#>`, never picked by hand:
the highest-preference family that did **not** build the diff takes the general pass, the next takes the
security lens (`codex → agy → vibe → claude`; a capped family falls through with `--exclude`). One family
left runs both prompts and says so in the PR body; none left means the layer is **DARK**, said out loud.

**A silent reviewer is a FAILED run, not a clean one**: the run asserts the reply carries real review
structure, posts `pending` before the CLI is even checked, pins the reviewed sha, and otherwise prints the
full reply, exits non-zero and fails the PR's `cross-review/<lens>` status. Both readers share one prompt
(`scripts/cross-review.prompt.md`): one pass, a `file:line` citation or the finding is not posted, at most
3 nits, skip what CI enforces, Blocking/Should-fix only on a re-review. `/security-review` is available
locally as a pre-push self-check, never a gate. Why this shape:
[`references/review-stack.md`](https://github.com/golden-frijoles/skills/blob/main/template/references/review-stack.md).

**Every finding is fixed or answered on the PR; neither pass authorizes anything.** **HIGH** = money
(payments, checkout, fulfillment), auth and authorization boundaries, tenancy, DB migrations, shared infra;
**LOW** = the rest; unsure means HIGH. The **builder merges their own PR at every
risk tier** once CI is green and findings are resolved — the tier selects the review
scope, not the merge authority. Roll back with `git revert` on `main`.

{{fill:security_floor}}

## Escalate, don't guess — the ONE trigger list

Stop and hand back to the planning tier — rather than inventing an answer — on any of:

> **money (payments, checkout, fulfillment) · auth and authorization boundaries · tenancy · DB migrations ·
> shared infra · plan ambiguity · a decision the plan doesn't cover · 2+ failed attempts at the same
> problem.**

Default to escalate when unsure. This is a **model-routing** trigger, not a merge gate. Everywhere else
that needs this list references it here; there is no second copy.

## Permissions — what an agent may do unattended

`.claude/settings.json` carries a committed `permissions` block: **allow** = verb classes only (never a
literal past command, and never one that destroys uncommitted work — an allowed command skips the
auto-mode classifier); **deny** = the irreversible-by-rule (CLI deploys, migration replays, force pushes and
protected-branch deletes, `rm -r`, whole-tree staging, edits to generated files, and the few repo scripts
that write production secrets from inside an allowed `node scripts/*`); **ask** = production secrets, env
writes and a service deploy. Deny and ask rules are carried in **three spellings** — bare,
assignment-prefixed and `env`-prefixed — because a leading assignment escapes a bare rule, and an escaped
*ask* is not a stricter outcome but a silent downgrade to the classifier.
Every deny/ask rule cites what it enforces in `.claude/permissions-ledger.json`, and
`node scripts/permissions-smoke.mjs` fails on an uncited rule, a stale ledger entry, a literal allow or a
missing baseline guardrail.

**Three actions get one focused question before you take them** — about irreversibility, not review: a
destructive or hard-to-reverse change to live data; real money or a third party's metered resource;
production secrets/IAM/DNS/TLS. The `ask` rules make that prompt automatic for the commands that do it.

**Auto mode is a USER setting** (`~/.claude/settings.json`): the same line in
a project file is ignored *and* masks the user default, so the smoke fails on it. A deny rule matches the
command an agent normally writes — it is not a sandbox: a leading assignment with an expansion
(`PATH=/x:$PATH vercel deploy`) was observed escaping a bare rule, so the critical rules carry an
expansion-safe form and the auto-mode classifier is the second floor.

## Definitions of Done

**A story can start** when its "as a / I want / so that" is clear, its acceptance check is testable, and
it ships on its own.

**A story is done** when acceptance criteria are confirmed working; typecheck, lint and build are clean;
the real behaviour is **smoke-tested** end to end (never "build passes, therefore done" — an untestable
gap is stated in the PR, not glossed); **every new spec has been observed failing once** via a deliberate
mutation, so it is not a tautology; and the sprint doc is ticked.

**An epic is done** when `node scripts/epic-dod.mjs --check <macro/slug>` passes — it derives the
mechanical half (sprints merged, README `status: shipped`, sprint statuses ticked with refs, a real
retrospective, no leftover branch) — **and** the judgment items below are true:

- [ ] The **product poster** reflects what is now live (✅ = enforced in code).
- [ ] **The actual is stamped** — `node scripts/epic-actuals.mjs --epic <slug> --write` writes `actual_*` into the
      epic README (`epic-dod` warns when it is missing), and the retro's `Quote vs actual:` line carries it.
- [ ] **`RETROSPECTIVE.md`** says what actually happened, and its durable learnings are promoted into
      `Roadmap/LEARNINGS.md` — sharpen the existing line, don't append a near-duplicate.
- [ ] **Each sprint has a smoke walkthrough** a person can follow blind, with real URLs; money/auth steps
      are flagged by name as owed to the product owner.
- [ ] **Team memory** (and its index, if your tooling keeps one) records the epic.
{{fill:kill_switch_dod}}

## Automated QA

The harness grows by **one spec per browser-/API-testable story** — coverage accretes with the work. Two
layers: an **`api` project** that is the deterministic gate (no browser binaries, runs on every PR, green
before merge), and an opt-in **`browser` project** for rendered UI an API call can't see (nightly or on
demand, never the gate). A browser spec replaces a browser smoke previously owed to the product owner.

## Documentation map

**`Roadmap/`** is the product source of truth in plain language (macro-section → epic → sprint → story,
plus the poster); **`LEARNINGS.md`** is the cross-epic digest, read at session start and fed at every
close; **`Roadmap/00-ideas/`** is the funnel — `seeds/` (lifecycle in frontmatter, never folder-shuffled),
`audits/`, and the **generated** `BUILD-ORDER.md` (`node scripts/build-order.mjs`, never hand-edited).
**Status SSOT = each epic README's frontmatter `status:`**; the board and any external projection are
derived views. **`Roadmap/bets/`** holds one file per wave; **`tasks/`** is the engineering delivery log.

## Conventions

- **Gitflow.** Branch off `main`, commit per story, PR → merge. Never commit feature work straight to
  `main`; never force-push a shared branch; merge latest `main` in before opening the PR.
- **Path-limited commits.** `git add <specific files>` then `git commit -- <those paths>` — never
  `git add -A`. Several agents share a checkout, so whole-tree staging commits a sibling's in-flight
  work. The deny list enforces it; parallel planners take their own `git worktree` or appoint one scribe
  for shared files like `BUILD-ORDER.md`.
- **Docs track code — verified, not generalized.** A canonical rule must reflect what the code actually
  does, checked against it — and a scoped learning is not globalized into a site-wide rule. On the poster
  ✅ means enforced in code, 🚧 partial or aspirational. Run a light drift audit periodically.
- **Parallel agents and async deploys.** `main` moves under you: merge latest `main` into a long-running
  branch; when repos deploy at different speeds, merge the data-producing repo first and make the consumer
  degrade gracefully.
- **Worker death is a normal case.** Each builder on its own worktree; a killed worker's uncommitted tree
  is evidence, not garbage; **verify by re-deriving repo state, never by trusting a completion report** —
  a rate-limited subagent still returns a plausible-sounding result. Checkpoint and hand
  off when the budget line says so (Claude Code: under the prompt; groom: at each approval gate) —
  not by sprint count. Where no line shows (function hooks off, or no figure yet), compact at
  sprint/PR boundaries.
- Commit messages end with the `Co-Authored-By: Claude` trailer.
{{fill:language_policy}}

{{fill:project_sections}}

## Tooling

{{fill:tooling_table}}

Actions that touch live production, real money, or paid infrastructure are surfaced to the product owner
before running.
