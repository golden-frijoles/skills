// piece-player.test.mjs — the pieces, as the band plays them, and the renderer that makes them (screensaver S1.5).
// node:test, Node 18+: the pieces are plain JavaScript (scripts/vendor-ascii-pieces.mjs strips their types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTION_ROWS, HEADER_ROWS, MIN_CROP, PIECES, PIECE_RENDER, SLACK_ROWS,
  captionOf, cropLines, fitAt, fitting, layoutFor, linesOf, parseClip, renderArgv,
} from './piece-player.mjs';
import { renderClip } from './piece-render.mjs';
import { CATEGORIES, MAX_COLS, MAX_ROWS, metaOf, qualifies, refusal } from '../../../scripts/vendor-ascii-pieces.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = [
  { id: 'tall', name: 'tall', cols: 60, rows: 25 },
  { id: 'cat', name: 'cat', cols: 56, rows: 15 },
  { id: 'wide', name: 'wide', cols: 90, rows: 14 },
  { id: 'fire', name: 'fire', cols: 60, rows: 18, anchor: 'bottom' },
];

test('fitting D3: whole when it fits, cropped by at most a quarter from its anchored side, never too wide, never scaled', () => {
  assert.deepEqual(fitting(22, 100, CATALOG), [
    { id: 'tall', name: 'tall', rows: 22, anchor: 'middle' }, // 25 → 22, within a quarter
    { id: 'cat', name: 'cat', rows: 15, anchor: 'middle' },
    { id: 'wide', name: 'wide', rows: 14, anchor: 'middle' },
    { id: 'fire', name: 'fire', rows: 18, anchor: 'bottom' },
  ]);
  assert.deepEqual(fitting(22, 80, CATALOG).map((f) => f.id), ['tall', 'cat', 'fire'], 'wide is never cut at the sides');
  assert.deepEqual(fitting(14, 100, CATALOG).map((f) => [f.id, f.rows]), [['cat', 14], ['wide', 14], ['fire', 14]]);
  assert.equal(Math.ceil(18 * MIN_CROP), 14);
  assert.deepEqual(fitting(5, 100, CATALOG), [], 'a short band gets none');
});

test('layoutFor D3/D7: under the whole band when a piece fits; else under its header (folded); else nowhere', () => {
  const extra = CAPTION_ROWS + SLACK_ROWS;
  const full = layoutFor({ maxRows: 40, columns: 100, bandRows: 12 }, CATALOG);
  assert.equal(full.compact, false);
  assert.equal(full.fits.length, 4);
  // 24 rows, a 16-row band: 6 left — nothing fits beside it, so the band folds to its header.
  const folded = layoutFor({ maxRows: 24, columns: 100, bandRows: 16 }, CATALOG);
  assert.equal(folded.compact, true);
  assert.deepEqual(folded.fits.map((f) => f.rows), [24 - HEADER_ROWS - extra, 15, 14, 18].map((r) => Math.min(r, 24 - HEADER_ROWS - extra)));
  assert.equal(layoutFor({ maxRows: 10, columns: 100, bandRows: 16 }, CATALOG), null, 'too small even folded');
  assert.equal(layoutFor({ maxRows: 40, columns: 30, bandRows: 0 }, CATALOG), null, 'too narrow for every piece');
});

test('fitAt / renderArgv: the seed picks a piece, rotation walks the fits, the argv is the bundled renderer', () => {
  const fits = fitting(30, 100, CATALOG);
  assert.equal(fitAt(fits, 0).id, 'tall');
  assert.equal(fitAt(fits, 1, 2).id, 'fire');
  assert.equal(fitAt(fits, -1).id, 'fire', 'any seed lands on a fit');
  assert.deepEqual(renderArgv('cat', '/p/piece-render.mjs'), ['node', '/p/piece-render.mjs', '--piece', 'cat', '--fps', '10', '--seconds', '30']);
  assert.match(PIECE_RENDER, /hooks\/piece-render\.mjs$/, "the copy beside this file, never the open repo's");
});

const clipText = (frames, head = {}) =>
  [JSON.stringify({ v: 2, piece: 'p', name: 'a piece', cols: 4, rows: 3, fps: 10, ...head }), ...frames.map((f) => JSON.stringify(f))].join('\n');

test('parseClip: the renderer\'s output, and nothing malformed', () => {
  const ok = parseClip(clipText(['ab\ncd\nef', 'gh\nij\nkl']));
  assert.equal(ok.name, 'a piece');
  assert.deepEqual(ok.frames[1], ['gh', 'ij', 'kl']);
  for (const bad of ['', 'not json\n"x"', clipText([]), clipText(['x'], { v: 1 }), clipText(['x'], { cols: 0 }), `${clipText(['x'])}\n42`, `${clipText(['x'])}\n{nope`])
    assert.equal(parseClip(bad), null, JSON.stringify(bad.slice(0, 40)));
});

