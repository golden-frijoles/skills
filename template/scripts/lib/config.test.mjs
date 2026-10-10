import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_FILENAME,
  ConfigError,
  EXIT_NEEDS_SETTING,
  NEEDS_SETTING,
  _resetAsked,
  getKey,
  loadConfig,
  findSecrets,
  looksLikeSecret,
  REDACTED,
  redactSecrets,
  migrate,
  needSetting,
  readSection,
  setKey,
  SECTIONS,
} from './config.mjs';

const project = (files = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gf-config-')));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
};

test('no file anywhere: the section is null (the rail decides what that means)', () => {
  assert.deepEqual(readSection('jev', { root: project() }), { raw: null, present: false, sources: [], duplicates: [] });
});

test('legacy only: handed back exactly as the legacy file had it', () => {
  const root = project({ 'jev.config.json': { egress: true, rails: { review: { mode: 'jev' } } } });
  const r = readSection('jev', { root });
  assert.deepEqual(r.raw, { egress: true, rails: { review: { mode: 'jev' } } });
  assert.deepEqual(r.sources, [join(root, 'jev.config.json')]);
});

test('new file only: its section', () => {
  const root = project({ [CONFIG_FILENAME]: { jev: { egress: false } } });
  assert.deepEqual(readSection('jev', { root }).raw, { egress: false });
});

test('both: the new file wins PER TOP-LEVEL KEY, legacy fills the gaps, and the overlap is reported', () => {
  const root = project({
    'jev.config.json': { egress: true, model: 'jev-1.13.0' },
    [CONFIG_FILENAME]: { jev: { egress: false } },
  });
  const r = readSection('jev', { root });
  assert.deepEqual(r.raw, { egress: false, model: 'jev-1.13.0' });
  assert.deepEqual(r.duplicates, ['egress']);
  assert.equal(r.sources.length, 2);
});

test('a malformed new file is a CONFIGURATION failure naming the file; an absent one is a fallback', () => {
  const root = project({ [CONFIG_FILENAME]: '{ nope' });
  assert.throws(() => readSection('jev', { root }), (e) => e instanceof ConfigError && e.message.includes(CONFIG_FILENAME));
});

test('an unknown section is IGNORED on read (a newer file must not break older rails), reported, refused on write', () => {
  const root = project({ [CONFIG_FILENAME]: { futureModule: { x: 1 }, jev: { egress: false } } });
  assert.deepEqual(readSection('jev', { root }).raw, { egress: false });
  assert.deepEqual(loadConfig({ root }).unknown, ['futureModule']);
  assert.throws(() => setKey('futureModule.x', 2, { root }), ConfigError);
});

test("a rail keeps its OWN error for an unparseable legacy file (legacy-only repos behave byte-identically)", () => {
  class RailError extends Error {}
  const root = project({ 'jev.config.json': '{ broken' });
  assert.throws(
    () =>
      readSection('jev', {
        root,
        onLegacyError: (p) => {
          throw new RailError(`jev.config.json: unparseable (${p})`);
        },
      }),
    RailError
  );
});

test('legacyPath overrides the table (reporting honours REPORTING_CONFIG)', () => {
  const root = project({ 'config/rep.json': { repos: ['a/b'] } });
  assert.deepEqual(readSection('reporting', { root, legacyPath: 'config/rep.json' }).raw, { repos: ['a/b'] });
});

test('smoke carves out triage/perf: live-smoke never receives the other policies', () => {
  const root = project({
    [CONFIG_FILENAME]: { smoke: { appDir: 'apps/web', triage: { x: 1 }, perf: { y: 2 } } },
    'smoke-triage.config.json': { legacy: true },
  });
  assert.deepEqual(readSection('smoke', { root }).raw, { appDir: 'apps/web' });
  assert.deepEqual(readSection('smoke.triage', { root }).raw, { legacy: true, x: 1 });
  assert.deepEqual(readSection('smoke.perf', { root }).raw, { y: 2 });
});

