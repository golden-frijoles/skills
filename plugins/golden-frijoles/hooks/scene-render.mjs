#!/usr/bin/env node
// scene-render.mjs — render one ascii.rest scene into a clip the band can play (screensaver S2).
//
//   node scene-render.mjs --scene <id> --cols <C> --rows <R> [--fps 8] [--seconds 30]
//
// WHY A PROCESS: a scene is 200×100 colour cells, and building one costs 12–280 ms in Node. The band's drawing runs
// in the engine's sandbox, measured ~10× slower — every scene went over the 1000 ms a drawing may take, and the engine
// unmounted it. So the scene runs HERE, in the person's own Node (the same way the band runs its resolver), once per
// scene and size, and the hooks module only paints the frames it gets back.
//
// HOW IT KEEPS THE PICTURE: each cell is a dot (` ·•●`) in a palette colour on the scene's ground; its colour is the
// two mixed by the dot's size. The picture is box-averaged down to C × 2R pixels — never stretched: 200×100 is 2:1,
// so C = 4R and every terminal cell is two square pixels, drawn as `▀` (top in the text colour, bottom behind it).
// The clip's colours are fitted to 94 (median cut over the whole clip), one printable character each.
//
// OUTPUT (stdout): line 1 is JSON `{ v, scene, name, cols, rows, fps, palette }`; every next line is one frame,
// C × 2R characters, pixel rows top to bottom. Zero deps, Node 18+.
import { SCENES } from './scenes/index.mjs';
import { isMain } from './vendor/lib/is-main.mjs';

export const ALPHABET = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)); // '!'..'~'
const COVER = { ' ': 0, '·': 0.3, '.': 0.3, '•': 0.6, '●': 1 };

/** `#rrggbb` → [r, g, b]. */
export const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) || 0);
/** [r, g, b] → `#rrggbb`. */
export const hexOf = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** The C × R terminal size a scene is drawn at for `room` rows and `columns` columns: 2:1, so C = 4R. */
export function sceneSize(room, columns, { maxRows = 28, minRows = 8 } = {}) {
  const rows = Math.min(maxRows, Math.floor(room), Math.floor(columns / 4));
  return rows >= minRows ? { cols: rows * 4, rows } : null;
}

/**
 * One frame of a scene as C × 2R RGB pixels: each source cell mixed from ground to its palette colour by its dot's
 * size, then box-averaged. `text` and `color` are what the scene's frame wrote; `src` its meta.
 */
export function downsample(text, color, src, cols, prows) {
  const { cols: W, rows: H } = src;
  const ground = rgbOf(src.ground ?? '#000000');
  const pal = (src.palette ?? []).map(rgbOf);
  const lines = String(text).split('\n');
  const px = new Float32Array(cols * prows * 3);
  for (let py = 0; py < prows; py++) {
    const y0 = Math.floor((py * H) / prows), y1 = Math.max(y0 + 1, Math.floor(((py + 1) * H) / prows));
    for (let pxx = 0; pxx < cols; pxx++) {
      const x0 = Math.floor((pxx * W) / cols), x1 = Math.max(x0 + 1, Math.floor(((pxx + 1) * W) / cols));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        const line = lines[y] ?? '';
        for (let x = x0; x < x1; x++) {
          const k = COVER[line[x]] ?? (line[x] ? 1 : 0);
          const c = pal[color[y * W + x]] ?? ground;
          r += ground[0] + (c[0] - ground[0]) * k;
          g += ground[1] + (c[1] - ground[1]) * k;
          b += ground[2] + (c[2] - ground[2]) * k;
          n++;
        }
      }
      const at = (py * cols + pxx) * 3;
      px[at] = r / n;
      px[at + 1] = g / n;
      px[at + 2] = b / n;
    }
  }
  return px;
}

/** Median cut over every pixel of the clip, on a 5-bit-per-channel histogram: at most `k` colours. */
export function fitPalette(frames, k = ALPHABET.length) {
  const hist = new Map();
  for (const px of frames)
    for (let i = 0; i < px.length; i += 3) {
      const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  const bins = [...hist].map(([key, n]) => ({ c: [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4], n }));
  let boxes = [bins];
  while (boxes.length < k) {
    let best = -1, axis = 0, span = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let a = 0; a < 3; a++) {
        let lo = 255, hi = 0;
        for (const b of box) (lo = Math.min(lo, b.c[a])), (hi = Math.max(hi, b.c[a]));
        if (hi - lo > span) (span = hi - lo), (best = i), (axis = a);
      }
    });
    if (best === -1) break;
    const box = boxes[best].sort((p, q) => p.c[axis] - q.c[axis]);
    const total = box.reduce((s, b) => s + b.n, 0);
    let acc = 0, cut = 1;
    for (; cut < box.length - 1; cut++) if ((acc += box[cut - 1].n) >= total / 2) break;
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    const n = box.reduce((s, b) => s + b.n, 0);
    return [0, 1, 2].map((a) => box.reduce((s, b) => s + b.c[a] * b.n, 0) / n);
  });
}

/** Each pixel's nearest palette colour, one character each. */
export function encode(px, palette) {
  const memo = new Map();
  let out = '';
  for (let i = 0; i < px.length; i += 3) {
    const key = ((px[i] >> 2) << 12) | ((px[i + 1] >> 2) << 6) | (px[i + 2] >> 2);
    let idx = memo.get(key);
    if (idx === undefined) {
      let d = Infinity;
      palette.forEach((c, j) => {
        const e = (c[0] - px[i]) ** 2 + (c[1] - px[i + 1]) ** 2 + (c[2] - px[i + 2]) ** 2;
        if (e < d) (d = e), (idx = j);
      });
      memo.set(key, idx);
    }
    out += ALPHABET[idx];
  }
  return out;
}

/** The whole clip as the text this script prints. `scene` is a module: `{ meta, default }`. */
export function renderClip(scene, { id, cols, rows, fps = 8, seconds = 30 }) {
  const frame = scene.default();
  const color = new Uint8Array(scene.meta.cols * scene.meta.rows);
  const frames = [];
  const n = Math.max(1, Math.round(fps * seconds));
  for (let i = 0; i < n; i++) frames.push(downsample(frame(i / fps, { color }), color, scene.meta, cols, rows * 2));
  const palette = fitPalette(frames);
  const head = { v: 1, scene: id, name: scene.meta.name, cols, rows, fps, palette: palette.map(hexOf) };
  return [JSON.stringify(head), ...frames.map((px) => encode(px, palette))].join('\n');
}

const arg = (argv, name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

async function main(argv) {
  const id = arg(argv, 'scene');
  if (!SCENES.includes(id)) {
    process.stderr.write(`scene-render: no scene "${id}" — one of ${SCENES.join(', ')}\n`);
    process.exit(2);
  }
  const cols = Number(arg(argv, 'cols'));
  const rows = Number(arg(argv, 'rows'));
  if (!(cols > 0 && rows > 0 && cols <= 400 && rows <= 100)) {
    process.stderr.write('scene-render: --cols and --rows must be sizes in cells\n');
    process.exit(2);
  }
  const scene = await import(`./scenes/${id}.mjs`);
  const clip = renderClip(scene, {
    id,
    cols,
    rows,
    fps: Number(arg(argv, 'fps', 8)) || 8,
    seconds: Math.min(60, Number(arg(argv, 'seconds', 30)) || 30),
  });
  process.stdout.write(`${clip}\n`);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
