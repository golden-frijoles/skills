// read-product.test.mjs — the product read setup drafts from (setup-drafts-strategy D1–D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SECRET_DIR, SECRET_PATH, formatProduct, readProduct, readRoutes, walk } from './read-product.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// Fake secrets are assembled at runtime: a key-shaped literal in this file is quoted back by reviewers and trips the
// review rail's own secret guard (verifier, #336).
const FAKE_KEY = ['sk', 'a'.repeat(26)].join('-');
const FAKE_PH = ['phc', 'should', 'never', 'be', 'read'].join('_');

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'read-product-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const PRODUCT = {
  'README.md': '# Tiendas\n\n[![badge](x)](y)\n\nTiendas lets small shops sell online in an afternoon.\n\n## Pricing\n',
  'package.json': JSON.stringify({ name: 'tiendas', description: 'Online shops for small sellers', keywords: ['shop'], dependencies: { next: '15' } }),
  'app/layout.tsx': "export const metadata = { title: 'Tiendas — sell online', description: 'Open a shop in an afternoon' }\n",
  'app/page.tsx': 'export default function P() { return <h1>Sell online today</h1> }\n',
  'app/(shop)/checkout/page.tsx': 'export default function C() { return null }\n',
  'app/api/orders/route.ts': 'export async function POST() {}\n',
  'pages/about.tsx': 'export default function A() { return null }\n',
  'lib/track.ts': [
    "posthog.capture('order_placed', { total })",
    "analytics.track('Signed Up')",
    "gtag('event', 'purchase', {})",
    'posthog.capture(eventName)',
    'mixpanel.track(`checkout_${step}`)',
    "posthog.capture('order_placed', { again: true })",
  ].join('\n'),
  'lib/checkout.ts': "if (posthog.isFeatureEnabled('new-checkout')) {}\nconst v = ld.variation('pricing-v2', false)\n",
  'lib/track.test.ts': "posthog.capture('only_in_a_test')\n",
  '.env.local': `POSTHOG_KEY=${FAKE_PH}\nposthog.capture('from_env')\n`,
  'config/secrets.ts': "posthog.capture('from_a_secret_file')\n",
  'lib/leak.ts': `const k = '${FAKE_KEY}'; posthog.capture('leaky_line')\n`,
  'node_modules/x/index.js': "posthog.capture('from_a_dependency')\n",
};

