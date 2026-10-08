# Claude Routines — stand-up runbook

The approved **Claude Code Routines** (research preview) for this project, as committed,
reviewable prompt artifacts plus the steps to stand them up. Routines are saved cloud Claude Code
configurations (prompt + repos + triggers) that run **autonomously on Anthropic-managed infra, as
the product owner** — so they keep running with the laptop closed. Created/managed in the product owner's account at
`claude.ai/code/routines` (or `/schedule` in the CLI).

> **TEMPLATE FILL-IN — read this first.** These seven prompts were proven in the project this template
> was extracted from, and ported by dobby-foundation's plugin-audit-and-extraction epic (Sprint 2) with
> their doctrine intact. The dated incidents below are that project's history, kept because they are the
> evidence for each rule. To adopt them:
> 1. Replace every `<your-org>/<root-repo>`, `<app-repo>`, `<api-repo>`, `<appDir>`, `<PROD_DOMAIN>` /
>    `<PROD_URL>` and `TEMPLATE FILL-IN` in these files (`grep -rn "TEMPLATE FILL-IN\|<[a-z-]*-repo>" .`).
>    The reporting routines read their repos from `reporting.config.json`, not from this file.
> 2. Stand each routine up from its prompt, and record its trigger id where this runbook shows
>    `<trigger-id>` — rule 3 below is why that matters.
> 3. To drop a routine you won't run, delete its prompt AND its name from `routines.test.mjs`'s expected
>    list. That is a visible, reviewed diff on purpose; the one-merge-authority rule holds regardless.

This repo commits the *prompts + this runbook*. **The account stand-up itself is operational, owed to
the product owner** — installing the GitHub App, creating the routines from these prompts, and setting B's
secrets/allow-list. Nothing here provisions infra or changes any account.

## Stand one up

Fill this project's values in `golden-frijoles.config.json` under `routines`, then render a reviewed prompt:

```bash
node scripts/routine-bootstrap.mjs <name>
```

Paste the output into `/schedule` in Claude Code (or `claude.ai/code/routines`). Scheduled routines have a
**minimum interval of one hour** and each account has a **daily run cap**, so consolidate related work before
adding another schedule. A routine that posts to Telegram needs a **custom network environment**: the default
Trusted network allowlist does not include `api.telegram.org`.

## The three rules that hold for all of them

1. **Advisory only — never a required check.** Every routine's output is a PR comment or a `claude/`
   PR for a human to review. None gates a merge, deploy, or money path. A plain PR **comment carries no
   commit-status**, so it *structurally cannot* be added as a required check in branch protection —
   keep it that way (Routine A must stay comment-only; never wire any status reporting). The
   deterministic layers (CI, `browser-smoke.yml`, `notion-sync.yml`, the deploy
   notifiers) remain the sole sources of truth.

   > ⚠️ **ONE EXCEPTION, added 2026-08-17 by the product owner: Routine B may merge its own PR** — and only
   > when `scripts/smoke-triage-scope.mjs` returns ALLOW, meaning the diff is test scaffolding only
   > and weakens nothing. See B's own section. Rule 1 is otherwise unchanged, and the "never a
   > required check" half is unchanged for *every* routine including B: the browser smoke remains the
   > sole detector and nothing a routine emits gates anything.

2. **Leave push at the `claude/` default.** A routine may only push `claude/`-prefixed branches unless
   unrestricted push is explicitly enabled — don't enable it. A only comments (no push); B/C open
   `claude/` PRs. (Merging a `claude/` PR needs no wider push scope — B stays inside this default.)

