# Releasing

One version, in lockstep, and the version bump *is* the release (D4). `plugin.json`'s `version` —
`kit/package.json`'s `version` from S2 on — and this file's newest `CHANGELOG.md` heading are always
the same number, and that number is the tag.

## The three-line procedure

1. **Bump `plugin.json`'s `version`** (+ `kit/package.json` from S2 on) **and add a `CHANGELOG.md`
   section** for it, in the same PR as the change that needs releasing. **Then run
   `node scripts/plugin-checksums.mjs`**: it rewrites `SHA256SUMS`, the SHA-256 of every plugin file that
   `goldenfrijoles.com/install.md` lists so an installer can check a release before installing it. CI
   fails while it is stale, and the release job attaches it to the GitHub Release.
2. **Merge to `main`.** `scripts/check-release.mjs` already blocked the merge if a shipped file
   (`plugins/**`, `kit/**`, or anything in the kit's script closure) changed without the version
   moving, or if the tag/`plugin.json`/CHANGELOG heading would disagree.
3. **CI does the rest.** `.github/workflows/release.yml` runs on every push to `main`. If `v<version>`
   has no tag yet, it creates the tag and a GitHub Release from that CHANGELOG section (`gh release
   create`). From S2 on, a publish job runs first (OIDC trusted publishing to npm, with provenance) and
   the tag is only created after `npm view @golden-frijoles/kit@<version>` confirms the publish landed.

Nobody pushes a release tag by hand — the tag is the *record* of a release CI already made.

## Pinning and rollback

- **Pin a release:** `claude plugin marketplace add golden-frijoles/skills@v0.1.0` (Git-based
  marketplace sources support a branch/tag `ref`).
- **Roll back:** `git revert` the bad change **and bump the version again** — a revert that doesn't
  bump the version never reaches anyone still tracking `main` (D4). Then, if needed, `npm deprecate` a
  bad kit version (from S2 on) and point people at the previous tag.

## Window between merge and publish

Consumers and strangers who install with no `ref` track `main`, so the version on `main` is live the
moment the merge lands — a few minutes before the publish job finishes (from S2 on). In that window a
freshly-rendered SKILL.md can advertise a kit version that isn't on npm yet. The skills' run rule
(S2.4) reports that as *could not look (kit unreachable)*, not as a broken project, and the local-copy escape hatch (D3: a project
with its own `scripts/<entry>.mjs` never reaches the kit at all) covers anyone who needs to keep working
through it.
