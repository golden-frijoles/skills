// roadmap-status-buckets.mjs — the SSOT for epic-status buckets and the seed-funnel definition, shared
// by scripts/build-order.mjs (Roadmap/00-ideas/BUILD-ORDER.md — the canonical in-repo board) and any
// other view of the roadmap a project builds (a reporting hub's live views, a dashboard). A single
// export means two views CANNOT independently drift on WHICH statuses count as "the funnel" or
// "building now" — matching counts are enforced by construction, not by a regression test alone.
//
// Extracted in the origin project after a real bug: a hub view counted EVERY grain:'Seed' row as a
// funnel member (including seeds that had since shipped/scaffolded/archived), while the board correctly
// counted only Raw/Ready/Queued — the hub's funnel stat was silently overcounting.

export const EPIC_STATUS_ORDER = ['In progress', 'Scaffolded', 'Shipped'];

// Seeds not yet scaffolded = the funnel. A seed can also carry Shipped/Scaffolded/Archived (it
// graduated into a real epic, or was retired) — those are NOT funnel members even though they're still
// grain: 'Seed' rows in the projection.
export const SEED_FUNNEL_STATUSES = new Set(['Raw', 'Ready', 'Queued']);

export function isFunnelSeed(row) {
  return row?.grain === 'Seed' && SEED_FUNNEL_STATUSES.has(row.status);
}

// The six stages (board-sinks-and-scrumban D1/D2) live in lib/stage.mjs; re-exported here so the old buckets and
// the new stages have one home. The buckets above stay for the readers that still group by `status`.
export { STAGES } from './stage.mjs';
