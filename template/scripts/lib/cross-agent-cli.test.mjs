// Dev-tooling reliability — Sprint 2: pure node:test for the Codex→Antigravity auto-fallback.
//
// Cross-agent tooling has no Playwright gate (it's a CLI, not app code), so this node:test IS the
// deterministic gate for the fallback-decision logic AND the Sprint-3 branch-resolve + stale-HEAD seam —
// same anti-erosion shape as the infra/gcp guard. It mocks BOTH the codex/agy runners (no network) and gh +
// git (injected deps), asserting the fallback fires on the AUTH signal only and the resolver never reviews
// the wrong/stale diff silently.
//
// Run: `node --test 'scripts/lib/*.test.mjs'`   (the bare-directory form was dropped in Node 24).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isCodexAuthError,
  decideCodexFallback,
  runWithCodexFallback,
  decideHeadGuard,
  decideTrivialSkip,
  isDocFile,
  resolveCurrentPr,
  runAntigravity,
  runDevin,
  AGENTS,
  checkAgyVersion,
  AGY_PINNED,
  AGY_MODEL,
  AGY_FALLBACK_MODEL,
  AGY_ARG_LIMIT,
  stripGeneratedFileDiffs,
  isContextWindowOverflow,
  isCodexOutdated,
} from './cross-agent-cli.mjs';

// The real stderr a live revoked Codex token emits (captured 2026-06-21) — the trigger must match THIS.
const REVOKED_TOKEN_STDERR = `Reading additional input from stdin...
ERROR codex_login::auth::manager: Failed to refresh token: 401 Unauthorized: { "code": "refresh_token_invalidated" }
ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.`;

test('isCodexAuthError: the real revoked-token stderr → true', () => {
  assert.equal(isCodexAuthError(REVOKED_TOKEN_STDERR), true);
});

test('isCodexAuthError: assorted auth phrasings → true', () => {
  assert.equal(isCodexAuthError('Your session has ended. Please log in again.'), true);
  assert.equal(isCodexAuthError('401 Unauthorized'), true);
  assert.equal(isCodexAuthError('the access token is expired'), true);
});

test('isCodexAuthError: non-auth failures → false (no fallback for these)', () => {
  assert.equal(isCodexAuthError('PR #5 has an empty diff (wrong number or repo?).'), false);
  assert.equal(isCodexAuthError('agy not found — install the Antigravity CLI'), false);
  assert.equal(isCodexAuthError('unknown error'), false);
  assert.equal(isCodexAuthError(''), false);
});

test('decideCodexFallback: exhaustive truth table', () => {
  // codexOk short-circuits regardless of the rest.
  assert.equal(
    decideCodexFallback({
      codexOk: true,
      authFailed: false,
      agyAvailable: false,
    }),
    'use-codex'
  );
  assert.equal(
    decideCodexFallback({
      codexOk: true,
      authFailed: true,
      agyAvailable: true,
    }),
    'use-codex'
  );
  // non-auth, non-stale failure never falls back.
  assert.equal(
    decideCodexFallback({
      codexOk: false,
      authFailed: false,
      agyAvailable: true,
    }),
    'fail-non-auth'
  );
  // auth failure + agy present → fall back; agy absent → both-dead.
  assert.equal(
    decideCodexFallback({
      codexOk: false,
      authFailed: true,
      agyAvailable: true,
    }),
    'fallback'
  );
  assert.equal(
    decideCodexFallback({
      codexOk: false,
      authFailed: true,
      agyAvailable: false,
    }),
    'fail-both-dead'
  );
  // stale-CLI (cliOutdated) recovers exactly like an auth lapse — fall back when agy is present, both-dead when not.
  assert.equal(
    decideCodexFallback({
      codexOk: false,
      authFailed: false,
      cliOutdated: true,
      agyAvailable: true,
    }),
    'fallback'
  );
  assert.equal(
    decideCodexFallback({
      codexOk: false,
      authFailed: false,
      cliOutdated: true,
      agyAvailable: false,
    }),
    'fail-both-dead'
  );
  // a plain non-auth, non-stale break with agy present still surfaces, not masked by a fallback.
  assert.equal(
    decideCodexFallback({
      codexOk: false,
      authFailed: false,
      cliOutdated: false,
      agyAvailable: true,
    }),
    'fail-non-auth'
  );
});

