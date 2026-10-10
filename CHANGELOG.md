# Changelog

All notable changes to the `golden-frijoles` plugin (and, from S2, the `@golden-frijoles/kit` package)
are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/). `plugin.json`'s `version` and this file's
newest heading are always the same number — `scripts/check-release.mjs` enforces it in CI.

## [Unreleased]

## [1.6.0] - 2026-10-10

**The Why reads as a story, in full, and the plan names its crew.**

### Added
- Refine writes a feature's **Why as a short story** in plain words: what is wrong today and for whom, what changes,
  why it matters to them, and how we will know. It reads the strategy you already have first (the persona, the value
  proposition, the business model), with a worked before and after.
- **`why-check`** (kit): checks that a Why fits the build view in full (five lines, about 320 characters) and reads as
  plain words: no file names, code names or internal words. Scaffolding refuses a feature whose Why fails it.
- Intent match asks one more, advisory question: does the Why read as a story a stranger could follow? It has its own
  line and never changes the total.
- The Plan gate shows the **Crew (planned, may change)**: who plans and orchestrates, which stories a Sonnet-class
  builder takes, who reviews and who writes the prose. The kickoff carries the **dispatch rule** that makes it happen,
  and takes a story back after one failed attempt.
- `epic-actuals --write` stamps **`actual_models`** (each model and its spend), and the retrospective has a
  *Crew (actual)* line beside the quote.
- `references/checkpoint.md`: the checkpoint shape refine and the kickoff use when you ask where things stand.

### Changed
- The build view shows the **whole Why**, wrapped at word boundaries, instead of cutting it off at one line.

## [1.5.0] - 2026-10-10

**One bet, wired: the flag knows its epic, its funnel and its read.**

### Added
- Refine's Stage 6b asks **Measure** first, "Do you want to know if this worked?", suggested for every feature: an
  enablement flag you roll out, with the bet's measurement in the seed (`target_segment`, `adopted_event`,
  `retained_event`, `retention_days`, an optional `satisfied_event`). **Safety** (a kill switch, by risk) follows.
- When you are not signed in, Measure is where an account is suggested, once per project, with "Later" always there:
  the bet is saved either way, and the Plan gate says "measured once you sign in".
- The bet's measurement travels from the seed through the scaffold, the roadmap contract and the roadmap push.
- A `measure` config section, with `measure.signIn` (`later` | `now`): the Measure sign-in answer, kept so it is asked
  once per project. Needs this kit: 1.4.0 refuses the section.
- Pairs with CLI 1.3.0: `frijoles bet sync <epic README>` creates the bet's Measure flag (off until you roll it out)
  and leaves an existing flag as it is. The console shows each measured flag's funnel on its epic page and in
  Journeys' From your flags, on the TARS model: targeted (everyone), got the flag on, adopted, retained, satisfied or
  "not measured", with adopters who never had the flag on shown beside it.

### Changed
- The cross-review rail accepts agy 1.3.3 (`AGY_PINNED`), after `cross-agent-doctor --fix` re-verified its contract and
  live-probed both models.

## [1.4.0] - 2026-10-09

**A golden welcome in the CLI.**

### Changed
- Setup now points to CLI 1.2.0 (which pins the latest published kit, 1.3.0, until this release publishes kit 1.4.0). Interactive `frijoles setup` ripens a green bean to gold and reveals FRIJOLES with a gold sweep. `--no-motion`, `NO_COLOR`, narrow terminals and machine output remain readable.
- The kit and plugin advance together to 1.4.0; the kit's behavior is unchanged in this release.

## [1.3.0] - 2026-10-09

**Setup instruments and connects: the events the North Star needs, in a pull request, and the first one seen.**

### Added
- After the Strategy gate, setup offers the measuring code as a **pull request you review**
  (`setup/references/instrument.md`): the SDK, a server-side client per request, one `track` per North Star input that
  needs an event (at the code point that proves it), and error capture. It is never merged for you, never on the
  default branch, and no key goes into code.
- Setup's connect step (`setup/references/connect.md`): sign in, `frijoles init --ingest`, the North Star synced, the
  roadmap pushed, then `frijoles status`. Setup ends with three lines: your North Star, your first idea and the PR,
  and the console link.
