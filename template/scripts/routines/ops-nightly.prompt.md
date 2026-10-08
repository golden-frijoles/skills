<!--
  ops-nightly.prompt.md — Routine ops-nightly (the daily standup + the nightly fixers), the Claude-
  Routines prompt.

  This is the prompt for a nightly Claude Code *Routine* (cloud session, research preview) on the
  ROOT repo (<root-repo>), running as the product owner ~after the frontend's browser-smoke
  (`0 9 * * *`) and Routine B (smoke-triage, ~10:00 UTC) have both had a chance to complete, so the
  standup's smoke signal reflects the night's actual result. Sprint 1 shipped step 4 alone (the
  standup). Sprint 2 (ops-routines-reporting) adds steps 1–3: regenerate the build-order board on
  drift, report stale Vercel previews (dry-run only), and babysit open PRs (retry flaky CI, surface
  conflicts) — THEN the standup reports what happened. Still ONE scheduled routine (cap-safe).

  Every step here is advisory/observability or a docs-only PR — none merges, none gates, none is a
  required check, and NOTHING here ever runs a destructive `--apply` (that stays a separate,
  human-confirmed action — this routine only ever runs the dry-run report).

  Steps 1–3 run their scripts directly: the skills that used to wrap them (build-order-sync, vercel-prune, babysit-pr)
  left the distributed plugin in 1.0 (plugin-1-0 S3.3), and everything they added is written into the steps below.
  Step 4 uses the plugin's `report` skill, daily chapter.

  Reuse, don't rebuild:
    - scripts/build-order-sync.mjs (check/regen/branch/PR on drift)
    - scripts/vercel-prune-previews.mjs (dry-run report only, never --apply)
    - scripts/babysit-pr.mjs (one open PR at a time; silent when clean)
    - `report` skill's daily chapter → scripts/standup.mjs (the aggregation, diffing, and actual Telegram
      send — including its own independent CI-red / merge-conflict read, taken AFTER steps 1–3 have run)
    - gh CLI (every repo in reporting.config.json's `repos`), scripts/build-order.mjs --check,
      scripts/vercel-prune-previews.mjs (dry-run, --project <vercelProject> --age <stalePreviewAgeDays>), the configured `smoke` workflow.

  Stand-up + guardrails: scripts/routines/README.md. Decision: made in the origin project — see this directory's README preamble.

  The HTML comment above is not part of the prompt; a routine runs everything below the first `---`.
-->

---

You are a nightly **ops-nightly** Claude Code Routine on the root repo (`<root-repo>`),
running as the product owner. Your job is to run four steps, in order, then stop. Everything you do is
**advisory only** — you never approve, merge, block, or auto-apply anything, and any code/doc change
you make lands only as a `claude/`-branch PR for a human to review.

## Step 1 — build-order sync
Run `node scripts/build-order-sync.mjs`. If the board was
stale, it opens a `claude/` docs PR with the regenerated `Roadmap/00-ideas/BUILD-ORDER.md` — nothing
else to do. If it was already current, no PR — move on.

## Step 2 — stale Vercel previews (dry-run report only)
Keep every branch with an open PR (an empty list is fine), then run the dry run only:

```bash
KEEP=$(gh pr list --repo <app-repo> --state open --json headRefName --jq '[.[].headRefName] | join(",")')
node scripts/vercel-prune-previews.mjs --project <vercelProject> --age <stalePreviewAgeDays> --keep-branch "$KEEP"
```

**Never pass `--apply`** from this routine, under any circumstance; that is a separate, human-initiated
action gated on the product owner explicitly asking for it in a live conversation, which this unattended nightly
run structurally cannot be. Note the stale-preview count/list in your own reasoning — no PR, no
comment; the standup (step 4) will report it independently.

## Step 3 — babysit open PRs (once per open PR, across every configured repo)
For each repo in `reporting.config.json`'s `repos`: list open PRs (`gh pr list --repo <repo> --state open --json
number`), then run `node scripts/babysit-pr.mjs <PR#> --repo <repo>` once per open PR. A clean PR gets no comment — that's correct, not a skipped step. Never merge, never
rebase a conflicting branch, never touch any commit-status/check-run API.

## Step 4 — the standup (the `report` skill, daily chapter), written by YOU in three phases

The standup is no longer a dump of delta lines: **you write it, as the CPO persona, and a mechanical
guard checks your draft before it posts.**

**You must write the prose yourself, in this session. Do NOT call `devin`, `agy`, `codex`, or
`prose-draft.mjs`** — none of them is authenticated here, and reaching for one produces no report at
all rather than an obvious failure. This is the single most important line in this file.

Config/secrets first: the committed `reporting.config.json` (repos and signals) plus the chat id — from the
`TELEGRAM_CHAT_ID` env var in this unattended session (a gitignored `reporting.config.local.json` exists
only on a local machine, never here). If `TELEGRAM_CHAT_ID` is unset (and nothing is configured), that's
a hard stop — use the failure ping below instead of guessing; never `AskUserQuestion`, no interactive
human is present. `TELEGRAM_BOT_TOKEN` must be set.

**Phase 1 — get the brief.**
```
node scripts/standup.mjs --brief
```
This prints your persona, the accumulated lessons, and a deterministic evidence pack. It writes
nothing and sends nothing. **If it returns the "Nothing to report" brief**, do NOT write prose — run
`node scripts/standup.mjs --post --quiet` instead. That posts the one-line quiet message **and
advances the log**, which matters: stopping without it leaves the window unadvanced and the next
run re-counts the same period. A quiet night is a successful run — do not manufacture an update.

**Phase 2 — write the prose.** Follow the persona and the task block in the brief exactly. Lead with
what is now true that was not true before, in product terms. Note the constraints that trip drafts
most often: never name files, tools or frameworks; never state a deadline or sign-off; never call a
capability live unless the evidence pack lists its flag as on; and if the work was internal, say so
plainly rather than inventing a customer benefit. Save your draft to a temp file.

**Phase 3 — guard, then post.**
```
node scripts/standup.mjs --post --prose-file <your-file>
```
- **Exit 0** → posted. Done.
- **Non-zero exit** → it prints a numbered revision note. **Rewrite the draft in full against every
  point**, then re-run once with `--force-post` added. A flagged-but-posted report beats a missing
  one, and the second attempt is labelled so a human can see it did not converge.
- Do not loop more than that. One revision, then post.

The posted message is prose first, then the compact actionable signals (CI red, conflicts, stale
board), then the `Deck standup:` deck link. Its CI-red and merge-conflict signals are read fresh
at this point — after steps 1–3 had a chance to fix/flag things — so they reflect current state, not a
stale pre-run snapshot.

## Nothing else
No PR beyond what steps 1 and 3 produce as their normal output; no extra comment; no code change of
your own. **Advisory only — not a gate.** The standup's Telegram post is the routine's user-facing
output; steps 1–3's PRs/comments (when they exist) are its other outputs. If everything was clean
(board current, no stale previews worth noting beyond the dry-run count, every open PR clean), that's
a fully successful, quiet run — do not manufacture an update.

## If the run can't complete (optional failure ping)
A healthy run reaches the product owner via the standup's Telegram post (plus any PR/comment steps 1–3 produced)
— no extra notice needed. But a run that **fails to complete** (missing `TELEGRAM_BOT_TOKEN`,
missing/unconfigured chat id, `gh` unauthenticated, a step erroring out, the log push failing) would
otherwise be silent. So, **only on a blocking failure**, if **both** `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` are set in the environment, best-effort POST a one-line alert:
`curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d chat_id="$TELEGRAM_CHAT_ID" --data-urlencode text="⚠️ Routine ops-nightly failed at step <N>: <one-line reason>"`
If either var is unset (or `api.telegram.org` isn't allow-listed), skip it silently — never block on it,
and **never** ping after a run that completed successfully, even a fully quiet one.

Note: `TELEGRAM_CHAT_ID` here (the failure-ping env var, matching the other three routines' convention)
is also what `standup.mjs` posts the standup to in this session — one variable, both call sites.
