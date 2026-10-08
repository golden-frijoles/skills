// wip.mjs — scrumban's pull, as advice at the moment of pulling (board-sinks-and-scrumban S3.4, D9, D22).
//
// `emit-epic-kickoff` asks this before it prints a kickoff: if Building is already at its limit (`board.wip.Building` in
// golden-frijoles.config.json), it says so in ONE line that names the limit and the cards in Building — and the kickoff
// is printed anyway. A WIP limit here is advice, never a gate (D9): the person pulling may have a good reason.
//
// Building is counted from the SAME rows every client reads (`buildRows`, the stage resolver), with the facts in the
// local snapshot — no network at kickoff time, and the age of those facts is said in the warning.

import { buildRows } from '../roadmap-extract.mjs';
import { gatherFacts } from './stage-facts.mjs';
import { getKey } from './config.mjs';

/**
 * The warning line, or null when there is no limit, Building is under it, or the roadmap cannot be read (advice must
 * never break the kickoff it decorates). `excluding` is the epic being pulled — it is not yet Building.
 */
export function wipWarning({ root, excluding = null, gather = gatherFacts } = {}) {
  try {
    const wip = getKey('board.wip', { root });
    const limit = wip && Number.isInteger(wip.Building) && wip.Building > 0 ? wip.Building : null;
    if (limit === null) return null;
    const facts = gather({ root, mode: 'snapshot' });
    const building = buildRows({ facts, root, dates: false }).filter(
      (r) => r.grain !== 'Sprint' && r.stage === 'Building' && r.slug !== excluding
    );
    if (building.length < limit) return null;
    const age =
      facts.mode === 'snapshot'
        ? ` (facts from ${facts.origin.replace('@', ' of ')})`
        : ' (docs only: no snapshot of git facts yet)';
    const names = building.map((r) => r.name).join('; ');
    return (
      `⚠ WIP: Building is ${building.length > limit ? 'over' : 'at'} its limit of ${limit} — ${names}${age}. ` +
      `Pulling this starts one more; finish or hand one off first, or go ahead knowingly. The kickoff follows.`
    );
  } catch {
    return null;
  }
}
