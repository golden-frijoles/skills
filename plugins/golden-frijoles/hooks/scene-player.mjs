// scene-player.mjs — the screensaver's scenes, as the band plays them (screensaver S2). Pure, like build-view.mjs.
//
// A scene is rendered once per size by scene-render.mjs, in its own Node process (the drawing sandbox is too slow to
// run one: every scene went over the 1000 ms a drawing may take). What comes back is a clip — a header line and one
// line of palette characters per frame — and this module turns a frame into rows of coloured runs: each terminal cell
// is `▀`, its top pixel the text colour and its bottom pixel the background. The hooks module only paints them.
import { SCENES } from './scenes/index.mjs';

export { SCENES };
export const FPS = 8;
export const SECONDS = 30; // one clip; it loops until the next scene
export const ROTATE_S = 60; // seconds on one scene before the next
export const SLEEP_MIN = 20; // after this long playing it stops, like a monitor going to sleep: the band comes back
export const RENDER_TIMEOUT_MS = 20_000;
export const CAPTION_ROWS = 1;
export const SLACK_ROWS = 1; // the engine's own row under the band, never crowded out
export const MIN_ROWS = 8; // a scene smaller than 32 × 8 cells is not worth drawing
export const MAX_ROWS = 28; // and one larger than 112 × 28 costs more than it shows
export const HEADER_ROWS = 1;

/** The renderer bundled beside this file — the person's own Node runs it, never a file the open repo supplies. */
export const SCENE_RENDER = decodeURIComponent(new URL('./scene-render.mjs', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:\/)/,
  '$1'
);

/** The C × R a scene is drawn at in `room` rows and `columns` columns: 2:1, so C = 4R; null when it would not fit. */
export function sceneSize(room, columns) {
  const rows = Math.min(MAX_ROWS, Math.floor(room), Math.floor((Number.isFinite(columns) ? columns : 80) / 4));
  return rows >= MIN_ROWS ? { cols: rows * 4, rows } : null;
}

/**
 * Where the scene goes (D3, D7): under the whole band when it fits there; else under the band's header alone (the
 * band folds while the scene plays, and comes back with the first key); else nowhere — a terminal too small for
 * a scene gets the band, never a squashed picture. `bandRows` is the band's wrapped height (screensaver.mjs).
 */
export function layoutFor({ maxRows, columns, bandRows }) {
  const total = Number.isFinite(maxRows) ? maxRows : 20;
  const full = sceneSize(total - bandRows - CAPTION_ROWS - SLACK_ROWS, columns);
  if (full) return { ...full, compact: false };
  const folded = bandRows > 0 ? sceneSize(total - HEADER_ROWS - CAPTION_ROWS - SLACK_ROWS, columns) : null;
  return folded ? { ...folded, compact: true } : null;
}

/** The scene `n` steps after the one `seed` starts on. */
export const sceneAt = (seed, n = 0) => SCENES[(((Math.trunc(seed) || 0) + n) % SCENES.length + SCENES.length) % SCENES.length];

/** A scene id as the caption says it: `lake-pichola` → `lake pichola`. */
export const sceneName = (id) => String(id || '').replace(/-/g, ' ');

/** The renderer's command line. */
export function renderArgv(id, { cols, rows }, script = SCENE_RENDER) {
  return ['node', script, '--scene', id, '--cols', String(cols), '--rows', String(rows), '--fps', String(FPS), '--seconds', String(SECONDS)];
}

const HEX = /^#[0-9a-f]{6}$/i;

/** scene-render.mjs's stdout → `{ scene, name, cols, rows, fps, palette, frames }`, or null for anything malformed. */
export function parseClip(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.length);
  if (lines.length < 2) return null;
  let head;
  try {
    head = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  const { v, scene, name, cols, rows, fps, palette } = head ?? {};
  if (v !== 1 || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  if (!Array.isArray(palette) || !palette.length || palette.length > 94 || !palette.every((c) => HEX.test(c))) return null;
  const frames = lines.slice(1);
  const size = cols * rows * 2;
  for (const f of frames) {
    if (f.length !== size) return null;
    for (let i = 0; i < f.length; i++) {
      const k = f.charCodeAt(i) - 33;
      if (k < 0 || k >= palette.length) return null;
    }
  }
  return { scene, name: String(name ?? sceneName(scene)), cols, rows, fps: Number(fps) || FPS, palette, frames };
}

/** One frame as terminal rows of runs: `[[{ top, bottom, n }, …], …]`, neighbouring cells of one pair joined. */
export function rowsOf(clip, frameNo) {
  const f = clip.frames[((frameNo % clip.frames.length) + clip.frames.length) % clip.frames.length];
  const out = [];
  for (let y = 0; y < clip.rows; y++) {
    const runs = [];
    for (let x = 0; x < clip.cols; x++) {
      const top = clip.palette[f.charCodeAt(2 * y * clip.cols + x) - 33];
      const bottom = clip.palette[f.charCodeAt((2 * y + 1) * clip.cols + x) - 33];
      const last = runs[runs.length - 1];
      if (last && last.top === top && last.bottom === bottom) last.n += 1;
      else runs.push({ top, bottom, n: 1 });
    }
    out.push(runs);
  }
  return out;
}

/** The line under the picture: which scene, where it is from, and how to get back. */
export function captionOf(name, { band = true, hint = null } = {}) {
  const back = band ? 'any key returns to the build view' : 'any key wakes it';
  return `  ascii.rest · ${name} — ${back}${hint ? ` · ${hint}` : ''}`;
}