test('isCodexOutdated: the real stale-CLI stderr → true; auth/other → false', () => {
  assert.equal(
    isCodexOutdated(
      `ERROR: {"message":"The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}`
    ),
    true
  );
  assert.equal(isCodexOutdated('update codex to continue'), true);
  assert.equal(isCodexOutdated(REVOKED_TOKEN_STDERR), false); // an auth lapse is a different class
  assert.equal(isCodexOutdated('PR #5 has an empty diff (wrong number or repo?).'), false);
  assert.equal(isCodexOutdated(''), false);
});

test('runWithCodexFallback: stale-CLI codex failure → falls back to Antigravity, banner names the upgrade not codex login', () => {
  const d = deps({
    codex: {
      ok: false,
      text: '',
      authFailed: false,
      cliOutdated: true,
      stderr: "The 'gpt-5.6-sol' model requires a newer version of Codex.",
    },
    agyAvailable: true,
  });
  const r = runWithCodexFallback(ARGS, d);
  assert.deepEqual(r, {
    findings: 'ANTIGRAVITY FINDINGS',
    fellBack: true,
    from: 'codex',
    to: 'antigravity',
  });
  assert.equal(d.calls.antigravity, 1);
  assert.match(d.calls.warnMsg, /behind its model requirement/);
  assert.match(d.calls.warnMsg, /cross-agent-doctor/); // points at the diagnosis, not `codex login`
});

test('runWithCodexFallback: stale-CLI + agy absent → fails naming the upgrade, not a token restore', () => {
  const d = deps({
    codex: {
      ok: false,
      text: '',
      authFailed: false,
      cliOutdated: true,
      stderr: 'requires a newer version of Codex',
    },
    agyAvailable: false,
  });
  assert.throws(
    () => runWithCodexFallback(ARGS, d),
    /behind its model requirement.*Antigravity unavailable/s
  );
});

// --- orchestrator with mocked runners -------------------------------------------------------------------

// Build injectable deps with spies. `codex` shapes the tryCodex result; agy presence + fail are configurable.
function deps({ codex, agyAvailable = true }) {
  const calls = { antigravity: 0, failMsg: null, warnMsg: null };
  return {
    calls,
    tryCodex: () => codex,
    runAntigravity: () => {
      calls.antigravity++;
      return 'ANTIGRAVITY FINDINGS';
    },
    hasCmd: () => agyAvailable,
    // die() exits the process; the test substitutes a throwing fail to assert the message instead.
    fail: (m) => {
      calls.failMsg = m;
      throw new Error(m);
    },
    warn: (m) => {
      calls.warnMsg = m;
    },
  };
}

const ARGS = { prompt: 'p', stdin: 'diff', antigravityArgv: 'full-argv' };

test('runWithCodexFallback: codex healthy → use codex, no fallback, agy untouched', () => {
  const d = deps({
    codex: { ok: true, text: 'CODEX FINDINGS', authFailed: false, stderr: '' },
  });
  const r = runWithCodexFallback(ARGS, d);
  assert.deepEqual(r, { findings: 'CODEX FINDINGS', fellBack: false });
  assert.equal(d.calls.antigravity, 0);
});

test('runWithCodexFallback: dead token + agy present → falls back to Antigravity (labeled signal)', () => {
  const d = deps({
    codex: {
      ok: false,
      text: '',
      authFailed: true,
      stderr: REVOKED_TOKEN_STDERR,
    },
    agyAvailable: true,
  });
  const r = runWithCodexFallback(ARGS, d);
  assert.deepEqual(r, {
    findings: 'ANTIGRAVITY FINDINGS',
    fellBack: true,
    from: 'codex',
    to: 'antigravity',
  });
  assert.equal(d.calls.antigravity, 1);
  assert.match(d.calls.warnMsg, /Codex token revoked.*codex login/i); // restore hint emitted
});

test('runWithCodexFallback: non-auth codex failure → fails clearly, NO fallback', () => {
  const d = deps({
    codex: {
      ok: false,
      text: '',
      authFailed: false,
      stderr: 'internal error: boom',
    },
    agyAvailable: true,
  });
  assert.throws(() => runWithCodexFallback(ARGS, d), /non-auth/);
  assert.equal(d.calls.antigravity, 0);
});

test('runWithCodexFallback: dead token + agy ALSO unavailable → one-line failure naming both fixes', () => {
  const d = deps({
    codex: {
      ok: false,
      text: '',
      authFailed: true,
      stderr: REVOKED_TOKEN_STDERR,
    },
    agyAvailable: false,
  });
  assert.throws(
    () => runWithCodexFallback(ARGS, d),
    (e) => {
      assert.match(e.message, /codex login/i);
      assert.match(e.message, /agy|antigravity/i);
      return true;
    }
  );
  assert.equal(d.calls.antigravity, 0);
});

