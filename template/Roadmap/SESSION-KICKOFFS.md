# Session kickoffs — prompt cheat sheet

Quick-reference prompts for starting a new session. **Fill the `<VALUES>` and paste.**

The principle: a kickoff is a **thin pointer, not a content dump**. Context lives in the durable docs
(`AGENTS.md`, `WAYS-OF-WORKING.md`, `LEARNINGS.md`, the epic/sprint files, team memory) — so the prompt
just *points* at them. This keeps prompts cheap and consistent, and it's **vendor-neutral**: any coding
agent re-orients from the same docs. It also sidesteps the biggest hidden cost in multi-agent dev — the
"communication tax" of re-passing large context.

> `AGENTS.md` "Start here" already chains to `WAYS-OF-WORKING.md` + `LEARNINGS.md` + team memory, so
> naming **AGENTS + the one sprint/scope doc** is usually all the orientation an agent needs.

**The three stages.** Once the economics layer is adopted (WAYS-OF-WORKING → *Betting & appetite*),
every kickoff below sits in one of three stages — say which one you're in and the rest follows:

| Stage | Question it answers | Kickoffs |
|---|---|---|
| **Shape** | *What is this worth, and what's the smallest thing that delivers it?* | §1 (groom → a pitch), §3 (spike), §10 (re-shape after a breaker) |
| **Bet** | *What are we funding this wave, and what does it displace?* | §9 (the betting table) |
| **Build** | *Execute the approved plan.* | §2, §4, §6, §7, §8 |

Shaping without a bet produces plans nobody funds; betting without shaping funds work nobody sized.
A **fixed-scope** ask (bug, chore, clear story) skips Bet by design — see §1.

## Fill-in values
- `<ask>` — the raw one-line request
- `<epic-slug>` — e.g. `discovery-polish`
- `<NN-macro>` — macro-section folder, e.g. `01-onboarding-and-auth`
- `<N>` — sprint number
- `<risk>` — **LOW** (reviewer may auto-merge on green CI) / **HIGH** (product owner merges)
- `<appetite>` — **S** (one builder session) / **M** (one wave) / **L** (multi-wave) — the budget, fixed before the solution
- `<lane>` — **shaped bet** (→ the table) / **fixed scope** (→ straight to a builder) / **reactive** (logged against the wave)
- `<wave>` — the wave file under `Roadmap/bets/`, e.g. `wave-<date>-<slug>.md`
- `<AGENTS-path>` — this project's `AGENTS.md` (or the app-specific one, if it's a monorepo)
- `<who-wrote-it>` — the family that built the diff: `claude` / `codex` / `agy` / `vibe`. Feeds
  `review-route.mjs`, which picks the two families that did *not* build it (see §4). Which of these
  are installed and authenticated is a **TEMPLATE FILL-IN** — the router reports an uninstalled family
  as a short/dark layer rather than silently substituting.

## Command shorthands
A small, fixed vocabulary so the *instruction* half of a message is unambiguous — each verb just
**points** at a numbered kickoff/action below (same thin-pointer principle; vendor-neutral).
Pleasantries are fine and cost nothing — the leverage is the defined verb, not trimming "great work."

