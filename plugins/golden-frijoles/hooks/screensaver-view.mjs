// screensaver-view.mjs — the `Client` module index.tsx draws in the band (screensaver D3). The logic is in
// screensaver-view-core.mjs; this file only binds the real catalog to it.
import { pieces } from './ascii/index.ts';
import { createSaverView } from './screensaver-view-core.mjs';

export default createSaverView(pieces);
