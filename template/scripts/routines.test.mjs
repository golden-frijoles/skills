// routines.test.mjs — house-format guard for the Claude-Routines prompts under scripts/routines/.
// Each `*.prompt.md` must parse via loadPromptBody() (HTML-comment header + `---` body) into a
// non-empty prompt — the same contract scripts/cross-review.mjs / cross-panel.mjs rely on. Free
// coverage: caught by scripts-guard.yml's `node --test 'scripts/*.test.mjs'`, no glob change needed.
// Fill/refusal and runtime-token behaviour belongs to routine-bootstrap.test.mjs: it exercises the same prompt
// loader seam without duplicating a second placeholder table here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadPromptBody } from './lib/cross-agent-cli.mjs';

const ROUTINES = join(dirname(fileURLToPath(import.meta.url)), 'routines');

// DERIVED, not hand-listed. This was a literal array of six names until 2026-08-05, which meant a
// seventh prompt could land unguarded and the suite would still pass — a guard that hand-picks its
// own population decays silently while staying green (LEARNINGS: "guard the population, not the
// door you found"). Reading the directory makes the guard's roots the same set the repo actually
// has, so adding a prompt cannot skip it.
const PROMPTS = readdirSync(ROUTINES)
  .filter((f) => f.endsWith('.prompt.md'))
  .map((f) => f.replace(/\.prompt\.md$/, ''))
  .sort();

test('the derived prompt population is non-empty and includes every committed routine', () => {
  // The negation of the bug above: if the glob ever silently matched nothing, every per-prompt test
  // below would vacuously pass and the whole file would be green having checked nothing (AGENTS.md
  // rule 5). Assert the population itself.
  assert.ok(PROMPTS.length >= 7, `expected at least 7 routine prompts, found ${PROMPTS.length}`);
  for (const expected of ['pr-review', 'roadmap-hygiene', 'smoke-triage', 'ops-nightly', 'weekly-recap', 'pmo-report', 'prod-smoke']) {
    assert.ok(PROMPTS.includes(expected), `${expected}.prompt.md is missing from scripts/routines/`);
  }
});

for (const name of PROMPTS) {
  test(`${name}.prompt.md parses to a non-empty body in the house format`, () => {
    const body = loadPromptBody(join(ROUTINES, `${name}.prompt.md`));
    assert.ok(body.length > 0, `${name} body is empty`);
    // The HTML-comment header must be stripped — the body is what the routine runs.
    assert.ok(!body.includes('<!--'), `${name} body still contains the HTML-comment header`);
  });
}

// Every prompt must DECLARE its authority in one of exactly two ways. Until 2026-08-17 there was
// only one — "advisory only" — and that was the whole policy. The product owner then granted Routine B bounded
// merge authority, which this guard correctly caught as a missing banner rather than letting the
// policy change slip in unannounced.
//
// The fix is not to exempt B. It is to make the exception itself the thing under guard: B must say
// what bounds it, the bound must be the script and not prose, and NO SECOND routine may quietly join
// it. `AUTHORITY_BOUNDED` is a closed set asserted below — adding a name to it is a visible diff in a
// file whose tests run on every commit, which is exactly the review the change deserves.
const ADVISORY_BANNER = 'advisory only';
const BOUNDED_BANNER = 'merge authority is bounded by `scripts/smoke-triage-scope.mjs`';
const AUTHORITY_BOUNDED = new Set(['smoke-triage']);

test('exactly one routine holds merge authority, and it is smoke-triage', () => {
  // The population, not the door: derived from the prompts themselves, so a prompt that grew the
  // banner without being added to the set fails here rather than passing unnoticed.
  const declaring = PROMPTS.filter((name) =>
    loadPromptBody(join(ROUTINES, `${name}.prompt.md`)).toLowerCase().includes(BOUNDED_BANNER));
  assert.deepEqual(declaring, [...AUTHORITY_BOUNDED],
    'the set of routines claiming merge authority changed — this is a governance change, not a typo');
});

test('every prompt declares its authority, and only the bounded one omits advisory-only', () => {
  for (const name of PROMPTS) {
    const body = loadPromptBody(join(ROUTINES, `${name}.prompt.md`)).toLowerCase();
    if (AUTHORITY_BOUNDED.has(name)) {
      assert.ok(body.includes(BOUNDED_BANNER), `${name} holds merge authority but does not name its bound`);
    } else {
      assert.ok(body.includes(ADVISORY_BANNER), `${name} is missing the advisory-only banner`);
    }
  }
});

test('the routine that merges also carries the rules that make merging safe', () => {
  // A merge authority stated without its constraints is a merge authority without constraints. Each
  // of these is load-bearing: the never-weaken rule (the cheapest way to fake a green nightly), the
  // app-code boundary (the product owner's actual limit), and the verify-on-main step (a branch run tests
  // production's OLD code — three green branch runs once missed a live regression).
  // Whitespace-normalized: these phrases are prose and wrap across lines at the 100-col margin, so
  // matching the raw text would fail on a reflow that changed nothing.
  const body = loadPromptBody(join(ROUTINES, 'smoke-triage.prompt.md')).toLowerCase().replace(/\s+/g, ' ');
  for (const [needle, why] of [
    ['never make a red run green by testing less', 'the never-weaken rule'],
    ['never merge a change to application code', 'the app-code boundary'],
    ['undecidable', 'the third state — a partly-unread diff must not resolve to allow or block'],
    ['on `main` after the deploy', 'the verify-on-main step'],
    ['revert', 'the revert path when main goes red'],
  ]) {
    assert.ok(body.includes(needle), `smoke-triage.prompt.md no longer states ${why} ("${needle}")`);
  }
});
