// routine-bootstrap.test.mjs — the bootstrap must either render a fully configured prompt or print nothing.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROUTINE_TOKENS, runRoutineBootstrap } from './routine-bootstrap.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'routine-bootstrap-'));
  const routines = join(root, 'routines');
  const prompt = join(routines, 'weekly-recap.prompt.md');
  // The loader is injected below; the name/path still exercises the CLI's routine lookup.
  return {
    root,
    routines,
    prompt,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function invoke({
  values = {},
  body = 'Root: <root-repo>; later: <date>; file: <your-file>.',
  argv = ['weekly-recap'],
} = {}) {
  const f = fixture();
  const stdout = [];
  const stderr = [];
  try {
    const code = runRoutineBootstrap(argv, {
      root: f.root,
      routinesDir: f.routines,
      names: ['weekly-recap'],
      loadBody: (path) => {
        assert.equal(path, f.prompt);
        return body;
      },
      readSectionFor: (section, { root }) => {
        assert.equal(section, 'routines');
        assert.equal(root, f.root);
        return { raw: values };
      },
      out: (text) => stdout.push(text),
      err: (text) => stderr.push(text),
    });
    return { code, out: stdout.join(''), err: stderr.join('') };
  } finally {
    f.cleanup();
  }
}

test('fills project values, strips the prompt header through the loader seam, and leaves runtime tokens alone', () => {
  const result = invoke({ values: { 'root-repo': 'acme/root' } });
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.match(result.out, /Root: acme\/root/);
  assert.match(result.out, /<date>/);
  assert.match(result.out, /<your-file>/);
});

test('refuses every missing value and writes no prompt to stdout', () => {
  const result = invoke({ body: '<root-repo> <app-repo> <PROD_URL>', values: { 'app-repo': '' } });
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  for (const key of ['root-repo', 'app-repo', 'PROD_URL']) assert.match(result.err, new RegExp(key));
});

test('the declared TEMPLATE FILL-IN markers are fill-ins, not runtime substitutions', () => {
  const entry = ROUTINE_TOKENS.find((token) => token.key === 'deploy-path');
  const result = invoke({
    body: `Wait for ${entry.token}.`,
    values: { 'deploy-path': 'Vercel build then deploy' },
  });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.out, /TEMPLATE FILL-IN:/);
  assert.match(result.out, /Vercel build then deploy/);
});

test('an unknown routine names every valid routine and exits 2', () => {
  const result = invoke({ argv: ['nope'] });
  assert.equal(result.code, 2);
  assert.equal(result.out, '');
  assert.match(result.err, /Unknown routine "nope"/);
  assert.match(result.err, /weekly-recap/);
});

test('--list prints routine names', () => {
  const result = invoke({ argv: ['--list'] });
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.equal(result.out, 'weekly-recap\n');
});

test('grep-to-zero: an unclassified <token> or TEMPLATE FILL-IN marker refuses, naming it', async () => {
  const { unclassifiedTokens } = await import('./routine-bootstrap.mjs');
  assert.deepEqual(unclassifiedTokens('run on <date> for <brand-new-token>'), ['<brand-new-token>']);
  assert.deepEqual(unclassifiedTokens('TEMPLATE FILL-IN: something new'), ['TEMPLATE FILL-IN']);
  assert.deepEqual(unclassifiedTokens('run on <date> in <repo>'), []);
});

test('every real prompt is fully classified today (a new token fails here first)', async () => {
  const { unclassifiedTokens, routineNames, ROUTINES_DIR } = await import('./routine-bootstrap.mjs');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  for (const name of routineNames()) {
    const text = readFileSync(join(ROUTINES_DIR, `${name}.prompt.md`), 'utf8');
    const html = /<!--[\s\S]*?-->/g;
    assert.deepEqual(unclassifiedTokens(text.replace(html, '')), [], name);
  }
});

test('#191 review: a new TEMPLATE FILL-IN marker is seen even beside a known one', async () => {
  const { unclassifiedTokens, ROUTINE_TOKENS } = await import('./routine-bootstrap.mjs');
  const known = ROUTINE_TOKENS.find((e) => e.kind === 'fill-in' && e.token.startsWith('TEMPLATE FILL-IN')).token;
  assert.deepEqual(unclassifiedTokens(`${known}\nTEMPLATE FILL-IN: a brand new slot`), ['TEMPLATE FILL-IN']);
  assert.deepEqual(unclassifiedTokens(known), []);
});

// git exports GIT_DIR into hooks, and from a linked worktree it points at the REAL repo: an unsealed
// `git init` here would rewrite it (git-fixtures-sealed.test.mjs).
function sealedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') || k === 'GF_PROJECT_ROOT') delete env[k];
  return env;
}

test('#191 review: run from a SUBDIRECTORY, the project root config is read', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const env = sealedEnv();
  const repo = mkdtempSync(join(tmpdir(), 'rb-root-'));
  spawnSync('git', ['init', '-q'], { cwd: repo, env });
  mkdirSync(join(repo, 'Roadmap'));
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
  const values = { 'root-repo': 'acme/root', 'your-org': 'acme', 'app-repo': 'acme/app' };
  writeFileSync(join(repo, 'golden-frijoles.config.json'), JSON.stringify({ routines: values }));
  const script = join(dirname(fileURLToPath(import.meta.url)), 'routine-bootstrap.mjs');
  const r = spawnSync(process.execPath, [script, 'weekly-recap'], {
    cwd: join(repo, 'apps', 'web'),
    encoding: 'utf8',
    env: { ...env, GF_PROJECT_ROOT: repo },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /acme\/root/);
});

test('agy on #191: a missing routines/ is an empty list, not a crash; CRLF prompts still fill', async () => {
  const { routineNames, runRoutineBootstrap } = await import('./routine-bootstrap.mjs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  assert.deepEqual(routineNames(join(tmpdir(), 'no-such-routines-dir-xyz')), []);
  let out = '';
  const code = runRoutineBootstrap(['r'], {
    names: ['r'],
    loadBody: () => 'Repo <root-repo>\r\non <date>\r\n',
    readSectionFor: () => ({ raw: { 'root-repo': 'acme/root' } }),
    out: (t) => (out += t),
    err: () => {},
  });
  assert.equal(code, 0);
  assert.match(out, /Repo acme\/root\non <date>/);
});