3. **🚨 A prompt file in this directory is NOT what the cloud stores. Keep the two reconciled, or you changed
   nothing.** The cloud routine stores its own copy of the prompt in the product owner's account; editing the
   committed file here does not touch it. Both known routines had silently diverged:

   | Routine | Drift found | State |
   |---|---|---|
   | `smoke-triage` (`<trigger-id>`) | Stored prompt was a short ad-hoc text that had **never** matched `smoke-triage.prompt.md` — no diagnosis rubric, no advisory banner, no failure ping, and branch `claude/smoke-fix-<date>` instead of `claude/smoke-triage-<date>` | re-synced 2026-08-17 |
   | `ops-nightly` (`<trigger-id>`) | Stored prompt still called `skills/<name>/SKILL.md` paths that no longer exist (skills moved to the `golden-frijoles` plugin) and still described step 4 as a simple skill call, not the 3-phase CPO prose write with its mechanical guard | re-synced 2026-08-17 |

   The ops-nightly divergence was caught by the routine itself — it followed the repo file instead of
   its stored prompt and reported the mismatch. That worked because the run had the repo in front of
   it. **Do not rely on that.** A drifted prompt is invisible from the codebase, which is the same
   failure shape as a fixture pinned to an Actions secret.

   ### The fix: the stored prompt is a BOOTSTRAP, not a copy

   Copying 9KB of prose into the cloud on every edit is a sync ritual, and a sync ritual is a thing
   people forget — which is how both routines drifted in the first place. So as of 2026-08-17 the
   stored prompt for `smoke-triage` and `ops-nightly` no longer *contains* the instructions. It is a
   short bootstrap that says: **read `scripts/routines/<name>.prompt.md` from the repo and follow
   everything after the first `---`.** The repo file is the only copy, so it cannot disagree with
   itself.

   Three things make that safe, and none of them is optional:

   - **A bootstrap that cannot read its file must STOP**, not improvise from memory. Both say so
     explicitly, and both fall back to a Telegram `FAILED` line rather than a guessed run. An
     improvised triage that merges something is far worse than a night with no triage.
   - **The few rules that must survive a bad checkout are restated in the bootstrap itself** — never
     weaken a spec, never merge app code, never `vercel-prune --apply`, write the standup prose in
     session. Belt and braces on the ones where being wrong is expensive.
   - **`smoke-triage` now lists the root repo as a second source**, because its prompt and its merge
     gate (`scripts/smoke-triage-scope.mjs`) both live here while its work happens in the frontend
     repo.

   **What still needs doing by hand:** creating a routine, changing its schedule/env/sources, or
   editing a bootstrap. Use the `RemoteTrigger` tool — `action: "list"` shows every trigger with its
   stored prompt, `"get"` shows one, `"update"` writes. There is no CLI, so there is no `--check`
   script to add; a script that could not actually read the triggers would be one that exits green
   having checked nothing.

   **Not yet converted:** `roadmap-hygiene` and `prod-smoke` still carry full stored prompts.
   `roadmap-hygiene`'s has the same drift (it predates the committed `roadmap-hygiene.prompt.md`).
   Convert them the same way when either is next touched.

   > ⚠️ **Schedule drift, recorded not fixed:** this file says smoke-triage runs "~10:00 UTC"; the
   > live trigger is `0 11 * * *`. 11:00 is the correct one and the doc is wrong — scheduled
   > `browser-smoke.yml` runs have been observed *starting* as late as 10:14, so a 10:00 triage would
   > regularly find the detector still in progress and correctly no-op. Left at 11:00 deliberately;
   > ops-nightly at 11:55 is the constraint on moving it later.

---

## Routine A — Review on every PR  *(stand up first)*
**Prompt:** [`pr-review.prompt.md`](pr-review.prompt.md) · **Repos:** `<your-org>/<app-repo>`
+ `<api-repo>` (add root `<root-repo>` only if you want Roadmap-doc PRs
reviewed too).