test('getKey: the effective value, else the registry default', () => {
  const root = project({ 'scripts/review-config.json': { reviewScope: 'every-pr' } });
  assert.equal(getKey('review.reviewScope', { root }), 'every-pr');
  assert.equal(getKey('review.reviewScope', { root: project() }), 'security-paths-only');
  assert.equal(getKey('jev.egress', { root: project() }), null);
});

test('setKey creates the file, round-trips, and leaves other keys alone', () => {
  const root = project({ [CONFIG_FILENAME]: { review: { families: ['codex'] } } });
  setKey('review.reviewScope', 'every-pr', { root });
  const json = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'));
  assert.deepEqual(json, { review: { families: ['codex'], reviewScope: 'every-pr' } });
  assert.equal(getKey('review.reviewScope', { root }), 'every-pr');
});

test('setKey refuses an unknown section and a secret value, and names the fix', () => {
  const root = project();
  assert.throws(() => setKey('nope.x', 1, { root }), ConfigError);
  assert.throws(() => setKey('reporting.botToken', '123:abcDEF', { root }), /env var NAME/);
  assert.throws(() => setKey('jev.key', 'sk-live-0123456789abcdefghij', { root }), ConfigError); // a real-length token
  setKey('reporting.botToken', 'TELEGRAM_BOT_TOKEN', { root }); // an env var NAME is the right answer
  assert.equal(existsSync(join(root, CONFIG_FILENAME)), true);
});

test('looksLikeSecret: token prefixes and secret-named keys with non-env-name values', () => {
  assert.equal(looksLikeSecret('reporting.chatId', 'ghp_0123456789abcdefghijklmn'), true);
  assert.equal(looksLikeSecret('reporting.chatId', 'ghp_abc'), false, 'too short to be a token: a name');
  assert.equal(looksLikeSecret('deploy.apiKey', 'abc123'), true);
  assert.equal(looksLikeSecret('deploy.apiKey', 'VERCEL_TOKEN'), false);
  assert.equal(looksLikeSecret('review.reviewScope', 'every-pr'), false);
  assert.equal(looksLikeSecret('jev.egress', true), false);
});

test('migrate folds legacy into the new file, new wins, legacy files untouched, --dry-run writes nothing', () => {
  const legacy = { reviewScope: 'every-pr', securityPaths: ['a/**'], _about: 'note' };
  const root = project({
    'scripts/review-config.json': legacy,
    [CONFIG_FILENAME]: { review: { reviewScope: 'security-paths-only' } },
  });
  const before = readFileSync(join(root, CONFIG_FILENAME), 'utf8');
  const dry = migrate({ root, dryRun: true });
  assert.deepEqual(dry.folded, ['review.securityPaths']);
  assert.equal(readFileSync(join(root, CONFIG_FILENAME), 'utf8'), before, 'dry run wrote nothing');
  migrate({ root });
  const json = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'));
  assert.deepEqual(json.review, { reviewScope: 'security-paths-only', securityPaths: ['a/**'] });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'scripts/review-config.json'), 'utf8')), legacy);
});

test('migrate in an empty repo: nothing to fold, no file written', () => {
  const root = project();
  assert.deepEqual(migrate({ root }).folded, []);
  assert.equal(existsSync(join(root, CONFIG_FILENAME)), false);
});

test('migrate never copies a secret-looking value; it reports it', () => {
  const root = project({ 'reporting.config.json': { repos: ['a/b'], botToken: 'xoxb-123' } });
  const r = migrate({ root, dryRun: true });
  assert.deepEqual(r.skipped, ['reporting.botToken']);
  assert.equal('botToken' in r.config.reporting, false);
});

test('loadConfig lists every present section with its sources and duplicates', () => {
  const root = project({ 'jev.config.json': { egress: true }, [CONFIG_FILENAME]: { jev: { egress: false } } });
  const c = loadConfig({ root });
  assert.deepEqual(c.sections.jev, { egress: false });
  assert.deepEqual(c.duplicates, ['jev.egress']);
});

