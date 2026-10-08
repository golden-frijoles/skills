// stage.mjs — the ONE place an initiative's stage is decided (board-sinks-and-scrumban D2, D13).
//
// Every roadmap client — the extractor that feeds the Hub and Notion, BUILD-ORDER.md, the CLI build view, the
// kickoff's WIP advice — reads a stage computed here, so no two of them can compute it differently. Before this,
// stage was written in five places in two vocabularies (seed `status:`, epic `status:`, `phase:`, a free-text
// sprint `Status:` line, and inference the CLI mod skipped offline), and the clients disagreed.
//
// ── The rule (README § Architecture lock, D13) ───────────────────────────────────────────────────────────
// 1. Off the board: `status: archived` (epic or seed) → stage null.
// 2. Shipped: `status: shipped`. Docs win over a stale branch — 12 of the 13 work branches on origin on
//    2026-10-01 were merged and never deleted (C7), including one of an epic that has shipped.
// 3. Git and GitHub next. A branch is LIVE while its newest PR is open, or it has none; merged or closed means
//    done or abandoned. Any live branch → the highest sprint's: an open, non-draft PR is QA, anything else is
//    Building (a tie goes to Building: work is still happening). No live branch but a merged PR → QA (merged,
//    close-out owed), unless a sprint AFTER the highest merged one is still Planned by its own docs: then Ready to
//    build (paused between sprints).
// 4. Docs last: raw → To groom · ready → Grooming · queued/scaffolded/in-progress → Ready to build.
//    `in-progress` is never Building on its own word (D3): Building and QA are facts, never fields.
//
// Pure: facts come in as arguments (lib/stage-facts.mjs gathers them), so a fixture can pin every case.
// Zero deps beyond the branch parser the build view already used.

import { branchCandidates } from './work-branch.mjs';

/** The six stages, in board order (D1 — locked by the product owner, 2026-10-01). */
export const STAGES = Object.freeze(['To groom', 'Grooming', 'Ready to build', 'Building', 'QA', 'Shipped']);

/**
 * What each stage is CALLED where a person reads it (plugin-1-0 D6): plain agile, Backlog → Refining → Ready. The keys
 * above are stored data and never change; every printed stage goes through `stageWord`. The console's twin is
 * `apps/web/lib/screen-words.ts → stageLabel`, and a test keeps the two equal.
 */
export const STAGE_WORDS = Object.freeze({ 'To groom': 'Backlog', Grooming: 'Refining', 'Ready to build': 'Ready' });
export const stageWord = (stage) => STAGE_WORDS[stage] ?? stage;

const DOCS_STAGE = {
  raw: 'To groom',
  ready: 'Grooming',
  queued: 'Ready to build',
  scaffolded: 'Ready to build',
  'in-progress': 'Ready to build',
};

/**
 * Which initiative a branch belongs to: the LONGEST reading of it that names a known slug (`known`), with a
 * seed that carries `epic:` folded into that epic (`alias`: seed slug → epic slug). null when it names none.
 */
export function ownerOf(branch, known, alias = new Map()) {
  for (const c of branchCandidates(branch)) {
    if (known.has(c.slug)) return { slug: alias.get(c.slug) ?? c.slug, sprint: c.sprint };
  }
  return null;
}

/**
 * Split run-wide facts into per-initiative facts. `branches` are origin branch names; `prs` are
 * `{ number, head, state, draft, url }` with state OPEN | MERGED | CLOSED. A PR is attributed by its head
 * branch NAME, so a merged PR whose branch was deleted still counts for its initiative.
 * Returns Map slug → { branches: [{ name, sprint }], prs: [{ …pr, sprint }] }.
 */
export function attributeFacts({ branches = [], prs = [] } = {}, known, alias = new Map()) {
  const out = new Map();
  const slot = (slug) => {
    if (!out.has(slug)) out.set(slug, { branches: [], prs: [] });
    return out.get(slug);
  };
  for (const name of branches) {
    const owner = ownerOf(name, known, alias);
    if (owner) slot(owner.slug).branches.push({ name, sprint: owner.sprint });
  }
  for (const pr of prs) {
    const owner = ownerOf(pr.head, known, alias);
    if (owner) slot(owner.slug).prs.push({ ...pr, sprint: owner.sprint });
  }
  return out;
}

const rankOf = (sprint) => sprint ?? 1;
const newest = (prs) =>
  prs.reduce((best, pr) => (best === null || pr.number > best.number ? pr : best), null);

/**
 * The stage of one initiative.
 *
 * @param row      `{ grain: 'Epic' | 'Seed', status: <frontmatter status, lower-case, or null>, sprints?, sprints_total? }`
 *                 — `sprints` is `[{ n, status }]` with each sprint's own docs status (Planned · In progress · …)
 * @param gitFacts `{ branches: [{ name, sprint }] }` — this initiative's branches on origin
 * @param prFacts  `{ prs: [{ number, head, state, draft, url, sprint }] }` — PRs from its branches, any state
 * @param origin   appended to the source when the facts are not live (`snapshot@<iso>`), else null
 * @returns `{ stage, source, pr }` — stage is one of STAGES or null (archived: off the board); `pr` is the PR
 *          the stage was read from, or null.
 */