test("runWithCodexFallback: context-window overflow → fails clearly, NO fallback (retrying wouldn't help)", () => {
  const d = deps({
    codex: {
      ok: false,
      text: '',
      authFailed: false,
      contextOverflow: true,
      stderr: 'tokens used\n0',
    },
    agyAvailable: true,
  });
  assert.throws(() => runWithCodexFallback(ARGS, d), /context window/i);
  assert.equal(
    d.calls.antigravity,
    0,
    'an overflow is an input-size problem, not an auth problem — no fallback attempt'
  );
});

// --- isContextWindowOverflow (pure) — the real Codex overflow signature, captured live 2026-07-11 --------

test('isContextWindowOverflow: the real Codex overflow message → true', () => {
  assert.equal(
    isContextWindowOverflow(
      "ERROR: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
    ),
    true
  );
});

test('isContextWindowOverflow: case-insensitive, and matches on stdout OR stderr text alike', () => {
  assert.equal(isContextWindowOverflow('codex RAN OUT OF ROOM in the model’s context window'), true);
});

test('isContextWindowOverflow: unrelated errors/empty → false', () => {
  assert.equal(isContextWindowOverflow('internal error: boom'), false);
  assert.equal(isContextWindowOverflow(''), false);
  assert.equal(isContextWindowOverflow(undefined), false);
});

// --- decideCodexFallback: contextOverflow takes priority over authFailed ----------------------------------

test('decideCodexFallback: contextOverflow wins even if authFailed is ALSO somehow true', () => {
  assert.equal(
    decideCodexFallback({
      codexOk: false,
      authFailed: true,
      contextOverflow: true,
      agyAvailable: true,
    }),
    'fail-context-overflow'
  );
});

// --- stripGeneratedFileDiffs (pure) — the fix for Codex blowing its context window on a huge lockfile ----
// Found live: a PR's package-lock.json diff (~12–19K lines) blew Codex's context window. This strips whole
// per-file diff hunks for known generated-file basenames to a one-line placeholder before the diff ever
// reaches a reviewer CLI.

const SMALL_HUNK = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 const x = 1
+const y = 2
`;

const LOCKFILE_HUNK = `diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,4 @@
 {
   "name": "app",
+  "newDep": "^1.0.0"
 }
`;

test('stripGeneratedFileDiffs: leaves ordinary source-file hunks completely untouched', () => {
  const { diff, strippedFiles } = stripGeneratedFileDiffs(SMALL_HUNK);
  assert.equal(diff, SMALL_HUNK);
  assert.deepEqual(strippedFiles, []);
});

test('stripGeneratedFileDiffs: replaces a package-lock.json hunk with a placeholder, reports it stripped', () => {
  const combined = SMALL_HUNK + LOCKFILE_HUNK;
  const { diff, strippedFiles } = stripGeneratedFileDiffs(combined);
  assert.deepEqual(strippedFiles, ['package-lock.json']);
  assert.match(diff, /generated file — diff omitted/);
  assert.doesNotMatch(diff, /"newDep"/); // the actual lockfile content is gone
  assert.match(diff, /const y = 2/); // the real source hunk survives byte-for-byte
});

test('stripGeneratedFileDiffs: known lock-file family (yarn/pnpm/composer/Cargo/etc.) all match', () => {
  for (const name of [
    'yarn.lock',
    'pnpm-lock.yaml',
    'composer.lock',
    'Gemfile.lock',
    'Cargo.lock',
    'poetry.lock',
    'npm-shrinkwrap.json',
  ]) {
    const hunk = `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`;
    const { strippedFiles } = stripGeneratedFileDiffs(hunk);
    assert.deepEqual(strippedFiles, [name], `expected ${name} to be recognized as generated`);
  }
});

test('stripGeneratedFileDiffs: generated PMO report-library JSON is stripped by default', () => {
  const hunk = `diff --git a/public/reports-data.json b/public/reports-data.json\nindex 1..2 100644\n--- a/public/reports-data.json\n+++ b/public/reports-data.json\n@@ -1 +1 @@\n-{\"items\":[]}\n+{\"items\":[{\"huge\":\"payload\"}]}\n`;
  const { diff, strippedFiles } = stripGeneratedFileDiffs(hunk);
  assert.deepEqual(strippedFiles, ['public/reports-data.json']);
  assert.match(diff, /generated file — diff omitted/);
  assert.doesNotMatch(diff, /huge/);
});

