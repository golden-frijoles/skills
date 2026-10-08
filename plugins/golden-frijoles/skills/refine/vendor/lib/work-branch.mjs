// work-branch.mjs — read a work branch name as `<type>/<slug>[-s<N>][-words]` (board-sinks-and-scrumban D13).
//
// Moved here, unchanged, from build-state.mjs, where it was born (build-visualization-claude-mods S3). The stage
// resolver (lib/stage.mjs) needs the SAME reading of a branch as the build view, and a second parser for one
// naming convention is how two clients come to disagree about which epic a branch belongs to. build-state.mjs
// re-exports both functions, so nothing that imported them from there had to change.
//
// Zero deps, no imports.

const BRANCH_PREFIX_RE = /^(?:feat|fix|chore|spike|bug|docs)\/(.+)$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)*$/;

/** A sprint token right after the slug: `s3`, `sprint3`, or `sprint` `3` → 3; else null. */
function sprintAt(rest) {
  const m = String(rest[0] ?? '').match(/^s(?:print)?(\d+)$/);
  if (m) return Number(m[1]);
  return rest[0] === 'sprint' && /^\d+$/.test(rest[1] ?? '') ? Number(rest[1]) : null;
}

/**
 * Every reading of a work branch as `<slug>[-s<N>][-anything]`, LONGEST slug first:
 * `feat/foo-s4-licences` → foo-s4-licences, foo-s4, foo (sprint 4). The resolver takes the first reading
 * whose slug names an epic (or a seed) on disk. [] for a branch that isn't a work branch.
 */
export function branchCandidates(branch) {
  const m = String(branch || '').match(BRANCH_PREFIX_RE);
  if (!m || !SLUG_RE.test(m[1]) || m[1].includes('..')) return [];
  const tokens = m[1].split('-');
  const out = [];
  for (let i = tokens.length; i >= 1; i--) {
    out.push({
      slug: tokens.slice(0, i).join('-'),
      sprint: sprintAt(tokens.slice(i)),
      exact: i === tokens.length,
    });
  }
  return out;
}

/**
 * The syntactic reading alone, no disk: `feat/foo-s3` → { slug: 'foo', sprint: 3 },
 * `feat/foo-s3-extra` → { slug: 'foo', sprint: 3 }; null for a branch that is not a work branch.
 */
export function parseBranch(branch) {
  const cands = branchCandidates(branch);
  if (!cands.length) return null;
  const withSprint = cands.find((c) => c.sprint !== null);
  return withSprint
    ? { slug: withSprint.slug, sprint: withSprint.sprint }
    : { slug: cands[0].slug, sprint: null };
}