test('cropLines / linesOf: frames loop, crop from the anchor, and pad to the piece\'s width so it never jitters', () => {
  const lines = ['a', 'b', 'c', 'd'];
  assert.deepEqual(cropLines(lines, 2, 'bottom'), ['c', 'd']);
  assert.deepEqual(cropLines(lines, 2, 'top'), ['a', 'b']);
  assert.deepEqual(cropLines(lines, 2, 'middle'), ['b', 'c']);
  assert.deepEqual(cropLines(lines, 9), lines);
  const clip = parseClip(clipText(['ab\ncd\nef', 'gh\nij\nkl']));
  assert.deepEqual(linesOf(clip, 0, { rows: 2, anchor: 'bottom' }), ['cd  ', 'ef  ']);
  assert.deepEqual(linesOf(clip, 3), ['gh  ', 'ij  ', 'kl  '], 'the clip loops');
});

test('captionOf: the piece, where it is from, and how to get back', () => {
  assert.equal(captionOf('campfire'), '  ascii.rest · campfire — any key returns to the build view');
  assert.equal(captionOf('x', { band: false, hint: 'goldenfrijoles.com' }), '  ascii.rest · x — any key wakes it · goldenfrijoles.com');
});

test('piece-render.mjs: a real piece renders to a clip parseClip reads, at its own size', () => {
  const out = execFileSync(process.execPath, [join(HERE, 'piece-render.mjs'), '--piece', 'campfire', '--fps', '2', '--seconds', '1'], { encoding: 'utf8' });
  const clip = parseClip(out);
  const meta = PIECES.find((p) => p.id === 'campfire');
  assert.deepEqual([clip.cols, clip.rows, clip.frames.length, clip.name], [meta.cols, meta.rows, 2, 'campfire']);
  assert.ok(clip.frames[0].join('').trim().length > 20, 'a picture, not a blank');
  assert.throws(() => execFileSync(process.execPath, [join(HERE, 'piece-render.mjs'), '--piece', 'nope'], { stdio: 'pipe' }));
});

test('every vendored piece renders at its declared size, from an allowed category, in one ink', async () => {
  assert.ok(PIECES.length >= 60, `${PIECES.length} pieces`);
  for (const p of PIECES) {
    assert.ok(CATEGORIES.includes(p.category), `${p.id}: ${p.category}`);
    assert.ok(p.cols <= MAX_COLS && p.rows <= MAX_ROWS, p.id);
    const piece = await import(`./pieces/${p.id}.mjs`);
    assert.equal(piece.meta.palette, undefined, `${p.id} is one ink`);
    const clip = parseClip(renderClip(piece, { id: p.id, fps: 2, seconds: 1 }));
    assert.equal(clip.frames[1].length, p.rows, `${p.id} rows`);
    assert.ok(clip.frames[1].every((l) => [...l].length <= p.cols), `${p.id} cols`);
  }
});

test('the vendored pieces are pure: no import, no network, no process, no eval — the guard has teeth too', () => {
  const dir = join(HERE, 'pieces');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs');
  assert.equal(files.length, PIECES.length);
  for (const f of files) assert.equal(refusal(readFileSync(join(dir, f), 'utf8')), null, f);
  assert.match(refusal('import x from "y";'), /imports/);
  assert.equal(refusal('import type { A } from "y";'), null, 'a type import is stripped');
  for (const bad of ['fetch("u")', 'process.exit()', 'eval("1")', 'new Function("x")', 'globalThis.x', 'await import("x")'])
    assert.ok(refusal(bad), bad);
  assert.equal(refusal('// a comment that says fetch( and process.\nconst a = 1;'), null, 'comments are not code');
});

test('qualifies: the product owner\'s categories only (no logos, companies, distros, scenes), one ink, a band\'s size', () => {
  const src = (category, extra = '') => `export const meta = {\n  name: "x",\n  category: "${category}",\n  cols: 60,\n  rows: 20,\n${extra}};`;
  assert.equal(qualifies(metaOf(src('nature'))), true);
  for (const no of ['logos', 'companies', 'distros', 'scenes', 'ui', 'data', 'type']) assert.equal(qualifies(metaOf(src(no))), false, no);
  assert.equal(qualifies(metaOf(src('nature', '  palette: ["#000000"],\n'))), false, 'a palette is a canvas piece');
  assert.equal(qualifies(metaOf(src('nature').replace('cols: 60', 'cols: 120'))), false, 'too wide for a band');
});
