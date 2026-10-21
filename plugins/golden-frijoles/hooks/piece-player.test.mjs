// piece-player.test.mjs — the pieces, as the band plays them, and the renderer that makes them (screensaver S1.5).
// node:test, Node 18+: the pieces are plain JavaScript (scripts/vendor-ascii-pieces.mjs strips their types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTION_ROWS, HEADER_ROWS, MIN_CROP, MIN_ROWS, PIECES, PIECE_RENDER, SLACK_ROWS, TIGHT_CROP,
  captionOf, cropLines, fitAt, fitting, layoutFor, linesOf, parseClip, renderArgv, runsOf, tooSmallText,
} from './piece-player.mjs';
import { colourCode, colourFrame, renderClip } from './piece-render.mjs';
import { ORIGINALS, catalogOf } from './originals/registry.mjs';
import { ORIGINAL_PIECES } from './originals/catalog.mjs';
import { CATEGORIES, MAX_COLS, MAX_ROWS, metaOf, qualifies, refusal } from '../../../scripts/vendor-ascii-pieces.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED = PIECES.filter((p) => !p.color); // ascii.rest's text pieces; ours are in originals/
const CATALOG = [
  { id: 'tall', name: 'tall', cols: 60, rows: 25 },
  { id: 'cat', name: 'cat', cols: 56, rows: 15 },
  { id: 'wide', name: 'wide', cols: 90, rows: 14 },
  { id: 'fire', name: 'fire', cols: 60, rows: 18, anchor: 'bottom' },
];