test('needSetting: an unset key emits the protocol line ONCE; a set key never emits', () => {
  _resetAsked();
  const root = project();
  const lines = [];
  const write = (s) => lines.push(s);
  assert.equal(needSetting('review.reviewScope', { root, write }), 'security-paths-only');
  needSetting('review.reviewScope', { root, write });
  assert.equal(lines.length, 1, 'asked once per process');
  assert.ok(lines[0].startsWith(`${NEEDS_SETTING} {`));
  assert.equal(JSON.parse(lines[0].slice(NEEDS_SETTING.length + 1)).key, 'review.reviewScope');

  _resetAsked();
  const set = project({ [CONFIG_FILENAME]: { review: { reviewScope: 'every-pr' } } });
  const quiet = [];
  assert.equal(needSetting('review.reviewScope', { root: set, write: (s) => quiet.push(s) }), 'every-pr');
  assert.equal(quiet.length, 0, 'a set key never asks');
});

test('needSetting: an explicit null counts as unanswered (Jev egress, D12)', () => {
  _resetAsked();
  const root = project({ 'jev.config.json': { egress: null } });
  const lines = [];
  assert.equal(needSetting('jev.egress', { root, write: (s) => lines.push(s) }), null);
  assert.equal(lines.length, 1);
});

test('needSetting: blocking exits 7; non-blocking continues', () => {
  _resetAsked();
  let code;
  needSetting('reporting.destination', { root: project(), write: () => {}, blocking: true, exit: (c) => (code = c) });
  assert.equal(code, EXIT_NEEDS_SETTING);
});

test('needSetting refuses a key that is not registered', () => {
  assert.throws(() => needSetting('nope.x', { root: project(), write: () => {} }), /not in the registry/);
});

test("a rail's injected IO answers ONLY for its legacy file, never for the new file (compat with rail tests)", () => {
  const root = project(); // no new file on disk
  const r = readSection('smoke.perf', {
    root,
    legacyPath: '/fixture/perf.json',
    legacyExists: () => true,
    legacyRead: () => JSON.stringify({ baseUrl: 'https://a' }),
  });
  assert.deepEqual(r.raw, { baseUrl: 'https://a' });
});

test('a converted rail sees the new file: jev egress overridden by golden-frijoles.config.json', async () => {
  const { loadJevConfig } = await import('./jev.mjs');
  const root = project({
    'jev.config.json': { egress: true, rails: { review: { mode: 'jev' }, prose: { mode: 'off' } } },
    [CONFIG_FILENAME]: { jev: { egress: false } },
  });
  const cfg = loadJevConfig({ root });
  assert.equal(cfg.egress, false, 'the new file wins');
  assert.equal(cfg.rails.review.mode, 'jev', 'the legacy file fills the gap');
});

// ── Review of #49 ───────────────────────────────────────────────────────────────────────────────

test('#1 null in the new file is UNSET: saving jev.egress null never re-enables what legacy turned off', async () => {
  const { loadJevConfig } = await import('./jev.mjs');
  const root = project({ 'jev.config.json': { egress: false } });
  setKey('jev.egress', null, { root });
  assert.equal(readSection('jev', { root }).raw.egress, false);
  assert.equal(loadJevConfig({ root }).egress, false, 'the legacy opt-out survives');
});

test('#2 a legacy file holding JSON null is PRESENT and malformed: the rail throws, never falls back', async () => {
  const { loadJevConfig, JevConfigError } = await import('./jev.mjs');
  const root = project({ 'jev.config.json': 'null' });
  const r = readSection('jev', { root });
  assert.equal(r.present, true);
  assert.throws(() => loadJevConfig({ root }), JevConfigError);
});

test('#3 a deep set keeps the legacy siblings of what it changes', () => {
  const root = project({ 'jev.config.json': { rails: { review: { mode: 'jev' }, prose: { mode: 'jev' } } } });
  setKey('jev.rails.review.mode', 'off', { root });
  assert.deepEqual(readSection('jev', { root }).raw.rails, { review: { mode: 'off' }, prose: { mode: 'jev' } });
});

