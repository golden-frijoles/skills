// scene-player.test.mjs — the scenes, as the band plays them, and the renderer that makes them (screensaver S2).
// node:test, Node 18+: the scenes are plain JavaScript (scripts/vendor-ascii-scenes.mjs strips their types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTION_ROWS, HEADER_ROWS, MAX_ROWS, MIN_ROWS, SCENES, SCENE_RENDER, SLACK_ROWS,
  captionOf, layoutFor, parseClip, renderArgv, rowsOf, sceneAt, sceneName, sceneSize,
} from './scene-player.mjs';
import { ALPHABET, downsample, encode, fitPalette, renderClip, rgbOf } from './scene-render.mjs';
import { refusal } from '../../../scripts/vendor-ascii-scenes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('sceneSize: 2:1 — four columns a row — capped, and none below the floor', () => {
  assert.deepEqual(sceneSize(25, 100), { cols: 100, rows: 25 }, 'width-bound');
  assert.deepEqual(sceneSize(12, 200), { cols: 48, rows: 12 }, 'height-bound');
  assert.deepEqual(sceneSize(80, 400), { cols: MAX_ROWS * 4, rows: MAX_ROWS }, 'capped');
  assert.equal(sceneSize(MIN_ROWS - 1, 200), null, 'too short');
  assert.equal(sceneSize(40, MIN_ROWS * 4 - 1), null, 'too narrow');
  for (const [room, cols] of [[9, 37], [21, 84], [28, 120]]) {
    const s = sceneSize(room, cols);
    assert.equal(s.cols, s.rows * 4, `${room}x${cols} keeps 2:1`);
  }
});

test('layoutFor D3/D7: under the whole band when it fits; else under its header (folded); else nowhere', () => {
  const extra = CAPTION_ROWS + SLACK_ROWS;
  assert.deepEqual(layoutFor({ maxRows: 40, columns: 100, bandRows: 12 }), { cols: 100, rows: 25, compact: false });
  // 18 rows, a 12-row band: 4 left — too few beside it, so the band folds to its header and the scene gets 15.
  assert.deepEqual(layoutFor({ maxRows: 18, columns: 100, bandRows: 12 }), { cols: 60, rows: 18 - HEADER_ROWS - extra, compact: true });
  assert.equal(layoutFor({ maxRows: 10, columns: 100, bandRows: 12 }), null, 'too small even folded');
  // No band at all (any folder): the scene takes the room, and there is nothing to fold.
  assert.deepEqual(layoutFor({ maxRows: 20, columns: 100, bandRows: 0 }), { cols: 72, rows: 18, compact: false });
  assert.equal(layoutFor({ maxRows: 9, columns: 100, bandRows: 0 }), null);
});

test('sceneAt / sceneName / renderArgv: the seed picks a scene, rotation walks the list, and the argv is the bundled renderer', () => {
  assert.equal(SCENES.length, 34);
  assert.equal(sceneAt(0), SCENES[0]);
  assert.equal(sceneAt(5, 1), SCENES[6]);
  assert.equal(sceneAt(-1), SCENES.at(-1), 'any seed lands on a scene');
  assert.equal(sceneAt(SCENES.length * 3 + 2), SCENES[2]);
  assert.equal(sceneName('lake-pichola'), 'lake pichola');
  assert.deepEqual(renderArgv('lake-pichola', { cols: 60, rows: 15 }, '/p/scene-render.mjs'), [
    'node', '/p/scene-render.mjs', '--scene', 'lake-pichola', '--cols', '60', '--rows', '15', '--fps', '8', '--seconds', '30',
  ]);
  assert.match(SCENE_RENDER, /hooks\/scene-render\.mjs$/, 'the copy beside this file, never the open repo\'s');
});

const clipText = (frames, { cols = 2, rows = 1, palette = ['#000000', '#ffffff', '#ff0000'] } = {}) =>
  [JSON.stringify({ v: 1, scene: 's', name: 'a scene', cols, rows, fps: 8, palette }), ...frames].join('\n');

test('parseClip: the renderer\'s output, and nothing malformed', () => {
  const ok = parseClip(clipText(['!"#!', '""!!']));
  assert.equal(ok.name, 'a scene');
  assert.equal(ok.frames.length, 2);
  for (const bad of [
    '',
    'not json\n!!!!',
    clipText([]),
    clipText(['!!!']), // short frame
    clipText(['!!!$']), // a character past the palette
    clipText(['!!!!'], { palette: ['red'] }),
    clipText(['!!!!'], { palette: Array(95).fill('#000000') }),
    clipText(['!!!!']).replace('"v":1', '"v":2'),
  ])
    assert.equal(parseClip(bad), null, JSON.stringify(bad.slice(0, 40)));
});