- `roadmap-push --env-file .env.local` reads the push's own variables from the file, evaluating nothing.
- Pairs with CLI 1.1.0 (which pins kit 1.2.0, the latest published when it was built): `frijoles init --ingest` (an ingest key in `.env.local`, verified before anything is minted) and
  `frijoles status` (has the project's first event arrived). Today shows the same, behind the
  `onboarding.first_event_band_enabled` switch.

### Removed
- **The `gf` CLI alias**, as 1.0 promised ("until 2026-12-31 or CLI 1.1.0"): CLI 1.1.0 publishes `frijoles` only. Replace
  `gf <command>` with `frijoles <command>` (or `npx -y @golden-frijoles/cli <command>`).

## [1.2.0] - 2026-10-09

**Setup drafts the strategy: two North Stars from the evidence, and a first bet in one review.**

### Added
- `refine/read-product.mjs`: what the product says and already measures (the README, the landing copy, the routes,
  analytics calls with their event names, flag reads), each with its `path:line`. Read-only, bounded, and it never
  opens an environment file or prints a key.
- Setup asks *"In one sentence: what is this for, and who is it for?"* before it drafts anything, then drafts the three
  strategy files with a source on every claim line (`(README.md:3)`, `(your words)`, `(assumed)`) and **two** North
  Star candidates to choose between (`setup/references/draft.md`).
- The new-idea route offers *Write it now* (about 5 minutes) before the 45-minute coaching.
- The Strategy gate shows product and persona, the two North Star candidates side by side (each with its inputs and
  whether each is already tracked), the roadmap, and, once you choose, a first idea as a bet sentence whose target you
  give ("not known yet" is an answer). Approve writes the chosen North Star, agrees the files, and writes the first
  idea into the backlog, grounded when it has a target.

### Changed
- The coaches open on an existing draft and go deeper over it, keeping its sources; they never start from a blank
  template over a file with content.

## [1.1.1] - 2026-10-09

### Fixed
- `bets-grounded.mjs` rounds the share to two decimals, as the engine stores input values (`NUMERIC(14,2)`), so a
  same-day re-push is not reported as a different value. The first production reading was 0.0667 sent, 0.07 stored.

## [1.1.0] - 2026-10-09

**Grounded bets: every Why is a hypothesis traced from the North Star.**

### Added
- `refine` Stage 1.5 writes the bet as one sentence (*We believe that … for … will … because … We'll know when …*),
  traced from the strategy: which North Star input, for whom and doing which job, by what mechanism, on what evidence.
- When no input fits, `refine` challenges once with two or three reframes (another input, a smaller cut on the highest
  domino, a chore). An override is always allowed and recorded as `grounded: false` with its reason.
- `strategy.mjs` prints `persona:` and `job:` from the PMF narrative.
- The Plan gate opens with the bet sentence and shows `Grounded ..... yes | no — <reason>`.
- Seeds and epics carry `persona`, `grounded` and `grounded_reason`; the scaffold copies them, the contract checks them,
  and the roadmap push sends `grounded` and `grounded_reason`.
- `bets-grounded.mjs` (in the kit) computes `grounded_bets_share` per month from the funded bets, and `--push` posts it
  as that North Star input's value.
- A flag created at Stage 6b carries the bet's hypothesis as its description.

### Removed
- **`gf-kit`**, as 1.0 promised ("until 2026-12-31 or kit 1.1.0"): the kit publishes `frijoles-kit` only. Replace
  `gf-kit <script>` with `frijoles-kit <script>` (or `npx -y @golden-frijoles/kit <script>`). The `gf` CLI alias is a
  separate package and keeps its own date.

### Changed
- With no strategy, `refine` offers the North Star chapter once per seed instead of never asking; a decline records
  `grounded: false — no strategy yet`.

## [1.0.1] - 2026-10-09

### Changed
- The cross-review rail accepts agy 1.3.2 (`AGY_PINNED`), after `cross-agent-doctor --fix` re-verified its help contract
  and live-probed both models.

## [1.0.0] - 2026-10-08

**Golden Frijoles 1.0: five plain skills, the `frijoles` CLI, and Refining.** One breaking release, so a renamed
command is found in one place. Everything below landed in 0.44.0–0.46.0 and ships together; nothing here is new
behaviour.

| You typed | Now |
|---|---|
| `gf …` | `frijoles …` (`gf` keeps working with a notice until 2026-12-31 or CLI 1.1.0) |
| `gf-kit …` | `frijoles-kit …` (same window) |
| `/golden-frijoles:golden-frijoles` | `/golden-frijoles:setup` |
| `/golden-frijoles:groom` | `/golden-frijoles:refine` |
| `/golden-frijoles:pmf-narrative`, `north-star`, `risk-validation`, `cold-read` | `/golden-frijoles:strategy` (it routes to the chapter) |
| `/golden-frijoles:standup-post`, `weekly-recap`, `pmo-report` | `/golden-frijoles:report` (daily · weekly · pmo) |
| `/golden-frijoles:live-smoke` | `/golden-frijoles:smoke` |
| "use the pr-reviewer subagent" | "use the verifier" (add "security lens" for that pass) |
| `build-order-sync`, `doc-hygiene`, `vercel-prune`, `babysit-pr`, `prose-draft` | the routines run their scripts; `frijoles-kit <name>` anywhere |
| Board: To groom · Grooming · Ready to build | Backlog · Refining · Ready (stored stage keys unchanged) |

Pin the previous release with `claude plugin marketplace add golden-frijoles/skills@v0.43.0`, and the CLI with
`npm i -g @golden-frijoles/cli@0.8.0`.

## [0.46.0] - 2026-10-08

### Changed
- **Five skills and one agent** (plugin-1-0 S3), down from fifteen and one:
  | Now | Was |
  |---|---|
  | `setup` | `golden-frijoles` |
  | `refine` | `groom` (0.45.0) |
  | `strategy` (chapters: cold read · PMF narrative · North Star · risk validation) | `cold-read`, `pmf-narrative`, `north-star`, `risk-validation` |
  | `report` (daily · weekly · pmo) | `standup-post`, `weekly-recap`, `pmo-report` |
  | `smoke` | `live-smoke` |
  | agent `verifier` (general or security lens) | agent `pr-reviewer` |
  Asking for an old name by its words still reaches the right chapter: each router's description keeps the old
  trigger phrases.
- **The install prompt's last step** reads "Run the setup skill from the golden-frijoles plugin."

### Removed
- `build-order-sync`, `doc-hygiene`, `vercel-prune`, `babysit-pr` and `prose-draft` are no longer installed: they were
  our own operations. Their scripts stay in the kit (`frijoles-kit build-order-sync`, …), and the template's routines
  run them directly, with what each skill added written into the routine's steps.

## [0.45.0] - 2026-10-08

### Changed
- **The planning skill is `refine`** (plugin-1-0 S2): `/golden-frijoles:refine`, formerly `groom`. It moves an idea from
  Backlog through Refining to Ready, so it carries the stage's name. Every locator, reference and the vendored kickoff
  follow; the installed path is `skills/refine/`.
- **The screens say Backlog → Refining → Ready.** The board, the epic page, the build view's stage track and the
  generated `BUILD-ORDER.md` headings; stored stage keys are unchanged. "Grooming" is retired: Scrum renamed it
  refinement in 2013, and in UK and Australian English the word mostly means child abuse. `check-gate-words` bans
  groom, grooming and groomed inside the gates; the console's vocabulary guard retires "Grooming" as a label.
- **Plain agile in the last two places:** the L-bet question is now "Start the next part of `<slug>`? What waits for
  it?", and the session kickoff's shaped-bet row describes the Plan gate.

## [0.44.0] - 2026-10-08

### Changed
- **The CLI's command is `frijoles`, and the kit's is `frijoles-kit`** (plugin-1-0 S1). oh-my-zsh's git plugin defines
  `alias gf='git fetch'` and its starter `.zshrc` enables it, so `gf login` ran `git fetch` on those machines. Every
  skill, template file and printed command now says `frijoles` / `frijoles-kit`. `gf` and `gf-kit` keep working with a
  one-line notice on stderr until **2026-12-31 or version 1.1.0**, whichever comes first; scripts that run the CLI try
  `frijoles` first and fall back to `gf`. Tokens (`gf_pat_…`), `GF_*` variables and the credentials path are unchanged.

## [0.43.0] - 2026-10-08

### Added
- **Three one-pagers from the strategy files** (coaches-v2 S3.2). `gf-kit one-pagers` renders a business model canvas
  (with "Strategyzer.com" under it, CC BY-SA 3.0), a value proposition sheet (our own layout: the customer's outcome,
  motivation and gaps against the product's promise, the North Star, and what is not claimed yet) and a persona poster,
  as printable HTML and Markdown in `Roadmap/00-strategy/one-pagers/`. Every line is derived from the files and shows
  its label (true today, aspirational, agreed, sourced, hypothesis); an unlabelled persona line reads as a hypothesis;
  a sheet from a draft file is watermarked. The Strategy gate's Approve renders them, and so does each coach's last
  step. The narrative template gains labelled lines and a `### Persona` block; its headings are unchanged.

### Changed
- **Per-coach fixes** (S3.1). The narrative coach distils a rich first answer into one insight (earned · unique ·
  grounded), picks the one person who hurts most before asking the problem, and fills the persona from laddered-up
  needs. The North Star coach runs its candidates against 4–5 customer scenarios, in a table, before the maker picks.
  The risk coach reads the North Star too and starts from every claim the earlier files mark as untested.
- **Voice and one copy** (S3.3). The coaches speak as the Golden Frijoles strategy coach; outside methods and brands
  appear only in each coach's Sources credit. The CLI version a skill quotes is derived from the CLI's own
  `package.json` (north-star and setup now name 0.8.0, not 0.3.0 and 0.7.0), and the monorepo's unit suite fails while
  one differs.

## [0.42.0] - 2026-10-08

### Changed
- **The three strategy coaches share one way of working** (coaches-v2 S2.1, groom's `references/coaching.md`). Each
  opens by playing back the strategy files already written, starts every message with `Step N of X` (pmf-narrative 8 ·
  north-star 7 · risk-validation 6), saves its file after every step with early answers parked under their headings,
  and offers a cold read once before coaching.
- **Options, not a blank page** (S2.2). Each step offers 2–4 options to pick or edit, looked up and cited when the step
  leans on the present; when the coach can't look it says so and uses the classic cases. No invented figures.
- **Delegation, the product check and private strategy** (S2.3). A step the maker hands over gets an options brief,
  and its section opens with `_Proposed by the coach, not decided yet._` until they pick; the Strategy gate asks about
  each such section, and Approve removes the line. Benefits and moats are labelled `(true today)` or `(aspirational)`
  against the repo. Before the first write, `gf-kit strategy-private ensure` keeps `Roadmap/00-strategy/` out of git on
  a public repo (or one whose visibility can't be read), unless something there is already committed or `.gitignore`
  says `!Roadmap/00-strategy/`.
- **Ladder up** (S2.4). An example the founder gives becomes the need behind it, checked against outside evidence or
  labelled `(hypothesis)`, and confirmed before it reaches a dimension or a persona line.

## [0.41.0] - 2026-10-08

### Added
- **`cold-read`: an independent read before the strategy coaches** (coaches-v2 S1.1). A separate agent reads the repo
  under an exclusion list (no strategy files, no coaching methods, no positioning) and writes a cold read with a
  reading log and its own contamination; `gf-kit cold-read run` gives it to Codex when it is reachable, and says so
  (exit 3) when no other model family is, so the skill runs it as a same-family agent and records that. The read is
  sealed with a sha256 (`<file>.sha256`, `shasum -a 256 -c` format) and a seal is never replaced.
- **The compare** (coaches-v2 S1.2). `gf-kit cold-read compare <read>` refuses a read whose hash changed, naming both
  hashes, and otherwise writes the compare skeleton: converged · diverged · only the cold read · only coached ·
  decisions · did it earn its place. Sections a coach wrote on the maker's behalf are listed as facilitator-authored,
  read from the strategy files.

## [0.40.0] - 2026-10-08

### Changed
- **The build view says why, how far and where** (build-view-upgrade S1.1–S1.3). A Why line under Epic reads the
  epic's target (hypothesis, metric from ━━▸ to, read date) or says "no target set". Progress is one bar per sprint
  (▰ a story with a commit, ▱ not yet, │ between sprints). Status is the stage as a track, `Grooming ─ Ready ─
  ◉ Building ─ QA ─ Shipped`, with where it came from on the line under it. The link opens the epic's own page on
  the Hub (`<board.hubUrl>/epic/<slug>`), and the board when nothing is in flight.
- **The session line is in colour, with the time to each reset** (build-view-upgrade S1.4). Each figure is green,
  yellow from 60 %, red from the hand-off line, and each rate-limit window shows its reset: `5h 78% (-2h) · 7d 46%
  (-3d)`. It draws on a row under the prompt's hint line; an engine without `$.state` keeps the plain status line.

## [0.39.0] - 2026-10-08

### Changed
- **Setup also runs on a fresh skeleton** (first-run-setup D4 follow-up). After `gf setup` and `gf-kit init`, the
  config and an empty `Roadmap/` both exist; the umbrella skill's Stage 2 now still runs there (no epic and no idea
  yet), so the repo read or the new idea's sentence is reached. A Q1 that `gf setup` already answered is not asked
  again: setup says what it found and takes that route.

## [0.38.0] - 2026-10-08

### Changed
- **The config registry no longer asks "where are you starting" at setup** (first-run-setup D4 follow-up).
  `project.startPoint` is now `askWhen: 'never-yet'`: setup's route writes it (This repo → `building`; a new idea →
  `idea` or `plan`). Any tool that asks the setup questions from the registry, such as `gf config` once it depends
  on this kit, now asks Q1 and the account question only.

## [0.37.0] - 2026-10-07

### Changed
- **Setup says what happened and what it found before asking anything** (first-run-setup S1.1). Signed in, it opens
  with "Signed in as …" and the product this machine is signed in for (from `gf whoami`), then "I looked first":
  whether `Roadmap/` is here, the stack, the commit count and the open pull requests. Then one plain question: **What
  are we working on? 1 This repo · 2 A new idea · 3 Just planning**, writing `project.mode` as before. The "where are
  you starting" question is gone; the route records it.
- **A new idea starts with one sentence** (S1.3), then **1 Strategy first** (the three coaches, ending at the Strategy
  gate) or **2 A first epic now** (groom, with your sentence as the ask). With no strategy, a pitch now says
  `Moves · Tests: not grounded — no strategy yet` and the Plan gate's Moves line says "not grounded: no strategy yet",
  until a strategy exists.

### Added
- **`groom/read-repo.mjs`: an existing project, read into the roadmap** (S1.2). A dry run first: what shipped (merged
  pull requests grouped by branch, else merge commits, release tags or `docs/`; the last 12 months, the 20 largest,
  and what was left out), what's being built (open pull requests) and the open issues grouped into ideas. On approval
  it writes them through `scaffold-epic.mjs`, `fund.mjs` and the seed template: shipped epics marked "backfilled, no
  target", Building epics named by their branch so the live board finds them, ideas in the backlog listing their issue
  numbers. New files under `Roadmap/` only, checked against the roadmap contract; nothing on GitHub is touched, and
  without `gh` it reads git alone and says so.

## [0.36.0] - 2026-10-07

### Changed
- **The strategy step ends in one Strategy gate** (gates-in-plain-agile S2.1). From setup's idea path, the agent
  writes the three strategy files from the conversation and the repo, then shows where to read them, what was decided
  from the repo, up to three decisions only you can make (who first, the North Star, the riskiest assumption), and
  **1 Approve the strategy · 2 Change something · 3 Coach me through it, one piece at a time**. Approve sets
  `status: agreed` in each file, as the coaches did; the coaches no longer ask you to mark a file agreed.

### Added
- **`scripts/check-gate-words.mjs`** (plugin-repo tooling, S2.2): no gate block shows a bookkeeping word (fund,
  scaffold, underwritten, displaced, cycle, kickoff, epic mode, agreed, draft), no copy names a retired option, and a
  gate has one wording everywhere. Both lists are read from groom's `references/gates.md`; file values, keys and
  paths in inline code are never flagged. Runs in the skills CI and, for the root Roadmap copies, the monorepo CI.

## [0.35.0] - 2026-10-07

### Changed
- **The Plan and Build gates speak plain agile** (gates-in-plain-agile S1). Every gate has one shape, written once in
  groom's new `references/gates.md`: where to read it, what's decided for you, the two or three decisions only you can
  make, then numbered options. The Plan gate shows the plan's path, "We bet that …", Moves, Target, Read date, Size,
  Sprints, Flag and Measured by, then **1 Approve the plan · 2 Park it · 3 Change something** and "What this pushes
  back". **Park it** is the old "approve, don't fund", unchanged in behaviour. After approval the Build gate says what
  was created, the one command (`/build <slug>`), where to follow it (with `board.hubUrl` set) and only the optional
  setup items that are missing. `fund.mjs`, `scaffold-epic.mjs` and every file value they write are unchanged.
- **`strategy.mjs` prints the event behind a North Star input** (`event <name>`, only for a `telemetry_event` input),
  so the Plan gate's "Measured by" line never invents an event name.
- **The option names match everywhere**: the WAYS-OF-WORKING template, `SESSION-KICKOFFS.md` and the `bets/` and
  `00-ideas/` READMEs say "Approve the plan" and "Park it".

## [0.34.0] - 2026-10-07

### Added
- **An epic's flag travels with it** (one-epic-page S2.3). When groom Stage 6b decides a flag, its key goes in the
  seed's frontmatter as `flag_key:`. `scaffold-epic` copies it into the epic README, the doc-format contract checks it
  against the SDK's key grammar (`contract-flag-key-invalid`), and `roadmap-extract` pushes it as `flag_key`. It also
  pushes the README's own `**Flag:** …` line as `flag_note`, which is where an epic with no flag says why. The Hub's
  epic page reads the flag's state from your project's registry and links to it in Ship.
- **SESSION-KICKOFFS says the Hub's plain lines are the same steps**: "Wrap sprint 2 of the x epic in p" is
  `Wrap S2`, "Resume the x epic in p where its last session stopped" is `Resume`, and so on.

### Changed
- **The agy pin is 1.3.1.** agy auto-updated mid-review, and `cross-agent-doctor agy --fix` re-verified its help
  contract with a green live probe.

## [0.33.0] - 2026-10-07

### Changed
- **`epic-read` fetches the number itself** (result-record S3). With a target and no `--actual`, it runs
  `gf north-star readings <target_metric> --to <today> --json` and drafts from the latest reading since the epic
  shipped, citing `north-star:<input>@<day>`. `--experiment <key>` also reads the experiment's decision record through
  `gf experiments decision` and cites `ab:<key>`. All you do is approve with `--write`. The owner's `--actual` /
  `--evidence` still win. No `gf`, not signed in, or no reading → one "could not fetch the number" line, and it asks,
  as before. Needs `@golden-frijoles/cli` 0.6.0 and `gf login`; the project-key check (`SELF_PROJECT_API_KEY`) is gone.

## [0.32.0] - 2026-10-07

### Added
- **`epic-read.mjs` reads an epic's result on its read date** (result-record S2.1). Before the date it says when the
  read is due and stops. On the date it drafts proven, disproven or unclear from the target and the number the owner
  reports, with its evidence, and writes nothing until `--write`, which is the owner's approval. It re-runs the
  contract on what it is about to write: proven or disproven without evidence that points somewhere is refused. A
  read more than 90 days after shipping is written and marked late. An epic shipped with no target can take an owner
  verdict, one epic at a time. With the project key, it checks the metric against the project's North Star inputs.
- **`session-resume` says when a read is due**: one `[read-due]` line per epic, until its verdict is written.

### Changed
- `stampFrontmatter` moved from `epic-actuals.mjs` to `lib/frontmatter-stamp.mjs` (still re-exported there), so both
  README writers share one line editor.
- A target is now `target_metric`, `target_from` and `target_to` together; a written read date that passes before
  shipping is read on ship day; an evidence link must parse as an https URL.

## [0.31.0] - 2026-10-07

### Added
- **Every epic can carry its result record** (result-record S1). Groom's Stage 1.5 now asks once which number the
  bet should move, from what to what, and when it is read, offering the North Star input keys `strategy.mjs` prints on
  its new `Target:` line (free text otherwise, shown as "not grounded"). The seed holds `hypothesis`, `target_metric`,
  `target_from`, `target_to` and `read_date`; `scaffold-epic` copies them into the epic README, which is born with
  `verdict`, `verdict_actual`, `verdict_evidence` and `verdict_at` set to null. The Bet block shows the target.
- **The contract knows the fields.** `roadmap-contract.mjs` validates them (`verdict` is proven, disproven or unclear;
  dates are real days; proven or disproven needs a number and evidence that points somewhere: an `https://` link,
  `north-star:<input>@YYYY-MM-DD` or `ab:<experiment>`). No target at all is fine.
- **The extract carries them to the Hub**, with the default read date (30 days after shipping, only for a shipped
  epic that has a target) labelled `read_date_derived`, and `read_late` for a verdict more than 90 days after
  shipping. The day rule lives once, in `scripts/lib/result-dates.mjs`.

## [0.30.0] - 2026-10-06

### Changed
- **Setup's account question says what an account adds before asking** (account-from-the-terminal S2.3). Q4 now
  reads in four short lines: what works with no account, what an account adds, that signing in opens the browser
  once, and that it can wait until a bet needs a flag — then **Sign in now (recommended)** · **Later**. "Now" runs
  `gf login` (browser sign-in, CLI 0.5.0) then `gf init`; "Later" finishes setup with no account. The
  `project.account` key and its values are unchanged.

## [0.29.1] - 2026-10-06

### Fixed
- **`cross-agent-doctor --fix` bumps both copies of the agy pin** (the repo's `scripts/lib/` and the template's), so a
  bump can no longer break script parity; the pin is now agy 1.3.0.
- **A git test fixture can no longer rewrite the repository it runs in.** `git-fixtures-sealed` now also catches the
  cwd-first `git(dir, 'init', …)` shape that slipped past it and flipped `core.bare` from a worktree pre-push hook.

## [0.29.0] - 2026-10-06

### Changed
- **The install prompt reads first and waits** (account-from-the-terminal S1.2). It now tells the agent to read
  `https://goldenfrijoles.com/install.md` before installing anything, summarise what it installs, changes and
  contacts, offer a security review and wait for a go-ahead. The README and the umbrella `golden-frijoles` SKILL.md
  carry it verbatim; golden-beans' `install-prompt.test.ts` holds the transcription to its source.

## [0.28.0] - 2026-10-04

### Added
- **The approval gate is the betting table** (fund-at-approval). `groom`'s Stage 7 ends with one question carrying a
  Bet block (appetite · quote · cycle · position · displaced): **approve** funds the bet and scaffolds it in the same
  commit; **approve, don't fund** leaves the seed `ready` and scaffolds nothing.
- **`groom/fund.mjs`** places a bet: one row in the month's cycle file (`Roadmap/bets/wave-YYYY-MM.md`, created on
  first use), `underwritten_by:` (the bare cycle name) and `appetite:` on the seed, and a `build_order` from `--next`
  or `--after <slug>`. Only the queue (live, funded work) renumbers; a shipped or archived number never moves. On a
  bet already in the queue it re-bets (no placement: a new cycle row, position kept) or reorders (a placement: the
  funding record is left alone).
- **`scaffold-epic.mjs --slug <seed>`** scaffolds a fixed-scope seed from the seed alone: title, area, macro, type and
  risk from its frontmatter, one sprint whose stories are its acceptance criteria (bullets or a numbered list). It copies the seed's
  `build_order` into the README, sets the seed's `epic:` and `status: scaffolded`, and prints one commit that holds
  the cycle row and the board too.
- **The epic kickoff for an L bet** carries the one-line re-bet the builder asks at each wave boundary.

### Changed
- **`build-order.mjs` fails a live bet with no funding record**: an epic scaffolded or in progress, or a queued seed,
  whose `underwritten_by:` is missing or names no `Roadmap/bets/` file. A project upgrading onto this release funds
  its live work once (`fund.mjs`, or a backfill cycle file) before its board passes again.
- **`scaffold-epic.mjs` refuses an unfunded seed** (one whose `underwritten_by:` is empty) and prints the `fund.mjs`
  command. With no seed file at all, it scaffolds as before.
- **`emit-epic-kickoff` / `emit-kickoff` on a seed with no epic** say so and print the scaffold command, instead of
  "no epic found" (dogfood F33).
- **`priority:` is retired.** The extractor stops emitting it, the seed template and the docs drop it; the cycle row
  is the intent and the record. `underwritten_by` is read from the epic README first, then the seed.

## [0.27.2] - 2026-10-04

### Fixed
- **A clean vibe review is a review.** `isTruncatedReview` kept its own list (Blocking / Should-fix / Nit), so
  `Clean.`, the one-line verdict the review prompt asks for, failed as "truncated" before the review guard saw it.
  Every clean vibe review died that way. It now asks `assertReviewOutput`, the one definition of a review.
- **agy says which failure it hit.** agy 1.2.16 exits 3 with the reason: `RESOURCE_EXHAUSTED` (a weekly quota every
  Gemini tier shares) or `UNAVAILABLE 503 / no capacity` (gone a minute later). Both used to read as "quota". A
  capacity answer is now retried on the same model (`AGY_CAPACITY_RETRIES`, default 2, `AGY_CAPACITY_WAIT_MS`,
  default 30 s), and the final error names each model's own cause, with the quota's reset time.
  When agy exits 0 with nothing on stdout, each call's own `--log-file` is read and the last real error
  is reported, instead of a guessed "likely a quota cap".
- **A log branch no longer fails a Vercel preview.** `log-branch.mjs` writes a `vercel.json` with
  `git.deploymentEnabled: false` beside the log, so a repo whose Vercel project builds every branch stops trying
  to build `claude/session-journal` (an orphan with no `package.json`).

## [0.27.1] - 2026-10-04

### Fixed
- **Every doc names a kickoff command that runs.** WAYS-OF-WORKING (*Epic-mode builds*, item 5) and
  SESSION-KICKOFFS now say `/build <slug>` with the plugin's mod, else
  `npx -y @golden-frijoles/kit emit-epic-kickoff --epic <slug>` from the project root (and `emit-kickoff … --sprint <N>`
  for the per-sprint exception). They used to name `node skills/groom/…`, a path that exists only inside the plugin.
  A new project gets the fixed WAYS-OF-WORKING from `gf-kit init` (kickoff-generator-path S2).
- `check-release.mjs` treats the Roadmap skeleton `gf-kit init` writes as shipped surface, so an edit to it can no
  longer merge without the release that publishes it.

## [0.27.0] - 2026-10-04

### Added
- **The kit carries both kickoff generators.** `npx -y @golden-frijoles/kit emit-epic-kickoff --epic <slug>` (and
  `--list`) and `npx -y @golden-frijoles/kit emit-kickoff --epic <slug> --sprint <N>` print the kickoff from any
  project root on any host, with no plugin checkout. Until now they ran only from the plugin's own folder, so a doc's
  `node skills/groom/…` line failed with `MODULE_NOT_FOUND` everywhere else (kickoff-generator-path S1).

### Changed
- One source: the generators, their shared argv/root/lookup module (`lib/kickoff-cli.mjs`) and the per-sprint
  template (`templates/kickoff.md`) live in `template/scripts/`. The groom skill's copies are now vendored bytes in
  `groom/vendor/`, checked by `render-hook-vendor.mjs --check`, and `groom/emit-*.mjs` are gone. `/build` runs
  `groom/vendor/emit-epic-kickoff.mjs`.
- The project root, when no `--repo-root` is given: `GF_PROJECT_ROOT` (what `gf-kit --root` sets), then the project
  around the script, then the nearest `Roadmap/` or `.git` above `cwd`, then `cwd`. Running from a subdirectory works
  now.
- The one-sprint hint names the kit command (`npx -y @golden-frijoles/kit emit-kickoff …`).

## [0.26.2] - 2026-10-04

### Added
- `jev-eval.mjs --no-expiry`: replay the eval set without the shadow-expiry rot guard. Meant for a blocking PR gate,
  where a date would otherwise turn every unrelated PR red; the daily expiry run (no flag) still forces the decision
  (ci-diet S1.1).

## [0.26.1] - 2026-10-04

### Fixed

- **The build view no longer floods the main window.** Every 30 s tick and every Bash call logged a
  `build view: … check cached in N ms` row, and each usage refresh logged `usage: refreshed (ok)`. Routine
  bookkeeping now goes to the debug log alone (`$.ui.log(…, { to: "debug" })`, read with `claude --debug`). A
  problem worth acting on still reaches the transcript, once per distinct line per load. Pinned by a node:test and
  by an engine-level `claude plugin test` case, both checked by mutation.

## [0.26.0] - 2026-10-03

### Added

- **A feat/fix commit on an epic branch names exactly one story** (live-build-view S2.1). A new `commit-msg` hook
  (template + this repo) runs `scripts/story-check.mjs`. On a branch that resolves to an epic, a
  `feat`/`fix`/`perf`/`refactor` subject must name ONE id that epic (or that sprint, on `-s<N>`) lists. A list or
  range like `S1.1/1.2` counts as two. A refusal prints the valid ids. Other types, merges, reverts, fixups and
  non-epic branches pass. Bypass once with `GF_SKIP_STORY_CHECK=1`. When the resolver cannot load, the check fails
  open and says so.
- **`scripts/epic-phase.mjs lock --epic <slug>`** stamps the architecture lock: the README's `phase: Building` and
  `locked_at`, plus sprint 1's phase. It refuses a README with no `D1`. Until the stamp, the band reads
  **Locking architecture** on a live epic branch. The Hub's stage is unchanged.
- **`/build <slug>`**: the mod's command puts the generated epic kickoff in the prompt box, and you press enter.
  `emit-epic-kickoff.mjs --list` names the epics a kickoff can start. groom Stage 8 ends with `Build it: /build <slug>`.

### Changed

- **Progress counts stories done**: `3 of 7 stories have commits · in flight S1.4 · Sprint 1 of 2`
  (`progress.stories_with_commits`; every earlier JSON field kept). It replaces "Story 1 of 7", which was a
  position.
- **The kickoff's lock step names the command**, and drops a sentence that restated *Epic-mode builds*.
- `locked_at` joins the epic frontmatter contract (an ISO date-time when present).

## [0.25.0] - 2026-10-03

### Added

- **The build view moves while the agent works** (live-build-view S1). The band used to refresh only when a person sent
  a message, so a one-message epic build showed the same view for its whole run. It now re-checks after every Bash
  call and every 30 s, and re-resolves only when every worktree's HEAD and branch, or the newest `Roadmap/` doc, has
  changed. A check that resolves nothing costs about 48 ms on a 535-entry Roadmap.
- **QA from an open PR, with no network on a turn's path.** A separate timer refreshes the PR facts online (60 s after
  start, then every 5 min), and so does a `git push` or `gh pr create|ready|merge|close`, queued so the tool call
  never waits. No `gh`, or a failing one, logs once and keeps the last snapshot.
- **A `Plugin` row when your install is behind**: `Plugin  0.24.0 installed · 0.25.0 published — /plugin to update`.
  It compares the installed manifest with the local marketplace clone's, never the network.
- **`autoUpdate: true`** for the golden-frijoles marketplace in the template's `.claude/settings.json`.
- **`claude plugin test`** in CI, over the mod's new `hooks/build-view.mod.test.ts` (the tick, the Bash re-check, the
  push trigger, the online timer).

