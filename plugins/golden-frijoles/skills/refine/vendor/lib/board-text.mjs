// board-text.mjs — the six-stage board as terminal text (board-sinks-and-scrumban S3.2, `roadmap-extract --sink terminal`).
//
// The terminal sink: the same rows the Hub renders, grouped by the same function (`groupByStage`), said in plain text.
// Shipped is the long column, so it shows a count and the most recent few; every other column lists every card.
//
// Pure — the caller passes the rows and how fresh their facts are.

import { STAGES, groupByStage } from './stage.mjs';

const SHIPPED_SHOWN = 5;

function cardLine(row) {
  const meta = [
    row.grain === 'Seed' ? 'seed' : null,
    row.type,
    row.risk ? `risk ${String(row.risk).toLowerCase()}` : null,
    Number.isFinite(row.build_order_num) ? `#${row.build_order_num}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `  · ${row.name}${meta ? ` — ${meta}` : ''}`;
}

/**
 * @param rows   the extractor's rows
 * @param facts  `{ mode, origin }` from lib/stage-facts.mjs — said in the header, so a reader knows how old Building/QA are
 */
export function renderBoardText(rows, facts = { mode: 'docs' }) {
  const columns = groupByStage(rows);
  const fresh =
    facts.mode === 'live'
      ? 'live from git and GitHub'
      : facts.mode === 'snapshot'
        ? `from the ${String(facts.origin ?? 'snapshot').replace('@', ' of ')}`
        : 'from the docs alone — Building and QA need git/GitHub facts (--live)';
  const out = [`Board — six stages, ${fresh}`, ''];
  for (const stage of STAGES) {
    const list = columns[stage];
    out.push(`${stage} (${list.length})`);
    const shown = stage === 'Shipped' ? list.slice(0, SHIPPED_SHOWN) : list;
    for (const row of shown) out.push(cardLine(row));
    if (stage === 'Shipped' && list.length > shown.length)
      out.push(`  … and ${list.length - shown.length} more`);
    if (list.length === 0) out.push('  —');
    out.push('');
  }
  const next = columns['Ready to build'][0];
  out.push(next ? `Next to pull: ${next.name}` : 'Nothing is ready to pull.');
  return `${out.join('\n')}\n`;
}
