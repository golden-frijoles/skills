import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANCH_PREFIXES,
  citations,
  effectiveBareRefsRepo,
  evaluate,
  frontmatter,
  isRealClosedDate,
  intentAnswer,
  intentScore,
  ITEMS,
  fetchExternal,
  parseTreeUrl,
  refKey,
  verify,
} from './epic-dod.mjs';

const README_SHIPPED = '---\nstatus: shipped   # closed\nslug: demo\n---\n# Epic\n';
const README_OPEN = '---\nstatus: in-progress\nslug: demo\n---\n# Epic\n';
const SPRINT_DONE = {
  name: 'sprint-1.md',
  text: '# S1\n\n**Status:** ✅ shipped — o/r#12 merged\n',
};
const SPRINT_OPEN = {
  name: 'sprint-2.md',
  text: '# S2\n\n**Status:** ⬜ not started\n',
};
const RETRO_REAL = '# Retro\n\n_Closed: 2026-09-17_\n';
const RETRO_STUB = '# Retro\n\n_Closed: <date>_\n';
const merged = (...refs) => new Map(refs.map((r) => [r, 'merged']));

const closedEpic = {
  slug: 'demo',
  readme: README_SHIPPED,
  sprints: [SPRINT_DONE],
  retro: RETRO_REAL,
  verified: merged('pr:o/r#12'),
  branches: ['main', 'feat/other'],
};

test('a known-CLOSED epic passes every derivable item', () => {
  const r = evaluate(closedEpic);
  assert.equal(r.ok, true, JSON.stringify(r.items));
  for (const k of ITEMS) assert.equal(r.items[k].state, 'pass', k);
});