test('stripGeneratedFileDiffs: a nested-path lockfile (apps/foo/package-lock.json) still matches', () => {
  const hunk = `diff --git a/apps/foo/package-lock.json b/apps/foo/package-lock.json\nindex 1..2 100644\n--- a/apps/foo/package-lock.json\n+++ b/apps/foo/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n`;
  const { strippedFiles } = stripGeneratedFileDiffs(hunk);
  assert.deepEqual(strippedFiles, ['apps/foo/package-lock.json']);
});

test('stripGeneratedFileDiffs: a similarly-named but NOT-actually-a-lockfile path is left alone', () => {
  // "my-package-lock.json.md" or a file merely containing the substring must not false-positive.
  const hunk = `diff --git a/docs/package-lock.json.md b/docs/package-lock.json.md\nindex 1..2 100644\n--- a/docs/package-lock.json.md\n+++ b/docs/package-lock.json.md\n@@ -1 +1 @@\n-old\n+new\n`;
  const { strippedFiles } = stripGeneratedFileDiffs(hunk);
  assert.deepEqual(strippedFiles, []);
});

test('stripGeneratedFileDiffs: extraPatterns lets a caller add repo-specific generated files', () => {
  const hunk = `diff --git a/dist/bundle.min.js b/dist/bundle.min.js\nindex 1..2 100644\n--- a/dist/bundle.min.js\n+++ b/dist/bundle.min.js\n@@ -1 +1 @@\n-old\n+new\n`;
  const { strippedFiles: withoutPattern } = stripGeneratedFileDiffs(hunk);
  assert.deepEqual(withoutPattern, [], 'not stripped without an explicit pattern');
  const { strippedFiles: withPattern } = stripGeneratedFileDiffs(hunk, {
    extraPatterns: [/\.min\.js$/],
  });
  assert.deepEqual(withPattern, ['dist/bundle.min.js']);
});

test('stripGeneratedFileDiffs: empty/falsy input passes through harmlessly', () => {
  assert.deepEqual(stripGeneratedFileDiffs(''), {
    diff: '',
    strippedFiles: [],
  });
  assert.deepEqual(stripGeneratedFileDiffs(undefined), {
    diff: undefined,
    strippedFiles: [],
  });
});

test('stripGeneratedFileDiffs: multiple generated files in one diff all get stripped, order preserved', () => {
  // .replaceAll, not .replace — the naive single-replace version left the "b/" side of the diff --git
  // header un-renamed (LOCKFILE_HUNK repeats "package-lock.json" 4x: the diff --git a/…, b/…, ---, +++
  // lines), which silently degraded this into a same-path duplicate rather than a true second file.
  const secondHunk = LOCKFILE_HUNK.replaceAll('package-lock.json', 'apps/x/package-lock.json');
  const combined = LOCKFILE_HUNK + SMALL_HUNK + secondHunk;
  const { strippedFiles } = stripGeneratedFileDiffs(combined);
  assert.deepEqual(strippedFiles, ['package-lock.json', 'apps/x/package-lock.json']);
});

// --- Cost guard: decideTrivialSkip (pure, the CI "skip a typo PR" decision) -----------------------------

test('isDocFile: docs/text paths → true, code → false', () => {
  for (const p of ['README.md', 'a/b.mdx', 'notes.txt', 'x.rst', 'LICENSE', 'docs/guide.ts', '.gitignore'])
    assert.equal(isDocFile(p), true, p);
  for (const p of ['src/app.ts', 'a/Component.tsx', 'scripts/x.mjs', 'README.md.ts', 'mddocs/x.ts'])
    assert.equal(isDocFile(p), false, p);
});

test('decideTrivialSkip: empty / no files → skip (nothing to review)', () => {
  assert.deepEqual(decideTrivialSkip({ files: [] }), {
    skip: true,
    reason: 'empty diff',
  });
  assert.deepEqual(decideTrivialSkip({}), { skip: true, reason: 'empty diff' });
});

test('decideTrivialSkip: docs-only of ANY size → skip', () => {
  const files = [
    { path: 'README.md', additions: 400, deletions: 12 },
    { path: 'docs/x.mdx', additions: 99, deletions: 0 },
  ];
  assert.deepEqual(decideTrivialSkip({ files }), {
    skip: true,
    reason: 'docs-only diff',
  });
});

