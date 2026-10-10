# The gates — one shape, plain agile words

Every decision the product owner makes with the agent is a **gate**: Strategy (setup's strategy step), Plan (refine
Stage 7) and Build (refine Stage 8). This file is their **one home**. Refine, setup and the coaches point here; none of
them restate a gate.

## The shape

Every gate prints four things, in this order, and nothing else:

1. **Where to read it** — a path (and the console link, when there is one).
2. **What's decided for you** — what the agent settled from the repo and the conversation; no need to check unless
   the person disagrees.
3. **The two or three decisions only they can make** — questions lettered a, b, c, so an answer to one is never
   mistaken for an option. None left open → leave the line out.
4. **The numbered options** — the person picks one by its number, or answers in their own words.

Print each gate from its block below: fill every `<…>`, leave out a line whose value is missing, and never add a line.
After the options, a gate may carry one closing line (the Plan gate's "What this pushes back"), then refine's budget
line (`session-budget.md`).

## The words on screen

The words a person reads are plain agile. The records behind them keep their names: files, keys, values, folders and
script names never change, so a gate may show one as a path or in `code`, never as a word.

| On screen | Behind it (files keep these) | Never on screen |
|---|---|---|
| Idea, in the backlog | a seed in `Roadmap/00-ideas/seeds/` | seed |
| Epic · Sprint · User story | the epic `README.md`, `sprint-N.md`, a story heading | scaffold, scaffolds, scaffolded, scaffolding, kickoff, kickoffs, kick-off, epic mode |
| Approve the plan | `fund.mjs`: a row in `Roadmap/bets/wave-YYYY-MM.md`, `underwritten_by:`, a build position | fund, funds, funded, funding, underwrite, underwritten, cycle, cycles |
| Park it | the seed stays `status: ready` | — |
| What this pushes back | `fund.mjs --displaced` | displaced |
| Approve the strategy | `status: agreed` in each `Roadmap/00-strategy/` file | agreed |
| Change something | `status: draft`, revised in place | draft, drafts, drafted |
| Backlog → Refining → Ready → Building → QA → Shipped | `status:` and `phase:` in the epic README | groom, grooming, groomed |
| Proven · Disproven · Unclear | `verdict:` in the epic README | — |
| Flag | `flag_key:`, a flag in Golden Frijoles | — |

"Bet" is the idea behind an epic and appears only as its sentence ("We believe that … for … will … because … We'll
know when …"), never as a stage, a button or a status.

| Was | Now |
|---|---|
| approve (fund + scaffold) | Approve the plan |
| approve, don't fund | Park it |

## The Strategy gate (setup's strategy step)

Setup's strategy step drafts the three strategy files first, by setup's `references/draft.md`: the founder's sentence,
then the reads, then each file by its coach's template with `status: draft` and a source on every claim line, and two
North Star candidates in `north-star.md`'s `## Candidates`. Then:

```gate strategy
Your strategy is written and ready to review.

Read them      Roadmap/00-strategy/  (<n> files, any Markdown viewer; <k> lines marked assumed)

Product & persona (from the repo, no need to check unless you disagree)
               For: <persona, doing their job>
               The problem: <the problem, one line>
               The promise: <the value proposition, one line>
               How you charge: <the business model, one line>

North Star     A · <name> (<game>, counts <unit>): <metric, one line>
                   Inputs: <input> (tracked as <event> | needs an event) · <input> (…) · <input> (…)
                   Builds: <what it would make you build>
               B · <name> (<game>, counts <unit>): <metric, one line>
                   Inputs: <input> (…) · <input> (…) · <input> (…)
                   Builds: <what it would make you build>

Roadmap        <n> shipped, <n> being built, <n> ideas (from the repo)

First idea     <after a: We believe that <the change> for <persona> will <move the input>, because <the insight>.
               We'll know when <the signal>. | before a: written once you choose A or B>

Decisions only you can make:
  a. North Star: A or B?
  b. <after a: The first idea's target: <input> from what number, to what, by when? "Not known yet" is an answer.>
  c. <one more question the repo leaves open, if any>

Answer them here, or:

  1 Approve the strategy
  2 Change something
  3 Coach me through it, one piece at a time
```

- **Product & persona** comes from what the files say; a line the repo cannot answer becomes a decision instead (never
  more than three) or is left out. Never invent a fact about the business. *Read them* counts the `(assumed)` lines.
- **North Star** shows the two candidates from `## Candidates` **alike**: each with its game and what it counts, its
  inputs (each marked with the event `read-product` found, or "needs an event") and its *what it would make you build*
  line. Neither is shown first as the default, and nothing about the first idea appears until the person picks.
  **Roadmap** is one line from `read-repo` (left out on route 2).
- **First idea** appears once decision a is answered (show the gate again with it): a bet sentence
  (`result-record.md`, *We'll know when* included) on one input of the chosen candidate. Its target is decision b, asked
  as a question: never propose the numbers. "Not known yet" is a full answer.
- **Decision order:** a coach's proposals first (the rule below), then a, then b once a is answered, then at most one
  more; the three-decision limit counts a, b and that one.
- **A strategy with one North Star** (written before candidates existed, or by the North Star coach, which settles
  the choice in its workshop) shows it as before: "North Star: <metric>. Keep it?" in place of a.
- **Answers to the decisions** are written into the files before anything else, then the gate is shown again.
- **A section the coach proposed** (its first line is `_Proposed by the coach, not decided yet._`, refine's
  `references/coaching.md` §5) is a decision only the person can make: list it under *Decisions only you can make*
  as "<file> · <heading>: the coach's proposal. Keep it?", ahead of the others. **List every one**, however many: the
  three-decision limit counts the other decisions, never these, because Approve accepts each proposal it removes.
- **1 Approve the strategy** before decision a is answered asks a first (and then b), in the gate's words, and never
  picks a candidate for the person; with both answered it writes the chosen candidate into `north-star.md`'s own sections (the game, the metric, the
  input table) and its `## Sync payload`, and removes `## Candidates`; sets `status: agreed` in each strategy file's
  frontmatter (Approve is agreement: bets against these inputs are grounded); removes the proposed line from every
  section the gate listed (approving accepts those proposals); and writes the **first bet** as a seed from refine's
  `templates/scope-seed.md` in `Roadmap/00-ideas/seeds/`, every `{{…}}` filled: `title` (the change, a few words),
  `slug` (from the title), `area` (where `read-repo` puts ideas; `01` on a new project), `type: feature`, `appetite: null`
  (refine sets it), `risk: low`, `status: raw`, `intent_ask: proxy` with the founder's one sentence as the ask; the
  sentence as `hypothesis`; `persona`; `target_metric` (the input's key), `target_from`, `target_to` and `read_date`
  (null = 30 days after shipping) from decision b, with `grounded: true`. "Not known yet" leaves the four target fields
  null with `grounded: false` and `grounded_reason: no baseline yet`, never an invented number. Then run
  `node scripts/build-order.mjs` (the run rule applies) so the board shows it. It changes nothing else. Then render the
  one-pagers from the approved files (`node scripts/one-pagers.mjs`, run as the coaches' kit rule says), tell the
  person where they are in one line. Inside setup, go on to its instrument and connect steps (setup's
  `references/instrument.md`, `references/connect.md`); otherwise offer refining (`refine`). The North Star's sync to the engine stays the person's own step (the North Star chapter of `strategy`).
- **2 Change something** revises the files in place; they stay `status: draft`. Show the gate again.
- **3 Coach me through it** runs the `strategy` skill's chapters `pmf-narrative`, then `north-star`, then `risk-validation`, each in its full
  step-by-step mode on the file already written (or from setup's one sentence, with no file yet, for a new idea), one after the other without asking in between, then shows this gate
  again.
- **When a coach finishes** (each coach's last step points here): inside "Coach me through it", go on to the next coach,
  or back to this gate after the last. **Before showing this gate**, when `Roadmap/00-strategy/cold-read/` holds a sealed
  read (a `.sha256` beside it) with no `<read>-compare.md` yet, offer the compare first (the cold-read chapter of `strategy`, Part 2):
  it must run while the proposed lines are still in the files, and Approve removes them. Run on its own, once its file is written: when all three files exist and any is
  not yet approved, show this gate; with a file missing, offer that file's coach first.

## The Plan gate (refine Stage 7)

```gate plan
The plan is ready: <path to the seed>

We believe that <the change> for <persona> will <move the input>, because <the insight>.
We'll know when <the signal>.

  Moves ........ <the target metric's name> (your North Star input)
  Grounded ..... yes | no — <the reason the product owner gave>
  Target ....... <from> → <to>
  Read date .... <read date, or: 30 days after it ships>
  Size ......... <appetite>, about $<lo>–<hi> of agent time
  Sprints ...... <1 title  2 title …>. <n> user stories
  Flag ......... <flag key>, <on, so you can switch it off | off until you roll it out, measured by <event>> | none: <why>
  Measured by .. <the event the target metric counts>

Decisions only you can make:
  a. <question>
  b. <question>

  1 Approve the plan
  2 Park it (it stays in the backlog, refined)
  3 Change something

What this pushes back: <what waits>. It builds next | It builds after <title>.
```

- **The bet** is the seed's `hypothesis`, the sentence Stage 1.5 wrote (`result-record.md`), shown as written. A seed
  refined before the sentence existed shows its hypothesis, or the problem in one sentence, as it is. A Bug or Chore
  shows `Why: keeps <X> working` and no Grounded line.
- **Grounded** shows the seed's `grounded`: `yes` when true; `no — <grounded_reason>` when false. Left out when
  `grounded` is null (a Bug, a Chore, or a seed refined before it existed).
- **The values** come from the seed's frontmatter and pitch: `hypothesis`, `target_metric` / `target_from` /
  `target_to` / `read_date` (`result-record.md`), `appetite` and `quote`, the slices, `flag_key` and its polarity or
  the Stage 6b carve-out. "(your North Star input)" only when the target metric is one of the keys `strategy.mjs` printed; no
  target → leave out Moves, Target and Read date (except as *Not grounded* says). Never invent a number or a hypothesis.
- **Not grounded.** When `strategy.mjs` printed nothing (no strategy yet), the Moves line always shows, target or not:
  `<the target metric's name> (not grounded: no strategy yet)`, or `not grounded: no strategy yet` with no target. It is
  read at each gate, so it stops showing once a strategy exists.
- **Flag** says what Stage 6b decided (`kill-switch.md`): a kill switch ships **on, so you can switch it off**; a
  Measure flag (enablement) ships **off until you roll it out, measured by <the bet's adopted_event>**, and while the
  founder chose "Later" at the sign-in suggestion it adds "(measured once you sign in)". "none: <why>" only when Stage 6b wrote a carve-out; an epic that never
  reached Stage 6b leaves the line out. When the seed does not say which polarity, leave out on/off rather than guess.
- **Measured by** is the event `strategy.mjs` prints beside the target metric's input (`event <name>`), only when it
  prints one. Otherwise leave the line out; never invent an event name.
- **What this pushes back** is what you propose stays waiting because of this epic (from the month's
  `Roadmap/bets/` file and *Ready* in `BUILD-ORDER.md`), and where it goes in the queue. The person edits either.
- **1 Approve the plan** runs refine Stage 7.3: `fund.mjs --slug <slug> --displaced "<what waits>" --next` (or
  `--after <slug>` when it builds after another), then `scaffold-epic.mjs`, then the one commit. Then show the Build gate.
- **2 Park it** runs nothing: the seed stays `status: ready`, nothing is funded or scaffolded, exactly as the old
  option did (Was | Now). Say "Parked: it stays in the backlog, refined." and stop.
- **3 Change something**: revise the seed and show the gate again.

## The Build gate (refine Stage 8)

```gate build
✓  Plan approved: <epic title>
   Its sprints and user stories are in <epic folder>, committed
✓  Flag planned: <flag key><, on when it ships | , off when it ships>. One user story creates it

Start building whenever you're ready:
  /build <slug>

Follow it here: <board link>/epic/<slug>

<only when at least one line below shows:>
Setup is done. Optional, only if you want them:
  gh ........... lets me open and watch pull requests        <not installed | not signed in>
  Codex ........ a second model reviews each pull request     not installed
  Digest ....... a Telegram message when something is due     not set up
  Claude app ... see <project> from a chat: the console's Setup has your link

<when an item is missing:>
  1 Start building now
  2 <the first missing item: Install gh first | Sign in to gh first | Install Codex first | Set up the digest first>
  3 Later
<when nothing is missing:>
  1 Start building now
  2 Later
```

- **The flag line** only when the seed has a `flag_key`, on or off as the Plan gate said (left out when it did not say). Refine never creates a flag;
  its user story does (`kill-switch.md`).
- **`/build <slug>`** is the line in Claude Code with the plugin. Anywhere else it is Stage 8's generator command (or
  `npx -y @golden-frijoles/kit emit-epic-kickoff --epic <slug>` from the project root), shown as a command; its output
  is the prompt to paste into the building session.
- **Follow it here** only when `board.hubUrl` is set (the kit's `config get board.hubUrl`); the link is that value, without a
  trailing `/`, plus `/epic/<slug>`. Unset → leave the line out.
- **Optional items, only the missing ones**, each found by a command, never assumed: gh — `command -v gh` finds nothing
  (not installed), or `gh auth status` fails (not signed in);
  Codex — `command -v codex` finds nothing; Digest — `TELEGRAM_BOT_TOKEN` is in neither the environment nor
  `.env.local` (check the key's name, never print its value); its fix is setup's *Notify setup*. The Claude app line
  only when the project is linked to Golden Frijoles, and it is never an option. "Setup is done." and the "Optional"
  heading only when at least one item line shows. Nothing missing → the options are **1 Start building now · 2 Later**.
- **The `<when …:>` lines** pick which part to print; they are never printed themselves.
- **1 Start building now**: in Claude Code, tell the person to type `/build <slug>`; elsewhere run the command above
  and hand over its output. Refine never builds. With an item missing, **2** walks it, then shows this
  gate again. **Later**: stop; the epic waits in *Ready*.
