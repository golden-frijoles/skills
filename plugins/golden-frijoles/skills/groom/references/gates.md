# The gates — one shape, plain agile words

Every decision the product owner makes with the agent is a **gate**: Strategy (setup's strategy step), Plan (groom
Stage 7) and Build (groom Stage 8). This file is their **one home**. Groom, setup and the coaches point here; none of
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
After the options, a gate may carry one closing line (the Plan gate's "What this pushes back"), then groom's budget
line (`session-budget.md`).

## The words on screen

The words a person reads are plain agile. The records behind them keep their names: files, keys, values, folders and
script names never change, so a gate may show one as a path or in `code`, never as a word.

| On screen | Behind it (files keep these) | Never on screen |
|---|---|---|
| Idea, in the backlog | a seed in `Roadmap/00-ideas/seeds/` | seed |
| Epic · Sprint · User story | the epic `README.md`, `sprint-N.md`, a story heading | scaffold, scaffolded, kickoff, epic mode |
| Approve the plan | `fund.mjs`: a row in `Roadmap/bets/wave-YYYY-MM.md`, `underwritten_by:`, a build position | fund, funds, funded, funding, underwritten, cycle |
| Park it | the seed stays `status: ready` | — |
| What this pushes back | `fund.mjs --displaced` | displaced |
| Approve the strategy | `status: agreed` in each `Roadmap/00-strategy/` file | agreed |
| Change something | `status: draft`, revised in place | draft, drafts |
| Backlog → Grooming → Ready → Building → QA → Shipped | `status:` and `phase:` in the epic README | — |
| Proven · Disproven · Unclear | `verdict:` in the epic README | — |
| Flag | `flag_key:`, a flag in Golden Frijoles | — |

"Bet" is the idea behind an epic and appears only as "We bet that …", never as a stage, a button or a status.

| Was | Now |
|---|---|
| approve (fund + scaffold) | Approve the plan |
| approve, don't fund | Park it |

## The Strategy gate

Shown by setup's strategy step after the agent has written the three strategy files. Its block lands with the
Strategy gate (gates-in-plain-agile sprint 2).

## The Plan gate (groom Stage 7)

```gate plan
The plan is ready: <path to the seed>

We bet that <the seed's hypothesis, or the problem in one sentence>.

  Moves ........ <the target metric's name> (your North Star input)
  Target ....... <from> → <to>
  Read date .... <read date, or: 30 days after it ships>
  Size ......... <appetite>, about $<lo>–<hi> of agent time
  Sprints ...... <1 title  2 title …>. <n> user stories
  Flag ......... <flag key>, <on, so you can switch it off | off until you try it> | none: <why>
  Measured by .. <the event the target metric counts>

Decisions only you can make:
  a. <question>
  b. <question>

  1 Approve the plan
  2 Park it (it stays in the backlog, groomed)
  3 Change something

What this pushes back: <what waits>. It builds next | It builds after <title>.
```

- **The values** come from the seed's frontmatter and pitch: `hypothesis`, `target_metric` / `target_from` /
  `target_to` / `read_date` (`result-record.md`), `appetite` and `quote`, the slices, `flag_key` and its polarity or
  the Stage 6b carve-out. "(your North Star input)" only when the target metric is one of the keys `strategy.mjs` printed; no
  target → leave out Moves, Target and Read date. Never invent a number or a hypothesis.
- **Flag** says what Stage 6b decided (`kill-switch.md`): a kill switch ships **on, so you can switch it off**; an
  enablement flag ships **off until you try it**. "none: <why>" only when Stage 6b wrote a carve-out; an epic that never
  reached Stage 6b leaves the line out. When the seed does not say which polarity, leave out on/off rather than guess.
- **Measured by** is the event `strategy.mjs` prints beside the target metric's input (`event <name>`), only when it
  prints one. Otherwise leave the line out; never invent an event name.
- **What this pushes back** is what you propose stays waiting because of this epic (from the month's
  `Roadmap/bets/` file and *Ready* in `BUILD-ORDER.md`), and where it goes in the queue. The person edits either.
- **1 Approve the plan** runs groom Stage 7.3: `fund.mjs --slug <slug> --displaced "<what waits>" --next` (or
  `--after <slug>` when it builds after another), then `scaffold-epic.mjs`, then the one commit. Then show the Build gate.
- **2 Park it** runs nothing: the seed stays `status: ready`, nothing is funded or scaffolded, exactly as the old
  option did (Was | Now). Say "Parked: it stays in the backlog, groomed." and stop.
- **3 Change something**: revise the seed and show the gate again.

## The Build gate (groom Stage 8)

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

- **The flag line** only when the seed has a `flag_key`, on or off as the Plan gate said (left out when it did not say). Groom never creates a flag;
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
  and hand over its output. Groom never builds. With an item missing, **2** walks it, then shows this
  gate again. **Later**: stop; the epic waits in *Ready*.