test('rowsOf: each cell is its top and bottom pixel; neighbours of one pair join into one run; frames loop', () => {
  // cols 2, rows 1: pixel row 0 = top, pixel row 1 = bottom. '!' = #000000, '"' = #ffffff, '#' = #ff0000.
  const clip = parseClip(clipText(['!!""', '!#"#']));
  assert.deepEqual(rowsOf(clip, 0), [[{ top: '#000000', bottom: '#ffffff', n: 2 }]]);
  assert.deepEqual(rowsOf(clip, 1), [[{ top: '#000000', bottom: '#ffffff', n: 1 }, { top: '#ff0000', bottom: '#ff0000', n: 1 }]]);
  assert.deepEqual(rowsOf(clip, 2), rowsOf(clip, 0), 'the clip loops');
});

test('captionOf: the scene, where it is from, and how to get back', () => {
  assert.equal(captionOf('lake pichola'), '  ascii.rest · lake pichola — any key returns to the build view');
  assert.equal(captionOf('x', { band: false, hint: 'goldenfrijoles.com' }), '  ascii.rest · x — any key wakes it · goldenfrijoles.com');
});

test('downsample: a dot mixes ground into its colour by its size, then the cells are box-averaged', () => {
  const src = { cols: 2, rows: 2, ground: '#000000', palette: ['#ffffff'] };
  const color = new Uint8Array(4);
  const px = downsample('●●\n  ', color, src, 1, 1); // one pixel from four cells: two full dots, two empty
  assert.deepEqual([...px].map(Math.round), [128, 128, 128]);
  const dots = downsample('·•\n●●', color, src, 2, 2);
  assert.deepEqual([dots[0], dots[3], dots[6]].map(Math.round), [77, 153, 255], '· 0.3, • 0.6, ● 1');
});

test('fitPalette / encode: at most 94 colours, each pixel its nearest, one printable character each', () => {
  const frame = new Float32Array([255, 0, 0, 0, 0, 255, 250, 5, 5, 0, 255, 0]);
  const palette = fitPalette([frame], 3);
  assert.ok(palette.length <= 3);
  const text = encode(frame, palette);
  assert.equal(text.length, 4);
  assert.equal(text[0], text[2], 'near-red and red share a colour');
  assert.ok([...text].every((c) => ALPHABET.includes(c)));
  assert.deepEqual(rgbOf('#0a10ff'), [10, 16, 255]);
});

test('scene-render.mjs: a real scene renders to a clip parseClip reads — at the size asked, 2:1, coloured', () => {
  const out = execFileSync(process.execPath, [join(HERE, 'scene-render.mjs'), '--scene', 'lake-pichola', '--cols', '32', '--rows', '8', '--fps', '2', '--seconds', '1'], {
    encoding: 'utf8',
  });
  const clip = parseClip(out);
  assert.ok(clip, out.slice(0, 200));
  assert.deepEqual([clip.cols, clip.rows, clip.frames.length, clip.name], [32, 8, 2, 'lake pichola']);
  assert.ok(new Set(clip.frames[0]).size > 8, 'a scene, not a flat fill');
  assert.throws(() => execFileSync(process.execPath, [join(HERE, 'scene-render.mjs'), '--scene', 'nope', '--cols', '8', '--rows', '2'], { stdio: 'pipe' }));
});

test('every scene renders a frame at a small size — none throws, every one draws something', async () => {
  for (const id of SCENES) {
    const scene = await import(`./scenes/${id}.mjs`);
    assert.deepEqual([scene.meta.cols, scene.meta.rows], [200, 100], id);
    const clip = parseClip(renderClip(scene, { id, cols: 32, rows: 8, fps: 1, seconds: 1 }));
    assert.ok(clip && new Set(clip.frames[0]).size > 2, id);
  }
});

test('the vendored scenes are pure: no import, no network, no process, no eval — the guard has teeth too', () => {
  const dir = join(HERE, 'scenes');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs');
  assert.equal(files.length, SCENES.length);
  for (const f of files) assert.equal(refusal(readFileSync(join(dir, f), 'utf8')), null, f);
  assert.match(refusal('import x from "y";'), /imports/);
  assert.equal(refusal('import type { A } from "y";'), null, 'a type import is stripped');
  for (const bad of ['fetch("u")', 'process.exit()', 'eval("1")', 'new Function("x")', 'globalThis.x', 'await import("x")'])
    assert.ok(refusal(bad), bad);
  assert.equal(refusal('// a comment that says fetch( and process.\nconst a = 1;'), null, 'comments are not code');
});