### Changed

- **Claude Code 2.1.288 is the floor the mod is checked against** (CI pin 2.1.278 → 2.1.288). Mods are on by default
  from 2.1.287, so `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is gone from the settings, `hooks.json` and CI.

## [0.24.1] - 2026-10-03

### Fixed

- **A failed Devin run now says why.** `runDevin` logged only the last line of Devin's stderr, which is the closing `}`
  of its JSON detail block, so a quota cap, an auth lapse and a capacity refusal all read as `devin -p failed: }`. It now
  keeps the `Error:` line (`devinErrorLine`), e.g. "Your weekly usage quota has been exhausted".
- **agy pin 1.2.15 → 1.2.16** (`AGY_PINNED`, re-verified by `cross-agent-doctor agy --fix`: contract and both live
  probes green).

### Added

- **A guard that every `writeProse(` call is awaited** (`lib/prose-writer.test.mjs`, scripts and `lib/`). It went
  async in 0.21 and two of the origin project's callers kept calling it bare, so their reports died silently.

## [0.24.0] - 2026-10-02

### Added

- **`epic-actuals --push` — your usage, sent to your Golden Frijoles project, opt-in** (finops S3). With
  `spend.telemetry: on` (`gf-kit config set spend.telemetry on`; unset = off, nothing leaves the machine), each changed
  (session, epic) goes to the existing `POST /api/v1/track` as one `$agent_usage` event — tokens by kind, model and
  skill breakdowns, ≈ API $, the price table's date, first/last turn. Metrics only, never content; the engine refuses
  any other key. It uses the project ingest key the roadmap push already reads (`SELF_PROJECT_API_KEY`, else
  `GROWTH_ENGINE_API_KEY`) and `GROWTH_ENGINE_URL`. Unchanged sessions are not re-sent; the engine keeps the latest
  snapshot per (session, epic). The build view's refresh pushes too when the setting is on — only after a complete
  scan, within 5 s, at most every 10 minutes. `--epic <slug> --json` reports `pushed_at`.
- **A refused push is never silent.** A snapshot the engine refuses as malformed (400) is counted; the build view's Spend
  row then ends `· N usage pushes refused — epic-actuals --push --json` until a later push goes through cleanly, and a
  `--push` run with a refusal prints it and exits non-zero. A failed push backs off 10 minutes, and a malformed config is a reason, never a crash.

### Changed

- **`spend.telemetry` asks a real question** — what it sends, and that it never sends content.
- The build view's usage refresh may take up to 15 s (a ≤ 6 s scan plus the opt-in push's ≤ 5 s).

## [0.23.0] - 2026-10-02

### Added

- **Quotes, calibrated from your own history** (finops S2). `quote.mjs --appetite S|M|L` prints the p25–p75 of
  `actual_usd` over shipped epics at that appetite — `$24–35 (M, n=4, p25–p75)` — or, with fewer than 3, a wide default
  labelled `wide` with its n. `--report` says how many actuals landed inside their quote; `--json` for tools.
- **Groom writes the quote.** Stage 1.5 runs `quote.mjs` and records the line in the seed's new `quote:` line;
  `scaffold-epic` copies it into the epic README (`quote_low_usd`, `quote_high_usd`, `quote_basis`), or takes
  `--quote <lo>-<hi> [--quote-basis "…"]`. Absent is `null`, never 0. Nobody types a quote.
- **The band compares spend with the quote** — the four states of the approved mockup: `≈$38 of quote $30–55 (M)`
  with a green bar; `≈$71 · 29% over quote $30–55 (M)` with a full red bar (an alert — nothing is stopped); `no quote`
  with no bar; and a thin history shown as `(M · 2 past epics, wide)`.
- **Close stamps the actual.** `epic-dod --check` warns (never fails) on a shipped epic with no `actual_usd`, naming
  `epic-actuals --epic <slug> --write`; the retrospective template gains a `Quote vs actual:` line and the epic
  Definition of Done names the stamp.

### Changed

- `roadmap-extract` emits the six FinOps fields on epic rows, and reads an epic's appetite from its README first, then
  its seed.

## [0.22.0] - 2026-10-02

### Added

- **`epic-actuals.mjs` — what each epic consumed, measured from this machine's Claude Code transcripts** (finops S1).
  `npx -y @golden-frijoles/kit epic-actuals --epic <slug>` prints sessions, tokens by kind, model and skill, and an
  **≈ API $** (a list-price equivalent from one dated price table, `lib/model-prices.mjs`, read from the official
  pricing page on 2026-10-02 — not what anyone was billed). No hook, receiver or credential: Claude Code already writes
  every turn to `~/.claude/projects`. One message is counted once (its final streamed write), a resumed session's
  copied history never moves a turn to another branch, subagents count toward their parent, and branch → epic is the
  build view's own reading. Planning on `main` is reported as `unattributed`. Metrics only — no message content is ever
  read into the index or printed. Codex/Agy/Vibe/Devin passes are not measured, and the report says so.
- **The incremental usage index** in the main checkout's `.golden-frijoles/` (ignored): a second run reads only new
  bytes, and totals outlive Claude Code's 30-day transcript cleanup.
- **`--backfill [--write]`**: every shipped epic, measured or with the reason it could not be; `--write` stamps
  `actual_usd`, `actual_mtok` and `actual_basis` on the measured ones.
- **The build view's `$ Spend` row** on an epic branch, between Progress and Status: `≈$38 · 1.9M tok · 4 sessions ·
  this machine`. It reads the summary file only; the mod refreshes it from `session.measure` (the bundled script, at
  most once a minute, 10 s timeout). No summary → no row, never a zero. The refresh reads for at most 6 s and saves,
  so a first scan on a slow machine completes over a few runs; until it does, the row stays hidden rather than low.
  A backfill never overwrites an actual already written.

### Changed

- **The frontmatter contract reads decimals** (`38.42`) and declares six optional FinOps fields once —
  `quote_low_usd`, `quote_high_usd`, `quote_basis`, `actual_usd`, `actual_mtok`, `actual_basis`; `doc-format` rejects a
  non-numeric value.
- **agy pinned to 1.2.15** (re-verified by `cross-agent-doctor agy --fix` on 2026-10-02, probed with
  `gpt-oss-120b-medium` — the Gemini models were quota-capped).

## [0.21.0] - 2026-10-02

### Added

- **One projector, every sink.** `roadmap-extract --sink terminal` prints the six-stage board; `--sink hub` pushes it to
  a Golden Frijoles Hub (`GROWTH_ENGINE_URL` + the project's ingest key: `SELF_PROJECT_API_KEY`, else the SDK's
  `GROWTH_ENGINE_API_KEY`) — so
  `npx -y @golden-frijoles/kit roadmap-extract --sink hub` feeds the hosted board from any repo; `--sink notion` runs the
  optional Notion sync copied beside it. `roadmap-push.mjs` ships in the kit.
- **WIP as advice at the moment of pulling.** `board.wip` (`{ "Building": 2, "QA": 3 }`) in
  `golden-frijoles.config.json`: when Building is at its limit, `emit-epic-kickoff` prints one warning line naming the
  limit and the cards in Building — and the kickoff still prints. Default: no limits, no advice.
- **`board.hubUrl`**: the build view ends with a `Board ↗` link to this work's card on the Hub.

### Changed

- **The build view is a client of the stage resolver.** Its Status line is the stage — the same row the Hub and
  BUILD-ORDER.md read — with where it came from and how old the facts are ("QA · from github: PR #7 ready (snapshot, 3h
  ago)"); the written `phase:` stays as a detail. A Board line counts Building, QA and Ready to build and names the next
  pull. Online it makes one facts gather (no separate PR lookup); the hook stays offline and reads the snapshot, which
  `session-resume` now refreshes at session start.
- **The optional Notion sink writes a `Stage` select** when the database has one (it never changes the schema), and
  splits long text across Notion's 2000-character objects instead of failing.

## [0.20.0] - 2026-10-01

### Added

- **One stage, decided once.** `scripts/lib/stage.mjs` exports the six stages (To groom · Grooming · Ready to build ·
  Building · QA · Shipped) and `resolveStage()`, the only place a card's stage is computed. Building and QA are facts:
  a work branch on origin is Building, a ready PR is QA, a merged PR waiting for its close-out is QA, and a merged or
  closed branch left on origin no longer counts. `lib/stage-facts.mjs` gathers those facts once per run (one
  `git ls-remote`, one `gh pr list`) and keeps them in `.golden-frijoles/board.json`, so an offline run says how old
  they are.
- **The projection carries the card.** Every epic and seed row from `roadmap-extract.mjs` now has `stage`,
  `stage_source`, `goal`, `sprints`, `links`, `pr`, `kickoff` (Ready to build only) and `shipped_at`. `--live`
  gathers facts now, the default reads the snapshot and never touches the network, and `--docs-only` reads none.
- **`build-order.mjs --live`** prints the full six-stage board; the committed `BUILD-ORDER.md` is the docs-only view,
  because Building and QA move on events no commit records.

### Changed

- **Starting a build is the trigger.** The epic kickoff's first instruction pushes `feat/<slug>`, and the per-sprint
  kickoff pushes `feat/<slug>-s<N>`, before any other work.
- **The epic kickoff builder lives in `template/scripts/lib/epic-kickoff.mjs`**, vendored into the groom skill
  (`groom/vendor/`, checked by `render-hook-vendor.mjs --check`), so the kickoff a board card carries and the one the
  CLI prints are one function. `groom/templates/epic-kickoff.md` is gone; the text is `EPIC_KICKOFF_TEMPLATE`.
- **`BUILD-ORDER.md` is grouped by the six stages**, and its epic links resolve (they pointed one folder too high).
- **One extractor.** Area names are derived from the project's own `Roadmap/NN-*` folders (they were another
  product's), and rows gain `status_date` and `build_order_num`. An epic's `type` and `risk` come from its README
  frontmatter first.

## [0.19.0] - 2026-10-01

### Added

- **The North Star coach names the command that sends its file:** `npx -y @golden-frijoles/cli@0.3.0 north-star set
  Roadmap/00-strategy/north-star.md`. It's a dry run first, and `--yes` sends it. The coach tells the user to run it
  and never writes to an engine itself. The command is new in `@golden-frijoles/cli` 0.3.0.

## [0.18.0] - 2026-10-01

### Added

- **Groom reads the strategy the coaches leave.** `groom/strategy.mjs` reads `Roadmap/00-strategy/` and prints the
  input metrics a seed could move and the riskiest dimension it could test. Stage 0 runs it, and the pitch gets one
  line under its title: `Moves: <input key> · Tests: <dimension>`. A project with no `00-strategy/` gets no output, no
  line and no nag. A strategy file it can't read is named with the reason, and grooming carries on.

### Changed

- **A "worth doing?" gap routes to the coaches.** `intent-match`'s think-chain route used to say "answer by hand until
  think-skills ships". It now names `pmf-narrative` and `risk-validation`. Only the label changed: the question Jev
  answers is the same stamped wording.

## [0.17.0] - 2026-09-30

### Added

- **Three strategy coaches ship in the plugin: `pmf-narrative`, `north-star` and `risk-validation`.** They walk a
  product builder through a PMF narrative, a North Star workshop, and finding the riskiest dimension plus one targeted
  test. Each one writes `Roadmap/00-strategy/<name>.md` from its own `templates/<name>.md`, as `status: draft`, and
  asks before overwriting an `agreed` file. `north-star.md` carries a sync payload in the shape the Golden Frijoles
  engine accepts. Each coach ends by offering the next (narrative, then North Star, then risk validation, then
  `groom`). Risk Validation starts from the narrative's six dimensions when that file exists, instead of asking for
  them again.

### Fixed

- **Asking for a North Star workshop loads the North Star coach.** Its description used to be Risk Validation's, word
  for word, so the request matched the wrong skill.
- **`doc-format` catches an HTML comment that never closes** (`unclosed-html-comment`, in epic READMEs, sprints and
  retros). One that never closes hides everything after it when the doc renders, and two epic READMEs shipped that
  way. A comment quoted in a code span or a code fence (of any length) is an example, so the rule skips it.

### Changed

- **The umbrella skill routes strategy asks to the coaches**, and no longer calls the planning chain out of scope.
- **Each coach credits its sources** by name and URL: Amplitude's *North Star Playbook* for the North Star coach, and
  Reforge's courses and Helmer's *7 Powers* for the other two.


## [0.16.0] - 2026-09-30

### Added

- **A screen is a `surface` block, and it draws itself grey.** `lib/surface.mjs` reads the ` ```surface ` blocks in a
  seed: a state id, a route, then one line per block (`- head "Orders" action "Share your shop"`) from twelve kinds,
  with only three facts (an action's words, a count, a list's columns). A line it cannot read fails with the file, the
  line and the known kinds, with a guess when it is close (`lsit` → `list`). `node scripts/sketch-render.mjs <seed>`
  turns every block into one grey wireframe page for the product owner to approve; it imports nothing but Node and the
  parser. `validateMap` checks a project's `surface.map.json` (the twelve kinds mapped onto its own). `groom` carries
  both.

### Changed

- **The seed template's screen example uses that grammar.** It shipped a YAML-ish list (`blocks:`, `- heading: …`)
  that nothing read; the parser now refuses that shape with a pointer to the new one. The visuals rule says to render
  every surface block and publish the page for review.

## [0.15.0] - 2026-09-30

### Changed

- **Every Jev question is data.** The review guard's, the prose guard's and intent-match's questions now live in
  `scripts/lib/jev-questions/{review,prose,intent}.json`, in the exact shape Jev receives, each with a `measured`
  block beside it (model, date, how many it decided, how many of those were right). The guards read them through
  `lib/jev-questions.mjs`. The move is byte-identical, so every verdict is unchanged. The kit ships the three files.

### Added

- **A recording remembers its wording.** Each `jev-eval.fixtures.json` recording stamps a hash of every question it
  answered. Edit one word of a question and `node scripts/jev-eval.mjs` fails, naming the question and `run --live`,
  where it used to replay the old answers green. The existing recordings were stamped without a Jev call.
- **A leak guard for Python.** `check-plugin-leaks` fails on any `optimize/`, `.py` or `requirements*` path in the
  mirrored tree and on a shipped script that imports `optimize/` or spawns `python`. `kit-tarball` asserts the
  same on the packed kit. The kit stays zero-dependency Node.

## [0.14.1] - 2026-09-30

### Fixed

- **The build view no longer throws on an engine without `$.state`.** Claude Code 2.1.278 (also the version CI
  validates against) has no `$.state` noun, so the band's read threw on every draw and the engine logged
  `golden-frijoles: ui.render hook skipped: threw TypeError: … evaluating '$.state.get'`. **The band needs a Claude
  Code that has `$.state` (2.1.285 does).** On an older engine it now draws nothing and says so once under `claude
  --debug`. Every `$.state` call goes through one tested guard (`attempt` in `hooks/build-view.mjs`).
- **The session line's "questions waiting" count can no longer stick** if drawing the line fails mid-question.

## [0.14.0] - 2026-09-30

### Added

- **The session budget line.** Under the prompt in Claude Code: `Session 48% · 5h 23% · 7d 9% → keep going`,
  from the engine's own `session.measure` figures, turning to **checkpoint** (context ≥ 60%, or 3+ questions
  waiting) or **hand off** (context ≥ 80%, or the 5-hour limit ≥ 90%). A figure the engine does not have yet is
  left out, never shown as 0%. It advises and never compacts, clears or ends anything. Each verdict change is
  logged to `.golden-frijoles/session-budget.jsonl`, which ignores itself in git.