| Say this | Expands to |
|---|---|
| **Groom: \<ask\>** / **Shape: \<ask\>** | §1 — groom a raw ask into a shaped pitch (synonyms; "Shape" just names the stage) |
| **Bet** / **Bet the wave** | §9 — run the betting table at a wave boundary, write `Roadmap/bets/<wave>.md` |
| **Re-shape \<slug\>** | §10 — an M/L bet hit its circuit breaker; back to shaping, never extended in flight |
| **Build epic \<epic\>** | §2 — build a WHOLE epic in one orchestrated run (**the default**) |
| **Build S\<N\> of \<epic\>** | §2b — build a single sprint (the exception: one-sprint epic, or the next sprint's scope genuinely isn't knowable yet) |
| **Spike \<name\>** | §3 — run a spike |
| **Review PR #\<N\>** | §4 — route + run the external pass(es) + the fresh reviewer |
| **Cross-review PR #\<N\>** | §4 — synonym; always route it, never hand-pick `--agent` |
| **Panel: \<scope-doc \| ask\>** | advisory second opinion on a *plan* — `node scripts/cross-panel.mjs <doc> --lens both --agent <reviewer>` (single-pass, print-only, never gates; surfaced at groom Stage 2/4) |
| **Wrap S\<N\>** | tick the sprint doc status + emit the §7 sprint-wrap terminal summary |
| **Close epic \<slug\>** | §6 — full epic Definition of Done |
| **Clear to merge — LOW** / **product-owner-merge** | the risk-tier gate: reviewer auto-merges on green CI / product owner merges |
| **Next** | proceed to the next story/sprint per the current `sprint-N.md` |
| **Resume** | §8 — pick up a session that died mid-flight |

---

## 1 · Groom a raw ask into a shaped pitch — strong model *(the Shape stage)*
```
Groom: <ask>.
Read <AGENTS-path> (Start here) + Roadmap/LEARNINGS.md; skim team memory, Roadmap/00-ideas/BUILD-ORDER.md
and the latest Roadmap/bets/ wave file (what's already funded, and what it displaced).
Use the groom skill — planning only, no code. Orient → SET THE APPETITE BEFORE ANY SOLUTIONING → classify
class + lane → "can we already do this?" → disambiguate → platform-primitives-first reframe → bill of
materials → slice into sprints. Land the pitch in Roadmap/00-ideas/seeds/ with appetite: set and
underwritten_by: null; my approval at the gate funds it (fund.mjs) and scaffolds it, in one commit. Never
assume — validate at each gate.
```
**The appetite is a creative constraint, not a forecast.** It is fixed *before* the solution is
designed; if the solution won't fit, narrow the problem or cut scope — never grow the appetite
mid-shaping. An agent will build anything if allowed to tokenmaxx; the appetite is what makes it
stop and hammer scope instead.

**Then the lane decides what happens next — say which one at the end of the groom:**

| Lane | Tell | What follows |
|---|---|---|
| **Shaped bet** | genuinely-new / strategic | pitch is complete (problem · appetite · bill of materials · rabbit holes · no-gos) → the gate: **approve** funds it (cycle row · `underwritten_by` · build position) and scaffolds it in one commit; **approve, don't fund** leaves it `ready` for §9. An unfunded epic is a plan nobody paid for, so none is scaffolded. |
| **Fixed scope** | bug, chore, well-specified story | default `appetite: S`, the same gate → on my approval fund it and scaffold it from the seed alone (`scaffold-epic.mjs --slug <seed>`: one sprint, its acceptance criteria as stories), commit path-scoped, and emit the kickoff (§2) |
| **Reactive / ops** | incident, launch support, can't wait | no shaping — do it, then log it against the current wave's budget so the economics stay visible |

*Add when it should wait:* `"Approve, don't fund — leave it ready for the next betting table."`

## 2 · Build a WHOLE epic — epic mode *(the default)*

**Don't hand-write this prompt, and don't save it anywhere.** Start the build with one command in Claude Code:

```
/build <epic-slug>
```

