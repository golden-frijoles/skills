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
// of `rows` lines of at most `cols` characters. Zero deps, Node 18+.
import { PIECES } from './pieces/index.mjs';
import { isMain } from './vendor/lib/is-main.mjs';

/** The whole clip as the text this script prints. `piece` is a module: `{ meta, default }`. */
export function renderClip(piece, { id, fps = 10, seconds = 30 }) {
  const frame = piece.default();
  const n = Math.max(1, Math.round(fps * seconds));
  const head = { v: 2, piece: id, name: piece.meta.name, cols: piece.meta.cols, rows: piece.meta.rows, fps };
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(JSON.stringify(frame(i / fps, { paper: false })));
  return [JSON.stringify(head), ...frames].join('\n');
}

const arg = (argv, name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

async function main(argv) {
  const id = arg(argv, 'piece');
  if (!PIECES.some((p) => p.id === id)) {
    process.stderr.write(`piece-render: no piece "${id}"\n`);
    process.exit(2);
  }
  const piece = await import(`./pieces/${id}.mjs`);
  const fps = Math.min(30, Number(arg(argv, 'fps', 10)) || 10);
  const seconds = Math.min(60, Number(arg(argv, 'seconds', 30)) || 30);
  process.stdout.write(`${renderClip(piece, { id, fps, seconds })}\n`);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