- **Groom prints the same line at each approval gate** (`session-line.mjs`), for Cowork, which cannot see
  its own context: asks open, questions waiting, gates passed, "context: not measured here", and the verdict
  from the same thresholds (`THRESHOLDS` in `groom/session-budget.mjs`, the one table).

### Changed

- **The agy pin is 1.2.14** (`cross-agent-cli.mjs`, both copies): the doctor's live probe was green on the
  primary and fallback models.
- **"One deep ask per approval gate; keep going while the budget line says so"** replaces "one deep ask per
  run" in groom, and "a fresh session per sprint" in WAYS-OF-WORKING and LEARNINGS. The old rules were set
  for earlier models; the product owner's decision bandwidth is the binding constraint now.

## [0.13.0] - 2026-09-30

### Added

- **`semantic-lint.mjs`: deterministic selectors pick, Jev judges** (semantic-lint S1). Each rule in
  `golden-frijoles.config.json` → `lint.rules` (id, source, severity, globs, allowlist, patterns, one question) selects
  the diff hunks whose ADDED lines match, outside its allowlist; Jev is asked one question per selected hunk. A push
  that selects nothing makes no call. Four outcomes: raise, clear, uncertain, and **not checked** (no key, egress off,
  a timeout, a malformed answer, a hunk over 6,000 chars, past 20 candidates or 60 s), which is printed and logged and
  never counts as clear. Raise-only, never blocking. In the kit through `jev-eval.mjs`, which replays its set.
