// check-gate-words.test.mjs — the guard fired against fixtures, and against the real tree (gates-in-plain-agile S2.2).
//
// A guard observed only as "CI was green" cannot be told from a broken one (check-plugin-leaks' lesson), so each rule
// is fired on purpose here: a gate block carrying "approve (fund + scaffold)" must fail, the same gate with the word
// only inside inline code must pass, and gates.md losing a table or a gate must fail rather than check nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATES_REF, checkGateWords, gateBlocks, parseGatesRef, run, screenText } from './check-gate-words.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_REF = readFileSync(join(ROOT, GATES_REF), 'utf8');

const REF = `# gates

| On screen | Behind it (files keep these) | Never on screen |
|---|---|---|
| Approve the plan | \`fund.mjs\` | fund, funded, cycle |
| Park it | the seed stays \`status: ready\` | — |
| Approve the strategy | \`status: agreed\` | agreed, epic mode |

| Was | Now |
|---|---|
| approve (fund + scaffold) | Approve the plan |
| approve, don't fund | Park it |

\`\`\`gate strategy
  1 Approve the strategy
\`\`\`

\`\`\`gate plan
  1 Approve the plan
  2 Park it
\`\`\`

\`\`\`gate build
  /build <slug>
\`\`\`
`;

const ref = { path: 'gates.md', text: REF };
const check = (files, refText = REF) => checkGateWords({ files: [ref, ...files], refText, refPath: 'gates.md' }).findings;

test('the lists come from gates.md, never from code', () => {
  const { words, retired } = parseGatesRef(REF);
  assert.deepEqual(words, ['fund', 'funded', 'cycle', 'agreed', 'epic mode']);
  assert.deepEqual(retired, ['approve (fund + scaffold)', "approve, don't fund"]);
  // The real reference carries the nine words the epic names.
  const real = parseGatesRef(REAL_REF).words;
  for (const w of ['fund', 'scaffold', 'underwritten', 'displaced', 'cycle', 'kickoff', 'epic mode', 'agreed', 'draft'])
    assert.ok(real.includes(w), `gates.md's "Never on screen" column lacks "${w}"`);
});

test('the reference itself is clean', () => {
  assert.deepEqual(check([]), []);
});

test('FAILS: "approve (fund + scaffold)" put back into a gate', () => {
  const skill = {
    path: 'skill.md',
    text: 'Show this:\n\n```gate plan\n  1 Approve the plan\n  → approve (fund + scaffold)\n```\n',
  };
  const findings = check([skill]);
  assert.ok(findings.some((f) => f.startsWith('skill.md:5: gate plan shows "fund"')), findings.join('\n'));
  assert.ok(findings.some((f) => f.includes('retired option "approve (fund + scaffold)"')), findings.join('\n'));
  assert.ok(findings.some((f) => f.includes('gate plan differs from the one in gates.md')), findings.join('\n'));
});

test('FAILS: a retired option named in prose, outside any gate', () => {
  const doc = { path: 'WAYS.md', text: 'while "Approve, don\'t fund" leaves it ready\n' };
  assert.deepEqual(check([doc]), [`WAYS.md:1: names the retired option "approve, don't fund" (gates.md: Was | Now)`]);
});

test('FAILS: a retired option in any other table of gates.md — only the Was | Now table is exempt', () => {
  const extra = REF + '\n| Option | Note |\n|---|---|\n| approve, don\'t fund | old |\n';
  const findings = checkGateWords({ files: [{ path: 'gates.md', text: extra }], refText: extra, refPath: 'gates.md' }).findings;
  assert.deepEqual(findings, [`gates.md:${extra.split('\n').length - 1}: names the retired option "approve, don't fund" (gates.md: Was | Now)`]);
});

test('PASSES: file values, keys and paths in inline code, and placeholders, are not words on screen', () => {
  const block = '```gate strategy\n  1 Approve the strategy\n```\n';
  const fine = { path: 'coach.md', text: `${block}\nIt sets \`status: agreed\` in \`Roadmap/bets/wave-2026-10.md\`.\n` };
  assert.deepEqual(check([fine]), []);
  assert.equal(screenText('Flag ... `x.funded_enabled` <the cycle name>').includes('fund'), false);
  // Prose outside gate blocks may explain the records: only a gate's own lines are checked for words.
  assert.deepEqual(check([{ path: 'wow.md', text: 'Approve writes a cycle row and marks it funded.\n' }]), []);
});

test('words match whole words only, multi-word phrases across any space', () => {
  const blocks = (body) => [{ path: 'x.md', text: '```gate other\n' + body + '\n```\n' }];
  assert.deepEqual(check(blocks('the fundamentals of a bicycle')), []);
  assert.equal(check(blocks('run it in epic  mode')).length, 1);
  assert.equal(check(blocks('Funded!')).length, 1);
});

test('FAILS: gates.md without its tables or a gate cannot pass by reading nothing', () => {
  assert.throws(() => parseGatesRef('no tables'), /Never on screen/);
  assert.throws(() => parseGatesRef(REF.replace('| Was | Now |', '| Old | New |')), /Was \| Now/);
  const noBuild = REF.replace(/```gate build[\s\S]*?```\n/, '');
  assert.deepEqual(check([], noBuild).filter((f) => f.includes('missing')), [
    'gates.md: the `gate build` block is missing, so nothing would be checked for it',
  ]);
});

test('an unclosed gate block is a finding', () => {
  assert.equal(gateBlocks('```gate plan\nno end').at(0).body, null);
  assert.ok(check([{ path: 'x.md', text: '```gate plan\nno end' }]).some((f) => f.includes('never closed')));
});

test('the real tree is clean, and --also adds a file outside it', () => {
  const out = [];
  const err = [];
  assert.equal(run([], { log: (l) => out.push(l), error: (l) => err.push(l) }), 0, err.join('\n'));
  assert.match(out.join('\n'), /clean \(\d+ files, 3 gate blocks\)/);

  const dir = mkdtempSync(join(tmpdir(), 'gate-words-'));
  mkdirSync(join(dir, 'Roadmap'));
  writeFileSync(join(dir, 'Roadmap', 'SESSION-KICKOFFS.md'), '*Add when it should wait:* "approve, don\'t fund"\n');
  const err2 = [];
  assert.equal(run(['--also', 'Roadmap/SESSION-KICKOFFS.md'], { cwd: dir, log: () => {}, error: (l) => err2.push(l) }), 1);
  assert.match(err2.join('\n'), /Roadmap\/SESSION-KICKOFFS\.md:1: names the retired option/);
  assert.equal(run(['--also', 'nope.md'], { cwd: dir, log: () => {}, error: () => {} }), 2);
});