test('D2: README, package, landing copy, routes, analytics and flags, each with its file', () => {
  const root = project(PRODUCT);
  try {
    const p = readProduct(root);
    assert.deepEqual(p.stack, ['Node.js (Next.js)']);
    assert.deepEqual(p.readme.title, { text: 'Tiendas', at: 'README.md:1' });
    assert.deepEqual(p.readme.paragraph, { text: 'Tiendas lets small shops sell online in an afternoon.', at: 'README.md:5' });
    assert.equal(p.package.description, 'Online shops for small sellers');
    assert.deepEqual(
      p.landing.map((l) => `${l.kind}:${l.text}@${l.at}`),
      [
        'title:Tiendas — sell online@app/layout.tsx:1',
        'description:Open a shop in an afternoon@app/layout.tsx:1',
        'heading:Sell online today@app/page.tsx:1',
      ]
    );
    assert.deepEqual(
      p.routes.map((x) => `${x.path}@${x.at}`),
      ['/@app/page.tsx', '/about@pages/about.tsx', '/checkout@app/(shop)/checkout/page.tsx'],
      'route groups dropped, api routes are not pages; each with its file'
    );
    assert.deepEqual(
      p.analytics.map((a) => `${a.vendor}:${a.name}@${a.at}`),
      [
        'PostHog:order_placed@lib/track.ts:1',
        'Segment:Signed Up@lib/track.ts:2',
        'Google Analytics:purchase@lib/track.ts:3',
        'PostHog:null@lib/track.ts:4',
        'Mixpanel:null@lib/track.ts:5',
      ],
      'a repeated event once; a variable or a template with a placeholder is not a name'
    );
    assert.deepEqual(
      p.flags.map((f) => `${f.vendor}:${f.name}`),
      ['PostHog:new-checkout', 'LaunchDarkly:pricing-v2']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D3: secret files are never opened, key-shaped lines never printed, tests and dependencies never read', () => {
  const root = project(PRODUCT);
  try {
    const p = readProduct(root);
    const all = JSON.stringify(p);
    for (const never of ['from_env', FAKE_PH, 'from_a_secret_file', 'leaky_line', FAKE_KEY, 'only_in_a_test', 'from_a_dependency'])
      assert.doesNotMatch(all, new RegExp(never), never);
    assert.equal(p.skipped.secret, 2, '.env.local and config/secrets.ts');
    assert.ok(p.skipped.dirs.includes('node_modules'));
    for (const path of ['.env', '.env.production', 'certs/server.pem', 'keys/id.key', 'src/aws-credentials.json'])
      assert.match(path, SECRET_PATH, path);
    for (const path of ['src/env.ts', 'app/keyboard.tsx', 'README.md']) assert.doesNotMatch(path, SECRET_PATH, path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D3: bounded — the file cap and the size cap are counted and said', () => {
  const root = project({ 'a.ts': 'x', 'b.ts': 'x', 'c.ts': 'x'.repeat(50), 'README.md': '# R\n' });
  try {
    const w = walk(root, { maxFiles: 2, maxBytes: 20 });
    assert.equal(w.files.length, 2);
    assert.equal(w.skipped.large, 1);
    assert.equal(w.skipped.overCap, 1);
    const text = formatProduct({ ...readProduct(root), skipped: { ...w.skipped, dirs: [] }, scanned: 2 });
    assert.match(text, /1 files over 256 KB; 1 files past the 4000-file cap/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: Next pages/ and app/, also under apps/*', () => {
  assert.deepEqual(
    readRoutes(['apps/web/app/settings/page.tsx', 'pages/index.tsx', 'pages/_app.tsx', 'pages/api/x.ts']).map((x) => x.path),
    ['/', '/settings']
  );
});

test('D1: the CLI reads, writes nothing, and --json is the same facts', () => {
  const root = project(PRODUCT);
  try {
    const human = spawnSync(process.execPath, [join(HERE, 'read-product.mjs'), '--root', root], { encoding: 'utf8' });
    assert.equal(human.status, 0);
    assert.match(human.stdout, /README \.+ Tiendas \(README\.md:1\)/);
    assert.match(human.stdout, /PostHog: order_placed \(lib\/track\.ts:1\)/);
    const json = spawnSync(process.execPath, [join(HERE, 'read-product.mjs'), '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(json.stdout).routes.length, 3);
    assert.match(human.stdout, /\/checkout \(app\/\(shop\)\/checkout\/page\.tsx\)/);
    assert.match(human.stdout, /Description \.+ Online shops for small sellers \(package\.json:1\)/);
    assert.equal(spawnSync(process.execPath, [join(HERE, 'read-product.mjs'), '--root'], { encoding: 'utf8' }).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codex #336: a key-shaped README heading is never printed; every call on a line is found', () => {
  const root = project({
    'README.md': `# Shop\n\nSells things.\n\n## ${FAKE_KEY}\n`,
    'lib/a.ts': "posthog.capture('one'); posthog.capture('two')\n",
  });
  try {
    const p = readProduct(root);
    assert.ok(!JSON.stringify(p).includes(FAKE_KEY));
    assert.deepEqual(p.analytics.map((a) => a.name), ['one', 'two']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agy #336: symlinks are never followed — a linked README, package.json or folder is not read', () => {
  const outside = project({ 'secret.md': '# Outside title\n\nprivate words\n', 'pkg.json': '{"name":"outside"}', 'src/x.ts': "posthog.capture('outside_event')\n" });
  const root = project({ 'lib/in.ts': "posthog.capture('inside_event')\n" });
  try {
    symlinkSync(join(outside, 'secret.md'), join(root, 'README.md'));
    symlinkSync(join(outside, 'pkg.json'), join(root, 'package.json'));
    symlinkSync(join(outside, 'src'), join(root, 'linked'));
    const p = readProduct(root);
    assert.equal(p.readme, null);
    assert.equal(p.package, null);
    assert.deepEqual(p.analytics.map((a) => a.name), ['inside_event']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('verifier #336: event names are the event, never a user id, a partial string or a guess', () => {
  const root = project({
    'server/track.py': 'posthog.capture("user-123", "signed_up")\nanalytics.track("f4ca124298", "Signed Up")\n',
    'lib/a.ts': [
      'posthog.capture("user\'s thing")',
      "posthog.capture('prefix_' + kind)",
      "posthog?.capture('optional_chain')",
      "posthog.capture(userId, 'server_event')",
      "posthog.capture('distinct', 'node_server_event')",
      '// posthog.capture(\'in_a_comment\')',
      " * analytics.track('in_jsdoc')",
      "config.variation('not-a-flag')",
      "client.track('another_client')",
      "ldClient.variation('real-flag', false)",
    ].join('\n'),
  });
  try {
    const p = readProduct(root);
    assert.deepEqual(
      p.analytics.map((a) => `${a.vendor}:${a.name}`),
      [
        "PostHog:user's thing",
        'PostHog:null',
        'PostHog:optional_chain',
        'PostHog:null',
        'PostHog:node_server_event',
        'PostHog:signed_up',
        'Segment:Signed Up',
      ]
    );
    assert.deepEqual(p.flags.map((f) => `${f.vendor}:${f.name}`), ['LaunchDarkly:real-flag']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier #336: routes under apps/*/src/app; a folder named for credentials is a route, not a secret', () => {
  assert.deepEqual(
    readRoutes(['apps/web/src/app/pricing/page.tsx', 'app/flag-credentials/[slug]/page.tsx']).map((x) => x.path),
    ['/flag-credentials/[slug]', '/pricing']
  );
  for (const path of ['.npmrc', 'home/.netrc', 'keys/id_rsa', 'AuthKey_ABC.p8', 'infra/terraform.tfstate']) assert.match(path, SECRET_PATH, path);
  assert.doesNotMatch('app/flag-credentials/[slug]/page.tsx', SECRET_PATH);
});

test('verifier #336: a README that is a folder or too big is not read; symlinks skipped are said', () => {
  const root = project({ 'README.md/x.txt': 'not a file', 'big/package.json': '{}' });
  try {
    assert.equal(readProduct(root).readme, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const big = project({ 'README.md': `# Big\n\n${'x'.repeat(300 * 1024)}\n`, 'a.ts': 'x' });
  try {
    symlinkSync(join(big, 'a.ts'), join(big, 'b.ts'));
    const p = readProduct(big);
    assert.equal(p.readme, null);
    assert.match(formatProduct(p), /1 symlinks \(never followed\)/);
  } finally {
    rmSync(big, { recursive: true, force: true });
  }
});

test('codex round 2 #336: a folder that is a secret store is never entered; a multiline call is read; package facts cite their line', () => {
  const root = project({
    'secrets/tracking.ts': "posthog.capture('inside_secrets')\n",
    '.ssh/config.ts': "posthog.capture('inside_ssh')\n",
    'app/flag-credentials/page.tsx': "posthog.capture('route_kept')\n",
    'lib/multi.ts': "posthog.capture(\n  'signed_up',\n  { plan },\n)\n",
    'package.json': '{\n  "name": "tiendas",\n  "description": "Online shops"\n}\n',
  });
  try {
    const p = readProduct(root);
    const names = p.analytics.map((a) => a.name);
    assert.ok(!names.includes('inside_secrets') && !names.includes('inside_ssh'), names.join());
    assert.ok(names.includes('route_kept') && names.includes('signed_up'), names.join());
    assert.equal(p.skipped.secret, 2, 'secrets/ and .ssh/ are both secret folders, counted and never entered');
    assert.deepEqual(p.package.at, { name: 'package.json:2', description: 'package.json:3', keywords: 'package.json' });
    assert.match(formatProduct(p), /Description \.+ Online shops \(package\.json:3\)/);
    for (const dir of ['secrets', 'Secret', '.ssh', '.aws']) assert.match(dir, SECRET_DIR, dir);
    for (const dir of ['keys', 'private', 'credentials', 'certs', 'flag-credentials', 'secret-santa-app']) assert.doesNotMatch(dir, SECRET_DIR, dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier round 2 #336: words containing sk- or sk_ are not keys; the join only follows a call, never a comment', () => {
  const root = project({
    'README.md': '# Task-management for small teams\n\nA desk-reservation tool.\n',
    'app/keys/page.tsx': 'export default function K() { return null }\n',
    'src/i18n/keys/en.ts': "posthog.capture('i18n_folder_read')\n",
    'lib/a.ts': [
      "posthog.capture('task_completed')",
      "analytics.track('risk_assessment_viewed')",
      'bar(',
      "  // posthog.capture('commented_next_line')",
      ')',
      'foo(',
      '  posthog.capture(dyn)',
      ')',
      'class C { #private = 1 }',
    ].join('\n'),
  });
  try {
    const p = readProduct(root);
    assert.equal(p.readme.title.text, 'Task-management for small teams');
    assert.equal(p.readme.paragraph.text, 'A desk-reservation tool.');
    assert.ok(p.routes.some((r) => r.path === '/keys'), 'a keys/ route is read');
    assert.deepEqual(
      p.analytics.map((a) => `${a.name}@${a.at}`),
      ['task_completed@lib/a.ts:1', 'risk_assessment_viewed@lib/a.ts:2', 'null@lib/a.ts:7', 'i18n_folder_read@src/i18n/keys/en.ts:1']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier round 3 #336: a # comment is a comment in Python and Ruby, and a private field in JS is not', () => {
  const root = project({
    'a.py': "#posthog.capture('py_hash_nospace')\n    #posthog.capture('uid', 'py_indented')\nposthog.capture('uid', 'py_real')\n",
    'b.rb': "#analytics.track('rb_comment')\nanalytics.track('uid', 'rb_real')\n",
    'c.ts': "class C { #x = 1 }\nposthog.capture('ts_real')\n",
  });
  try {
    assert.deepEqual(readProduct(root).analytics.map((a) => a.name), ['py_real', 'rb_real', 'ts_real']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
