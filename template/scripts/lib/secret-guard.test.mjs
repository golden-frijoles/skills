// secret-guard.test.mjs — a reviewer's reply never reaches a PR comment carrying this machine's secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSecretValues, findSecretLeaks, parseEnvValues, MIN_SECRET_LENGTH } from './secret-guard.mjs';

const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiJ9.service-role-looking-value.sig';

test('parseEnvValues: KEY=value, export, quotes, comments and blanks', () => {
  assert.deepEqual(parseEnvValues('# c\nexport A="x y"\nB=\'q\'\nC=\n\nD = plain\n'), [
    { key: 'A', value: 'x y' },
    { key: 'B', value: 'q' },
    { key: 'D', value: 'plain' },
  ]);
});

test('collectSecretValues: every long value in the root .env* files, never the .example', () => {
  const root = mkdtempSync(join(tmpdir(), 'sg-'));
  writeFileSync(join(root, '.env.local'), `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\nPORT=3000\n`);
  writeFileSync(join(root, '.env.example'), 'SUPABASE_SERVICE_ROLE_KEY=placeholder-placeholder-1234\n');
  const values = collectSecretValues({ root, env: {}, home: null });
  assert.deepEqual(values, [SERVICE_KEY]);
});

test('collectSecretValues: secret-NAMED process env vars count; ordinary ones do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'sg-'));
  const long = 'x'.repeat(MIN_SECRET_LENGTH);
  const values = collectSecretValues({
    root,
    home: null,
    env: { TELEGRAM_BOT_TOKEN: long, PATH: `/usr/bin:${long}` },
  });
  assert.deepEqual(values, [long]);
});

test('findSecretLeaks: an env value in the reply is caught and redacted, and the value never appears in the report', () => {
  const reply = `**Blocking**\n- The config reads ${SERVICE_KEY} from .env.local.`;
  const { leaks, redacted } = findSecretLeaks(reply, { values: [SERVICE_KEY] });
  assert.equal(leaks.length, 1);
  assert.doesNotMatch(JSON.stringify(leaks), /service-role-looking-value/);
  assert.doesNotMatch(redacted, /service-role-looking-value/);
  assert.match(redacted, /\[REDACTED env value\]/);
});

test('findSecretLeaks: credential shapes are caught without any env file', () => {
  for (const s of [
    'ghp_' + 'a'.repeat(36),
    'sk-ant-' + 'b'.repeat(40),
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'https://hooks.slack.com/services/T000/B000/' + 'c'.repeat(24),
    '1234567890:' + 'A'.repeat(35),
    'AKIA' + 'Z'.repeat(16),
  ]) {
    assert.equal(findSecretLeaks(`**Nit**\n- ${s}`).leaks.length, 1, s.slice(0, 12));
  }
});

test('findSecretLeaks: an ordinary review is clean', () => {
  const reply = '**Blocking**\n- None.\n\n**Should-fix**\n- `scripts/cross-review.mjs:42` pins the sha.';
  assert.deepEqual(findSecretLeaks(reply, { values: ['not-in-the-reply-0123456789'] }).leaks, []);
});

// ── round 3 on #188: this repo's own service-role key lives in apps/web/.env.local ─────────────────────
test('collectSecretValues: nested .env files (apps/web/.env.local) and .envrc count; node_modules never does', async () => {
  const { mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'sg-'));
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(
    join(root, 'apps', 'web', '.env.local'),
    'SUPABASE_SERVICE_ROLE_KEY=nested-app-secret-value-1\n'
  );
  writeFileSync(join(root, '.envrc'), 'export DB_URL=envrc-secret-value-12345\n');
  writeFileSync(join(root, 'node_modules', 'x', '.env'), 'X=vendored-not-ours-0123456\n');
  const values = collectSecretValues({ root, env: {}, home: null }).sort();
  assert.deepEqual(values, ['envrc-secret-value-12345', 'nested-app-secret-value-1']);
});

test('parseEnvValues: inline comments are not part of the value, quoted or not', () => {
  assert.deepEqual(
    parseEnvValues(
      'A="quoted-secret-value" # note\nB=bare-secret-value-123 # note\nC=has#hash-no-space\n'
    ).map((e) => e.value),
    ['quoted-secret-value', 'bare-secret-value-123', 'has#hash-no-space']
  );
});

