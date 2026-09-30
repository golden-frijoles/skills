# Learnings — operating notes for every build

**Read this at the start of every session.** It's the distilled, cross-cutting wisdom from past
epics' retrospectives — the things that would have saved the last agent time. The full story of any
item lives in its epic's `RETROSPECTIVE.md`; this file keeps only the *transferable* rule.

**How this file stays useful (Definition of Done, epic):** at epic close, promote any durable,
generalizable learning from your `RETROSPECTIVE.md` into the right section below — a one-liner + a
*why* + the date/source. **Dedupe** (sharpen the existing line, don't append a near-duplicate). If a
rule here is now wrong, fix or delete it. Keep it short — a long digest is an unread digest.

**TEMPLATE NOTE:** the entries below are a curated, generalized subset carried over from the origin
project (`dobby-foundation`'s own extraction) — the tooling/process gotchas that don't depend on any
particular stack. As you build this project, your own entries will accumulate here; keep the same
one-liner + why + date shape.

---

## Multi-agent & async deploy coordination
*If several agents work in parallel on their own branches, against repos that deploy independently.*

- **`main` moves under you.** Before opening a PR — and again if it sits open — **merge latest `main`
  into your branch**. Tell-tale: CI fails on a spec/check for something you never touched → a sibling
  agent landed something on `main` and your preview (if you have one) predates it. **A re-run alone
  won't fix it** — the mismatch is structural; only `git merge origin/main` + push clears it. Confirm
  with `git log HEAD..origin/main`.
  **Corollary — the stale-vs-fresh mismatch can hit your own NEW code too, not just an untouched
  check, when a sibling PR changes a shared file's CONVENTIONS (a lint rule, not a feature).** The
  diagnostic tell: check whether a FAILING assertion is about a rule/convention that changed, not just
  a feature/data mismatch.
- **Announce cross-cutting or direct-to-`main` changes**, and prefer a PR even for "engine" features.
  Anything touching shared surface — a root layout/middleware file, global styles, `package.json`/deps,
  a new sibling worktree — can break every other open PR.
- **Don't yank a shared branch out from under another agent.** If the repo's working tree is on
  someone else's branch, do your change in an isolated `git worktree` instead of switching it.
  **Corollary — checking CI status and merging a PR need no local checkout at all.** `gh pr checks <N>`
  and `gh pr merge <N>` operate against the pushed remote branch via the GitHub API; they don't care
  what's checked out locally.
- **Before building a story, grep whether a sibling PR already fixed the identical root cause.** Two
  epics approved the same day can target the same bug from different scope docs. Check
  `git log --oneline -- <the file the story's root-cause names>` + `gh pr list` during research, not
  assumed.
- **Risk tier decides who merges**: low-risk → the reviewer/agent may merge on green CI; anything
  touching money / auth / DB / shared infra → the product owner merges. When unsure, treat as high.
  **Corollary — an explicit "merge on green" authorization changes who decides to pause and check in,
  not whether the review layers themselves still run.** "Merge on green" is permission to proceed
  through the established gate without re-asking at each step, not permission to skip the gate.
  **Corollary — a "merge on green" given for one PR does not carry forward to a LATER PR in the same
  session/epic, even a similarly-scoped one**, and a builder's own plan can promise a review step the
  standing authorization never touched. Re-check whether a standing "merge on green" was given for
  *this* PR/story, not just somewhere earlier in the conversation.
- **When your branch is BEHIND `main`, the two-dot `git diff main..HEAD` lies — read the three-dot.**
  Two-dot compares tips directly, so it folds in the *inverse* of every commit `main` gained since you
  branched (a sibling epic's new files show up as "deletions" in your diff — alarming and wrong).
  Review with **three-dot `git diff main...HEAD`** (merge-base→HEAD = only your changes), and **merge
  `origin/main` into the branch before merging the PR** so the merged tree is what actually ships.
- **A squash-merged sprint branch is a dead end — start the next sprint on a FRESH branch off `main`.**
  A squash-merged PR's individual commits aren't on `main` (only the one squash commit is), so
  continuing that branch for the next sprint re-introduces a messy duplicate diff and can't
  fast-forward. Branch clean off `origin/main` for each new sprint.
- **To verify "is the prior sprint serving?", reason off `origin/main` — never the working tree — and
  read PR *state*, not branch commits.** Local app checkouts routinely sit on *other* agents'
  branches, so on-disk files lie about `main`, and a squash-merged sprint's individual commits
  genuinely aren't on `main`. Confirm with `gh pr view <#> --json state,mergeCommit` or `git fetch`
  then `git grep <x> origin/main` — an `ls`/working-tree read is not evidence about `main`.
- **Concurrent planning commits in a shared worktree collide the git index.** Fix: (1) **path-limited
  commits** — `git add <your files>` + `git commit -- <those paths>`, never `git add -A`; (2) for
  parallel planning, give each session its own worktree, or appoint a single **scribe** for shared
  files (like `BUILD-ORDER.md`).
- **A subagent/fork that dies mid-task from a shared session rate-limit still returns a `result` — that
  text is its last tool-call narration, not a trustworthy completion claim.** After any subagent/fork
  batch — especially one large enough to plausibly share a rate-limit, or any showing a failed status —
  re-derive actual file state directly (grep the real repo) and run the language's type-checker/build
  before treating the batch as complete.

## Tooling gotchas
- **A script with a co-located pure-logic test file MUST guard its `main()` call with an `isMain`
  check.** Importing a script that calls `main()` unconditionally at module scope re-executes the
  whole script for real (shell-outs, notifications, git pushes, all of it) the moment a test file
  loads it for its pure helpers: `const isMain = process.argv[1] && …; if (isMain) main()`.
- **Run the repo binaries directly when `npm`/`npx` chokes.** A sibling worktree that reuses the same
  `package.json` name as the main checkout breaks npm **workspace resolution** at the monorepo root.
  Use the binary path directly (`node /…/node_modules/typescript/bin/tsc --noEmit`,
  `/…/node_modules/.bin/{next,playwright}`). New worktrees should use a unique package name or be
  excluded from the root `workspaces` glob.
- **A worktree needing its own `npm install` forces worktree-local binaries for everything, including
  test runners.** A fresh `git worktree` resolves most tooling fine via walk-up to the root
  `node_modules`, but if any dependency needs a local install (e.g. a CSS framework's PostCSS plugin
  resolution), that install adds a worktree-local copy of your test framework too — switch to the
  **worktree-local** binary path, or you'll hit "two different versions" / "No tests found" errors.
- **`gh pr merge --delete-branch` fails when a worktree holds `main`.** The merge still succeeds on
  GitHub; only the local branch-delete errors. Verify with `gh pr view <n> --json state`.
- **A server-side `process.env.X ?? \`https://${req.headers.get('host')}\`` fallback is a real
  production landmine, distinct from client-bundle build-time-inlining bugs.** The trap is the
  Host-header fallback when the env var is unset: a bare container run without an explicit runtime env
  var can get a literal `0.0.0.0:PORT` or similar garbage as the `Host` header, and the fallback
  happily builds a broken URL from it — dangerous on any redirect-URL-building code path (OAuth
  callbacks, payment-provider return URLs). Fix: one shared `resolveOrigin()`-style helper that
  rejects obviously-wrong hosts and **throws instead of silently building a broken URL** — a loud
  failure beats a dead redirect.
- **A unit-tested pure helper can't live in the same file as code that imports a framework/runtime-only
  module** (e.g. a Next.js `next/cache` import, or an auth SDK's server-only entrypoint). A generic
  test runner that can't load that module throws an opaque, unrelated-looking error the moment it
  imports the file at all — even if the pure function itself never touches the framework-only code.
  Keep the pure logic in its own zero-import file; let the framework-touching wrapper import *it*.
- **Swapping a framework-generated artifact for a hand-rolled route breaks specs on exact format.**
  Converting a typed/generated file (robots.txt, sitemap, OG image, metadata) to a hand-rolled
  equivalent can silently change output details (header casing, field order) that an existing spec
  asserted on. When you replace anything a framework generates, diff the *exact bytes* the old one
  emitted and grep the suite for any spec asserting that surface.
- **CI sometimes just doesn't schedule a workflow for a PR.** Seen occasionally on `opened`; close/
  reopen doesn't always fix it — an empty-commit push (a real `synchronize` event) does. Don't merge
  on an absent gate: re-trigger, and lean on the local gate + a green preview as the real signal.
- **`node --test <dir>` (bare directory) can silently fail to discover tests depending on your Node
  version** — it may try to load the directory as a module instead of globbing it. Use an explicit
  glob: `node --test 'scripts/lib/*.test.mjs'`.
- **A "resolve the PR from the current branch" tool must read PR `state`** — a list/view call can
  return MERGED/CLOSED PRs too, especially for a reused branch name whose PR already merged. Treat
  `state !== 'OPEN'` as "no open PR for this branch" and pair it with a stale-HEAD guard
  (`git rev-parse HEAD` vs the PR's `headRefOid` → warn + require an explicit override) so the first
  run always reviews the current diff.
- **A hosted CLI-authenticated integration (Vercel-style env-var management, similar platforms) can
  silently store or report EMPTY values** through a convenience CLI command even when the underlying
  API call "succeeds." Verify by value **length** where you can't read the value directly (a scoped
  read token may be needed), not just by exit code.
- **A "sensitive"/write-only secret is confirmable by presence/type but not by value** — you can check
  it exists and which environment it targets, but not its actual content, from a CLI or API. Read the
  provider's dashboard, or have the app surface the cause on use (missing key → a specific, classifiable
  error) instead of guessing.
- **Driving a young foreign CLI: run `<cli> --help` first, pin the version, and design for degrade —
  never build against a documented flag from memory.** A less-mature CLI can have surprising interface
  shapes (no JSON output mode, arguments only via argv not stdin, or vice versa) that don't match a
  more mainstream CLI's conventions. Smoke-test by running it against something real and reading the
  actual output before scripting around it.
  **A young foreign CLI can silently break its own contract on a MINOR version bump** — a print mode
  that used to always emit something can start exiting 0 with empty output on a real failure. Treat
  **empty output as failure** (not success), and make any version-pin check **fail loud** so a
  contract break gets caught, not silently absorbed.
  **A CLI authed by an interactive/OAuth login is NOT free to run in CI** — confirm a portable
  non-interactive credential path AND its cost before automating it in a runner; some CLIs have no
  headless auth at all, which may mean an advisory/local-only tool stays local-only rather than
  becoming a CI job.
- **`process.exit()` truncates piped stdout — flush synchronously, or you ship a tool that works to a
  file but crashes in a pipe.** A script that does `console.log(json); process.exit(0)` can produce
  valid output when redirected to a file (sync writes) but truncated output down a pipe, because the
  async stdout write hasn't drained when exit fires. Use a synchronous write before `process.exit`, or
  exit in the write callback. Test a tool the way it's actually invoked (pipe, not just file redirect).
- **Git background auto-maintenance can race a burst of rapid commits and leave stale `*.lock`
  files**, producing intermittent "cannot lock ref" errors. Clear locks recursively
  (`find .git -name '*.lock'`) and run a rapid-commit batch with `git -c gc.auto=0 commit …` so
  auto-maintenance can't re-trigger mid-sequence.
- **A delta-only reporting tool must special-case a missing/wiped baseline as a bounded no-op, never as
  "everything happened."** Diffing current state against an empty/`null` previous snapshot makes every
  historical item look "new" — guard for a missing baseline with ONE bounded summary (counts only)
  instead of enumerating full history, and keep a message-length safety net regardless of the guard.
- **A script with both scheduled state-tracking delivery and on-demand artifact generation must keep
  the artifact mode stateless.** Reusing a stateful window/log rail for an on-demand report mode risks
  silently advancing state a scheduled run depends on — keep on-demand modes explicitly
  non-state-mutating and lock that with a test.

## Working efficiently
- **Session length is set by a measured line, not a stamina rule.** A whole epic in one session is the
  main context-cost driver, and the durable state (the plan file, sprint docs, team memory) makes
  re-entry cheap by design — so checkpoint or hand off when the budget line says so (its thresholds
  live in one table, `THRESHOLDS` in groom's `session-budget.mjs`), not per sprint. Groom's twin rule is "one deep ask
  per approval gate". *(Sharpened 2026-09-30, session-budget: "fresh session per sprint" was set for
  earlier models.)*