test('decideTrivialSkip: tiny code diff under threshold → skip with the count', () => {
  const r = decideTrivialSkip({
    files: [{ path: 'src/a.ts', additions: 3, deletions: 2 }],
  });
  assert.equal(r.skip, true);
  assert.match(r.reason, /trivial diff \(5 changed lines < 10\)/);
});

test('decideTrivialSkip: a real code change of any size → review (no skip)', () => {
  assert.deepEqual(
    decideTrivialSkip({
      files: [{ path: 'src/a.ts', additions: 40, deletions: 0 }],
    }),
    {
      skip: false,
    }
  );
  // one real code file among docs → not docs-only, and 40 lines ≥ 10 → review.
  assert.deepEqual(
    decideTrivialSkip({
      files: [
        { path: 'README.md', additions: 200, deletions: 0 },
        { path: 'src/a.ts', additions: 40, deletions: 0 },
      ],
    }),
    { skip: false }
  );
});

test('decideTrivialSkip: boundary — exactly minLines code change is reviewed (< is strict)', () => {
  assert.deepEqual(
    decideTrivialSkip({
      files: [{ path: 'src/a.ts', additions: 10, deletions: 0 }],
    }),
    {
      skip: false,
    }
  );
  assert.equal(
    decideTrivialSkip({
      files: [{ path: 'src/a.ts', additions: 9, deletions: 0 }],
    }).skip,
    true
  );
});

test('decideTrivialSkip: a custom minLines is honored, singular line wording', () => {
  assert.equal(
    decideTrivialSkip({
      files: [{ path: 'src/a.ts', additions: 30 }],
      minLines: 50,
    }).skip,
    true
  );
  const one = decideTrivialSkip({
    files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
  });
  assert.match(one.reason, /1 changed line </); // singular "line", not "lines"
});

// --- Sprint 3: resolve + SHA-compare seam (mock gh + git) -----------------------------------------------

test('decideHeadGuard: matching SHAs → proceed silently', () => {
  assert.equal(decideHeadGuard({ localHead: 'abc123', prHeadOid: 'abc123', force: false }), 'match');
  assert.equal(decideHeadGuard({ localHead: 'abc123', prHeadOid: 'abc123', force: true }), 'match');
});

test('decideHeadGuard: mismatch → block without --force, force-through with it', () => {
  assert.equal(decideHeadGuard({ localHead: 'aaa', prHeadOid: 'bbb', force: false }), 'mismatch-block');
  assert.equal(decideHeadGuard({ localHead: 'aaa', prHeadOid: 'bbb', force: true }), 'mismatch-force');
});

test('decideHeadGuard: an unreadable SHA is treated as a mismatch (never a silent match)', () => {
  assert.equal(decideHeadGuard({ localHead: null, prHeadOid: 'bbb', force: false }), 'mismatch-block');
  assert.equal(decideHeadGuard({ localHead: 'aaa', prHeadOid: null, force: false }), 'mismatch-block');
});

// A throwing `fail` (die exits the process) so the test asserts the message instead of exiting.
const throwingFail = (m) => {
  throw new Error(m);
};

test('resolveCurrentPr: branch + valid OPEN `gh pr view` JSON → parsed PR fields', () => {
  const deps = {
    runGit: (args) => (args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? 'feat/x' : null),
    runGh: () => ({
      ok: true,
      stdout: JSON.stringify({
        number: 42,
        state: 'OPEN',
        headRefName: 'feat/x',
        headRefOid: 'deadbeef',
      }),
      stderr: '',
    }),
    fail: throwingFail,
  };
  assert.deepEqual(resolveCurrentPr({}, deps), {
    number: 42,
    headRefName: 'feat/x',
    headRefOid: 'deadbeef',
  });
});

test('resolveCurrentPr: `--repo` is forwarded to gh', () => {
  let seen = null;
  const deps = {
    runGit: () => 'feat/x',
    runGh: (args) => {
      seen = args;
      return {
        ok: true,
        stdout: JSON.stringify({
          number: 7,
          state: 'OPEN',
          headRefName: 'feat/x',
          headRefOid: 'c0ffee',
        }),
        stderr: '',
      };
    },
    fail: throwingFail,
  };
  resolveCurrentPr({ repo: 'owner/repo' }, deps);
  assert.deepEqual(seen, [
    'pr',
    'view',
    '--json',
    'number,state,headRefName,headRefOid',
    '--repo',
    'owner/repo',
  ]);
});

