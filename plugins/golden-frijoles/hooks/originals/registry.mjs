// registry.mjs — the pieces we draw ourselves (screensaver S1.6): the whole modules, loaded only by piece-render.mjs in
// the person's own Node. The band reads catalog.mjs (meta only); a test keeps the two in step.
import { SET as PSYCHEDELIC } from './psychedelic.mjs';
import { SET as ART } from './art.mjs';
import { SET as STORY } from './story.mjs';
import { SET as OWN } from './own.mjs';
import { isMain } from '../vendor/lib/is-main.mjs';

/** `gf-<name>` → `{ meta, make }`; make() returns the frame function `(t) → { cols, rows, ch, fg, bg }`. */
export const ORIGINALS = {};
for (const set of [PSYCHEDELIC, ART, STORY, OWN])
  for (const piece of Object.values(set)) ORIGINALS[`gf-${piece.meta.name}`] = piece;

// Play order: the showpieces first, the kinds alternating so no two neighbours look alike.
const ORDER = ['starry-night', 'jellyfish', 'lorenz', 'balrog-bridge', 'spark', 'the-scream', 'wormhole', 'giants-castle', 'ripples', 'beanstalk', 'disco-fever', 'flow', 'great-wave', 'golden-harp', 'persistence-of-memory'];

/** The catalog entries these pieces need (what catalog.mjs holds), in play order. */
export const catalogOf = (originals = ORIGINALS) =>
  Object.entries(originals).sort(([, a], [, b]) => ORDER.indexOf(a.meta.name) - ORDER.indexOf(b.meta.name)).map(([id, { meta }]) => ({ id, name: meta.name, category: meta.category, cols: meta.cols, rows: meta.rows, color: true }));

if (isMain(import.meta.url)) process.stdout.write(`${JSON.stringify(catalogOf(), null, 2)}\n`);