1. **Install the Claude GitHub App** on `<your-org>/<app-repo>` and `<api-repo>`.
2. **Create the routine** from `pr-review.prompt.md`.
3. **Trigger:** GitHub → `pull_request`, action **`opened`**, filter **Is draft = `false`**.
   ⚠️ A GitHub trigger takes **one specific action OR all-actions-in-category — you cannot combine
   `opened` + `ready_for_review`** ([docs](https://code.claude.com/docs/en/routines)). Pick **`opened`**:
   it matches directly-opened non-draft PRs (incl. Dependabot), which is how PRs land here. (`opened`
   does **not** fire on a draft→ready flip — `ready_for_review` does; pick that instead only if you
   habitually open drafts first, or pick **all pull_request actions** + the draft filter for full
   coverage, at the cost of also firing on label/sync/close.)
4. **Env/connectors:** GitHub App only. No Notion. Network = GitHub. Push left at the `claude/`
   default (the routine only comments).
5. **Output:** one advisory review comment per PR (mirrors the `cross-review.prompt.md` rubric — five
   AGENTS rules, single pass). **Comment-only; never a status check.**

Revives the descoped `cross-agent-review-always` goal: a cloud session runs *as the product owner*, so it
sidesteps the CI foreign-CLI auth blocker that forced that epic local-only. (This is the
**Claude-family** reviewer, not codex/agy — a different second-opinion family, but auto-on-every-PR is
restored.)

## Routine C — Weekly roadmap/Notion hygiene  *(stand up second)*
**Prompt:** [`roadmap-hygiene.prompt.md`](roadmap-hygiene.prompt.md) · **Repo:** root
`<root-repo>`.

1. **Install the Claude GitHub App** on `<root-repo>` (root repo).
2. **Create the routine** from `roadmap-hygiene.prompt.md`.
3. **Trigger:** Schedule, **weekly — Mon 14:00 UTC** (after the 08:00 nightly `notion-sync.yml`).
4. **Env/connectors:** **No Notion connector** — no `.mcp.json`, no `NOTION_TOKEN`. The routine refines
   the `00-ideas` funnel, flags status-drift, runs `node scripts/build-order.mjs`, invokes the
   `doc-hygiene` skill (`node scripts/doc-hygiene.mjs` — always-read-set size + LEARNINGS/poster
   dedupe-staleness candidates), and opens a `claude/` **docs PR** with the regenerated
   `BUILD-ORDER.md` + any new `DOC-HYGIENE-REPORT-*.md` + a drift report. Network = GitHub.
5. **Propagation:** after the product owner merges the docs PR, the existing `notion-sync.yml` propagates
   docs→Notion as usual. **Augments, does not replace** that workflow.

## Routine B — Nightly smoke triage  *(now-unblocked fast-follow)*
**Prompt:** [`smoke-triage.prompt.md`](smoke-triage.prompt.md) · **Repo:**
`<your-org>/<app-repo>` (frontend). **Gate:** `devops-reliability-cleanup` Story 1 (the
smoke fix) — done, so B is unblocked.

1. **Install the Claude GitHub App** on `<app-repo>` (already done for A).
2. **Create the routine** from `smoke-triage.prompt.md`.
3. **Trigger:** Schedule, **nightly ~10:00 UTC** (after the `0 9 * * *` `browser-smoke.yml`).
4. **Env:** the `TEST_*` secrets (the project's per-role test identities and fixture ids — TEMPLATE FILL-IN) so authed smokes light up; **Allowed-domains:**
   `<PROD_DOMAIN>` + the auth provider's domains + the backend's URL.
5. **Output:** on a **green** smoke, nothing. On a **red** smoke, a fix on `claude/smoke-triage-<date>`
   that either **merges and is verified on `main` after deploy**, or stays a **draft** PR plus a
   Telegram ping. **Augments, never replaces** the deterministic smoke, which stays the sole detector.

### B's teeth — the 2026-08-17 change

For its first two months B stopped at a draft PR. Nobody merged them, so the nightly stayed red for
three nights (08-15/16/17) and the 08-16 and 08-17 drafts **independently re-diagnosed the same
defect from scratch**. A fixer that cannot land its fix re-does its work every night. The product owner's call:
give it merge authority, bounded.

Two independent gates decide, and **both** live in
[`scripts/smoke-triage-scope.mjs`](../smoke-triage-scope.mjs) (root repo, `node:test`-covered) rather
than in the prompt — because a merge-to-production predicate must not be a model reading its own diff
at 10:00 UTC with nobody watching:

- **Surface** — every changed path is test scaffolding (`e2e/`, `playwright.config.ts`,
  `browser-smoke.yml`, `scripts/browser-smoke-*`). An allow-list, not a deny-list. **Any** change to
  `app/`, `lib/`, `components/`, database migrations — anything reaching production — stays a draft.
- **No weakening** — the diff must not make the smoke pass by testing less: no added
  `test.skip`/`fixme`/`only`/serial mode, no deleted spec file, no removed assertion. "Never weaken
  the test" has been in B's prompt since it was written, and a prompt rule is a request; deleting a
  red spec is the cheapest way for any agent to turn a nightly green and it looks like a fix in every
  summary it would write about itself. `test.slow()` is deliberately **allowed** — raising a timeout
  budget is a legitimate shipped fix (#349), and a guard that rejects correct output is worse than one
  that misses a rare fault.

Exit codes are three-valued: `0` allow, `1` block, `2` **undecidable** (part of the diff could not be
read — treated as block, and the ping must say the word). A blocked diff is never discarded or
trimmed to fit; it becomes exactly the draft PR B used to produce, which is a safe degradation to
yesterday's behaviour.

After merging, B **re-runs the smoke on `main` once the deploy lands** — a branch run tests
production's old code, and three green branch runs once missed a live PWA-nav regression. If `main`
goes red, B opens a **draft revert PR** and pings with `REVERT`; it never merges the revert itself and
never attempts a second fix in the same run.

**Still true:** B never merges application code, never marks ready outside a `claude/` branch, never
becomes a required check, and never weakens a spec.

## Routine ops-nightly — Daily standup + the nightly fixers  *(fourth routine, stand up any time after B)*
**Prompt:** [`ops-nightly.prompt.md`](ops-nightly.prompt.md) · **Repo:** root `<root-repo>`
(reads/writes `gh` across every repo in `reporting.config.json`).

**Sprint 1** shipped step 4 alone (the standup). **Sprint 2**
(`ops-routines-reporting` (the origin project's `ops-routines-reporting` epic) S2) added
steps 1–3 — the routine now runs, in order: `build-order-sync` (regen + docs PR on drift),
`vercel-prune` (dry-run report only — **never** `--apply`), `babysit-pr` (once per open PR across all 3
repos — silent on a clean PR), then `standup-post` (reports what happened). Still **one** scheduled
routine (cap-safe) — see the budget table below.

1. **Install the Claude GitHub App** on `<root-repo>` (root repo) if not already done for
   Routine C.
2. **Create the routine** from `ops-nightly.prompt.md`.
3. **Trigger:** Schedule, **nightly ~10:30 UTC** — after both the frontend's `browser-smoke.yml`
   (`0 9 * * *`) and Routine B (smoke-triage, ~10:00 UTC) have had a chance to complete, so the standup's
   smoke signal reflects the night's actual result.
4. **Env:**
   - **`TELEGRAM_BOT_TOKEN`** in the routine's environment — this routine's Telegram use is
     **LOAD-BEARING** (step 4's actual output), not the optional failure-ping the other three routines
     use.
   - **`TELEGRAM_CHAT_ID`** in the routine's environment — **this is the one that actually works for an
     unattended routine run.** The committed `reporting.config.json` carries repos and signals; a chat
     id there works too, but a PUBLIC repo keeps it in the gitignored `reporting.config.local.json`,
     which never exists in a routine's fresh checkout — so `standup.mjs` uses this env var, and it's the same one the optional failure-ping already
     needed, so one setting covers both.
   - **Network access → Custom**, with **`api.telegram.org`** allow-listed (same requirement as the
     other three routines' optional ping — here it's required for step 4 to do anything at all).
   - **⚠️ The `gh` CLI is NOT pre-installed in a routine's cloud sandbox — every step here shells out to
     it, so this is the #1 thing that blocks the whole routine if skipped.** (Confirmed live, 2026-07-02:
     the first two `ops-nightly` runs both failed at step 2 with "no `gh` CLI binary at all" — only the
     built-in GitHub tools were present, and those are read-oriented and scoped to whichever repo the
     routine cloned, not the multi-repo `gh pr list`/`gh run rerun`/`gh pr comment` calls these scripts make.)
     Fix, in the routine's **environment** settings (Edit routine → environment icon → settings gear):
     1. **Setup script** — add:
        ```bash
        apt update || true
        apt install -y gh
        ```
        **Not** the naive `apt update && apt install -y gh`, which failed live (exit 100, 2026-07-02):
        the base image ships two THIRD-PARTY PPAs pre-configured (`deadsnakes`, `ondrej/php` — unrelated
        to `gh`), and Launchpad returned `403 Forbidden` on both (a shared-sandbox-IP reputation issue,
        not a network-access misconfiguration — the request reached Launchpad's server and got a real
        403, not a proxy-block). `apt update` treats ANY repo failure as fatal even though the Ubuntu
        archives `gh` actually needs (`noble-updates/universe`, where `gh` ships on 24.04) fetched fine.
        `|| true` makes the update non-fatal so the install step still runs. This runs once and is
        cached (~7-day expiry); it does not re-run every session.
     2. **`GH_TOKEN`** env var — a GitHub Personal Access Token with access to every configured repo
        (`<root-repo>`, `<app-repo>`, `<api-repo>`). `gh` reads
        `GH_TOKEN` automatically — no `gh auth login` step needed. A **fine-grained PAT** scoped to just
        every configured repo with **Contents: Read & Write**, **Pull requests: Read & Write**, **Actions: Read &
        Write** (Metadata: Read is auto-included) is the least-privilege choice; a classic PAT with the
        `repo` scope also works if simpler. Mint one at
        [github.com/settings/tokens](https://github.com/settings/tokens) (or
        [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
        for fine-grained).
     3. `github.com`/`api.github.com` are already in the **Trusted** network-access default — no domain
        change needed there, only the two steps above.
   - **`gh` write scope sufficient for `run rerun`, `pr comment`, and `pr create` on a `claude/`-branch.**
     Steps 1 and 3 write (build-order-sync opens a docs PR; babysit-pr re-runs failed workflow runs and
     posts a PR comment) — both stay inside the routine's **default** `claude/`-prefix push scope (step
     1's branch is `claude/build-order-sync-<date>`; step 3 never pushes a branch at all, only comments
     + re-runs).
   - **No "Allow unrestricted branch pushes" permission is needed for ANY step, including the standup's
     own log persistence.** `scripts/standup.mjs` (step 4) used to commit `scripts/standups.log` straight
     to `main`, which needed that broader permission — live 2026-07-02/03, its Save button failed
     ("Failed to save changes") in the claude.ai Routines UI. Fixed by moving the log onto a dedicated
     `claude/standup-log` branch instead (`scripts/lib/log-branch.mjs`, git plumbing only — hash-object/
     mktree/commit-tree/push, no checkout), which is already inside the routine's **default** push scope.
     Nothing to configure here anymore; if that Permissions-tab toggle still won't save for you, it no
     longer matters for this routine.
   - **`VERCEL_API_TOKEN`** so step 2's richer per-branch report actually resolves. Not load-bearing —
     `standup.mjs`'s own simpler stale-preview count (step 4) already degrades gracefully to
     "unavailable" without it (confirmed live in S1), same fallback the standup has always had; this is
     purely so step 2's own dry-run report has real numbers to show, rather than an auth error.
5. **Output:** one Telegram message per night (the standup) — either the delta lines or a one-line
   "quiet night, no change" post, now with a `Deck standup:` story-deck link appended for mobile
   reading/forwarding — **plus, only when there's something to act on:** a `claude/` docs PR from step 1
   (board was stale) and/or an advisory comment on a PR from step 3 (it had a conflict or a retryable
   failing check). **Never** an `--apply` run, **never** a merge, **never** a required check.
   - ⚠️ **First-live-action gate (owed to the product owner, per the epic's risk-tier rule):** before this routine
     runs unattended on schedule, confirm the first live `vercel-prune --apply` (run only by explicit
     ask, never by this routine) and the first live `babysit-pr` action (a real retry/comment on a real
     PR) each look correct — see
     `sprint-2.md` (the origin project's `ops-routines-reporting` epic)'s walkthrough.

## Routine weekly-recap — Weekly executive recap  *(fifth routine, the longer-horizon complement to ops-nightly)*
**Prompt:** [`weekly-recap.prompt.md`](weekly-recap.prompt.md) · **Repo:** root `<root-repo>`
(reads `gh` + `git log` across every repo in `reporting.config.json`).

Shipped by `ops-routines-reporting` (the origin project's `ops-routines-reporting` epic)
S3 — a dedicated **weekly** routine (mirroring Routine C's precedent of a standalone weekly schedule,
rather than a day-of-week-gated step folded into the nightly `ops-nightly` routine). One step: the
`weekly-recap` skill (`scripts/weekly-recap.mjs`) gathers the week's merged PRs (every configured repo),
shipped/closed epics (README frontmatter `status:` flips), a merges-to-main deploy count per app repo,
and a short retro digest per shipped epic — then posts one Telegram message.

1. **Install the Claude GitHub App** on `<root-repo>` (root repo) if not already done for
   Routine C / `ops-nightly`.
2. **Create the routine** from `weekly-recap.prompt.md`.
3. **Trigger:** Schedule, **weekly — Mon 15:30 UTC** (after Routine C's Mon 14:00 roadmap-hygiene and
   comfortably after the prior night's `ops-nightly` run, so the recap can reflect that week's tail end).
4. **Env:**
   - **The `gh` CLI setup script + `GH_TOKEN`** — same requirement as `ops-nightly`'s (see its own env
     section above for the exact setup script and PAT scopes). `weekly-recap.mjs` shells out to
     `gh pr list` across every configured repo, so this is load-bearing here too. If `ops-nightly` and
     `weekly-recap` share the same cloud environment (the usual setup), provisioning it once for
     `ops-nightly` covers this routine too — nothing to redo.
   - **`TELEGRAM_BOT_TOKEN`** in the routine's environment — this routine's Telegram use is
     **LOAD-BEARING** (its one step's actual output), same as `ops-nightly`'s.
   - **`TELEGRAM_CHAT_ID`** in the routine's environment — **this is the one that actually works for an
     unattended routine run** (same reasoning as `ops-nightly`'s: a gitignored local chat id never reaches a
     routine's fresh checkout — `weekly-recap.mjs` uses this env var, the same one the optional failure-ping
     already needed).
   - **Network access → Custom**, with **`api.telegram.org`** allow-listed (same requirement as the
     other routines).
   - **No "Allow unrestricted branch pushes" permission needed** — same as `ops-nightly`'s. The window
     log lives on a dedicated `claude/weekly-recap-log` branch (`scripts/lib/log-branch.mjs`), already
     inside the routine's default `claude/`-prefix push scope, so there's nothing to configure here.
5. **Output:** one Telegram message per week — merged PRs, deploys (merge counts), shipped/closed epics,
   and a short retro digest per shipped epic, or a one-line "quiet week" post when there's nothing to
   report. **Never** a PR, **never** a code change, **never** a required check.

## Routine pmo-report — Weekly PMO operational report  *(sixth routine, stakeholder report delivery)*
**Prompt:** [`pmo-report.prompt.md`](pmo-report.prompt.md) · **Repo:** root `<root-repo>`
(reads `gh` + `git log` across every configured repo; posts to Telegram; writes `claude/pmo-reports-log`).

Shipped by `pmo-operational-reports` (the origin project's `pmo-operational-reports` epic)
S3. One step: the `pmo-report` skill (`scripts/pmo-report.mjs --weekly`) gathers scrum/DORA/doc-ops
metrics, renders a story-deck URL, posts headline numbers plus the deck link to Telegram, and
then advances the PMO window log.

1. **Install the Claude GitHub App** on `<root-repo>` if not already done for Routine C /
   `ops-nightly`.
2. **Create the routine** from `pmo-report.prompt.md`.
3. **Trigger:** Schedule, **weekly — Mon 16:30 UTC** (after roadmap-hygiene and weekly-recap, so the PMO
   deck reflects the current Roadmap/doc state).
4. **Env:**
   - **The `gh` CLI setup script + `GH_TOKEN`** — same requirement as `ops-nightly`'s. `pmo-report.mjs`
     reads merged/open PRs across every configured repo through the REST rail.
   - **`TELEGRAM_BOT_TOKEN`** in the routine's environment — load-bearing; the Telegram post is the
     routine's actual output.
   - **`TELEGRAM_CHAT_ID`** in the routine's environment — the unattended path. A local run can put the
     chat id in the gitignored `reporting.config.local.json`; it never reaches a routine session.
   - **Network access -> Custom**, with **`api.telegram.org`** allow-listed.
   - **No unrestricted branch push needed** — the PMO window log lives on `claude/pmo-reports-log`
     through `scripts/lib/log-branch.mjs`.
5. **Output:** one Telegram message per week with headline PMO numbers plus a story-deck link.
   **Never** a PR, **never** a merge, **never** a required check.

## Routine prod-smoke — Daily production watchdog  *(seventh routine — a REWRITE of the oldest one)*
**Prompt:** [`prod-smoke.prompt.md`](prod-smoke.prompt.md) · **Repo:** root `<root-repo>`
(runs `scripts/prod-smoke.mjs` against live prod; posts to Telegram; may open a `claude/` draft PR).

**This one replaces an existing routine rather than adding a new load.** The original *"prod
smoke (daily)"* (trigger id `<trigger-id>`) predates all six routines above and was
never committed — its six curl checks lived only in the cloud prompt, with no git source. So no epic
could update them, and two failures followed on 2026-08-05:

- **`market-architecture-foundation`** (shipped 07-31) moved `/l` behind a one-hop 308 to `/mx/l`.
  The watchdog went red against a route that had been correct for five days. The epic updated
  `lib/markets.ts` in both repos and the e2e specs — and had no file here to edit.
- The same cutover turned `/` from the marketplace into the market **selector**. That check kept
  returning 200 and stayed green **while testing a different page**; `/mx` lost coverage entirely
  with no signal at all. A green check that changed meaning is worse than a red one.

The checks now live in the project's `scripts/prod-smoke.checks.mjs` (the shared engine is
[`scripts/prod-smoke.mjs`](../prod-smoke.mjs), with `node:test` coverage), so a
route change is a reviewable diff and the epic that moves a route updates the smoke in the same PR.
Because a 200 proves only that *something* answered, every check guarding a rendered page also
asserts a structural body marker — status alone could not tell the selector and the marketplace apart.

> ### ✅ STOOD UP 2026-08-06 — `<trigger-id>`, daily `17 13 * * *` UTC
>
> Created via the remote-trigger API (`RemoteTrigger` / `POST /v1/code/triggers`), **not** the web UI,
> and confirmed with a live manual run against production. Steps 1–3 below are kept as the record of
> how it was stood up; they are done.
>
> **🚨 The ORIGINAL watchdog was NOT replaced, because it could not be found.** It does not appear in
> `GET /v1/code/triggers` for this account (which lists only `ops-nightly`, `smoke-triage` and
> `roadmap-hygiene`), and no workflow in any of the project's repos performs these checks. The trigger id
> recorded in team memory, `<trigger-id>`, returns **404**. So it is running from
> somewhere this session cannot see or reach.
>
> **Until someone finds and disables it, a red night pages TWICE** — once from the old prompt
> asserting `/l` → 200 (a false alarm; that route legitimately 308s), once from this one. Disabling
> the old routine is owed, and it is the only remaining step.

1. **Install the Claude GitHub App** on `<root-repo>` if not already done for Routine C /
   `ops-nightly` / `pmo-report`.
2. **Create the routine** from `prod-smoke.prompt.md`. (Originally written as "replace the old
   routine's prompt, keep its trigger" — that turned out to be impossible; see the box above.)
3. **Trigger:** Schedule, **daily 13:17 UTC** (~07:17 Mexico City) — a first-thing-in-the-morning
   check. It has no dependency on CI or the other routines; it probes live production directly, so
   its hour is not coupled to anything.
4. **Env:**
   - **Network access → Custom**, with **`<PROD_DOMAIN>`** allow-listed (the checks) and
     **`api.telegram.org`** (the alert). Without the first, every check reports **unavailable** —
     which the script reports as `UNAVAILABLE`, never as a production outage.
   - **`TELEGRAM_BOT_TOKEN`** + **`TELEGRAM_CHAT_ID`** — load-bearing on a red run; silent on green.
   - Push left at the `claude/` default (it only ever opens a draft PR against the smoke itself).
5. **Output:** **nothing on green.** On red, one Telegram alert naming each failing check with
   observed-vs-expected, plus — only when the change is *provably* deliberate — a `claude/` **draft**
   PR re-pointing the check. **Never** a merge, **never** a required check, and **never** a check
   weakened to turn a red run green.

---

## Daily-cap budget (Pro)

The **daily routine-run cap (Pro = 5/day) bites the SCHEDULED runs** — GitHub-event and API triggers
have their **own separate per-routine/per-account hourly caps**, not the scheduled daily cap, and
**one-off `Run now` runs don't count** at all ([docs](https://code.claude.com/docs/en/routines) ·
[blog](https://claude.com/blog/introducing-routines-in-claude-code)).

| Routine | Trigger | Counts against the 5/day scheduled cap? |
|---|---|---|
| A — review-on-PR | GitHub `pull_request.opened` | **No** — GitHub-event, separate hourly caps |
| C — roadmap hygiene | Schedule, weekly | Yes, but ~0.14/day |
| B — smoke triage | Schedule, nightly | Yes, 1/day |
| ops-nightly — standup + nightly fixers | Schedule, nightly | Yes, 1/day (still one routine, now 4 steps) |
| weekly-recap — weekly exec recap | Schedule, weekly | Yes, but ~0.14/day |
| pmo-report — weekly PMO deck delivery | Schedule, weekly | Yes, but ~0.14/day |
| prod-smoke — daily production watchdog | Schedule, daily | Yes, 1/day |

- **Scheduled load = B (1/day) + ops-nightly (1/day) + prod-smoke (1/day) + C (~0.14/day) + weekly-recap (~0.14/day) + pmo-report (~0.14/day) ≈ 3.4/day**
  — under the 5/day cap.
- ⚠️ **That figure assumes the old watchdog is gone, and it is not** (see the box above — it could not
  be located to disable). While both run, the real load is ≈ **4.4/day**: still under the cap, but the
  headroom is one routine, not two. This is a second reason to find and kill the old one, beyond the
  duplicate paging.
- **A is effectively uncapped for our volume** (GitHub events, hourly caps only); it does **not** eat
  the scheduled budget. On a busy day it's bounded by the preview hourly cap, not the daily 5.
- **No upgrade pressure:** everything here runs on **Pro**. Higher daily run counts are the only
  routines-relevant Max/Team/Enterprise upsell, and our scheduled load doesn't approach the Pro cap.

## Routine D — Deploy verification: **OUT** (recorded, do not re-litigate)
Held by decision (in the origin project — re-check it for yours). **Both** deploys already ping Telegram with terminal status — backend (its build
pipeline's completion notifier) and frontend (`notify-telegram.yml`'s Vercel-poll job: ✅ READY
/ ❌ ERROR / ❌ CANCELED). There is **no notifier gap** to fill, so D's only delta would be a deeper
go/no-go (run smoke + scan logs after the ping) — thin. **Hold** unless those pings prove too thin; if
ever revived, it *augments* the existing notifiers and triggers via `/fire` from CD (API triggers
don't consume the scheduled 5/day cap).

## Run-failure visibility (optional Telegram ping)

Routines have **no built-in failure alert** — *"a green status means the session started and exited
without an infrastructure error. It does not mean the task succeeded"* ([docs](https://code.claude.com/docs/en/routines)).
Your **actionable output is already visible via GitHub** (A's PR comment, B/C's `claude/` PRs all
trigger GitHub notifications). The gap is a **run that fails to complete** (network blocked, auth,
hourly cap) — that shows only on `claude.ai/code/routines` / the transcript unless you check.

This section is about that **optional** ping for A/B/C — none of them has a Telegram post as its actual
output. **ops-nightly, weekly-recap, and pmo-report are the exceptions**: their Telegram post IS the routine's
output, so their Telegram setup is load-bearing, not optional (see each one's own section above for the
full env list). They still use this same failure-ping *pattern* for the "couldn't even attempt the
post" case.

To close it without checking the app daily, each prompt has an **optional, best-effort Telegram
ping-on-failure** step, gated on two env vars being present (so it degrades to a no-op where unset).
To enable it on a routine:
1. Add env vars to the routine's environment: **`TELEGRAM_BOT_TOKEN`** + **`TELEGRAM_CHAT_ID`** (the
   same the project's ops chat bot/chat the deploy notifiers use).
2. Set the environment's **Network access → Custom** and add **`api.telegram.org`** to Allowed-domains
   (the Default "Trusted" allowlist does not include it), keeping the default package-manager list.

The ping fires **only on a blocking failure** (never on a healthy run — those reach you via GitHub),
naming the routine + what failed. Skip steps 1–2 to leave a routine silent-except-GitHub.

## Notes
- **Research preview:** limits/API may change. All three routines are advisory/observability; if the
  feature breaks, the deterministic layers above remain the SSOT and are untouched. The only standing
  discipline: never let a routine become load-bearing.
- **Smoke walkthrough** for verifying the stand-up:
  `sprint-1.md` (the origin project's `routines-enablement` epic) → *Smoke walkthrough*.