test('resolveCurrentPr: a MERGED/CLOSED PR (reused branch name) → treated as "no open PR"', () => {
  const deps = {
    runGit: () => 'chore/x',
    runGh: () => ({
      ok: true,
      stdout: JSON.stringify({
        number: 16,
        state: 'MERGED',
        headRefName: 'chore/x',
        headRefOid: 'f8aa7119',
      }),
      stderr: '',
    }),
    fail: throwingFail,
  };
  assert.throws(
    () => resolveCurrentPr({}, deps),
    /no open PR for branch `chore\/x` \(found #16, state MERGED\)/
  );
});

test('resolveCurrentPr: no open PR for the branch → clear message, no stack trace', () => {
  const deps = {
    runGit: () => 'feat/x',
    runGh: () => ({
      ok: false,
      stdout: '',
      stderr: 'no pull requests found for branch "feat/x"',
    }),
    fail: throwingFail,
  };
  assert.throws(() => resolveCurrentPr({}, deps), /no open PR for branch `feat\/x`/);
});

test('resolveCurrentPr: detached HEAD → clear message, never a silent wrong review', () => {
  const detached = { runGit: () => 'HEAD', fail: throwingFail };
  assert.throws(() => resolveCurrentPr({}, detached), /detached HEAD/);
  const noBranch = { runGit: () => null, fail: throwingFail };
  assert.throws(() => resolveCurrentPr({}, noBranch), /detached HEAD/);
});

test('resolveCurrentPr: a generic gh failure surfaces the stderr tail (not masked as "no PR")', () => {
  const deps = {
    runGit: () => 'feat/x',
    runGh: () => ({
      ok: false,
      stdout: '',
      stderr: 'error connecting to api.github.com\nnetwork is unreachable',
    }),
    fail: throwingFail,
  };
  assert.throws(() => resolveCurrentPr({}, deps), /gh pr view failed.*network is unreachable/s);
});

test('resolveCurrentPr: a repo/remote misconfig is NOT masked as "no open PR" (tight matcher)', () => {
  // e.g. a bad --repo or missing remote — must surface the real error, not "no open PR".
  const deps = {
    runGit: () => 'feat/x',
    runGh: () => ({
      ok: false,
      stdout: '',
      stderr: 'could not find any remotes / no default branch',
    }),
    fail: throwingFail,
  };
  assert.throws(() => resolveCurrentPr({}, deps), /gh pr view failed/);
});

// --- Sprint 2 (devops-reliability-cleanup S4): agy 1.0.10 print contract + fail-loud version check ---------
// agy 1.0.7→1.0.10 changed `--print`: it now needs an explicit --model or exits 0 with NO output (the bug we
// fixed). These lock the new invocation (a stubbed agy → non-empty capture, the --model + argv framing present,
// empty stdout treated as failure, the size cap intact) and the fail-loud version gate.

// NOTE for whoever next runs `node scripts/cross-agent-doctor.mjs agy --fix`: that command rewrites
// AGY_PINNED and its marker in cross-agent-cli.mjs, but it does NOT rewrite the literal below —
// so a green-probe bump always leaves this test red until you update it here too, deliberately.
// That is the intended shape (the assertion IS the "somebody decided this" record), but the
// failure is confusing on first contact: `--fix` prints "test suite FAILED after the bump" and
// the offending assertion lives in a file it never touched. Two further traps seen live on the
// 1.1.6 → 1.1.7 bump (2026-07-25): `--fix` ALSO folds a trailing `⚠ devin not found (ENOENT)`
// warning into that same "FAILED" line, and this suite is `scripts/lib/*.test.mjs` — running only
// `node --test scripts/*.test.mjs` reports a clean 159/0 and hides the real failure. Run both
// globs, exactly as .githooks/pre-commit does.
// Adopted from a consuming project (distribute-what-we-use S1). That copy asserted a literal pin ('1.2.8'),
// which fails the moment `cross-agent-doctor.mjs agy --fix` bumps the constant and then runs this very
// suite. The invariant worth guarding is that the constant and its machine-managed marker agree.
test('AGY_PINNED and its machine-managed marker name the same version', () => {
  const src = readFileSync(new URL('./cross-agent-cli.mjs', import.meta.url), 'utf8');
  const marker = /^\/\/ agy-doctor: last verified [0-9-]+ against (\S+)\.$/m.exec(src);
  assert.ok(marker, 'the marker line exists');
  assert.equal(marker[1], AGY_PINNED);
});

// A stub `spawn` returning a fixed result for every call; records each call.
function spawnStub(result) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  return { spawn, calls };
}

// A stub `spawn` returning a SEQUENCE of results (one per call) — for exercising the primary→fallback retry.
function spawnSeq(results) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return results[calls.length - 1];
  };
  return { spawn, calls };
}

