# Golden Frijoles project template

The copy-once skeleton for a new `~/dobby/` sibling project: a generalized `Roadmap/` (ways-of-work,
learnings, session kickoffs, the idea funnel), an `AGENTS.md` skeleton with a per-project rules slot,
CI workflow shapes, portable `scripts/`, and a Playwright `api`/`browser` e2e harness shape. Pairs with
the `golden-frijoles` plugin (`../.claude-plugin/marketplace.json`) — the template is copy-once, the
plugin is pull-based/versioned; see the repo root README for the distinction.

## Spawn a new project from this template

1. **Create the new repo — decide `--private` vs `--public` deliberately, not by habit:**
   ```
   gh repo create <owner>/<new-project> --private
   git clone https://github.com/<owner>/<new-project>.git ~/dobby/<new-project>
   ```
   **GitHub Actions minutes are only METERED for `--private` repos** — they draw from one shared
   monthly pool across your *entire* GitHub account, not per-repo. `--public` repos get unlimited
   free Actions minutes. If you have several private projects already, a new one defaults to
   `--private` here but is competing for the same shared quota as all the others — this template's
   guards are already built local-first + PR-only specifically to keep that cost low regardless
   (see step 5 and `.githooks/`), but it's still worth the 5-second visibility check
   (`gh repo view <owner>/<new-project> --json isPrivate`) if minutes ever run tight, rather than
   discovering it from a "90% of your quota used" email like the origin project did.
2. **Copy this template's contents** into the new repo root (everything under `template/`, not the
   `template/` directory itself):
   ```
   cp -R template/. ~/dobby/<new-project>/
   rm -rf ~/dobby/<new-project>/optional      # opt-in integrations — copy back only what you enable
   ```
