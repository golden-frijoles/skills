// read-product.test.mjs — the product read setup drafts from (setup-drafts-strategy D1–D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SECRET_PATH, formatProduct, readProduct, readRoutes, walk } from './read-product.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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
  '.env.local': "POSTHOG_KEY=phc_should_never_be_read\nposthog.capture('from_env')\n",
  'config/secrets.ts': "posthog.capture('from_a_secret_file')\n",
  'lib/leak.ts': "const k = 'sk-abcdefghijklmnopqrstuvwxyz'; posthog.capture('leaky_line')\n",
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
    assert.deepEqual(p.routes, ['/', '/about', '/checkout'], 'route groups dropped, api routes are not pages');
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
    for (const never of ['from_env', 'phc_should', 'from_a_secret_file', 'leaky_line', 'sk-abcdef', 'only_in_a_test', 'from_a_dependency'])
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
  assert.deepEqual(readRoutes(['apps/web/app/settings/page.tsx', 'pages/index.tsx', 'pages/_app.tsx', 'pages/api/x.ts']), [
    '/',
    '/settings',
  ]);
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
    assert.equal(spawnSync(process.execPath, [join(HERE, 'read-product.mjs'), '--root'], { encoding: 'utf8' }).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