test('#10 the secret guard walks nested values and knows Telegram and Slack; names are not secrets', () => {
  const root = project();
  assert.throws(() => setKey('reporting.telegram', { botToken: '123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ' }, { root }), /reporting\.telegram\.botToken/);
  assert.throws(() => setKey('reporting.slack', { url: 'https://hooks.slack.com/services/T0/B0/xyz' }, { root }), ConfigError);
  assert.deepEqual(findSecrets('deploy', { vercelProject: 'sk-shop', name: 'npm_utils' }), []);
  const m = project({ 'reporting.config.json': { repos: ['a/b'], telegram: { botToken: '123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ' } } });
  const r = migrate({ root: m, dryRun: true });
  assert.deepEqual(r.skipped, ['reporting.telegram.botToken']);
  assert.equal('telegram' in r.config.reporting, false, 'the credentials block stays behind whole');
});

test('#12 REPORTING_CONFIG is honoured by list and migrate, not only by the rail', () => {
  const root = project({ 'cfg/rep.json': { repos: ['a/b'] } });
  const env = { REPORTING_CONFIG: 'cfg/rep.json' };
  assert.deepEqual(readSection('reporting', { root, env }).raw, { repos: ['a/b'] });
  assert.deepEqual(migrate({ root, env, dryRun: true }).folded, ['reporting.repos']);
});

test('#14 __proto__ / constructor / prototype segments are refused (no prototype pollution)', () => {
  const root = project();
  for (const k of ['review.__proto__.x', 'review.constructor.prototype.x', 'review..x']) {
    assert.throws(() => setKey(k, 1, { root }), ConfigError, k);
  }
  assert.equal({}.x, undefined);
});

test('looksLikeSecret: Golden Frijoles\' own CLI token and a URL with a password (review of the S5 diff)', () => {
  assert.equal(looksLikeSecret('review.reviewers', 'gf_pat_abcdefghijklmnopqrstuvwxyz0123'), true);
  assert.equal(looksLikeSecret('deploy.db', 'postgres://user:pa55word@host/db'), true);
  assert.equal(looksLikeSecret('deploy.db', 'postgres://host/db'), false);
  assert.equal(looksLikeSecret('smoke.envs.preview', 'https://user@preview.example.com'), false);
});

test('a config file that is a symlink out of the project is refused, new or legacy (security lens on #49)', async () => {
  const { mkdtempSync, symlinkSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const outside = mkdtempSync(join(tmpdir(), 'cfg-outside-'));
  writeFileSync(join(outside, 'creds.json'), JSON.stringify({ review: { token: 'do-not-print-me' } }));
  const root = mkdtempSync(join(tmpdir(), 'cfg-root-'));
  symlinkSync(join(outside, 'creds.json'), join(root, 'golden-frijoles.config.json'));
  assert.throws(() => loadConfig({ root }), /outside the project/);
  const root2 = mkdtempSync(join(tmpdir(), 'cfg-root-'));
  symlinkSync(join(outside, 'creds.json'), join(root2, 'jev.config.json'));
  assert.throws(() => readSection('jev', { root: root2 }), /outside the project/);
  // an in-project symlink is fine
  const root3 = mkdtempSync(join(tmpdir(), 'cfg-root-'));
  writeFileSync(join(root3, 'real.json'), JSON.stringify({ review: { reviewScope: 'every-pr' } }));
  symlinkSync(join(root3, 'real.json'), join(root3, 'golden-frijoles.config.json'));
  assert.equal(loadConfig({ root: root3 }).sections.review.reviewScope, 'every-pr');
});

test('migrate refuses a legacy file that is a symlink out of the project (security lens on #49, round 4)', async () => {
  const { mkdtempSync, symlinkSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const outside = mkdtempSync(join(tmpdir(), 'mig-outside-'));
  writeFileSync(join(outside, 'creds.json'), JSON.stringify({ model: 'do-not-print-me' }));
  const root = mkdtempSync(join(tmpdir(), 'mig-root-'));
  symlinkSync(join(outside, 'creds.json'), join(root, 'jev.config.json'));
  assert.throws(() => migrate({ root, dryRun: true }), /outside the project/);
});

test('looksLikeSecret: surrounding whitespace does not hide a token (security lens on golden-beans #164)', () => {
  assert.equal(looksLikeSecret('reporting.destination', ` sk-${'a'.repeat(20)}`), true);
  assert.equal(looksLikeSecret('reporting.destination', `gf_pat_${'a'.repeat(32)}\n`), true);
  assert.equal(looksLikeSecret('reporting.destination', '\t postgres://u:pw@db/x'), true);
  assert.equal(looksLikeSecret('reporting.tokenEnv', ' TELEGRAM_BOT_TOKEN '), false, 'an env NAME is still a name');
});

// ── Review of the wave-2 copy-ins (consumer PRs) ─────────────────────────
test('REPORTING_CONFIG may name a file outside the project, even when the rail passes it as legacyPath', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const outside = mkdtempSync(join(tmpdir(), 'rep-outside-'));
  writeFileSync(join(outside, 'reporting.json'), JSON.stringify({ destination: 'terminal' }));
  const root = mkdtempSync(join(tmpdir(), 'rep-root-'));
  const env = { REPORTING_CONFIG: join(outside, 'reporting.json') };
  assert.equal(readSection('reporting', { root, env, legacyPath: env.REPORTING_CONFIG }).raw.destination, 'terminal');
  // a DIFFERENT outside path passed as legacyPath is still refused
  assert.throws(() => readSection('reporting', { root, env: {}, legacyPath: env.REPORTING_CONFIG }), /outside the project/);
});

test('migrate refuses a section that is not an object instead of replacing it with {}', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'mig-bad-'));
  writeFileSync(join(root, 'golden-frijoles.config.json'), JSON.stringify({ jev: 'bad' }));
  writeFileSync(join(root, 'jev.config.json'), JSON.stringify({ egress: true }));
  assert.throws(() => migrate({ root, dryRun: true }), /"jev" must be an object/);
});

