// piece-player.mjs — the screensaver's pieces, as the band plays them (screensaver S1.5). Pure, like build-view.mjs.
//
// A piece is rendered once by piece-render.mjs, in its own Node process (the drawing sandbox is too slow for the heavy
// ones), and comes back as a clip: a header line and one JSON string per frame. This module decides which pieces fit
// the room the band leaves — each at its own size, never scaled: centred, or cropped by at most a quarter of its height
// from the side it keeps (D3) — and turns a frame into the lines the band draws.
import { PIECES } from './pieces/index.mjs';

export { PIECES };
export const FPS = 10;
export const SECONDS = 30; // one clip; it loops until the next piece
export const ROTATE_S = 45; // seconds on one piece before the next
export const SLEEP_MIN = 20; // after this long playing it stops, like a monitor going to sleep: the band comes back
export const RENDER_TIMEOUT_MS = 20_000;
export const CAPTION_ROWS = 1;
export const SLACK_ROWS = 1; // the engine's own row under the band, never crowded out
export const HEADER_ROWS = 1;
export const MIN_CROP = 0.75; // a piece may lose at most a quarter of its height to fit, never its width
// …unless nothing fits that way: a short band (the Mac app in fullscreen) takes the piece that keeps the most of itself,
// down to half its height, and never fewer than MIN_ROWS rows. Still never its width, never scaled.
export const TIGHT_CROP = 0.5;
export const MIN_ROWS = 8;

/** The renderer bundled beside this file — the person's own Node runs it, never a file the open repo supplies. */
export const PIECE_RENDER = decodeURIComponent(new URL('./piece-render.mjs', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:\/)/,
  '$1'
);

/** The pieces that fit `room` rows and `columns` columns, in play order: `[{ id, name, rows, anchor }]`. */
export function fitting(room, columns, catalog = PIECES, crop = MIN_CROP) {
  const wide = Number.isFinite(columns) ? columns : 80;
  if (room < MIN_ROWS) return [];
  return catalog
    .filter((p) => p.cols <= wide && Math.ceil(p.rows * crop) <= room)
    .map((p) => ({ id: p.id, name: p.name, rows: Math.min(p.rows, Math.floor(room)), anchor: p.anchor ?? 'middle' }))
    .sort((a, b) => (crop === MIN_CROP ? 0 : loss(a, catalog) - loss(b, catalog))); // tight: the least cut first
}

/**
 * Where the screensaver goes (D3, D7): under the whole band when a piece fits there; else under the band's header alone
 * (the band folds while it plays, and comes back with the first key); else nowhere — a terminal too small for any piece
 * gets the band, never a squashed or cut-off picture. `bandRows` is the band's wrapped height (screensaver.mjs).
 */
export function layoutFor({ maxRows, columns, bandRows }, catalog = PIECES) {
  const { beside, folded } = roomOf({ maxRows, bandRows });
  // In order: beside the band, then folded — first trimming at most a quarter, then (a short band) at most half.
  for (const crop of [MIN_CROP, TIGHT_CROP]) {
    const full = fitting(beside, columns, catalog, crop);
    if (full.length) return { fits: full, compact: false };
    const fold = bandRows > 0 ? fitting(folded, columns, catalog, crop) : [];
    if (fold.length) return { fits: fold, compact: true };
  }
  return null;
}

/** The rows a piece has beside the whole band, and with the band folded to its header. */
export function roomOf({ maxRows, bandRows }) {
  const total = Number.isFinite(maxRows) ? maxRows : 20;
  const beside = total - bandRows - CAPTION_ROWS - SLACK_ROWS;
  return { beside, folded: bandRows > 0 ? total - HEADER_ROWS - CAPTION_ROWS - SLACK_ROWS : beside };
}

/** Why nothing plays, with what was measured — so a "too small" can be told from a band that drew nothing. */
export function tooSmallText(layout, catalog = PIECES) {
  const narrowest = Math.min(...catalog.map((p) => p.cols));
  if (!layout) return 'screensaver: the band has not been drawn here yet — try again in a moment.';
  const { folded } = roomOf(layout);
  const cols = Number.isFinite(layout.columns) ? layout.columns : '?';
  return `screensaver: no piece fits here — ${Math.max(0, folded)} free rows × ${cols} columns, and the smallest needs ${MIN_ROWS} × ${narrowest}. Make the window taller or wider.`;
}

const loss = (fit, catalog) => 1 - fit.rows / (catalog.find((p) => p.id === fit.id)?.rows ?? fit.rows);

/** The fit `n` steps after the one `seed` starts on. */
export const fitAt = (fits, seed, n = 0) => fits[((((Math.trunc(seed) || 0) + n) % fits.length) + fits.length) % fits.length];

/** The renderer's command line. */
export function renderArgv(id, script = PIECE_RENDER) {
  return ['node', script, '--piece', id, '--fps', String(FPS), '--seconds', String(SECONDS)];
}

/** piece-render.mjs's stdout → `{ piece, name, cols, rows, fps, frames }` (each frame its lines), or null if malformed. */
export function parseClip(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.length);
  if (lines.length < 2) return null;
  try {
    const head = JSON.parse(lines[0]);
    const { v, piece, name, cols, rows, fps } = head ?? {};
    if (v !== 2 || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
    const frames = lines.slice(1).map((l) => JSON.parse(l));
    if (!frames.every((f) => typeof f === 'string')) return null;
    return { piece, name: String(name ?? piece), cols, rows, fps: Number(fps) || FPS, frames: frames.map((f) => f.split('\n')) };
  } catch {
    return null;
  }
}

/** The rows of a frame to show: all of them, or `rows` of them kept from the anchored side. */
export function cropLines(lines, rows, anchor = 'middle') {
  if (!Number.isFinite(rows) || rows >= lines.length) return lines;
  const keep = Math.max(1, rows);
  const cut = lines.length - keep;
  const from = anchor === 'top' ? 0 : anchor === 'bottom' ? cut : Math.floor(cut / 2);
  return lines.slice(from, from + keep);
}

/** Frame `frameNo` of a clip as the lines drawn: looped, cropped to the fit, each line padded to the piece's width. */
export function linesOf(clip, frameNo, fit) {
  const f = clip.frames[((frameNo % clip.frames.length) + clip.frames.length) % clip.frames.length];
  return cropLines(f, fit?.rows ?? clip.rows, fit?.anchor).map((l) => l.padEnd(clip.cols));
}

/** The line under the picture: which piece, where it is from, and how to get back. */
export function captionOf(name, { band = true, hint = null } = {}) {
  const back = band ? 'any key returns to the build view' : 'any key wakes it';
  return `ascii.rest · ${name} — ${back}${hint ? ` · ${hint}` : ''}`;
}
