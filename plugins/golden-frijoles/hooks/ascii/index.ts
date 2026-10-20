// The pieces the screensaver can play. Every file in ./pieces, and ./types.ts, is copied from
// github.com/bas3line/ascii (ascii.rest, MIT — ./LICENSE; credited in the repo's NOTICE), unchanged but for
// doom-fire's warm-up (marked there). Only this index is ours.
//
// Chosen to be text in one ink (no `palette`, so no canvas), self-contained (no runtime imports), and short enough
// to sit in the band above the prompt. Order is the play order; a terminal too short for a piece crops it to at most
// three quarters of its height, from the side `anchor` names, and skips it below that — never scaled, never cut at the
// sides (screensaver.mjs `fitPieces`). To add one: copy its file into ./pieces and add a line here.
import type { Frame, Meta } from './types.ts';
import aurora, { meta as auroraMeta } from './pieces/aurora.ts';
import bonsai, { meta as bonsaiMeta } from './pieces/bonsai.ts';
import cat, { meta as catMeta } from './pieces/cat.ts';
import dnaHelix, { meta as dnaHelixMeta } from './pieces/dna-helix.ts';
import doomFire, { meta as doomFireMeta } from './pieces/doom-fire.ts';
import fireflies, { meta as firefliesMeta } from './pieces/fireflies.ts';
import seaSwell, { meta as seaSwellMeta } from './pieces/sea-swell.ts';
import newtonsCradle, { meta as newtonsCradleMeta } from './pieces/newtons-cradle.ts';
import planet, { meta as planetMeta } from './pieces/planet.ts';
import pendulumWave, { meta as pendulumWaveMeta } from './pieces/pendulum-wave.ts';

export interface Piece {
  id: string;
  meta: Meta;
  make: () => Frame;
  /** The side a crop keeps: a fire its base, a tree its pot. Absent: the middle. */
  anchor?: 'top' | 'middle' | 'bottom';
}

export const pieces: Piece[] = [
  { id: 'aurora', meta: auroraMeta, make: () => aurora() },
  { id: 'bonsai', meta: bonsaiMeta, make: () => bonsai(), anchor: 'bottom' },
  { id: 'cat', meta: catMeta, make: () => cat() },
  { id: 'dna-helix', meta: dnaHelixMeta, make: () => dnaHelix() },
  { id: 'doom-fire', meta: doomFireMeta, make: () => doomFire(), anchor: 'bottom' },
  { id: 'fireflies', meta: firefliesMeta, make: () => fireflies() },
  { id: 'sea-swell', meta: seaSwellMeta, make: () => seaSwell(), anchor: 'bottom' },
  { id: 'newtons-cradle', meta: newtonsCradleMeta, make: () => newtonsCradle() },
  { id: 'planet', meta: planetMeta, make: () => planet() },
  { id: 'pendulum-wave', meta: pendulumWaveMeta, make: () => pendulumWave() },
];