test('config list and get redact secret-looking values a legacy file still holds; readSection does not', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'redact-'));
  const token = `123456789:${'A'.repeat(35)}`;
  writeFileSync(join(root, 'reporting.config.json'), JSON.stringify({ telegram: { botToken: token, chatId: '42' } }));
  const listed = JSON.stringify(loadConfig({ root }));
  assert.ok(!listed.includes(token));
  assert.ok(listed.includes('"chatId":"42"'));
  assert.equal(getKey('reporting.telegram.botToken', { root }), REDACTED);
  assert.equal(readSection('reporting', { root }).raw.telegram.botToken, token, 'rails still read the real value');
});

test('config list fails on a legacy file holding JSON null instead of reporting no settings', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'null-'));
  writeFileSync(join(root, 'jev.config.json'), 'null');
  assert.throws(() => loadConfig({ root }), /must be an object, not null/);
});

test('a kit-owned default outside the project is readable (installed mode); other outside files are not', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { kitRoot } = await import('./project-root.mjs');
  const root = mkdtempSync(join(tmpdir(), 'kit-owned-'));
  assert.ok(readSection('review', { root, legacyPath: join(kitRoot(), 'review-config.json') }).present);
});

test('redactSecrets: under a secret-named key, only an env-var NAME with an underscore is shown (review of #53)', () => {
  assert.equal(redactSecrets('reporting.telegram.botToken', 'ABCDEF1234567890'), REDACTED);
  assert.equal(redactSecrets('reporting.telegram.botToken', 'TELEGRAM_BOT_TOKEN'), 'TELEGRAM_BOT_TOKEN');
  assert.equal(redactSecrets('reporting.chatId', 'ABCDEF1234567890'), 'ABCDEF1234567890', 'not a secret-named key');
});

// one-bet-wired, verifier #341: a registry key whose section is not in SECTIONS can never be set.
test('every registry key lives in a section config set accepts', async () => {
  const { REGISTRY } = await import('./config-registry.mjs');
  for (const row of REGISTRY) assert.ok(SECTIONS.includes(row.key.split('.')[0]), `${row.key}: section not in SECTIONS`);
});

test('measure.signIn round-trips: set later, get later', () => {
  const root = mkdtempSync(join(tmpdir(), 'cfg-measure-'));
  setKey('measure.signIn', 'later', { root });
  assert.equal(getKey('measure.signIn', { root }), 'later');
});
