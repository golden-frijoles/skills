// strategy-private.test.mjs — strategy stays out of a public repo unless the maker chose otherwise (coaches-v2 D9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IGNORE_LINE, OPT_IN_LINE, appendIgnore, decide, hasOptIn, readFacts } from './strategy-private.mjs';

const base = { isRepo: true, visibility: 'public', tracked: 0, ignored: false, optedIn: false };

test('a public repo, or one whose visibility cannot be read, gets the folder ignored by default', () => {
  assert.equal(decide(base).write, true);
  assert.match(decide(base).line, /because this repo is public/);
  const unknown = decide({ ...base, visibility: 'unknown' });
  assert.equal(unknown.write, true);
  assert.match(unknown.line, /visibility couldn't be read/);
  assert.ok(unknown.line.includes(`change that line to \`${OPT_IN_LINE}\``));
});

test('a choice the maker already made is never undone: opted in, already committed, already ignored, private', () => {
  assert.equal(decide({ ...base, optedIn: true }).write, false);
  const tracked = decide({ ...base, tracked: 3 });
  assert.equal(tracked.write, false);
  assert.match(tracked.line, /3 already committed/);
  assert.equal(decide({ ...base, ignored: true }).write, false);
  assert.equal(decide({ ...base, visibility: 'private' }).write, false);
  assert.equal(decide({ ...base, visibility: 'internal' }).write, false);
  assert.equal(decide({ isRepo: false }).write, false);
});

test('appendIgnore keeps what was there and adds the folder once, with how to opt in', () => {
  assert.equal(
    appendIgnore(''),
    `# Strategy files are the maker's own. To commit them, change the next line to ${OPT_IN_LINE}\n${IGNORE_LINE}\n`
  );
  assert.match(appendIgnore('node_modules/'), /^node_modules\/\n# Strategy/);
  assert.ok(hasOptIn(`x\n${OPT_IN_LINE}\n`));
  assert.ok(hasOptIn('!/Roadmap/00-strategy/\n'));
  assert.ok(!hasOptIn(appendIgnore('')), 'the comment that mentions the opt-in is not itself an opt-in');
});

// Sealed from any outer repo: a hook's exported GIT_DIR must not retarget these git calls (LEARNINGS, 2026-10-06).
function sealedEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'strategy-private-'));
  spawnSync('git', ['init', '-q', root], { env: sealedEnv() });
  return root;
}
const gh = (visibility) => () => ({
  status: visibility ? 0 : 1,
  stdout: visibility ? `${visibility}\n` : '',
});

test('on a real repo: public → ignored after one write; after opting in, the next coach leaves it alone', () => {
  const root = repo();
  try {
    let facts = readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() });
    assert.equal(facts.visibility, 'public');
    assert.equal(decide(facts).write, true);
    writeFileSync(facts.gitignorePath, appendIgnore(facts.gitignore));

    facts = readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() });
    assert.equal(facts.ignored, true, 'git itself now ignores the folder');
    assert.equal(decide(facts).write, false);

    const gi = join(root, '.gitignore');
    writeFileSync(gi, readFileSync(gi, 'utf8').replace(`\n${IGNORE_LINE}\n`, `\n${OPT_IN_LINE}\n`));
    facts = readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() });
    assert.equal(facts.optedIn, true);
    assert.equal(decide(facts).write, false, 'the opt-in survives the next coach');

    assert.equal(
      readFacts(root, { run: gh(null), env: sealedEnv() }).visibility,
      'unknown',
      'gh failing reads as unknown'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFacts counts files already committed under the folder', () => {
  const root = repo();
  try {
    mkdirSync(join(root, 'Roadmap', '00-strategy'), { recursive: true });
    writeFileSync(join(root, 'Roadmap', '00-strategy', 'north-star.md'), 'x\n');
    spawnSync('git', ['-C', root, 'add', 'Roadmap/00-strategy/north-star.md'], { env: sealedEnv() });
    assert.equal(readFacts(root, { run: gh('PUBLIC'), env: sealedEnv() }).tracked, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