3. **Fill in every `TEMPLATE FILL-IN` marker** — grep for them: `grep -rl "TEMPLATE FILL-IN"
   ~/dobby/<new-project>/`. At minimum: `AGENTS.md`'s rules section, `Roadmap/README.md`'s mission +
   macro-sections, **`Roadmap/fill-ins.yml`** (your deploy rail, tooling, language policy and any
   project-only sections — then `node scripts/render-ways-of-working.mjs`; `WAYS-OF-WORKING.md` itself is
   generated and never hand-edited), `scripts/review-config.json`'s `securityPaths`, and
   **`reporting.config.json`** (copy `reporting.config.example.json` — the repo list, chat and optional
   signals the standup, weekly recap and PMO report read; only `repos` is required),
   **`live-smoke.config.json`** (copy `live-smoke.config.example.json` — the app dir and environment
   URLs `scripts/live-smoke.mjs` smokes), and
   `.github/workflows/ci.yml.example` → rename to `ci.yml` once real app code exists (at that point
   fill in `.githooks/pre-push`'s advisory TEMPLATE FILL-IN, so local pre-push feedback mirrors
   `ci.yml`'s real checks).
4. **Wire the marketplace and the permissions** — `.claude/settings.json` already points at this
   repo's `golden-frijoles` plugin and carries the committed `permissions` block: an `allow` list of verb
   classes, a `deny` list (CLI deploys, `supabase db push|reset`, force pushes, `rm -rf`, whole-tree
   staging, hand-edits of generated boards) and an `ask` list (secret/env writes). Every deny/ask rule
   is cited in `.claude/permissions-ledger.json`; `node scripts/permissions-smoke.mjs` checks the pair.
   Add project-specific rules to BOTH files. **Auto mode is a user setting** — put
   `"permissions": {"defaultMode": "auto"}` in `~/.claude/settings.json`; the same line in a project
   settings file is ignored *and* masks the user default, so the smoke fails on it. Keep
   `.claude/settings.local.json` for genuinely machine-specific entries only — a one-off approval that
   is really a verb class belongs in the committed list.
5. **Hooks are already wired** — the root `package.json`'s `"prepare": "git config core.hooksPath .githooks"`
   runs on the first `npm install`, activating `.githooks/pre-commit` (blocking, < 2s: `doc-format` on the
   Roadmap docs you staged) and `.githooks/pre-push` (< 30s: the `scripts/` unit tests and the board's
   freshness, gated on the paths the push actually carries). When your app adds its own `package.json`
   (e.g. under `apps/`), keep this root one. Read `.githooks/README.md` before adding a check: cost
   decides the stage, not importance.
6. **Commit + push**, then verify: `node scripts/build-order.mjs --check` (should report the board
   up to date on an empty funnel), and confirm the `guards` GitHub Actions workflow goes green on
   the initial commit (or is simply skipped — it's `pull_request`-only, so a direct push to `main`
   won't trigger it; that's expected, `.githooks/pre-commit` covers that path locally instead).
7. **Wire the flag provider** — feature flags are Golden Frijoles here, and this is the one step
   that is checked rather than described:
   ```
   node scripts/preflight.mjs
   ```
   On a fresh spawn it **fails**, and prints the two commands that fix it:
   ```
   npx @golden-frijoles/cli login
   npx @golden-frijoles/cli init
   ```
   `npm i -g @golden-frijoles/cli` puts `frijoles` on your PATH; every command takes `--json`. `frijoles init`
   creates the project if there isn't one, mints a `flag_read` key, writes `.env.local` at mode 0600
   (refusing if git does not actually ignore it) and prints the snippet that reads it. Re-run the
   preflight: it passes. **Then install the reader** — `frijoles` creates and kills flags, the SDK reads
   them, and they are different halves:
   ```
   cd apps/example-app && npm install          # @golden-frijoles/sdk is already a dependency
   ```
   Until it is installed the seam still loads and every flag resolves to its call-site default —
   by design, so a fresh clone builds — and `scripts/preflight.mjs` says so with a ⚠️ rather than
   letting five green ticks imply flags are working. See `AGENTS.md` rule 1 and
   [`references/flags-runtime.md`](references/flags-runtime.md) for the runtime rules — the short
   version is that **a Golden outage never fails a build**, because every read resolves
   synchronously against a default you supply at the call site.
8. **Groom your first idea** in a fresh Claude Code session — the `groom` skill should trigger from
   the marketplace-installed plugin.

## What ships runnable on day one

- **`apps/example-app/`** is a real, runnable harness, not just the shape of one: a zero-dependency
  `server.mjs`, an `api` spec, a `browser` spec, the live-smoke ad-hoc spec, and an auth-helper stub.
  `cd apps/example-app && npm install && npm run test:e2e` goes green before any product code exists,
  which proves the wiring. Replace the server with your app and keep the harness.
- **Every skill the `golden-frijoles` plugin advertises runs here.** `scripts/` carries each skill's full
  script closure, and the plugin's CI proves it against this directory.
- **The flag seam is already wired.** `apps/example-app/flags.mjs` wraps `createFlagProvider` with a
  fallback-per-call contract, `server.mjs` reads a demo kill-switch through it, and
  `flags.test.mjs` + `e2e/flags.spec.ts` prove the app boots, serves and passes its gate with **no
  credentials and the SDK not installed at all**. Your first high-risk epic starts at "create the
  flag", not at "integrate an SDK".

## Opt-in, not copied by default

- **`optional/notion/`** holds the Roadmap → Notion board sync. `scripts/roadmap-extract.mjs` (the
  projection `BUILD-ORDER.md` is built from) is in the skeleton; the push to Notion is not. See that
  folder's README to enable it. Step 2 above removes `optional/` from a new project by default.

## What's deliberately NOT here

- No real app code — `apps/example-app/` is a runnable harness with a demo server, not a product.
- No process content specific to the origin project's stack or brand names — verified with a grep for
  the origin project's product/stack/vendor identifiers at build time (dobby-foundation Sprint 1,
  Story 1.3; see that sprint's doc for the exact check).
- No infra-specific CI guards (the origin project's `infra-guard.yml`, `notion-sync.yml`) — those are
  specific integrations, not universal patterns. Add your own if/when you need the equivalent.