- **The pre-push hook runs it** in its ADVISORY section, on the ranges git hands the hook, `|| true`. Off by default:
  an off rail exits before anything that could ask about egress.
- **`jev-report.mjs` reports lint decisions**: per rule, raise / uncertain / clear / not-checked, and the raised and
  uncertain hunks to label.

### Changed

- **`lib/jev.mjs`: `RAILS` gains `lint`** (off by default, `thresholds: { default: 0.8 }`). Its threshold keys are
  `default` or a rule id, each 0.5…1 (below 0.5, raise and clear would overlap); the other rails' keys stay closed.
- **`lib/config.mjs`: `SECTIONS` gains `lint`**, and the registry declares `lint.rules` (`never-yet`, so `gf doctor`
  never reports Build unconfigured for it).
- **`jev-eval.mjs` evaluates the `lint` set** from the project's own `scripts/jev-eval.lint.fixtures.json` (rules are
  project data, so their labels are too; the template ships none). A recording pins its question's hash (question +
  `source`), so an edited rule fails the replay until `--live` re-measures it; every configured rule needs ≥30
  fixtures, and a fixture for a rule the project no longer defines fails instead of being skipped.

## [0.12.1] - 2026-09-30

### Fixed

- **The build view is readable again.** It was drawn through `$.ui.status`, a single status row: the
  resolver's lines ran together (their newlines shown as `�`) and everything past the terminal's width
  was cut off. It is now a band above the prompt, one wrapped row per resolver line, with a glyph and a
  colour per label (status and risk coloured by value, a progress bar from the story count). The rows
  only decorate the resolver's own lines; no fact is added or dropped (D3). The hook module is now
  `hooks/index.tsx`, and the plugin declares its `$.state` contract in `types/index.d.ts`.