test('findSecretLeaks: JWT and Supabase secret-key shapes are caught with no env file', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl';
  assert.equal(findSecretLeaks(`- ${jwt}`).leaks[0].name, 'JWT');
  assert.equal(findSecretLeaks('- sb_secret_' + 'k'.repeat(24)).leaks[0].name, 'Supabase secret key');
});

// ── codex security lens on #188: the realistic hostile diff is an outsider's ──────────────────────────
test('decideAuthorTrust: write access and up is trusted; read, none and unknown are refused unless allowed', async () => {
  const { decideAuthorTrust } = await import('./secret-guard.mjs');
  for (const p of ['admin', 'maintain', 'write'])
    assert.equal(decideAuthorTrust({ permission: p }).ok, true, p);
  for (const p of ['triage', 'read', 'none', null]) {
    const d = decideAuthorTrust({ permission: p });
    assert.equal(d.ok, false, String(p));
    assert.match(d.why, /--allow-untrusted-author/);
  }
  assert.equal(decideAuthorTrust({ permission: null, allowUntrusted: true }).ok, true);
});

test('findSecretLeaks: an 80+ char base64 run is withheld; ordinary code is not', () => {
  assert.equal(findSecretLeaks(`- ${'QUJD'.repeat(25)}==`).leaks[0].name, 'opaque base64 blob');
  assert.deepEqual(
    findSecretLeaks('- `scripts/lib/secret-guard.mjs:12` uses readFileSync(join(root, name))').leaks,
    []
  );
});

// ── codex security lens, round 4 on #188: shapeless secrets in the operator's own credential stores ─────
test('credentialValues: aws, netrc, npmrc, gh hosts and URL-embedded passwords', async () => {
  const { credentialValues } = await import('./secret-guard.mjs');
  // Fixtures are built at runtime so no committed line looks like a live credential (push protection).
  const awsKey = 'fixture' + 'Q'.repeat(33);
  assert.ok(credentialValues(`[default]\naws_secret_access_key = ${awsKey}\n`).includes(awsKey));
  const netrc = 'fixture-netrc-' + 'n'.repeat(8);
  assert.ok(credentialValues(`machine api.x.com login me password ${netrc}`).includes(netrc));
  const npmTok = 'npm_' + 'f'.repeat(36);
  assert.ok(
    credentialValues(`//registry.npmjs.org/:_authToken=${npmTok}`).includes(npmTok),
    'the token alone'
  );
  assert.equal(findSecretLeaks(`- ${npmTok}`).leaks[0].name, 'npm token');
  const gh = 'gho_' + 'g'.repeat(30);
  assert.ok(credentialValues(`    oauth_token: ${gh}`).includes(gh));
  const pw = 'fixture-url-pw-' + 'u'.repeat(8);
  assert.ok(credentialValues(`https://user:${pw}@example.com`).includes(pw));
});

test('collectSecretValues: a value from ~/.aws/credentials is matched verbatim in a reply', async () => {
  const { mkdirSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'sg-home-'));
  mkdirSync(join(home, '.aws'));
  const secret = 'fixture' + 'R'.repeat(33);
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${secret}\n`);
  const values = collectSecretValues({ root: mkdtempSync(join(tmpdir(), 'sg-')), env: {}, home });
  assert.equal(findSecretLeaks(`**Nit**\n- ${secret}`, { values }).leaks.length, 1);
});

test('credentialValues: padded base64 values are kept whole; registry URLs are not secrets (round 5 on #188)', async () => {
  const { credentialValues } = await import('./secret-guard.mjs');
  const padded = 'Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzcw' + '==';
  assert.ok(credentialValues(`_auth=${padded}`).includes(padded));
  assert.ok(credentialValues(`      "auth": "${padded}"`).includes(padded));
  const session = 'fixture' + 'S'.repeat(20) + '=';
  assert.ok(credentialValues(`aws_session_token = ${session}`).includes(session));
  const slashKey = '//' + 'fixture' + 'A'.repeat(31);
  assert.ok(
    credentialValues(`aws_secret_access_key = ${slashKey}`).includes(slashKey),
    'a // -leading key is a key'
  );
  assert.deepEqual(credentialValues('registry=https://registry.npmjs.org/'), []);
  assert.deepEqual(credentialValues('@scope:registry=https://npm.pkg.github.com/'), []);
  assert.deepEqual(credentialValues('repository = https://upload.pypi.org/legacy/'), []);
});