test('fitting D3: whole when it fits, cropped by at most a quarter from its anchored side, never too wide, never scaled', () => {
  assert.deepEqual(fitting(22, 100, CATALOG), [
    { id: 'tall', name: 'tall', rows: 22, anchor: 'middle', color: false }, // 25 → 22, within a quarter
    { id: 'cat', name: 'cat', rows: 15, anchor: 'middle', color: false },
    { id: 'wide', name: 'wide', rows: 14, anchor: 'middle', color: false },
    { id: 'fire', name: 'fire', rows: 18, anchor: 'bottom', color: false },
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
  // The Mac app in fullscreen: a band with 10 rows folded. Nothing fits trimming a quarter (cat needs 12), so the tight
  // fit takes what keeps the most of itself, down to half, least cut first — and never a piece wider than the band.
  const tight = layoutFor({ maxRows: 13, columns: 100, bandRows: 16 }, CATALOG);
  assert.equal(tight.compact, true);
  assert.deepEqual(tight.fits.map((f) => [f.id, f.rows]), [['wide', 10], ['cat', 10], ['fire', 10]], 'least cut first; tall loses over half');
  assert.ok(tight.fits.every((f) => f.rows >= MIN_ROWS));
  assert.deepEqual(layoutFor({ maxRows: 13, columns: 80, bandRows: 16 }, CATALOG).fits.map((f) => f.id), ['cat', 'fire'], 'still never too wide');
  assert.equal(fitting(MIN_ROWS - 1, 100, CATALOG, TIGHT_CROP).length, 0, 'never under MIN_ROWS');
  // The real catalog in that same band: something plays.
  assert.ok(layoutFor({ maxRows: 13, columns: 70, bandRows: 16 }).fits.length > 0);
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

test('tooSmallText: what was measured, and what the smallest piece needs', () => {
  assert.match(tooSmallText({ maxRows: 9, columns: 100, bandRows: 16 }, CATALOG), /no piece fits here — 6 free rows × 100 columns, and the smallest needs 8 × 56\./);
  assert.match(tooSmallText(null), /not been drawn here yet/);
});

test('captionOf: the piece, where it is from, and how to get back', () => {
  assert.equal(captionOf('campfire'), 'ascii.rest · campfire — any key returns to the build view');
  assert.equal(captionOf('x', { band: false, hint: 'goldenfrijoles.com' }), 'ascii.rest · x — any key wakes it · goldenfrijoles.com');
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
  assert.ok(VENDORED.length >= 60, `${VENDORED.length} pieces`);
  for (const p of VENDORED) {
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
  assert.equal(files.length, VENDORED.length);
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

test('originals D1: the catalog the band reads is exactly the pieces, in colour, at their own size, in a band\'s room', async () => {
  assert.deepEqual(ORIGINAL_PIECES, catalogOf(), 'run `node hooks/originals/registry.mjs` and paste it into catalog.mjs');
  assert.equal(ORIGINAL_PIECES.length, 15);
  assert.equal(new Set(PIECES.map((p) => p.id)).size, PIECES.length, 'ids are unique across both catalogs');
  for (const [id, { meta, make }] of Object.entries(ORIGINALS)) {
    assert.ok(id.startsWith('gf-') && meta.cols <= MAX_COLS && meta.rows <= MAX_ROWS, id);
    const clip = parseClip(renderClip({ meta, default: make }, { id, fps: 4, seconds: 2 }));
    assert.deepEqual([clip.cols, clip.rows, clip.frames.length, clip.colors.length], [meta.cols, meta.rows, 8, 8], id);
    for (const f of [clip.frames[0], clip.frames[7]]) assert.ok(f.length === meta.rows && f.every((l) => [...l].length === meta.cols), `${id} frame size`);
    assert.notEqual(clip.colors[1], clip.colors[7], `${id} moves`);
    assert.ok(new Set(clip.colors[7]).size > 6, `${id} has colour`);
  }
});

test('originals are loop-safe and deterministic: the same time gives the same frame', () => {
  for (const [id, { meta, make }] of Object.entries(ORIGINALS)) {
    const a = renderClip({ meta, default: make }, { id, fps: 5, seconds: 3 }), b = renderClip({ meta, default: make }, { id, fps: 5, seconds: 3 });
    assert.equal(a, b, id);
  }
});

test('colourCode / colourFrame / parseClip: 12-bit colour, 2 characters, round trip and refusal', () => {
  assert.equal(colourCode(0x000000, 0xffffff), 'AA');
  assert.equal(colourCode(-1, 0xffffff), '//', 'no colour is the given default (white here)');
  assert.equal(colourCode(0xffffff, 0), '//');
  assert.equal(colourCode(0xf80000, 0), '8A', 'red rounds to 4 bits: f8 → f');
  const f = { ch: ['ab', 'c '], fg: [0xff0000, -1, 0x00ff00, 0], bg: [0, 0, 0x0000ff, -1] };
  const text = colourFrame(f);
  assert.equal(text.split('\u0001')[0], 'ab\nc ');
  assert.equal(text.split('\u0001')[1].length, 4 * 4);
  const clip = parseClip([JSON.stringify({ v: 3, piece: 'x', name: 'x', cols: 2, rows: 2, fps: 1 }), JSON.stringify(text)].join('\n'));
  assert.deepEqual([clip.cols, clip.rows, clip.frames[0], clip.colors.length], [2, 2, ['ab', 'c '], 1]);
  const short = [JSON.stringify({ v: 3, piece: 'x', name: 'x', cols: 2, rows: 2, fps: 1 }), JSON.stringify('ab\nc \u0001AA')].join('\n');
  assert.equal(parseClip(short), null, 'colours of the wrong length are refused, not painted wrong');
  assert.equal(parseClip(['{"v":9,"cols":1,"rows":1}', '"x"'].join('\n')), null);
});

test('runsOf: neighbours of one colour pair merge, a space never splits a run, and the crop keeps the colours with their rows', () => {
  const cell = (fg, bg) => colourCode(fg, 0) + colourCode(bg, 0);
  const red = 0xff0000, blue = 0x0000ff;
  // 3 columns × 3 rows: row 0 red-on-blue ▀▀ then a space; row 1 the same; row 2 a different colour.
  const rows = ['▀▀ ', '▀▀ ', '▀▀▀'];
  const colors = [cell(red, blue) + cell(red, blue) + cell(0x00ff00, blue), cell(red, blue) + cell(red, blue) + cell(0x00ff00, blue), cell(0x00ff00, 0) + cell(0x00ff00, 0) + cell(0x00ff00, 0)].join('');
  const clip = { cols: 3, rows: 3, frames: [rows], colors: [colors] };
  const all = runsOf(clip, 0, { rows: 3, anchor: 'middle' });
  assert.deepEqual(all[0].map((r) => r.text), ['▀▀ '], 'equal pairs merge, and a space joins the run on its own background');
  assert.deepEqual(runsOf({ ...clip, frames: [['▀▀▀', rows[1], rows[2]]], colors: [cell(red, blue).repeat(3) + colors.slice(12)] }, 0, { rows: 3 })[0].map((r) => r.text), ['▀▀▀'], 'three of one pair are one run');
  assert.equal(all[0][0].fg, '#ff0000');
  assert.equal(all[0][0].bg, '#0000ff');
  const bottom = runsOf(clip, 0, { rows: 1, anchor: 'bottom' });
  assert.equal(bottom.length, 1);
  assert.equal(bottom[0][0].fg, '#00ff00', 'the bottom row keeps its own colours after the crop');
  assert.equal(runsOf(clip, 3, { rows: 1, anchor: 'top' })[0][0].fg, '#ff0000', 'looped; the top row keeps its own');
});

test('fitAt D1: a run opens on one of our colour pieces and plays them all before any ascii.rest piece', () => {
  const fits = [{ id: 'a', color: true }, { id: 'b', color: true }, { id: 'c', color: true }, { id: 'x' }, { id: 'y' }];
  for (let seed = 0; seed < 9; seed++) assert.ok(fitAt(fits, seed, 0).color, `seed ${seed} opens on ours`);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => fitAt(fits, 1, n).id), ['b', 'c', 'x', 'y', 'a', 'b']);
  assert.equal(fitAt(fits.filter((f) => !f.color), 7, 0).id, 'y', 'no colour piece fits: the old walk');
  assert.equal(captionOf('x', { from: 'golden frijoles' }), 'golden frijoles · x — any key returns to the build view');
});