const noWarn = () => {};

test('runAntigravity: stubbed agy → non-empty capture, with `-p <argv> --model <MODEL>` and stdin EOF', () => {
  const { spawn, calls } = spawnStub({
    status: 0,
    stdout: 'AGY REVIEW FINDINGS\n',
    stderr: '',
  });
  const out = runAntigravity('PROMPT+DIFF', {}, { spawn, warn: noWarn });
  assert.equal(out, 'AGY REVIEW FINDINGS'); // trimmed, non-empty
  assert.equal(calls.length, 1, 'a non-empty primary needs no fallback');
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'agy');
  // the 1.0.10 contract: prompt is the -p value, an explicit --model is passed (the fix for the empty output)
  assert.deepEqual(args.slice(0, 4), ['-p', 'PROMPT+DIFF', '--model', AGY_MODEL]);
  assert.equal(args[4], '--log-file', 'each call keeps its own log, so an empty answer can say why');
  assert.equal(opts.input, '', 'stdin must be given an immediate EOF (input:"") or print mode blocks');
});

test('runAntigravity: primary empty (quota) → AUTO-FALLS-BACK to AGY_FALLBACK_MODEL and returns its output', () => {
  const { spawn, calls } = spawnSeq([
    { status: 0, stdout: '   \n', stderr: '' }, // primary (Gemini) quota-exhausted → empty, exit 0
    { status: 0, stdout: 'FALLBACK FINDINGS\n', stderr: '' }, // GPT-OSS produces the review
  ]);
  let warned = '';
  const out = runAntigravity('PROMPT+DIFF', {}, { spawn, warn: (m) => (warned = m) });
  assert.equal(out, 'FALLBACK FINDINGS');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 4), ['-p', 'PROMPT+DIFF', '--model', AGY_MODEL]);
  assert.deepEqual(calls[1].args.slice(0, 4), ['-p', 'PROMPT+DIFF', '--model', AGY_FALLBACK_MODEL]);
  assert.match(warned, /did not answer \(.*empty output.*\) → used "/); // the substitution is announced, not silent
});

test('runAntigravity: BOTH primary and fallback empty → fail naming the quota cap', () => {
  const empty = { status: 0, stdout: '', stderr: '' };
  const { spawn, calls } = spawnSeq([empty, empty]);
  const out = runAntigravity('PROMPT+DIFF', { soft: true }, { spawn, warn: noWarn });
  assert.equal(out, null); // soft → null (non-soft die()s); the real message names RESOURCE_EXHAUSTED + both models
  assert.equal(calls.length, 2, 'tries primary then the fallback before giving up');
});

// ── runDevin — the third cross-family reviewer (prompt-file, no argv cap) ──────────────────────────────────
// Injected fs deps so no real devin binary or filesystem is touched.
function devinDeps(spawnResult, { failWrite = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return spawnResult;
  };
  const writes = [];
  const writeFile = (f, data) => {
    if (failWrite) throw new Error('disk full');
    writes.push({ f, data });
  };
  const removed = [];
  return {
    calls,
    writes,
    removed,
    deps: {
      spawn,
      writeFile,
      mkdtemp: (p) => `${p}XXXX`,
      rm: (d) => removed.push(d),
    },
  };
}

// Adopted from a consuming project, where `--agent devin` was a third review pool. Inverted by
// distribute-what-we-use S1's security lens: `devin -p` auto-approves read-only tools with no flag to turn
// them off, so an attacker's diff could steer it into reading host secrets into a posted comment.
test('AGENTS excludes devin — a reviewer that can read host files is refused', () => {
  assert.equal(AGENTS.devin, undefined);
  assert.equal(Object.keys(AGENTS).includes('devin'), false);
});

test('runDevin: stubbed devin → trimmed output via `-p --prompt-file <file>`, temp dir cleaned up', () => {
  const { calls, writes, removed, deps } = devinDeps({
    status: 0,
    stdout: 'DEVIN FINDINGS\n',
    stderr: '',
    error: null,
  });
  const out = runDevin('PROMPT+DIFF', {}, deps);
  assert.equal(out, 'DEVIN FINDINGS');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'devin');
  assert.equal(calls[0].args[0], '-p');
  assert.equal(calls[0].args[1], '--prompt-file');
  assert.equal(
    writes[0].data,
    'PROMPT+DIFF',
    'the whole prompt+diff is written to the file, not passed in argv'
  );
  assert.equal(removed.length, 1, 'the temp dir is always cleaned up');
});