test('a known-OPEN epic reports exactly what is outstanding — it never claims done', () => {
  const r = evaluate({
    slug: 'demo',
    readme: README_OPEN,
    sprints: [SPRINT_DONE, SPRINT_OPEN],
    retro: RETRO_STUB,
    verified: merged('pr:o/r#12'),
    branches: ['main', 'feat/demo-s2'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.items['readme-shipped'].state, 'fail');
  assert.match(r.items['sprints-ticked'].detail, /sprint-2\.md/);
  assert.match(r.items['sprints-merged'].detail, /sprint-2\.md cites no PR/);
  assert.match(r.items['retro-written'].detail, /stub/);
  assert.match(r.items['branch-deleted'].detail, /feat\/demo-s2/);
});

test('UNAVAILABLE is not pass — an unverifiable citation or an unreadable remote fails the run', () => {
  const r = evaluate({ ...closedEpic, verified: new Map(), branches: null });
  assert.equal(r.ok, false);
  assert.equal(r.items['sprints-merged'].state, 'unavailable');
  assert.equal(r.items['branch-deleted'].state, 'unavailable');
});

test('a sprint citing an UNMERGED PR fails even when another citation is merged', () => {
  const sprint = {
    name: 'sprint-1.md',
    text: '**Status:** ✅ done — o/r#12 and o/r#13\n',
  };
  const verified = new Map([
    ['pr:o/r#12', 'merged'],
    ['pr:o/r#13', 'unmerged'],
  ]);
  const r = evaluate({ ...closedEpic, sprints: [sprint], verified });
  assert.equal(r.items['sprints-merged'].state, 'fail');
  assert.match(r.items['sprints-merged'].detail, /UNMERGED/);
});

test('a merged citation does not vouch for an UNVERIFIABLE one alongside it', () => {
  // Found by codex on #17: `states.includes('merged')` passed a sprint whose other citation was a commit
  // this checkout has never seen — "I could not check" silently read as "checked".
  const sprint = {
    name: 'sprint-1.md',
    text: '**Status:** ✅ done — o/r#12 and deadbeef1\n',
  };
  const verified = new Map([['pr:o/r#12', 'merged']]);
  const r = evaluate({ ...closedEpic, sprints: [sprint], verified });
  assert.equal(r.items['sprints-merged'].state, 'unavailable');
  assert.match(r.items['sprints-merged'].detail, /1 of 2 citation\(s\) could be verified by nobody/);
  assert.equal(r.ok, false);
});

test('sprint docs in ANOTHER repo are READ and checked by the same rules — existence is not a pass', () => {
  const readme =
    '---\nstatus: shipped\nslug: demo\nsprints_in: https://github.com/o/foundation/tree/main/Roadmap/x\n---\n';
  const docs = {
    sprints: [{ name: 'sprint-1.md', text: '**Status:** ✅ done — o/r#12\n' }],
    retro: '_Closed: 2026-09-16_\n',
  };
  const verified = new Map([['pr:o/r#12', 'merged']]);
  const ok = evaluate({
    ...closedEpic,
    readme,
    sprints: [],
    retro: null,
    verified,
    externalDocs: docs,
  });
  assert.equal(ok.items['sprints-ticked'].state, 'pass');
  assert.equal(ok.items['sprints-merged'].state, 'pass');
  assert.equal(ok.items['retro-written'].state, 'pass');
  assert.match(ok.items['sprints-ticked'].detail, /read from https:/);
  assert.equal(ok.ok, true);

  // The hole codex found on #17: a directory that exists but holds no sprint docs used to pass.
  const empty = evaluate({
    ...closedEpic,
    readme,
    sprints: [],
    retro: null,
    externalDocs: { sprints: [], retro: null },
  });
  assert.equal(empty.items['sprints-ticked'].state, 'fail');
  assert.equal(empty.items['retro-written'].state, 'fail');
  assert.equal(empty.ok, false);

  // The docs are there but unticked / the retro is a stub: the same rules, so the same verdict.
  const unticked = evaluate({
    ...closedEpic,
    readme,
    sprints: [],
    retro: null,
    verified,
    externalDocs: {
      sprints: [{ name: 'sprint-1.md', text: '**Status:** ⬜ — o/r#12\n' }],
      retro: null,
    },
  });
  assert.equal(unticked.items['sprints-ticked'].state, 'fail');

  // A typo'd sprints_in (404) fails; an unreadable one is UNAVAILABLE, never green.
  const missing = evaluate({
    ...closedEpic,
    readme,
    sprints: [],
    retro: null,
    externalDocs: false,
  });
  assert.equal(missing.items['sprints-ticked'].state, 'fail');
  assert.equal(missing.ok, false);
  const unknown = evaluate({
    ...closedEpic,
    readme,
    sprints: [],
    retro: null,
    externalDocs: null,
  });
  assert.equal(unknown.items['sprints-merged'].state, 'unavailable');
  assert.equal(unknown.items['retro-written'].state, 'unavailable');
  assert.equal(unknown.ok, false);
  assert.deepEqual(parseTreeUrl('https://github.com/o/r/tree/main/Roadmap/09-x/slug'), {
    repo: 'o/r',
    ref: 'main',
    path: 'Roadmap/09-x/slug',
  });
  assert.equal(parseTreeUrl('see the other repo'), null);
});

test('an exemption excuses a failure with its reason; an exemption on a PASSING item is stale and fails', () => {
  const exempt = [
    {
      epic: 'demo',
      item: 'branch-deleted',
      reason: 'closed before the convention',
    },
  ];
  const excused = evaluate({
    ...closedEpic,
    branches: ['feat/demo'],
    exemptions: exempt,
  });
  assert.equal(excused.items['branch-deleted'].state, 'exempt');
  assert.equal(excused.ok, true);
  const stale = evaluate({ ...closedEpic, exemptions: exempt });
  assert.equal(stale.items['branch-deleted'].state, 'fail');
  assert.match(stale.items['branch-deleted'].detail, /STALE exemption/);
  assert.equal(stale.ok, false);
});

test('an exemption never turns UNAVAILABLE into a pass', () => {
  const exempt = [
    {
      epic: 'demo',
      item: 'branch-deleted',
      reason: 'closed before the convention',
    },
  ];
  const r = evaluate({ ...closedEpic, branches: null, exemptions: exempt });
  assert.equal(r.items['branch-deleted'].state, 'unavailable');
  assert.equal(r.ok, false);
});

test('an explicit owner/repo#N is not ALSO read as a local #N', () => {
  const keys = citations('merged as o/r#12 only').map(refKey);
  assert.deepEqual(keys, ['pr:o/r#12']);
});

test('citations: PR links, owner/repo#N, known repo names and commits — never a guessed bare #N', () => {
  const aliases = {
    backend: 'o/backend',
    'product-repo': 'o/product-management',
  };
  const text =
    'merged (product-repo #106, backend PR [#33]), https://github.com/o/front/pull/100, commit b13ae84, run 29305671818, o/r#9, AGENTS rule #3';
  const keys = citations(text, { aliases }).map(refKey);
  assert.ok(keys.includes('pr:o/product-management#106'));
  assert.ok(keys.includes('pr:o/backend#33'));
  assert.ok(keys.includes('pr:o/front#100'));
  assert.ok(keys.includes('pr:o/r#9'));
  assert.ok(keys.includes('commit:b13ae84'));
  assert.ok(!keys.some((k) => k.includes('29305671818')), 'a CI run id is not a citation');
  assert.ok(!keys.some((k) => k.endsWith('#3')), 'an unaliased bare #3 is ambiguous and must not be guessed');
  // With a declared single repo, a bare #N is that repo.
  assert.ok(citations('see #45', { bareRefsRepo: 'o/solo' }).map(refKey).includes('pr:o/solo#45'));
});

test('a sprint with only bare #N refs and no bareRefsRepo is UNAVAILABLE, not a fail and not a pass', () => {
  const sprint = {
    name: 'sprint-1.md',
    text: '**Status:** ✅ shipped — #12\n',
  };
  const r = evaluate({ ...closedEpic, sprints: [sprint], verified: new Map() });
  assert.equal(r.items['sprints-merged'].state, 'unavailable');
});

test('real status markers and close lines seen on shipped epics are accepted', () => {
  const green = {
    name: 'sprint-1.md',
    text: '**Status:** 🟩 shipped — o/r#12\n',
  };
  assert.equal(evaluate({ ...closedEpic, sprints: [green] }).items['sprints-ticked'].state, 'pass');
  const longClose = '# Retro\n\n_Closed: 2026-08-12 · S1–S5 shipped, verified live_\n';
  assert.equal(evaluate({ ...closedEpic, retro: longClose }).items['retro-written'].state, 'pass');
});

test('frontmatter strips inline comments and quotes', () => {
  assert.deepEqual(frontmatter('---\nstatus: shipped   # note\nslug: "x"\n---\n'), {
    status: 'shipped',
    slug: 'x',
  });
});

test('bareRefsRepo is honoured ONLY in a single-repo project — a sibling alias makes #N ambiguous again', () => {
  // Found by codex on #17: resolving a bare `#143` against this repo when the epic also cites a sibling
  // repo's #143 certifies the WRONG PR — a false green, not a miss.
  assert.deepEqual(effectiveBareRefsRepo({ bareRefsRepo: 'o/r', aliases: { r: 'o/r' } }), {
    repo: 'o/r',
    note: 'bare #N means o/r',
  });
  const multi = effectiveBareRefsRepo({ bareRefsRepo: 'o/r', aliases: { r: 'o/r', sib: 'o/sibling' } });
  assert.equal(multi.repo, null);
  assert.match(multi.note, /IGNORED.*o\/sibling/);
  assert.equal(effectiveBareRefsRepo({}).repo, null);
});

test('an epic with BOTH sprints_in and local sprint files fails — one epic, one source', () => {
  const readme =
    '---\nstatus: shipped\nslug: demo\nsprints_in: https://github.com/o/f/tree/main/Roadmap/x\n---\n';
  const r = evaluate({
    ...closedEpic,
    readme,
    externalDocs: { sprints: [{ name: 'sprint-1.md', text: '**Status:** ✅ o/r#1\n' }], retro: null },
  });
  assert.equal(r.items['sprints-ticked'].state, 'fail');
  assert.match(r.items['sprints-merged'].detail, /one epic, one source/);
  assert.equal(r.ok, false);
});

test('a retrospective date must EXIST, not merely match the shape', () => {
  assert.equal(isRealClosedDate('_Closed: 2026-09-16_'), true);
  assert.equal(isRealClosedDate('_Closed: 2026-99-99_'), false);
  assert.equal(isRealClosedDate('_Closed: 2026-02-30_'), false);
  assert.equal(isRealClosedDate('_Closed: <date>_'), false);
  const r = evaluate({ ...closedEpic, retro: '_Closed: 2026-13-01_\n' });
  assert.equal(r.items['retro-written'].state, 'fail');
});

test('a leftover branch under ANY named prefix keeps the epic open, not just feat/', () => {
  // Found by codex on #179: the process names feat/, fix/ and chore/, the check only looked at feat/.
  assert.deepEqual(BRANCH_PREFIXES, ['feat/', 'fix/', 'chore/']);
  for (const p of BRANCH_PREFIXES) {
    const r = evaluate({ ...closedEpic, branches: ['main', `${p}demo`] });
    assert.equal(r.items['branch-deleted'].state, 'fail', p);
  }
  const clean = evaluate({ ...closedEpic, branches: ['main', 'feat/other-epic'] });
  assert.equal(clean.items['branch-deleted'].state, 'pass');
});

test('verify(): a git ERROR is unavailable, a genuine non-ancestor is unmerged', () => {
  // Measured exit codes: `merge-base --is-ancestor` exits 1 for "not an ancestor" (a fact) and 128 when
  // origin/main is missing or unfetched (unknown). Collapsing 128 into `unmerged` is a false FAIL.
  const run = (cmd, args) => {
    if (args[0] === 'cat-file') return { status: 0 };
    if (args[0] === 'merge-base') return { status: args[2] === 'deadbeef1' ? 1 : 128 };
    return { status: 0, stdout: '' };
  };
  const out = verify(
    [
      { kind: 'commit', sha: 'deadbeef1' },
      { kind: 'commit', sha: 'cafebabe2' },
    ],
    { run }
  );
  assert.equal(out.get('commit:deadbeef1'), 'unmerged');
  assert.equal(out.get('commit:cafebabe2'), 'unavailable');
  // A commit this checkout has never heard of is unavailable, never "unmerged".
  const unknown = verify([{ kind: 'commit', sha: 'deadbeef1' }], { run: () => ({ status: 128 }) });
  assert.equal(unknown.get('commit:deadbeef1'), 'unavailable');
});

test('verify(): a PR read failure is unavailable; merged_at decides the rest', () => {
  const answers = {
    1: { status: 0, stdout: '2026-09-16T00:00:00Z\tclosed\n' },
    2: { status: 0, stdout: 'null\topen\n' },
    3: { status: 1, stderr: 'gh: Not Found' },
  };
  const run = (cmd, args) => answers[Number(args[1].split('/').pop())];
  const out = verify(
    [1, 2, 3].map((n) => ({ kind: 'pr', repo: 'o/r', number: n })),
    { run }
  );
  assert.equal(out.get('pr:o/r#1'), 'merged');
  assert.equal(out.get('pr:o/r#2'), 'unmerged');
  assert.equal(out.get('pr:o/r#3'), 'unavailable');
});

test('fetchExternal(): 404 is false, an unreadable file is unavailable, a good listing is read', () => {
  // The I/O half decides here, so it is tested here — a pure core is only as true as its inputs.
  const url = 'https://github.com/o/f/tree/main/Roadmap/09-x/demo';
  const listing = 'README.md\nsprint-1.md\nsprint-2.md\nRETROSPECTIVE.md\n';
  const ok = fetchExternal(url, {
    run: (cmd, args) => {
      const path = args[1];
      if (args.includes('.[] | .name')) return { status: 0, stdout: listing };
      return { status: 0, stdout: `body of ${path.split('/').pop().split('?')[0]}` };
    },
  });
  assert.deepEqual(
    ok.sprints.map((s) => s.name),
    ['sprint-1.md', 'sprint-2.md']
  );
  assert.match(ok.retro, /RETROSPECTIVE.md/);

  assert.equal(fetchExternal(url, { run: () => ({ status: 1, stderr: 'gh: Not Found (HTTP 404)' }) }), false);
  assert.equal(fetchExternal(url, { run: () => ({ status: 1, stderr: 'could not connect' }) }), null);
  // A file that lists but will not fetch makes the WHOLE read unavailable — a partial read would check
  // fewer sprints than the epic has and still look complete.
  const partial = fetchExternal(url, {
    run: (cmd, args) =>
      args.includes('.[] | .name')
        ? { status: 0, stdout: listing }
        : args[1].includes('sprint-2.md')
          ? { status: 1, stderr: 'boom' }
          : { status: 0, stdout: 'x' },
  });
  assert.equal(partial, null);
  assert.equal(fetchExternal('not a tree url'), null);
});

test('duplicate exemptions for one item FAIL instead of cancelling the staleness check out', () => {
  // Found by codex on #17: the first duplicate marked a passing item stale, the second excused that very
  // failure, and `ok` came back true — two wrongs making a green.
  const exemptions = [
    { epic: 'demo', item: 'branch-deleted', reason: 'a' },
    { epic: 'demo', item: 'branch-deleted', reason: 'b' },
  ];
  const r = evaluate({ ...closedEpic, exemptions });
  assert.equal(r.items['branch-deleted'].state, 'fail');
  assert.match(r.items['branch-deleted'].detail, /duplicate exemption/);
  assert.equal(r.ok, false);
});

test('a failed git fetch makes commit ancestry UNAVAILABLE, never merged or unmerged', () => {
  // Warning about a stale origin/main was not enough: a rewritten remote can make an abandoned commit
  // look merged, so the answer is "unknown" (found by codex on #17 and #179).
  const out = verify([{ kind: 'commit', sha: 'deadbeef1' }], {
    staleRemote: true,
    run: () => {
      throw new Error('git must not be consulted when the remote is stale');
    },
  });
  assert.equal(out.get('commit:deadbeef1'), 'unavailable');
});

// ── intent-answered (intent-match S3.1, D17): a SCORED epic must say whether we built what was meant ─────────

const SCORED_README = '---\nstatus: shipped\nslug: demo\nintent_match: 84   # advisory\n---\n# Epic\n';
const SCORED_SEED = '---\nslug: demo\nintent_match: 89\n---\n# Seed\n';

test('intent-answered: an unscored epic passes — older epics are never failed retroactively', () => {
  const r = evaluate(closedEpic);
  assert.equal(r.items['intent-answered'].state, 'pass');
  assert.match(r.items['intent-answered'].detail, /not scored/);
  const nullScore = evaluate({
    ...closedEpic,
    readme: README_SHIPPED.replace('slug: demo', 'slug: demo\nintent_match: null'),
    seed: '---\nintent_match: null\n---\n',
  });
  assert.equal(nullScore.items['intent-answered'].state, 'pass');
});

test('intent-answered: a scored epic without the _Intent:_ line fails and names the missing line', () => {
  for (const scored of [{ readme: SCORED_README }, { seed: SCORED_SEED }]) {
    const r = evaluate({ ...closedEpic, ...scored });
    assert.equal(r.ok, false);
    assert.equal(r.items['intent-answered'].state, 'fail');
    assert.match(r.items['intent-answered'].detail, /_Intent: yes \| mostly \| no_/);
  }
});

test('intent-answered: the template placeholder is not an answer; yes, mostly and no are', () => {
  const placeholder = evaluate({
    ...closedEpic,
    readme: SCORED_README,
    retro: `${RETRO_REAL}_Intent: yes | mostly | no_\n`,
  });
  assert.equal(placeholder.items['intent-answered'].state, 'fail');
  for (const a of ['yes', 'mostly', 'no', 'Mostly']) {
    const r = evaluate({ ...closedEpic, readme: SCORED_README, retro: `${RETRO_REAL}_Intent: ${a}_\n` });
    assert.equal(r.items['intent-answered'].state, 'pass', a);
    assert.match(r.items['intent-answered'].detail, new RegExp(a.toLowerCase()));
    assert.equal(r.ok, true);
  }
});

test('intent-answered: a scored epic with no retrospective fails, and unreadable external docs are unavailable', () => {
  assert.equal(
    evaluate({ ...closedEpic, readme: SCORED_README, retro: null }).items['intent-answered'].state,
    'fail'
  );
  const external = evaluate({
    ...closedEpic,
    readme: SCORED_README.replace(
      'slug: demo',
      'slug: demo\nsprints_in: https://github.com/o/r/tree/main/Roadmap/x/demo'
    ),
    sprints: [],
    retro: null,
    externalDocs: null,
  });
  assert.equal(external.items['intent-answered'].state, 'unavailable');
});

test('ITEMS: intent-answered is the sixth derived item', () => {
  assert.deepEqual(ITEMS, [
    'readme-shipped',
    'sprints-ticked',
    'sprints-merged',
    'retro-written',
    'branch-deleted',
    'intent-answered',
  ]);
});

test('intent-answered: the REAL groom retro template, as scaffolded, is unanswered (fresh review of #198)', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const rel = ['plugins', 'golden-frijoles', 'skills', 'groom', 'templates', 'RETROSPECTIVE.md'];
  // From scripts/, skills/scripts/ or skills/template/scripts/; a consumer's copy has none of them.
  const tpl = [
    join(here, '..', 'skills', ...rel),
    join(here, '..', ...rel),
    join(here, '..', '..', ...rel),
  ].find((p) => existsSync(p));
  if (!tpl) return t.skip('groom template not in this checkout');
  const text = readFileSync(tpl, 'utf8').replace('<date>', '2026-09-30');
  assert.equal(intentAnswer(text), null, 'the template, guidance comment included, is not an answer');
  const r = evaluate({ ...closedEpic, readme: SCORED_README, retro: text });
  assert.equal(r.items['intent-answered'].state, 'fail');
  const answered = text.replace(/^_Intent: yes \| mostly \| no_$/m, '_Intent: no_');
  assert.equal(intentAnswer(answered), 'no');
});

test('intent-answered: an answer inside a comment, or mid-sentence, is not an answer; a score over 100 is not a score', () => {
  assert.equal(intentAnswer('<!-- e.g. `_Intent: mostly_` -->'), null);
  assert.equal(intentAnswer('Write it like `_Intent: yes_` below.'), null);
  assert.equal(intentAnswer('_Closed: 2026-09-30_\n_Intent: Yes_ \n'), 'yes');
  assert.equal(intentScore({ intent_match: '150' }), null);
  assert.equal(intentScore({ intent_match: '100' }), 100);
});
