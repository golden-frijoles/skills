#!/usr/bin/env node
// roadmap-to-notion.mjs — OPT-IN: push the Roadmap projection to a Notion board. ONE-WAY, docs → Notion.
//
// ── Opt-in ─────────────────────────────────────────────────────────────────────────────────────────────
// This is NOT part of the copy-once skeleton. A project that wants a Notion board copies this file into its
// own scripts/ (next to roadmap-extract.mjs, which it imports) and sets NOTION_TOKEN + NOTION_DB_ID. See
// optional/notion/README.md. Docs stay the only source of truth; the board is a rebuilt projection.
//
// Modes:
//   --sync              upsert every projected row into Notion (default)
//   --pr <slug> …       scope-limited overlay for an open PR (see the in-flight block below)
//   --lifecycle         print the overlay label for the current PR state (PR_ACTION + PR_DRAFT env)
//
// Rows come from roadmap-extract.mjs's buildRows() — the same SSOT build-order.mjs reads — so the board can
// never disagree with BUILD-ORDER.md about an epic's status.

import { writeSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildRows } from './roadmap-extract.mjs';

// Notion caps ONE rich-text object at 2000 characters, and a property may carry up to 100 of them. An epic row carries
// its whole epic kickoff, often longer than that, so long text is SPLIT across objects, never cut: the kickoff on a
// Notion card is the one a builder pastes.
export const NOTION_TEXT_LIMIT = 2000;
export function richText(v) {
  if (!v) return { rich_text: [] };
  const s = String(v);
  const chunks = [];
  let i = 0;
  // A property holds at most 100 objects (200,000 chars); past that the rest is dropped — far beyond any roadmap row.
  while (i < s.length && chunks.length < 100) {
    let end = Math.min(i + NOTION_TEXT_LIMIT, s.length);
    // Never cut between the two halves of a surrogate pair (an emoji): both pieces would carry a broken half.
    const code = s.charCodeAt(end - 1);
    if (end < s.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    chunks.push({ text: { content: s.slice(i, end) } });
    i = end;
  }
  return { rich_text: chunks };
}

// Decide the live PR overlay label from the PR state — the SINGLE source the workflow (`--lifecycle`)
// and its node:test both read, so the bash and the test can't drift. Draft PR → In progress;
// ready PR → In review; closed (merged or not) → clear (notion-sync.yml re-derives Status on merge).
export function lifecycleForPr({ action, draft }) {
  if (action === 'closed') return { clear: true };
  return { status: draft ? 'In progress' : 'In review' };
}

// --- CLI dispatch. Wrapped in main() + guarded by isMain so the pure helpers above (floorSprintStatus,
// lifecycleForPr, normalizeBuildOrder, buildRows) can be imported by node:test without running the CLI
// (a bare module load would otherwise hit writeSync/process.exit). ----------------------------------
async function main() {
  const args = process.argv.slice(2);
  const hasFlag = (f) => args.includes(f);
  const flagVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

  // --lifecycle: print the overlay label the notion-pr-sync.yml workflow should send for the current PR
  // state (PR_ACTION + PR_DRAFT env). "clear" or the Lifecycle label. No docs/Notion read needed.
  if (hasFlag('--lifecycle')) {
    const decision = lifecycleForPr({ action: process.env.PR_ACTION, draft: process.env.PR_DRAFT === 'true' });
    writeSync(1, (decision.clear ? 'clear' : decision.status) + '\n');
    return;
  }

  const mode = hasFlag('--pr') ? 'pr' : 'sync';
  const rows = buildRows();

  // --- sync mode: upsert into Notion by slug (docs always win) ---
  const TOKEN = process.env.NOTION_TOKEN;
  const DB = process.env.NOTION_DB_ID;
  const needsNotion = mode === 'sync' || (mode === 'pr' && !hasFlag('--dry'));
  if (needsNotion && (!TOKEN || !DB)) { console.error('set NOTION_TOKEN and NOTION_DB_ID'); process.exitCode = 1; return; }
  const NV = '2022-06-28';
  const api = (path, init = {}) => fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': NV, 'Content-Type': 'application/json', ...(init.headers || {}) },
  }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; });

  const sel = (v) => (v ? { select: { name: String(v) } } : { select: null });
  const rt = richText;
  function props(row, epicId) {
    const p = {
      Name: { title: [{ text: { content: row.name } }] },
      Slug: rt(row.slug),
      Status: sel(row.status),
      Area: sel(row.area),
      Priority: sel(row.priority),
      Type: sel(row.type),
      Risk: sel(row.risk),
      Grain: sel(row.grain),
      'Sprint progress': rt(row.sprint_progress),
      'Build order ID': rt(row.build_order),
      'Doc link': rt(row.doc_link),
      Kickoff: rt(row.kickoff),
      'Last synced': { date: { start: new Date().toISOString().slice(0, 10) } },
    };
    if (row.grain === 'Sprint') p.Epic = { relation: epicId ? [{ id: epicId }] : [] };
    return p;
  }

  // --- in-flight (PR) mode: scope-limited PATCH of ONLY the named epic's row(s). -------------------
  // Used by the pull_request workflow so an open PR shows its epic's live Lifecycle (In progress for a
  // draft PR, In review when ready) WITHOUT running the full --sync rebuild from a feature branch (which
  // would clobber every other epic's row with one branch's worldview). This adds NO new rebuild path: it
  // reuses api()/sel() and writes ONLY the two overlay properties below, never the docs-derived Status
  // (the one-way docs → Status contract stays intact). Scoped by slug, so parallel PRs on different epics
  // never touch the same row. The --status label is free-form (the workflow passes the --lifecycle result).
  //   node roadmap-to-notion.mjs --pr <epic-slug>[,<slug2>] --status "In progress" --link <pr-url>
  //   node roadmap-to-notion.mjs --pr <epic-slug> --clear     # PR closed/merged → drop the overlay
  //   add --dry to preview the targeted rows from the projection without touching Notion (smoke-safe).
  if (mode === 'pr') {
    const PR_PROP = 'Lifecycle';     // a NEW Notion Select, separate from docs-derived Status (owner ratifies)
    const PR_LINK_PROP = 'PR link';  // a NEW Notion URL property                            (owner ratifies)
    const prSlugs = [...new Set(
      args.flatMap((a, i) => (a === '--pr' && args[i + 1] ? args[i + 1].split(',') : []))
          .map((s) => s.trim()).filter(Boolean),
    )];
    if (!prSlugs.length) { console.error('--pr: pass at least one epic slug'); process.exitCode = 1; return; }
    const status = flagVal('--status');
    const link = flagVal('--link');
    const clearing = hasFlag('--clear') || !status;
    const overlay = {
      [PR_PROP]: sel(clearing ? null : status),
      [PR_LINK_PROP]: { url: clearing ? null : (link || null) },
    };
    const isTarget = (slug) => prSlugs.some((s) => slug === s || slug.startsWith(`${s}--`)); // epic + its sprints

    if (hasFlag('--dry')) {
      const hits = rows.filter((r) => isTarget(r.slug));
      console.log(JSON.stringify({
        mode: clearing ? 'clear' : 'set', slugs: prSlugs, overlay,
        would_patch: hits.map((r) => ({ slug: r.slug, grain: r.grain, name: r.name })),
      }, null, 2));
      if (!hits.length) console.error(`--pr --dry: no projected rows match ${prSlugs.join(', ')}`);
      return;
    }

    // live: query the DB but keep ONLY the matching slugs, then PATCH each. (read is harmless; ~one page.)
    const targets = new Map();
    let prCursor;
    do {
      const page = await api(`/databases/${DB}/query`, { method: 'POST', body: JSON.stringify(prCursor ? { start_cursor: prCursor } : {}) });
      for (const p of page.results) {
        const slug = p.properties?.Slug?.rich_text?.[0]?.plain_text;
        if (slug && isTarget(slug)) targets.set(slug, p.id);
      }
      prCursor = page.has_more ? page.next_cursor : null;
    } while (prCursor);

    for (const [, id] of targets) await api(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: overlay }) });
    // Surface a no-op: a slug that matches no Notion row (a brand-new epic not yet --sync'd) would
    // otherwise report success while applying nothing. Don't fail (the deploy-lag window is legit) — warn.
    if (!targets.size) console.error(`--pr: no Notion row matched ${prSlugs.join(', ')} — overlay not applied (epic not synced yet?).`);
    console.log(`pr-sync done — ${clearing ? 'cleared overlay' : `set ${PR_PROP}="${status}"`} on ${targets.size} row(s) for ${prSlugs.join(', ')}`);
    return;
  }

  // 1. Snapshot existing rows by slug
  const existing = new Map();
  let cursor;
  do {
    const page = await api(`/databases/${DB}/query`, { method: 'POST', body: JSON.stringify(cursor ? { start_cursor: cursor } : {}) });
    for (const p of page.results) {
      const slug = p.properties?.Slug?.rich_text?.[0]?.plain_text;
      if (slug) existing.set(slug, p.id);
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  const slugToId = new Map(existing); // slug -> page id (kept current as we upsert)
  async function upsert(row, epicId) {
    const id = slugToId.get(row.slug) || existing.get(row.slug);
    if (id) { await api(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: props(row, epicId) }) }); return { id, created: false }; }
    const created = await api(`/pages`, { method: 'POST', body: JSON.stringify({ parent: { database_id: DB }, properties: props(row, epicId) }) });
    slugToId.set(row.slug, created.id);
    return { id: created.id, created: true };
  }

  let created = 0, updated = 0;
  // Pass 1: Epics + Seeds first (so sprint→epic relations can resolve)
  for (const row of rows.filter((r) => r.grain !== 'Sprint')) {
    const r = await upsert(row); r.created ? created++ : updated++;
  }
  // Pass 2: Sprints, relation → parent epic page id
  for (const row of rows.filter((r) => r.grain === 'Sprint')) {
    const epicId = slugToId.get(row.epic_slug) || existing.get(row.epic_slug) || null;
    const r = await upsert(row, epicId); r.created ? created++ : updated++;
  }
  // Archive Notion rows whose slug no longer exists in docs (never hard-delete)
  for (const [slug, id] of existing) {
    if (!rows.find((r) => r.slug === slug)) { await api(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties: { Status: sel('Archived') } }) }); }
  }
  console.log(`sync done — created ${created}, updated ${updated}, scanned ${existing.size} existing`);
}

// realpath, not resolve: on macOS a temp or symlinked path (/var → /private/var) never equals the module
// URL, and a plain comparison makes the CLI a silent no-op.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) await main();
