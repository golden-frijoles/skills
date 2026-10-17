#!/usr/bin/env node
// agy-doctor.mjs — an ALIAS for `node scripts/cross-agent-doctor.mjs agy` (distribute-what-we-use D2).
//
// There is one doctor for the reviewer CLIs, and it lives in `cross-agent-doctor.mjs` (codex + agy). This
// name survives because it is in muscle memory, old PR bodies and older copies of the fix message; running
// it runs the agy half of the real doctor with the same arguments:
//
//   node scripts/agy-doctor.mjs          ≡  node scripts/cross-agent-doctor.mjs agy
//   node scripts/agy-doctor.mjs --fix    ≡  node scripts/cross-agent-doctor.mjs agy --fix
//
// It also re-exports the doctor's pure cores under their old names, so anything that imported them from
// here keeps working (`parseModelList` is the doctor's stricter `parseAgyModelSlugs`). Never add logic here.
//
// Zero npm deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export {
  decideDoctorAction,
  bumpPinnedSource,
  parseAgyModelSlugs as parseModelList,
} from './cross-agent-doctor.mjs';
import { isMain } from './lib/is-main.mjs';

if (isMain(import.meta.url)) {
  const doctor = join(dirname(fileURLToPath(import.meta.url)), 'cross-agent-doctor.mjs');
  const r = spawnSync(process.execPath, [doctor, 'agy', ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
