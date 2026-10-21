#!/usr/bin/env node
// piece-render.mjs — render one ascii.rest piece into a clip the band can play (screensaver S1.5).
//
//   node piece-render.mjs --piece <id> [--fps 10] [--seconds 30]
//
// WHY A PROCESS: the band's drawing runs in the engine's sandbox, measured ~10× slower than Node, with 1000 ms a
// drawing may take — a piece whose setup is heavy (doom fire's warm-up) stalled past it and the picture was dropped. So
// a piece runs HERE, in the person's own Node (the same way the band runs its resolver), once per piece, and the hooks
// module only paints the frames it gets back. A piece is text in one ink at its own size: nothing is scaled.
//
// OUTPUT (stdout): line 1 is JSON `{ v: 2, piece, name, cols, rows, fps }`; every next line is one frame, a JSON string
// of `rows` lines of at most `cols` characters. A piece we draw ourselves (originals/, in colour) says `v: 3` and each
// frame string carries its colours after a \u0001: per cell, 2 characters of foreground then 2 of background, 12 bits
// each (4 per channel), 6 bits a character, the alphabet B64 below. Zero deps, Node 18+.
import { PIECES } from './pieces/index.mjs';
import { ORIGINAL_PIECES } from './originals/catalog.mjs';
import { isMain } from './vendor/lib/is-main.mjs';

export const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** A packed 0xRRGGBB (or -1: the terminal's own — white as ink, black as paper) as 2 characters, 4 bits a channel. */
export function colourCode(c, none) {
  const v = c < 0 ? none : c;
  const q = (shift) => Math.min(15, (((v >> shift) & 255) + 8) >> 4);
  const n = (q(16) << 8) | (q(8) << 4) | q(0);
  return B64[n >> 6] + B64[n & 63];
}
/** A colour frame `{ ch, fg, bg }` as the string one clip line holds. */
export function colourFrame(f) {
  let cells = '';
  for (let i = 0; i < f.fg.length; i++) cells += colourCode(f.fg[i], 0xffffff) + colourCode(f.bg[i], 0);
  return `${f.ch.join('\n')}\u0001${cells}`;
}

/** The whole clip as the text this script prints. `piece` is a module: `{ meta, default }`. */
export function renderClip(piece, { id, fps = 10, seconds = 30 }) {
  const frame = piece.default();
  const n = Math.max(1, Math.round(fps * seconds));
  const colour = typeof frame(0, { paper: false }) === 'object';
  const head = { v: colour ? 3 : 2, piece: id, name: piece.meta.name, cols: piece.meta.cols, rows: piece.meta.rows, fps };
  const frames = [];
  for (let i = 0; i < n; i++) {
    const f = frame(i / fps, { paper: false });
    frames.push(JSON.stringify(colour ? colourFrame(f) : f));
  }
  return [JSON.stringify(head), ...frames].join('\n');
}

const arg = (argv, name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

async function main(argv) {
  const id = arg(argv, 'piece');
  const own = ORIGINAL_PIECES.some((p) => p.id === id);
  if (!own && !PIECES.some((p) => p.id === id)) {
    process.stderr.write(`piece-render: no piece "${id}"\n`);
    process.exit(2);
  }
  const piece = own ? await import('./originals/registry.mjs').then(({ ORIGINALS }) => ({ meta: ORIGINALS[id].meta, default: ORIGINALS[id].make })) : await import(`./pieces/${id}.mjs`);
  const fps = Math.min(30, Number(arg(argv, 'fps', 10)) || 10);
  const seconds = Math.min(60, Number(arg(argv, 'seconds', 30)) || 30);
  process.stdout.write(`${renderClip(piece, { id, fps, seconds })}\n`);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