test('runDevin: empty stdout (quota/auth) → soft fail (null), not a false clean review', () => {
  const { deps } = devinDeps({
    status: 0,
    stdout: '   \n',
    stderr: '',
    error: null,
  });
  assert.equal(runDevin('P', { soft: true }, deps), null);
});

test('runDevin: spawn error (binary missing) → soft fail naming the fix, temp dir still cleaned', () => {
  const { removed, deps } = devinDeps({
    status: null,
    stdout: '',
    stderr: '',
    error: new Error('ENOENT'),
  });
  assert.equal(runDevin('P', { soft: true }, deps), null);
  assert.equal(removed.length, 1, 'cleanup runs even on a spawn error');
});

test('runAntigravity: a non-zero agy exit surfaces the stderr tail and does NOT burn the fallback', () => {
  const { spawn, calls } = spawnStub({
    status: 1,
    stdout: '',
    stderr: 'boom: bad flag\n',
  });
  const out = runAntigravity('PROMPT+DIFF', { soft: true }, { spawn, warn: noWarn });
  assert.equal(out, null); // soft → null; a crash is not the quota signal, so no fallback retry
  assert.equal(
    calls.length,
    1,
    'a real agy error fails fast — the fallback is only for the empty/quota case'
  );
});

test('runAntigravity: oversized argv trips the size cap BEFORE spawning', () => {
  const { spawn, calls } = spawnStub({
    status: 0,
    stdout: 'should not run',
    stderr: '',
  });
  const huge = 'x'.repeat(AGY_ARG_LIMIT + 1);
  const out = runAntigravity(huge, { soft: true }, { spawn, warn: noWarn });
  assert.equal(out, null);
  assert.equal(calls.length, 0, 'must not spawn agy when the input exceeds the argv cap');
});

test('checkAgyVersion: matching version → silent (no fail)', () => {
  let failed = false;
  checkAgyVersion({
    spawn: () => ({ stdout: '1.0.10\n', stderr: '' }),
    fail: () => {
      failed = true;
    },
    pinned: '1.0.10',
  });
  assert.equal(failed, false);
});

test('checkAgyVersion: mismatched version → LOUD fail naming the bump (not a silent warn)', () => {
  assert.throws(
    () =>
      checkAgyVersion({
        spawn: () => ({ stdout: '1.0.11\n', stderr: '' }),
        fail: throwingFail,
        pinned: '1.0.10',
      }),
    (e) => {
      assert.match(e.message, /agy 1\.0\.11 != pinned 1\.0\.10/);
      assert.match(e.message, /bump AGY_PINNED/);
      return true;
    }
  );
});

test('checkAgyVersion: unparseable version output → LOUD fail (never a silent pass)', () => {
  assert.throws(
    () =>
      checkAgyVersion({
        spawn: () => ({ stdout: 'not a version', stderr: '' }),
        fail: throwingFail,
        pinned: '1.0.10',
      }),
    /could not determine agy version/
  );
});

test('stripGeneratedFileDiffs strips jev-eval.fixtures.json (machine-written Jev recordings)', () => {
  const hunk = `diff --git a/scripts/jev-eval.fixtures.json b/scripts/jev-eval.fixtures.json\nindex 1..2 100644\n--- a/scripts/jev-eval.fixtures.json\n+++ b/scripts/jev-eval.fixtures.json\n@@ -1 +1 @@\n-{}\n+{"review":[]}\n`;
  const { strippedFiles } = stripGeneratedFileDiffs(hunk);
  assert.deepEqual(strippedFiles, ['scripts/jev-eval.fixtures.json']);
});

// ── devinErrorLine — the reason, not the trailing brace (2026-10-03) ─────────────────────────────────
// Devin ends an error with a JSON detail block; the rail logged only stderr's last line, `}`, for ten days.
test('devinErrorLine keeps the Error: line, not the JSON tail', async () => {
  const { devinErrorLine } = await import('./cross-agent-cli.mjs');
  const stderr =
    'Error: Agent error: Your weekly usage quota has been exhausted. (trace ID: abc): {\n' +
    '  "cognition.ai/errorKind": "resource_exhausted"\n}';
  assert.equal(devinErrorLine(stderr), 'Error: Agent error: Your weekly usage quota has been exhausted. (trace ID: abc)');
  assert.equal(devinErrorLine('warming up\nsomething broke\n}'), 'something broke');
  assert.equal(devinErrorLine(''), 'unknown error');
});
