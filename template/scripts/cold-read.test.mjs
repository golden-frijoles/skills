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
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_SECTIONS,
  deliveryTail,
  missingSections,
  parseSealLine,
  renderCompare,
  sealLine,
  sha256,
  stampRead,
  verifySeal,
} from './cold-read.mjs';
import { PROPOSED_LINE, proposedSections } from './lib/strategy-files.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'cold-read.mjs');
const BODY = [
  '## 1. Header\n\nA read.',
  '## 2. Reading log\n\nRead the README.\n\n**Contamination:** none.',
  '## 3. What this product is\n\nA tool.',
  '## 4. Who it is for\n\nMakers.',
  "## 5. The problem, in the customer's words\n\nTime.",
  '## 6. Market and competitors\n\nSpreadsheets.',
  '## 7. Positioning\n\nA category.',
  '## 8. Growth and business model\n\nA plugin; a plan.',
  '## 9. Riskiest assumption and the cheapest test\n\nThat makers pay. Ask five.',
  '## 10. Confidence and open questions\n\nLow.',
  '## 11. Sources\n\nNone.',
].join('\n\n');
const READ = `---\nkind: cold-read\nfamily: codex\ndate: 2026-10-08\n---\n\n${BODY}`;

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

test('missingSections: sealable only with all eleven sections and a reading log that discloses contamination', () => {
  assert.deepEqual(missingSections(READ), []);
  assert.equal(missingSections('## Header\n').length, REQUIRED_SECTIONS.length - 1);
  assert.deepEqual(missingSections(READ.replace('## 11. Sources', '## 11. Links')), ['Sources']);
  // the prompt and the check name the same sections, so a section added to one cannot be forgotten in the other
  const prompt = readFileSync(join(dirname(SCRIPT), 'cold-read.prompt.md'), 'utf8');
  const asked = [...prompt.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map((m) => m[1].replace(/:$/, ''));
  assert.deepEqual(
    asked,
    REQUIRED_SECTIONS.map(([name]) => name)
  );
  assert.deepEqual(missingSections(READ.replace('**Contamination:** none.', '')), [
    'Contamination (inside the reading log)',
  ]);
});

test('stampRead always writes our kind, family and date, keeping any other key the read brought', () => {
  assert.match(
    stampRead('## Header\n', { family: 'codex', date: '2026-10-08' }),
    /^---\nkind: cold-read\nfamily: codex\n/
  );
  const stamped = stampRead('---\nkind: cold-read\nfamily: me\nsources: 19\n---\n\n## Header\n', {
    family: 'codex',
    date: 'd',
  });
  assert.equal(stamped, '---\nkind: cold-read\nfamily: codex\ndate: d\nsources: 19\n---\n\n## Header\n');
});

test('the brief for a subagent says where to write and to reply with nothing but `written`', () => {
  assert.match(
    deliveryTail('Roadmap/00-strategy/cold-read/x.md'),
    /Write the document to `Roadmap\/00-strategy\/cold-read\/x\.md`/
  );
  assert.match(deliveryTail('x'), /reply with the single word `written`/);
  assert.match(deliveryTail(null), /Reply with the document only/);
});

test('proposedSections finds only sections that OPEN with the marker', () => {
  const text = `## Business model\n\n${PROPOSED_LINE}\n\nTiers.\n\n## Growth strategy\n\nMentions ${PROPOSED_LINE} later.\n`;
  assert.deepEqual(proposedSections(text), ['Business model']);
});

test('renderCompare: the reference sections, the full hash, and facilitator-authored rows read from the files', () => {
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
  assert.match(out, /Seal check \(2026-10-08\): UNVERIFIED/, 'no --expect, no claim it was verified');
  assert.match(
    renderCompare({ readPath: 'r', hash: 'h', family: 'codex', date: 'd', coached: [], expected: true }),
    /verified\. The cold read matches its seal/
  );
  assert.match(out, /Same model family/);
  assert.match(out, /pmf-narrative\.md` → \*\*Business model\*\*: written by the coach/);
  const other = renderCompare({ readPath: 'r', hash: 'h', family: 'codex', date: 'd', coached: [] });
  assert.match(other, /Different model family\*\* \(codex\)/);
  const bare = renderCompare({ readPath: 'r', hash: 'h', family: undefined, date: 'd', coached: [] });
  assert.match(bare, /family not recorded/);
  assert.match(bare, /none marked\. Coaches mark a section they wrote for the maker from plugin 0\.42\.0/);
  assert.doesNotMatch(bare, /decided by the maker/, 'never claims the maker decided everything');
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
    const first = cli(root, 'seal', file);
    assert.equal(first.status, 0);
    assert.equal(cli(root, 'seal', file).status, 0, 'resealing an unchanged file is a no-op');
    writeFileSync(file, `${READ}more\n`);
    const reseal = cli(root, 'seal', file);
    assert.equal(reseal.status, 1);
    assert.match(reseal.stderr, /never replaced/);
    writeFileSync(file, READ);

    const made = cli(root, 'compare', file, '--expect', sha256(READ).slice(0, 12));
    assert.equal(made.status, 0, made.stderr);
    const out = readdirSync(dirname(file)).find((f) => f.endsWith('-compare.md'));
    const text = readFileSync(join(dirname(file), out), 'utf8');
    assert.match(text, /cold_read: Roadmap\/00-strategy\/cold-read\/2026-10-08-cold-read\.md/);
    assert.match(text, /north-star\.md` → \*\*North Star metric\*\*/);
    assert.match(text, /coached: \[Roadmap\/00-strategy\/north-star\.md\]/);
    assert.match(text, /Seal check \(\d{4}-\d{2}-\d{2}\):\*\* verified/);
    assert.equal(cli(root, 'compare', file).status, 1, 'never overwrites a compare in progress');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a replaced seal is caught by the hash the maker was shown; an unfinished read is never sealed', () => {
  const { root, file } = project();
  try {
    const shown = cli(root, 'seal', file).stdout.match(/sha256 ([0-9a-f]{64})/)[1];
    writeFileSync(file, READ.replace('A read', 'A reed'));
    rmSync(`${file}.sha256`);
    assert.equal(cli(root, 'seal', file).status, 0, 'the sidecar alone cannot stop a reseal');
    const swapped = cli(root, 'compare', file, '--expect', shown.slice(0, 12));
    assert.equal(swapped.status, 1);
    assert.match(swapped.stderr, /The seal was replaced/);
    assert.equal(cli(root, 'compare', file, '--expect', '').status, 1, 'an empty --expect is not a pass');
    const resealed = readFileSync(`${file}.sha256`, 'utf8').slice(0, 11);
    assert.equal(
      cli(root, 'compare', file, '--expect', resealed).status,
      1,
      'fewer than 12 characters is not a check'
    );

    const unfinished = join(dirname(file), 'unfinished.md');
    writeFileSync(unfinished, '## Header\n');
    const r = cli(root, 'seal', unfinished);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not sealed .*missing: Reading log; What this product is/);
    assert.ok(!existsSync(`${unfinished}.sha256`));
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
    const brief = cli(root, 'brief', '--out', 'Roadmap/00-strategy/cold-read/x.md');
    assert.equal(brief.status, 0);
    for (const s of [
      '`Roadmap/00-strategy/`',
      'Reading log',
      'Contamination',
      'Riskiest assumption and the cheapest test',
      'Write the document to `Roadmap/00-strategy/cold-read/x.md`',
    ])
      assert.ok(brief.stdout.includes(s), s);
    assert.ok(!existsSync(`${file}.sha256`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A stub `codex` on PATH: answers --version, records where it ran, prints `reply` for any exec. */
function stubCodex(reply) {
  const bin = mkdtempSync(join(tmpdir(), 'codex-stub-'));
  writeFileSync(join(bin, 'reply.md'), reply);
  writeFileSync(
    join(bin, 'codex'),
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo "codex 0.0.0"; exit 0; }\npwd > "${bin}/cwd"\ncat "${bin}/reply.md"\n`,
    { mode: 0o755 }
  );
  return bin;
}
const runCli = (root, path, cwd) =>
  spawnSync(process.execPath, [SCRIPT, 'run'], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, PATH: path, GF_PROJECT_ROOT: root },
  });

test('run: Codex reads the project root, the read is stamped family: codex over its own frontmatter, and sealed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cold-read-run-'));
  const bin = stubCodex(`---\nkind: cold-read\n---\n\n${BODY}`);
  try {
    const r = runCli(root, `${bin}:/usr/bin:/bin`, tmpdir());
    assert.equal(r.status, 0, r.stderr);
    const dir = join(root, 'Roadmap', '00-strategy', 'cold-read');
    const read = readdirSync(dir).find((f) => f.endsWith('-cold-read.md'));
    const text = readFileSync(join(dir, read), 'utf8');
    assert.match(text, /^---\nkind: cold-read\nfamily: codex\ndate: \d{4}-\d{2}-\d{2}\n---\n/);
    assert.equal(parseSealLine(readFileSync(join(dir, `${read}.sha256`), 'utf8')), sha256(text));
    assert.equal(
      readFileSync(join(bin, 'cwd'), 'utf8').trim(),
      realpathSync(root),
      "codex ran in the project, not the caller's cwd"
    );
    const again = runCli(root, `${bin}:/usr/bin:/bin`, tmpdir());
    assert.equal(again.status, 1, 'a second run the same day is refused before codex is called');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('run: no codex on PATH exits 3 with one line and writes nothing; an unfinished Codex read writes nothing, so the retry works', () => {
  const root = mkdtempSync(join(tmpdir(), 'cold-read-run-'));
  const empty = mkdtempSync(join(tmpdir(), 'no-codex-'));
  const bin = stubCodex('## Header\n');
  try {
    const none = runCli(root, `${empty}:/usr/bin:/bin`, root);
    assert.equal(none.status, 3);
    assert.match(none.stderr, /no other model family reachable \(codex is not installed\)/);
    assert.ok(!existsSync(join(root, 'Roadmap')));

    const thin = runCli(root, `${bin}:/usr/bin:/bin`, root);
    assert.equal(thin.status, 1);
    assert.match(thin.stderr, /unfinished read \(missing: Reading log/);
    assert.match(thin.stderr, /Sources/);
    assert.ok(!existsSync(join(root, 'Roadmap')), 'nothing written, so a retry today is not blocked');
    writeFileSync(join(bin, 'reply.md'), BODY);
    assert.equal(runCli(root, `${bin}:/usr/bin:/bin`, root).status, 0, 'the retry runs and seals');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
