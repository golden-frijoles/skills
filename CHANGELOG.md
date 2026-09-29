# Changelog

All notable changes to the `golden-frijoles` plugin (and, from S2, the `@golden-frijoles/kit` package)
are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/). `plugin.json`'s `version` and this file's
newest heading are always the same number — `scripts/check-release.mjs` enforces it in CI.

## [Unreleased]

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
