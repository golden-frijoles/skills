# Changelog

All notable changes to the `golden-frijoles` plugin (and, from S2, the `@golden-frijoles/kit` package)
are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/). `plugin.json`'s `version` and this file's
newest heading are always the same number — `scripts/check-release.mjs` enforces it in CI.

## [Unreleased]

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
