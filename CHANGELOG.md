# Changelog

All notable changes to the `golden-frijoles` plugin (and, from S2, the `@golden-frijoles/kit` package)
are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/). `plugin.json`'s `version` and this file's
newest heading are always the same number — `scripts/check-release.mjs` enforces it in CI.

## [Unreleased]

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