## [0.12.0] - 2026-09-30

### Added

- **The close question** (intent-match S3). `templates/RETROSPECTIVE.md` gains `_Intent: yes | mostly | no_`: did we
  build what the product owner meant? `epic-dod` gains a sixth item, `intent-answered`: an epic whose README or seed
  carries a numeric `intent_match:` needs the line answered with one word; an unscored epic passes, so no epic closed
  before the score existed is failed retroactively. The template's own `yes | mostly | no` never counts.
- **`intent-outcomes.mjs`**: one row per scored epic across any repos on the Roadmap layout (`--repo`, repeatable):
  the score (README, seed, or the repo's `Roadmap/00-ideas/intent-backfill.json`), the answer from the retro, whether
  the ask was a proxy, and corrections derived from files — stories added since the README's first commit, dated
  amendments, disproved scope. The footer counts answered epics against the 20 the calibration waits for. An
  unreadable repo or a malformed backfill record is "could not look" (exit 2), never a smaller table.

## [0.11.0] - 2026-09-30

### Added

- **Planning keeps the ask** (intent-match S2). The seed template gains *The ask, as given* (the product owner's
  words, verbatim), *Claims* (numbered, editable), the *Teach-back* answer, `intent_ask:` / `intent_match:` keys, and
  a `## Visuals` section with a system-context example and a `surface` block for a screen. `scaffold-epic` copies
  the seed's `intent_match:` into the epic README (a whole number 0–100, otherwise `null`).
- **Groom Stage 3.5 and Stage 4.6.** Stage 3.5 runs `intent-match.mjs --write` (advisory, never a gate). Stage 4.6
  draws from the shape of the ask: a system context for every M/L bet, then a wireframe (`surface` block), flow,
  data sample, state machine, sequence or container diagram only when the ask triggers one; a screen's states come
  from the ten (idle · hover · focus · pressed · loading · success · error · empty · disabled · unbuilt).
- **`intent-reader.mjs`: an optional reader at the architecture lock.** `intent.reader` is `off` by default (one line,
  nothing read or spawned). On, the first installed of codex, agy and vibe — never Claude — reads the pitch once
  under a hard timeout (120 s), Jev scores whether it would build what the plan builds, and the agreement and the
  new total go into the epic README. Any failure is one `reader skipped: <why>` line and exit 0. The epic kickoff's
  lock step names it.
- The reader's reply passes `lib/secret-guard.mjs` before it is sent to Jev or written into a README, and is
  written indented (never fenced), so a reply's own fences or headings cannot break the section.
- `lib/cross-agent-cli.mjs` exports `agyArgs` and `vibeArgs`, so a caller with its own spawn builds the same argv.
- `lib/config.mjs`: an `intent` section and the `intent.reader` setting.

## [0.10.0] - 2026-09-29

### Added

- **`intent-match.mjs`: how well a groomed pitch captured the ask** (intent-match S1). It reads a seed's verbatim ask,
  its numbered claims, its teach-back answer and its acceptance list, asks Jev one question per item, and prints four
  components (coverage in, coverage out, clarity, teach-back), a total labelled **uncalibrated**, a placeholder band
  and, for each gap, the one artifact that would close it (a Jev Choice over copy deck, wireframe, flow, data sample,
  state machine, sequence, container diagram, spike, think chain). Advisory: it never gates anything. With no
  `TYPESAFE_API_KEY`, or `jev.egress` not `true`, or a pitch over Jev's budget, it prints "could not look" and no
  number, and exits 2. `--write` records `intent_match:` and an `## Intent match` section in the seed. Ships in the
  kit through groom.
- **`jev-eval` measures the intent questions**: an `intent` set of 37 labelled items, recorded live against
  `jev-1.13.0` (37/37 right, 32 decided), evaluated beside the rails without being one.

### Fixed

- **`TYPESAFE_API_KEY=` (set but empty) now means "no key".** It used to fall through to the key in `.env.local`, so
  blanking the variable for one command quietly used the key anyway.

## [0.9.0] - 2026-09-29

### Added

- **Routines stand up without hand-editing.** `routine-bootstrap.mjs <name>` fills a routine's project values from
  `golden-frijoles.config.json` → `routines`, leaves the values a routine fills while running alone, and prints a
  prompt ready to paste into `/schedule`. It refuses, naming every missing key, while any fill-in remains, and
  refuses any placeholder its table does not classify. The seven prompts and the runbook ship in the kit; the
  runbook names the one-hour minimum interval, the daily run cap, and the custom network environment a Telegram
  routine needs.
- **Cron templates for the model-free parts** (`standup.yml.example`, `build-order-sync.yml.example`), each warning
  that GitHub silently disables a scheduled workflow after 60 days without repository activity.

## [0.8.0] - 2026-09-29

### Fixed

- **A stranger with no Jev config is asked before anything is sent.** Two bugs made the ask unreachable: no config at
  all loaded as `egress: true`, and a rail's default `off` mode was checked before egress. An unanswered egress now
  asks once (non-blocking) whatever the rail mode, and nothing is sent before an explicit `egress: true`.

### Added

- **Jev setup route** in the umbrella skill: the egress answer first, the TypeSafe signup, the key in `.env.local`,
  then `jev-eval --live --limit 10` as proof — which asks only 10 fixtures per rail and writes nothing.
- **Notify setup route** and `notify-setup.mjs`: `--chat-id` reads the bot's chats and, when there are none, tells a
  set webhook from an unmessaged bot and names group privacy; `--test` sends one message to Telegram and/or Slack.
  `slack-notify.mjs` ships in the template. The `reporting.destination` question offers only what a sender exists for
  (the scheduled reports post to Telegram; Slack is test and ad-hoc).

## [0.7.0] - 2026-09-29

### Added

- **The epic kickoff's commands ship in the kit.** `review-route.mjs`, `cross-review.mjs` with its prompts and a
  default `review-config.json`, `lib/review-guard.mjs`, `cross-agent-doctor.mjs`, `session-resume.mjs`,
  `session-note.mjs` and `build-state.mjs` are in the closure, so a repo with only the plugin gets a route (or
  DARK with the install line), never "script not found". Proven on the packed tarball in a blank `HOME` with no
  `gh` or reviewer CLI on `PATH`. The project's own `golden-frijoles.config.json` → `review` still wins over the
  kit's default config.
- **`review-route.mjs` renders a route when GitHub CLI is not installed,** with the security lens forced
  (unknown is not "no security path"), so a stranger sees the DARK state instead of an exit. An installed `gh`
  that cannot read the PR (a wrong number, expired auth) still stops, and the PR number must be numeric.

### Security

- **The build view never runs code the open repo supplies.** It ran `<repo>/scripts/build-state.mjs` on every
  turn in whatever repo was open. It now always runs the copy bundled in the plugin (`hooks/vendor/`, generated
  from `template/scripts/` and checked in CI), and works in a repo that has no `scripts/` at all.

## [0.6.0] - 2026-09-29

### Changed

- **One review rail.** `cross-review.mjs` and `lib/cross-agent-cli.mjs` are now the superset of the three copies
  that had forked (the template, the origin project and a second consumer): whole-file context, builder/reviewer
  pairing, the transient-agy fallback and truncation guard, the `readSection('review')` config loader, the codex
  self-heal onto agy (now also on a stale codex CLI), and a comment that records the model that actually
  answered. Every consumer's old tests were run against it.
- **One doctor: `cross-agent-doctor.mjs`** (codex + agy) ships in the template. `agy-doctor.mjs` is an alias for
  `cross-agent-doctor.mjs agy`. Every fix message names a doctor that exists.
- **Codex now reviews on a pinned model, `gpt-5.6-terra` at high effort** (was: codex's own configured default).
  The review's model is then a property of the repo, not of each machine. If your codex account cannot use it,
  the failure names the escape: **`CODEX_MODEL=default`** uses codex's built-in default model. Reviews ignore
  `~/.codex/config.toml` (below), so a custom `model_provider` or base URL is not used either: such a setup
  routes past codex (`review-route.mjs --exclude codex`). The default
  `--agent` stays `codex`.
- **`review-route.mjs` passes `--builder`** in every command it prints, so the same-family refusal (and the
  codex→agy heal's re-check) fire in normal use. The heal also checks agy's version pin now.
- **The doctor checks the agy help contract before "signed out"**, so a visible contract break is never
  reported as merely could-not-look.

### Security

- **The Vibe reviewer runs with every host tool disabled** (`--disabled-tools '*'`, no `--auto-approve`). The
  read-only allow-list one copy carried let a malicious diff read an absolute path, such as `.env.local`, into a
  review comment posted on the PR. Reviewers still get the touched files' contents, embedded in the prompt.
- **`--agent devin` is refused.** A consumer used Devin as a third review pool, but `devin -p` auto-approves
  read-only tools with no flag to disable them, so the same injected-diff read applies. Devin stays the prose
  writer.
- **Codex reviews locked down:** `--sandbox read-only --ignore-user-config --ignore-rules --ephemeral`. It used to inherit the
  user's config — observed: a `workspace-write` sandbox, `on-request` approvals, and the user's MCP servers,
  a database one among them. Codex can still **read** host files; no flag removes that, so the risk is reduced,
  not closed. The channel is closed instead:
- **cross-review never publishes a reply that carries a secret verbatim** — not in a comment, not in a status,
  and not to Jev. Encoded or transformed output is out of scope for a string match; read access is the real
  control, and codex keeps it. The reply is checked first, against every value in the project's `.env*` files (root and two levels
  down, plus `.envrc`), this process's secret-named env vars, the values in the operator's own credential stores (`~/.aws/credentials`,
  `.netrc`, `.npmrc`, `gh`'s hosts file and a few more — an AWS secret key has no distinctive shape), and common
  credential shapes. A
  match posts nothing, fails the status, and prints the reply locally with the match redacted.
- **cross-review refuses an outsider's diff.** A PR whose author lacks write access to the repo (a fork PR on a
  public repo, or permission that cannot be read) is refused before any reviewer sees it. Read the diff yourself,
  then pass `--allow-untrusted-author`. This is the control for what the reviewer can read: no reviewer flag
  stops codex reading host files, and no string matcher catches an encoded secret. Long opaque base64 runs are
  withheld too, as defence in depth. **Residual, stated plainly:** a collaborator with write access is still
  trusted with more than their push access gives them. Their diff can steer codex into reading the *operator's*
  own files (`~/.aws`, `~/.npmrc`, codex's auth) and encoding the value so no string match catches it. Run the
  rail only on PRs from people you would hand those files to, or review from a machine that doesn't hold them.
- **A codex usage cap heals onto agy** like an auth lapse (a different quota pool).
- **The codex→agy self-heal re-checks the builder.** When agy built the diff, the heal fails loud instead of
  turning into a same-family review.

### Fixed

- **A signed-out agy is diagnosed as signed out,** not as a broken contract with every model "not listed", and
  the doctor no longer waits a minute per probe for a login that will not come.

## [0.5.4] - 2026-09-28

### Changed

- **The epic kickoff is lean.** `emit-epic-kickoff.mjs` no longer restates WAYS-OF-WORKING (the copy had
  already drifted on the review policy): the prompt points at *Epic-mode builds*, *Review & merge* and
  *Escalate, don't guess*, keeps five non-negotiables, and adds only the rules this epic's docs call for (high
  risk, a migration, a flag key). About 390 words instead of about 1,400 for a four-sprint epic. A test fails
  if a section the template names disappears from WAYS-OF-WORKING.
- **Worktree or in place is the orchestrator's call** (WAYS-OF-WORKING → *Epic-mode builds*): in place when
  it is the only session in the checkout and runs one builder, its own worktree otherwise.

### Fixed

- **The build view sees work in other worktrees.** On `main` (or any branch naming nothing) it lists every
  other worktree on a work branch, resolved like the current one, and the epics whose written `status:` is
  in-progress. On a work branch it adds an `Also` line when other worktrees are building.
- **Branch names with words after the sprint number resolve** (`feat/<slug>-s4-licences`), and `docs/` is a
  work branch. The longest leading run of words naming an epic wins, as before.
- **Bugs, chores and spikes show up.** A branch naming a seed with no epic renders that seed (type, appetite,
  risk, status); a seed that carries `epic:` resolves to that epic.

## [0.5.3] - 2026-09-28

### Changed

- This repository is now a **mirror**. The plugin, the kit and the template are developed in
  [`danybgoode/golden-beans`](https://github.com/danybgoode/golden-beans) under `skills/`, and every merge there that
  touches `skills/` is published here as a fast-forward. Install, pinning and releases are unchanged: the install prompt, `golden-frijoles/skills@<tag>`
  and `@golden-frijoles/kit` on npm (with provenance) all work as before. This is the first release made through the mirror.

## [0.5.2] - 2026-09-24

### Fixed

- `REPORTING_CONFIG` may again name a file outside the project (0.5.0 refused it when the reporting rail passed it).
- In installed mode, the kit's own bundled defaults are readable; the containment check is for the checkout's files.
- `config migrate` refuses a section that isn't an object instead of silently replacing it with `{}`.
- `config list` fails on a legacy file holding JSON `null` instead of reporting no settings.

### Security

- `config list` and `config get` (and `gf config`/`gf doctor`, which use them) print secret-looking values as
  `<redacted…>`. A legacy file may still hold a literal token that the write guard never saw. Rails read the real
  value, as before.

## [0.5.1] - 2026-09-24

### Security

- The config secret guard trims before it matches: a token with a leading space or a trailing newline
  (`' sk-…'`) was written to `golden-frijoles.config.json` instead of being refused.

## [0.5.0] - 2026-09-24

### Changed

- **Nothing is sent to TypeSafe (Jev) until you say yes.** The template's `jev.config.json` now ships
  `"egress": null`: unanswered. `null` behaves like `false` (the regex guards decide; the review guard's fallback reason reads
  `jev could not look (egress not answered)`, and the prose guard reports it as `why`), and the first run that would use Jev asks you once
  (`GF-NEEDS-SETTING jev.egress`). Answer with `gf-kit config set jev.egress true` or `false`. A project whose
  committed file says `"egress": true` keeps working exactly as before. A `jev.config.json` that leaves `egress`
  out used to mean `true`; it now means unanswered, so set it explicitly if you want Jev to keep deciding.
- The umbrella skill's setup asks at most three questions (what you're working on, where you're starting, and
  whether to connect an account now). Each one says its default, only the first is required, and every answer is
  saved through the kit's config core. The next step follows your answers: `gf-kit init` for a repo, nothing but
  the config file for planning only, then `groom` or `live-smoke`.

### Added

- `check-onboarding-parity --exec` checks `gf config list --json` runs with no credential. It skips until the
  resolved `gf` is 0.2.0 or newer.

## [0.4.0] - 2026-09-24

### Added

- **One config file.** `golden-frijoles.config.json` holds every non-secret setting, one section per module.
  The legacy files (`jev.config.json`, `reporting.config.json`, `live-smoke.config.json`,
  `smoke-triage.config.json`, `perf-probe.config.json`, `scripts/review-config.json`) keep working: the new file
  wins per key, and legacy fills the gaps. `gf-kit config list | get | set | migrate`. `migrate` never edits a
  legacy file. Secrets are refused: put the env var's NAME in the file.
- `@golden-frijoles/kit/config`: the same core for other tools (the `gf` CLI), with types.
- The settings registry, and the ask protocol: a script that needs an unset setting prints `GF-NEEDS-SETTING`,
  and the skill asks you once. The answer is
  saved through the kit, never through a project's own `scripts/config.mjs`, which may be unrelated code.

### Security

- A project-owned prompt asset (persona, lessons) that is a symlink leaving the project is now refused instead of
  read. It could otherwise have been sent to an external model.

## [0.3.0] - 2026-09-23

### Added

- The `golden-frijoles` umbrella skill: a stranger's agent that just installed the plugin has one
  place to start, instead of needing to know ten skill names. It detects state with commands (is
  `Roadmap/` present, is `gf` linked, is the kit reachable, which install channel), routes by job to
  the right named skill, and states plainly what the `npx skills` channel lacks (no build-view hook,
  no `pr-reviewer` agent).
- `gf-kit init` (`node scripts/init.mjs`): adopts any existing repo by writing the `Roadmap/` skeleton
  (README, WAYS-OF-WORKING, LEARNINGS, the `00-ideas/` funnel). Never overwrites a file that's already
  there, is idempotent, and touches nothing outside `Roadmap/`.
- The install prompt is one string, `golden-onboarding.mjs`'s `INSTALL_PROMPT`, transcribed from
  golden-beans' `apps/web/lib/install-prompt.ts` and checked verbatim across the repo README, the
  umbrella skill and the transcription itself — a one-word drift fails CI.
- `check-onboarding-parity.mjs --exec` now also runs the install prompt: `npx skills add
  golden-frijoles/skills --list`, and `claude plugin marketplace add` + `claude plugin install` in a
  scrubbed `HOME`/`XDG_CONFIG_HOME`/`CLAUDE_CONFIG_DIR`, with a negative control against the real
  `~/.claude/plugins/installed_plugins.json`.

## [0.2.0] - 2026-09-23

### Added

- `@golden-frijoles/kit` on npm: the 46 files the skills run, built from the skills' own `requires_scripts:`
  closure (never a committed copy), published from CI with provenance on the merge that bumps the version.
  `npx -y @golden-frijoles/kit@0.2.0 --list` shows what it carries.
- `gf-kit <name>` runs one script against the project you're standing in, found by walking up to `Roadmap/` or
  `.git` (override with `--root`). Nothing is copied into your repo.
- Skills run the kit unless the project has its own `scripts/<name>.mjs`, so a deliberate fork keeps working.

### Changed

- Every kit script resolves paths through one module (`lib/project-root.mjs`). A project's own copy behaves
  exactly as before.

## [0.1.0] - 2026-09-23

### Added

- The plugin ships under its product name: marketplace `golden-frijoles`, plugin `golden-frijoles`,
  installed with `claude plugin install golden-frijoles@golden-frijoles`.
- Apache-2.0 license and NOTICE at the repo root, so a stranger who installs the plugin is licensed to
  use it.
- Tagged releases: `plugin.json`'s `version` is the release, `scripts/check-release.mjs` fails a PR that
  changes a shipped file without bumping it, and `.github/workflows/release.yml` tags + publishes a
  GitHub Release from this file's newest section the moment a version bump merges to `main`.

### Changed

- Renamed from `ways-of-work@dobby-foundation`. `ways-of-work@dobby-foundation` no longer resolves —
  there is no alias (D6). Pin a release with `claude plugin marketplace add golden-frijoles/skills@v0.1.0`.