export function resolveStage(row, gitFacts = { branches: [] }, prFacts = { prs: [] }, origin = null) {
  const status = row.status ? String(row.status).toLowerCase() : null;
  const at = (source) => (origin ? `${source} · ${origin}` : source);

  if (status === 'archived') return { stage: null, source: 'docs: status archived', pr: null };
  if (status === 'shipped') return { stage: 'Shipped', source: 'docs: status shipped', pr: null };

  const prs = prFacts.prs ?? [];
  const live = (gitFacts.branches ?? [])
    .map((b) => ({ ...b, pr: newest(prs.filter((p) => p.head === b.name)) }))
    .filter((b) => b.pr === null || b.pr.state === 'OPEN');

  if (live.length) {
    const top = Math.max(...live.map((b) => rankOf(b.sprint)));
    const atTop = live.filter((b) => rankOf(b.sprint) === top);
    const ready = (b) => b.pr !== null && !b.pr.draft;
    // A tie goes to the branch still being built: one ready PR does not make a sprint that is also being worked
    // on in a sibling branch "in QA".
    const pick = atTop.find((b) => !ready(b)) ?? atTop[0];
    if (ready(pick)) return { stage: 'QA', source: at(`github: PR #${pick.pr.number} ready`), pr: pick.pr };
    if (pick.pr) return { stage: 'Building', source: at(`github: PR #${pick.pr.number} draft`), pr: pick.pr };
    return { stage: 'Building', source: at(`git: ${pick.name}`), pr: null };
  }

  const merged = prs.filter((p) => p.state === 'MERGED');
  if (merged.length) {
    const top = Math.max(...merged.map((p) => rankOf(p.sprint)));
    const last = newest(merged.filter((p) => rankOf(p.sprint) === top));
    // Paused between sprints only when a LATER sprint is still Planned by its own docs. Sprint numbers alone cannot
    // tell: an epic may ship every sprint in one PR from `feat/<slug>` (scenarios-pm-operable, #98 — 10 of 10
    // stories), which reads as "sprint 1" (lock run, 2026-10-01). Without sprint statuses, fall back to the count.
    const later = (row.sprints ?? []).filter((sp) => sp.n > top);
    const paused =
      row.grain === 'Epic' &&
      (Array.isArray(row.sprints)
        ? later.some((sp) => sp.status === 'Planned')
        : top < (Number(row.sprints_total) || 0));
    if (!paused) return { stage: 'QA', source: at(`github: PR #${last.number} merged`), pr: last };
    const next = later.find((sp) => sp.status === 'Planned');
    return {
      stage: 'Ready to build',
      source: at(`github: PR #${last.number} merged, S${next ? next.n : top + 1} not started`),
      pr: last,
    };
  }

  // Docs last. An absent status reads as raw for a seed (the extractor's legacy tolerance) and as scaffolded for
  // an epic (it has a README and sprint files, so it was scaffolded).
  const key = status ?? (row.grain === 'Epic' ? 'scaffolded' : 'raw');
  const stage = DOCS_STAGE[key] ?? 'Ready to build';
  return { stage, source: `docs: status ${key}`, pr: null };
}

/** `build_order_num`, with a missing one sorting last rather than first. */
const orderKey = (row) =>
  Number.isFinite(row.build_order_num) ? row.build_order_num : Number.MAX_SAFE_INTEGER;

/**
 * Rows with a stage, grouped into the six columns in board order. Ready to build runs in build order (D1); Shipped
 * runs newest first — by `shipped_at` (`shipped: 'recent'`, the default), or by build order, highest first
 * (`shipped: 'build-order'`). The second exists for a COMMITTED view: `shipped_at` is a git date, and a depth-1 CI
 * clone dates every row to its one commit, so a file sorted by it is not reproducible (build-order-guard went red on
 * exactly that). Every other column runs in build order, then name. Rows whose stage is null (archived) or that are
 * not initiatives (sprint rows) are left out — cards are initiatives (D7).
 */
export function groupByStage(rows, { shipped = 'recent' } = {}) {
  const columns = Object.fromEntries(STAGES.map((s) => [s, []]));
  for (const row of rows) {
    if (row.grain === 'Sprint' || !row.stage || !(row.stage in columns)) continue;
    columns[row.stage].push(row);
  }
  for (const stage of STAGES) {
    columns[stage].sort((a, b) =>
      stage !== 'Shipped'
        ? orderKey(a) - orderKey(b) || String(a.name).localeCompare(String(b.name))
        : shipped === 'build-order'
          ? (Number.isFinite(b.build_order_num) ? b.build_order_num : -1) -
              (Number.isFinite(a.build_order_num) ? a.build_order_num : -1) ||
            String(a.name).localeCompare(String(b.name))
          : String(b.shipped_at ?? '').localeCompare(String(a.shipped_at ?? '')) || orderKey(a) - orderKey(b)
    );
  }
  return columns;
}
