# Git hooks — the stage budget

**Auto-enabled.** The root `package.json`'s `prepare` script runs `git config core.hooksPath .githooks`
on every `npm install` / `npm ci`, so a fresh clone gets the hooks with no step anyone has to remember.
That matters more than it sounds: a hook that has to be switched on by hand is a hook most clones never
run. `scripts/pre-commit-hook.test.mjs` pins the wiring and times pre-commit against its budget.

## The heuristic: cost decides the stage, not importance

Three stages, each with a **wall-clock budget**. A check goes in the cheapest stage where it can
still do its job — and if it doesn't fit the budget, it moves *out*, not in.

| Stage | Budget | Scope | Runs |
|---|---|---|---|
| **pre-commit** | **< 2s** | Only the **staged files** | Many times an hour |
| **pre-push** | **< 30s** | Cheap **whole-repo** checks | A few times a day |
| **CI** | unbounded | **Everything**: full-corpus walks, integration tests, cross-file drift | Once per push/PR |

Three rules follow from it:

1. **Scope to the diff, not the repo.** A check that reads 860 files to validate the 2 you staged is
   99.8% waste. Give your checkers a path-scoped mode (`--files a.md b.md`) and use it here; keep the
   full-tree walk for CI, where it does the job the scoped one can't — catching drift in files
   *nobody touched*, e.g. when a rule added today makes an old file non-conforming.
2. **Tier tests by cost per TEST, not per file.** Name anything that spawns a process, walks a
   corpus, or touches a network `*.itest.mjs`; keep pure logic in `*.test.mjs`. The hooks glob
   `*.test.mjs` and skip the rest; CI runs both. Splitting *within* a file is normal and correct —
   tiering a whole file by its slowest test exiles the fast assertions along with it.
3. **A hook is never the only place a check runs.** CI is the gate; hooks are fast feedback. If your
   CI is PR-only and you also commit direct to `main`, add a `push:` trigger — otherwise moving work
   out of the hooks leaves that path uncovered.

## commit-msg — one story per commit on an epic branch

`commit-msg` runs `scripts/story-check.mjs` inside pre-commit's budget (one `node`, ~55 ms). On a branch that
resolves to an epic (`feat/<slug>[-s<N>]`), a `feat`/`fix`/`perf`/`refactor` commit must name exactly ONE story that
epic (or that sprint) lists, e.g. `feat(band): S2.1 …`. That makes the build view's story in flight a fact git
guarantees. A refusal lists the valid ids. `docs`/`chore`/`test`/`ci`/`build`/`style`, merges, reverts, fixups and
non-epic branches pass untouched. Bypass once with `GF_SKIP_STORY_CHECK=1 git commit …`. When the resolver cannot
load, the check passes and says so: a broken check never blocks work.

## The economics error this exists to prevent

Checks get pulled local to save CI minutes. That reasoning has a hole worth stating plainly:

> A CI minute is **asynchronous and parallel** — it costs money nobody waits for.
> A local minute is **serial and blocking** — it costs a human, standing still, on every commit.

Trading two minutes of human wait to save one billed minute is a bad trade in every direction, and
it compounds: the local cost is paid per commit, forever, and grows with the repo.

## The worked example this came from

A sibling project put a full-corpus check *and* the whole test suite in `pre-commit`. At 84 docs
that was ~1.4s and entirely reasonable. At **860 docs** the same structure cost **119.7 seconds per
commit**, and the split was:

| | |
|---|---|
| 37 pure test files, combined | **~0.6s** |
| ~8 repetitions of one corpus walk (2 in the hook, 6 inside 2 test files) | **~119s** |

Over 99% of the wait was the same walk repeated, and none of it examined the files being committed.
Nothing was wrong at 84 docs either — the structure just doesn't survive growth, and it degrades
gradually enough that no single commit ever feels like the one that broke it.

After: `pre-commit` **29ms** (staged docs only), `pre-push` **~0.7s** (582 tests), corpus walks and
integration tests in CI. Same coverage, ~4000× faster at the point a human is waiting.
