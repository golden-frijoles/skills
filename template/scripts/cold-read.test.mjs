// cold-read.test.mjs — the seal and the compare (coaches-v2 D2–D4). Zero deps — node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSealLine, renderCompare, sealLine, sha256, stampRead, verifySeal } from './cold-read.mjs';
import { PROPOSED_LINE, proposedSections } from './lib/strategy-files.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'cold-read.mjs');
const READ = '---\nkind: cold-read\nfamily: codex\ndate: 2026-10-08\n---\n\n## Header\n\nA read.\n';

test('a seal line is shasum format and parses back', () => {
  const line = sealLine(sha256(READ), '/x/2026-10-08-cold-read.md');
  assert.equal(line, `${sha256(READ)}  2026-10-08-cold-read.md\n`);
  assert.equal(parseSealLine(line), sha256(READ));
  assert.equal(parseSealLine('not a seal'), null);
});

test('verifySeal: holds, refuses a changed file by name of both hashes, refuses an unsealed one', () => {
  const seal = sealLine(sha256(READ), 'r.md');
  assert.deepEqual(verifySeal({ text: READ, seal }), { ok: true, sealed: sha256(READ) });
  const changed = verifySeal({ text: READ.replace('A read', 'A reed'), seal });
  assert.equal(changed.ok, false);
  assert.match(changed.reason, new RegExp(`hash changed: sealed ${sha256(READ)}, now [0-9a-f]{64}`));
  assert.match(verifySeal({ text: READ, seal: null }).reason, /not sealed/);
});

test('stampRead names the family on a read that has no frontmatter, and leaves one that has', () => {
  assert.match(
    stampRead('## Header\n', { family: 'codex', date: '2026-10-08' }),
    /^---\nkind: cold-read\nfamily: codex\n/
  );
  assert.equal(stampRead(READ, { family: 'x', date: 'y' }), READ);
});

test('proposedSections finds only sections that OPEN with the marker', () => {
  const text = `## Business model\n\n${PROPOSED_LINE}\n\nTiers.\n\n## Growth strategy\n\nMentions ${PROPOSED_LINE} later.\n`;
  assert.deepEqual(proposedSections(text), ['Business model']);
});

test('renderCompare: the reference sections, the hash, and facilitator-authored rows read from the files', () => {
  const out = renderCompare({
    readPath: 'Roadmap/00-strategy/cold-read/2026-10-08-cold-read.md',
    hash: sha256(READ),
    family: 'claude (same family)',
    date: '2026-10-08',
    coached: [
      { path: 'Roadmap/00-strategy/pmf-narrative.md', text: `## Business model\n\n${PROPOSED_LINE}\n` },
    ],
  });
  for (const h of [
    '## 1. Where they converged',
    '## 2. Where they diverged',
    '## 3. What only the cold read saw',
    '## 4. What only the coached run saw',
    '## 5. Decisions for the maker',
    '## 6. Did the cold read earn its place?',
  ])
    assert.ok(out.includes(h), h);
  assert.match(out, new RegExp(`cold_read_sha256: ${sha256(READ)}`));
  assert.match(out, /Same model family/);
  assert.match(out, /pmf-narrative\.md` → \*\*Business model\*\*: written by the coach/);
  assert.match(
    renderCompare({ readPath: 'r', hash: 'h', family: 'codex', date: 'd', coached: [] }),
    /Different model family\*\* \(codex\)/
  );
  assert.match(
    renderCompare({ readPath: 'r', hash: 'h', family: undefined, date: 'd', coached: [] }),
    /family not recorded/
  );
});

function project() {
  const root = mkdtempSync(join(tmpdir(), 'cold-read-'));
  mkdirSync(join(root, 'Roadmap', '00-strategy', 'cold-read'), { recursive: true });
  const file = join(root, 'Roadmap', '00-strategy', 'cold-read', '2026-10-08-cold-read.md');
  writeFileSync(file, READ);
  writeFileSync(
    join(root, 'Roadmap', '00-strategy', 'north-star.md'),
    `---\nkind: north-star\n---\n\n## North Star metric\n\n${PROPOSED_LINE}\n`
  );
  return { root, file };
}
const cli = (root, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GF_PROJECT_ROOT: root },
  });

test('the sprint smoke, end to end: seal prints the hash; one changed character and the compare refuses, naming it', () => {
  const { root, file } = project();
  try {
    const sealed = cli(root, 'seal', file);
    assert.equal(sealed.status, 0, sealed.stderr);
    assert.match(sealed.stdout, new RegExp(`sha256 ${sha256(READ)}`));
    assert.equal(cli(root, 'verify', file).status, 0);

    writeFileSync(file, READ.replace('A read', 'A reed'));
    const refused = cli(root, 'compare', file);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refused .*hash changed: sealed [0-9a-f]{64}, now [0-9a-f]{64}/);
    assert.deepEqual(
      readdirSync(dirname(file)).filter((f) => f.endsWith('-compare.md')),
      [],
      'no compare written'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a seal is never replaced, and the compare writes once, listing the proposed North Star', () => {
  const { root, file } = project();
  try {
    assert.equal(cli(root, 'seal', file).status, 0);
    assert.equal(cli(root, 'seal', file).status, 0, 'resealing an unchanged file is a no-op');
    writeFileSync(file, `${READ}more\n`);
    const reseal = cli(root, 'seal', file);
    assert.equal(reseal.status, 1);
    assert.match(reseal.stderr, /never replaced/);
    writeFileSync(file, READ);

    const made = cli(root, 'compare', file);
    assert.equal(made.status, 0, made.stderr);
    const out = readdirSync(dirname(file)).find((f) => f.endsWith('-compare.md'));
    const text = readFileSync(join(dirname(file), out), 'utf8');
    assert.match(text, /cold_read: Roadmap\/00-strategy\/cold-read\/2026-10-08-cold-read\.md/);
    assert.match(text, /north-star\.md` → \*\*North Star metric\*\*/);
    assert.match(text, /coached: \[Roadmap\/00-strategy\/north-star\.md\]/);
    assert.equal(cli(root, 'compare', file).status, 1, 'never overwrites a compare in progress');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unsealed read is refused, and the brief carries the exclusion list and the mandatory sections', () => {
  const { root, file } = project();
  try {
    const r = cli(root, 'verify', file);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not sealed/);
    const brief = cli(root, 'brief');
    assert.equal(brief.status, 0);
    for (const s of [
      '`Roadmap/00-strategy/`',
      'Reading log',
      'Contamination',
      'Riskiest assumption and the cheapest test',
    ])
      assert.ok(brief.stdout.includes(s), s);
    assert.ok(!existsSync(`${file}.sha256`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
