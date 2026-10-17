// check-is-main.test.mjs — the guard fires on every hand-rolled entry check found in the tree, and only on those.
// Run: node --test scripts/check-is-main.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, scan } from './check-is-main.mjs';

// The six spellings the 59 entries used before template-scripts-consumer-gates (D4), verbatim.
const SPELLINGS = {
  'resolve, lexical': 'const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
  'bare ===': 'if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();',
  pathToFileURL: 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()',
  'resolve both sides':
    'if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {',
  'realpath one side':
    'const isMain = (() => {\n  try {\n    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);',
  endsWith: "const isMain = process.argv[1] && process.argv[1].endsWith('init.mjs');",
};

test('fires on each of the six spellings', () => {
  for (const [name, text] of Object.entries(SPELLINGS)) {
    assert.equal(scan('template/scripts/x.mjs', text).length, 1, `should fire: ${name}`);
  }
});

test('fires when the comparison is split across lines (the window, not one line)', () => {
  const split = [
    'const isMain = (() => {',
    '  if (!process.argv[1]) return false;',
    '  try {',
    '    return realpathSync(process.argv[1]) ===',
    '      realpathSync(fileURLToPath(import.meta.url));',
  ].join('\n');
  // argv[1] and import.meta.url on DIFFERENT lines: only the window catches it (WINDOW = 0 must fail this; verifier, #399)
  assert.ok(scan('plugins/a.mjs', split).length >= 1);
});

test('does NOT fire on the helper, a plain argv read, a comment, or the call itself', () => {
  const owner = 'export function isMain(metaUrl, argv1 = process.argv[1]) {\n  return realpathSync(fileURLToPath(metaUrl));';
  assert.deepEqual(scan('template/scripts/lib/is-main.mjs', owner), []);
  assert.deepEqual(scan('plugins/golden-frijoles/skills/refine/vendor/lib/is-main.mjs', owner), []);
  const quiet = [
    'if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));',
    "const target = process.argv[1] ?? 'x';",
    '// once: resolve(process.argv[1]) === fileURLToPath(import.meta.url)',
    ' * `process.argv[1]` is compared with `import.meta.url` here',
  ];
  for (const line of quiet) assert.deepEqual(scan('template/scripts/x.mjs', line), [], `should not fire: ${line}`);
});

test('reports the file and the 1-based line', () => {
  const hits = scan('template/scripts/x.mjs', `a\nb\n${SPELLINGS['bare ===']}\n`);
  assert.deepEqual(
    hits.map((h) => [h.rel, h.line]),
    [['template/scripts/x.mjs', 3]]
  );
});

test('main: 0 clean, 1 on a finding, 2 when a scanned directory is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'is-main-guard-'));
  try {
    const dirs = ['template/scripts', 'plugins'];
    for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
    const quiet = { log: () => {}, error: () => {} };
    writeFileSync(join(root, 'template/scripts/ok.mjs'), "if (isMain(import.meta.url)) main();\n");
    assert.equal(main({ root, dirs, ...quiet }), 0);
    writeFileSync(join(root, 'plugins/bad.mjs'), `${SPELLINGS['resolve, lexical']}\n`);
    writeFileSync(join(root, 'plugins/bad.test.mjs'), `${SPELLINGS['resolve, lexical']}\n`); // tests are not scanned
    const out = [];
    assert.equal(main({ root, dirs, log: () => {}, error: (l) => out.push(l) }), 1);
    assert.match(out.join('\n'), /plugins\/bad\.mjs:1/);
    assert.doesNotMatch(out.join('\n'), /bad\.test\.mjs/);
    assert.equal(main({ root, dirs: ['nope'], ...quiet }), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