It runs the plugin's bundled generator, which reads the epic README and every `sprint-N.md`, and puts the finished
orchestrator prompt in your prompt box. Press enter. On a host without the plugin's mod, run the generator
from the project root and paste its output: `npx -y @golden-frijoles/kit emit-epic-kickoff --epic <epic-slug>`
(if the project has its own `scripts/emit-epic-kickoff.mjs`, run that instead). Either way the epic
docs are the state, so the prompt is regenerated every time, never kept in a file. A hand-composed kickoff is where
the architecture-lock pass gets summarised away. What it carries (SSOT: WAYS-OF-WORKING → *Epic-mode builds*, don't fork a second copy here):

- **Lock the architecture first.** `D1…Dn` in the epic README, verified against live code and live data,
  plus a per-sprint build contract, then `node scripts/epic-phase.mjs lock --epic <slug>`. Builders cite; they
  never re-derive.
- **Stack the branches.** `feat/<slug>` → `-s2` → `-s3`, one PR per sprint, merged in order.
- **Two cross-family review passes per PR, routed** (§4). No orchestrator subagent reviewers on LOW.
- **Merges pre-authorized on green** for this named epic — the gate and the review layers still apply.
- **Done means shipped**, not merged: migrations applied and verified, flags created, deploy confirmed.

*HIGH-risk epic: the pre-authorization is per-epic and per-plan. A new category of production mutation
(TLS/IAM/secrets, money or entitlement writes, a new external dependency or prod secret) is one focused
question, not a covered case.*

## 2b · Build a single sprint — *the exception*

Use this only for a **one-sprint epic**, or when a sprint's outcome genuinely changes the next sprint's
scope so the next kickoff honestly can't be written yet. Say which it is when you use it.

```
npx -y @golden-frijoles/kit emit-kickoff --epic <epic-slug> --sprint <N>
```

Or, hand-composed from the same shape:

```
Read <AGENTS-path> (Start here) + Roadmap/LEARNINGS.md, then
Roadmap/<NN-macro>/<epic-slug>/README.md + sprint-<N>.md.
Build Sprint <N> of "<epic-slug>" per WAYS-OF-WORKING, in your OWN git worktree off latest main on
feat/<epic-slug>. Plan mode → confirm stories with me → build one story at a time. Commit per story
PATH-SCOPED (git add <your files> && git commit -- <those paths>; never -A). One api spec per testable
story. Keep the CI gate green; open a draft PR declaring risk <risk>. Route the review with
`node scripts/review-route.mjs --builder <you> --tier <risk> <PR#>` — two cross-family passes; do NOT
spawn your own reviewer subagents on a LOW PR. Write the sprint smoke walkthrough into sprint-<N>.md
before calling it done.
```
*HIGH-risk: add — "all stories HIGH → product owner merges; the fresh reviewer subagent is mandatory;
the authed money-path browser smoke is owed to the product owner."*

## 3 · Run a spike — strong model
```
Read <AGENTS-path> (Start here) + Roadmap/LEARNINGS.md, then <brief path>.
Run the <name> spike: time-boxed, READ-ONLY investigation → a written DECISION appended to the brief. No
branch, no code. Answer the brief's questions against the live codebase; sort each capability into
already-possible / light-enhancement / genuinely-new; end with Go / No-go / Go-with-constraints.
I sign off the decision before anything gets groomed.
```

## 4 · Review a PR — one external pass (+ a security lens when triggered), routed (NOT the builder)
```
Review PR #<N> cold after the deterministic gate. The builder does not approve its own diff.
Route it — never hand-pick --agent:
  node scripts/review-route.mjs --builder <who-wrote-it> --tier <low|high> <N>
Run the TWO cross-family passes it prints (a family never reviews its own diff). On a LOW PR that is
the whole layer — do NOT also spawn your own reviewer subagents. On HIGH, add the fresh reviewer
subagent runs too (context independence). A capped family falls to the next in the preference order; if
only one family can run, it runs both prompts and the PR body says so.

**Why two and not three.** Until now a typical build ran the cross-agent passes *and* the orchestrator's
own parallel reviewer subagents, on every PR, regardless of tier — two of those three passes were paying
for the same read. The saving is taken on LOW tier only; HIGH keeps the subagent, because family
independence and context independence are different properties and HIGH is where the second one earns
its cost.
> **TEMPLATE FILL-IN — `<reviewer>`.** Name this project's actual cross-review stack here: one
> **baseline** reviewer run on every PR, one **second model family** escalated to on high-risk diffs,
> and optionally a **specialist/tie-breaker**. Different families matter more than which specific
> vendors — a second opinion from the same family mostly agrees with itself. `cross-review.mjs`'s
> `--agent` flag takes whichever CLIs this project has installed.

## 5 · Strategy / process work — strong model
```
Read <AGENTS-path> (Start here), Roadmap/WAYS-OF-WORKING.md, Roadmap/LEARNINGS.md; skim team memory,
Roadmap/00-ideas/BUILD-ORDER.md and the latest Roadmap/bets/ wave file.
<task>. Docs/planning only. Never assume — validate before editing any canonical doc. No git commits (flag
the changed files for me to review + commit).
```

## 6 · Close an epic
```
Close epic <epic-slug> per WAYS Definition of Done (epic): all sprints merged + smoke-tested (gaps stated) ·
each sprint-N.md has its smoke walkthrough · README ✅ AND its frontmatter `status: shipped` (the SSOT) ·
regenerate the board (`node scripts/build-order.mjs` — never hand-edit BUILD-ORDER.md) · RETROSPECTIVE.md
written · product poster (Roadmap/README.md) updated · team memory updated · promote durable learnings into
LEARNINGS.md (dedupe — sharpen, don't append near-duplicates) · branch deleted.
```

## 7 · Sprint-wrap terminal summary — what an agent prints when a sprint lands
The on-screen handoff when a sprint wraps (triggered by the **"Wrap S\<N\>"** shorthand). This is the
*terminal* message, **not** a doc — the durable record is the `sprint-N.md` (+ `RETROSPECTIVE.md` at
epic close). Keep it a **thin pointer + the delta the product owner must act on**; do **not** re-narrate
what the doc already holds (that re-summary is the only "double work" here — the fix is to point, not
repeat).
```
✅ S<N> "<epic>" wrapped — <one line: what shipped>
Merged:  PR #<N> (<commit>) · risk <LOW|HIGH>
Gate:    <your CI gate> green (CI <run id/link>)
Owed to you (can't self-smoke): <money/auth/browser steps by name — or "none">
Next:    <next story/sprint — or DECISION needed from you>
Detail:  Roadmap/<NN-macro>/<epic>/sprint-<N>.md   ← source of truth, not repeated here
```

## 8 · Resume a session that died mid-flight

Hitting a session limit part-way through an epic is routine, not exceptional — the epic-sized
handover (WAYS-OF-WORKING, "the default unit of work is the EPIC") makes a multi-hour run the normal
shape. The durable docs carry scope and outcomes; what dies with the session is the *in-flight*
state: which story was half-built, which "it's green" was observed rather than assumed, which of the
uncommitted files are finished.

> **TEMPLATE FILL-IN — this section assumes a `scripts/session-trail.mjs`,** which the template does
> **not** ship (it is the consuming project's to provide, same as every other `scripts/*.mjs` these
> docs invoke). Until it exists, resume by hand: read the branch, `git status`, and the sprint doc,
> and re-derive state from the repo rather than from the last session's summary — that re-derivation
> is the actual point of this section, not the script.

**Leaving the trail** — cheap, and worth doing at every natural boundary (a story lands, a gate goes
green, a decision gets made):
```bash
node scripts/session-trail.mjs --checkpoint "<what you just did / what's next>" \
  --verified "<command → the result you actually observed>"
```

**Picking it up:**
```
Resume: read <AGENTS-path> (Start here) + Roadmap/LEARNINGS.md, then run
`node scripts/session-trail.mjs --resume` and follow its briefing.
```

**Why this is not just a handover note.** `--resume` does not ask you to trust the note. Every
checkpoint captures branch, HEAD and the uncommitted file list *mechanically*, and re-entry **diffs
that against the repository as it is now, leading with the disagreement**. This is the direct
implementation of the LEARNINGS rule "re-derive a handover's status from the artifact, never from the
previous session's summary" — a rule that is normally paid for once, by a good-faith close-out
claiming work that did not survive a check.

Two conventions that keep it honest:
- **`--verified` is for facts you OBSERVED**, and renders under its own heading, separate from the
  note. A session's prose about what it did is a claim; a named command with its output is evidence.
  Blurring them is how a confidently wrong handover survives into the next session.
- **The trail lives in the epic folder** (`IN-FLIGHT.md`, inferred from a `feat/<epic-slug>` branch)
  and is **deleted at epic close**, with anything durable promoted into `RETROSPECTIVE.md`. It is
  working state, not a record.

## 9 · Bet a wave boundary — strong model *(the Bet stage)*

**Most bets never need this session**: approving a pitch in `groom` funds it at the gate (`fund.mjs`, in the same
commit as the scaffold). Run this one for what the gate did not settle — seeds approved with "approve, don't fund",
an L bet's next wave, or a queue that needs reordering — at a **wave boundary, not on a calendar**.

```
Bet the wave.
Read <AGENTS-path> (Start here), Roadmap/WAYS-OF-WORKING.md (Betting & appetite), and the cycle files in
Roadmap/bets/. Then read every seed in Roadmap/00-ideas/seeds/ with status: ready, and every L epic at a wave
boundary.
Run the betting table with me: for each candidate, state its appetite and — the part that matters — what
funding it DISPLACES. Recommend a slate that fits one wave; I decide. Fund each with groom's fund.mjs
(--slug <slug> --displaced "<…>" --next | --after <slug>; no placement flag re-bets an L bet in place): it
writes the cycle row, underwritten_by and the build position. Then regenerate the board
(node scripts/build-order.mjs — never hand-edit BUILD-ORDER.md). Planning only, no code.
```

Three rules that keep this from becoming a ceremony:

- **An unpicked pitch is let go, not backlogged.** Note it in the wave file only if it was seriously
  considered. If it matters, it resurfaces — that's cheaper than maintaining a graveyard.
- **"What did it displace?" is the whole point.** A bet with no named opportunity cost hasn't been
  bet on; it's been waved through. A ticket board can show you what's queued and never what it cost.
- **`underwritten_by: null` is the honest state of an idea nobody has paid for.** Fine in the funnel,
  impossible on the board — `build-order.mjs` hard-fails a `queued` seed with no `appetite:`, and any
  live bet with no `underwritten_by:` naming a cycle file.

Advisory second opinion available before you commit the slate: `node scripts/cross-panel.mjs
Roadmap/bets/<wave>.md --lens both --agent <reviewer>` — print-only, never gates.

## 10 · Re-shape a bet that hit its circuit breaker — strong model

**The breaker is the default, not the exception.** When an M/L bet exhausts its appetite, work
*stops and returns to shaping* — it is never extended in flight. Repeated hammering on one problem
means the work is uphill (unknowns), not that it needs more tokens. A scope that stops moving is a
raised hand.

```
Re-shape <slug> — it hit its appetite breaker.
Read <AGENTS-path> (Start here) + Roadmap/LEARNINGS.md, Roadmap/bets/<wave>.md, the seed
Roadmap/00-ideas/seeds/<slug>.md, and whatever the epic actually produced before it stalled.
Do NOT propose more budget. Answer three questions in writing: (1) what did we learn that the original
shaping didn't know? (2) what is the smaller problem that fits the SAME appetite? (3) if there isn't one,
what's the case for dropping it — and what did the spend buy us anyway? Update the seed's pitch in place;
land it at status: ready so it re-enters at the next betting table. Planning only, no code.
```

Record the outcome as a dated line in the wave file that funded it — a bet that stopped is a result,
not a failure to hide. The seed keeps its history; a re-shaped pitch that wins the next table is the
system working.

---

*§1–§8 mirror what the `groom` skill emits (Stage 8) — keep the two in sync. §9–§10 mirror
WAYS-OF-WORKING → *Betting & appetite* (the SSOT for appetite tiers, lanes and the breaker; don't
fork a second copy here). Section numbers §1–§8 are cited by number from WAYS-OF-WORKING and from
`scripts/`— renumber them and those references break. Conventions baked in: appetite before solution,
own worktree + path-scoped commits, risk tier, single-pass review, strong-model planning.*
