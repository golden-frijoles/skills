// jev-egress-callers.test.mjs — "nothing is sent before egress: true", asserted where text actually leaves.
//
// The D7 specs in jev.test.mjs spy on fetch in jevContext, which never fetches — so they could not fail
// (#190 review: a mutated caller gate that SENT with egress:null stayed green). These run the two real
// callers, judgeReviewOutput and judgeProse, with a spied fetch and no injected `ask`, and include the
// positive control (egress:true + key → a fetch happens), so a spy that can never fire is caught too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJevConfig } from './jev.mjs';
import { judgeReviewOutput } from './review-guard.mjs';
import { judgeProse } from './prose-guard.mjs';

const REVIEW = '### Blocking\n\n- `app/api/x/route.ts:12` trusts the body.\n\n### Should-fix\n\n- None.\n';
const PROSE =
  'The export shipped to every customer on Monday and is live in production. Uptime was 100% all week.';

function spiedDeps(egress) {
  let fetches = 0;
  const config = parseJevConfig({
    egress,
    rails: {
      review: { mode: 'jev' },
      prose: { mode: 'jev' },
    },
  });
  return {
    get fetches() {
      return fetches;
    },
    deps: {
      config,
      key: 'k',
      root: mkdtempSync(join(tmpdir(), 'jev-callers-')),
      write: () => {},
      log: () => {},
      needSetting: () => undefined,
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ error: 'spy' }), { status: 500 });
      },
    },
  };
}

for (const egress of [null, false]) {
  test(`egress ${egress}: judgeReviewOutput sends NOTHING, even with the rail at jev and a key`, async () => {
    const s = spiedDeps(egress);
    await judgeReviewOutput(REVIEW, {}, s.deps);
    assert.equal(s.fetches, 0);
  });

  test(`egress ${egress}: judgeProse sends NOTHING, even with the rail at jev and a key`, async () => {
    const s = spiedDeps(egress);
    await judgeProse(PROSE, {}, s.deps);
    assert.equal(s.fetches, 0);
  });
}

test('positive control — egress true + key: both callers DO reach fetch, so the spy can fire', async () => {
  const r = spiedDeps(true);
  await judgeReviewOutput(REVIEW, {}, r.deps);
  assert.ok(r.fetches >= 1, 'review judge reached the network');
  const p = spiedDeps(true);
  await judgeProse(PROSE, {}, p.deps);
  assert.ok(p.fetches >= 1, 'prose judge reached the network');
});
