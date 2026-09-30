import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSurface, SURFACE_KINDS } from './lib/surface.mjs';
import { renderSketch } from './sketch-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'sketch-render.mjs');
const SNAPSHOT = join(HERE, 'sketch-render.snapshot.html');

// Every kind, with its facts, a trailing empty column, a count over the drawing cap, a kind with no words, and words
// that would be markup if they were not escaped.
const ALL_KINDS = parseSurface(
  [
    'state: every-kind',
    'route: /app/sketch/[projectSlug]',
    '- head "Features" action "+ New feature"',
    '- answer "Which features are live, and which are <script>alert(1)</script> & \\"dark\\"?"',
    '- summary count 4',
    '- tiles count 14',
    '- toolbar',
    '- list columns "feature | state in production | type & risk |"',
    '- empty "No features yet"',
    '- card "It\'s a card"',
    '- steps count 3',
    '- field "Key"',
    '- tabs "Value | Environments | Funnel"',
    '- note',
  ].join('\n'),
  'every-kind.surface'
);

test('snapshot: all twelve kinds, drawn', () => {
  const html = renderSketch([ALL_KINDS], { title: 'Sketch — every-kind' });
  if (process.env.UPDATE_SNAPSHOT === '1') writeFileSync(SNAPSHOT, html);
  assert.equal(
    html,
    readFileSync(SNAPSHOT, 'utf8'),
    'rerun with UPDATE_SNAPSHOT=1 if the change is intended'
  );
  // The snapshot could be regenerated without a kind; this cannot.
  for (const kind of Object.keys(SURFACE_KINDS))
    assert.ok(html.includes(`data-kind="${kind}"`), `no ${kind} drawn`);
});

test('facts are drawn: a count as boxes (capped at 12 with the true number), columns as header words', () => {
  const html = renderSketch([ALL_KINDS]);
  const inBlock = (kind) => html.split(`data-kind="${kind}"`)[1].split('data-kind=')[0];
  assert.equal(inBlock('summary').match(/class="stat"/g).length, 4);
  assert.equal(inBlock('tiles').match(/class="tile"/g).length, 12);
  assert.match(inBlock('tiles'), /×14/);
  assert.equal(inBlock('steps').match(/class="dot"/g).length, 3);
  assert.match(inBlock('list'), /<span>type &amp; risk<\/span><span><\/span><\/div>/);
  assert.match(inBlock('head'), /class="button">\+ New feature</);
  assert.match(inBlock('tabs'), /class="tab on">Value</);
  assert.match(inBlock('note'), /class="bar"/, 'a kind with no words still draws its shape');
});

test('every word is escaped; the page has no script and no external URL', () => {
  const html = renderSketch([ALL_KINDS]);
  assert.ok(!html.includes('<script'), 'a word became markup');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;dark&quot;/);
  assert.match(html, /It&#39;s a card/);
  assert.doesNotMatch(html, /https?:|@import|<link|src=/i);
});

test('greys only: every colour in the page has R = G = B', () => {
  const html = renderSketch([ALL_KINDS]);
  const hexes = html.match(/#[0-9a-f]{3,6}\b/gi) ?? [];
  assert.ok(hexes.length > 5, 'found no colours at all — the check is not looking at the style');
  for (const hex of hexes) {
    const digits = hex.slice(1);
    const [r, g, b] =
      digits.length === 3 ? [...digits] : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
    assert.ok(
      r.toLowerCase() === g.toLowerCase() && g.toLowerCase() === b.toLowerCase(),
      `${hex} is not a grey`
    );
  }
  assert.doesNotMatch(html, /rgba?\(|hsla?\(|oklch\(|\b(red|green|blue|orange|yellow|purple|gold|teal)\b/i);
});

test('imports only node:* and the parser — never the design system (D4)', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  // `import … from`, bare `import '…'`, `import('…')` and `export … from` — every way an ES module pulls another in.
  const specifiers = [
    ...source.matchAll(/\b(?:import|export)\s*(?:[^'"();]*?\bfrom\s*)?\(?\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  assert.doesNotMatch(
    source,
    /\bcreateRequire\b|\brequire\(/,
    'a CommonJS escape hatch around the import scan'
  );
  assert.ok(specifiers.includes('./lib/surface.mjs'), `the scan found ${JSON.stringify(specifiers)}`);
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier === './lib/surface.mjs',
      `sketch-render.mjs imports ${specifier}`
    );
  }
});

function run(args, cwd) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

test('CLI: a seed with two blocks, a bare .surface file, and the default temp output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-render-'));
  writeFileSync(
    join(dir, 'seed.md'),
    '# Seed\n\n```surface\nstate: a\nroute: /a\n- head "A"\n```\n\n```surface\nstate: b\nroute: /b\n- list\n```\n'
  );
  const two = run(['seed.md', '--out', 'out.html'], dir);
  assert.equal(two.code, 0, two.stderr);
  assert.equal(two.stdout, 'out.html');
  assert.equal(readFileSync(join(dir, 'out.html'), 'utf8').match(/<section>/g).length, 2);

  writeFileSync(join(dir, 'one.surface'), 'state: one\nroute: /one\n- empty "Nothing yet"\n');
  const bare = run(['one.surface'], dir);
  assert.equal(bare.code, 0, bare.stderr);
  assert.equal(bare.stdout, join(tmpdir(), 'sketch-one.html'));
  assert.ok(existsSync(bare.stdout));
});

test('CLI: a malformed line fails with the file, the line, the suggestion and the known kinds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-render-'));
  writeFileSync(
    join(dir, 'bad.md'),
    'intro\n\n```surface\nstate: a\nroute: /a\n- lsit columns "a | b"\n```\n'
  );
  const bad = run(['bad.md', '--out', 'x.html'], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^bad\.md:6: unknown kind `lsit` — did you mean `list`\? Known kinds: head, /);
  assert.ok(!existsSync(join(dir, 'x.html')), 'a failed parse wrote a page');
});

test('CLI: no surface block is a failure, and so is a bad argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-render-'));
  writeFileSync(join(dir, 'plain.md'), '# Nothing to draw\n\n```js\nx\n```\n');
  const none = run(['plain.md'], dir);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /plain\.md: no `surface` block/);
  assert.equal(run([], dir).code, 2);
  assert.equal(run(['plain.md', '--wat'], dir).code, 2);
  assert.equal(run(['plain.md', '--out'], dir).code, 2);
});
