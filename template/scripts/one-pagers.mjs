#!/usr/bin/env node
// one-pagers.mjs — three sheets a maker can consult in seconds, derived from the strategy files (coaches-v2 D10).
//
//   node scripts/one-pagers.mjs                 render into Roadmap/00-strategy/one-pagers/ (.html and .md each)
//   node scripts/one-pagers.mjs --out <dir>     …somewhere else
//
// The sheets: a business model canvas, a value proposition sheet and a persona poster. The Strategy gate's Approve
// renders them, each coach renders them after its last write, and this command renders them on demand.
//
// ── Derived, never typed ──────────────────────────────────────────────────────────────────────────────────────────
// Every line on a sheet comes from a strategy file; nothing here holds strategy. A sheet typed by hand drifts from the
// narrative the day after it is printed, and then two documents disagree about the product (the 2026-10-05 reference
// sheets were transcribed, and needed a revision the next morning). A field the files don't fill says "Not written
// yet" rather than being guessed.
//
// ── Honest labels ─────────────────────────────────────────────────────────────────────────────────────────────────
// Each claim shows `true today`, `aspirational`, `agreed`, `sourced` or `hypothesis`, taken from the `(…)` label the
// coach wrote at the end of the line. A persona line with NO label renders as `hypothesis`: an unlabelled line is an
// unchecked one, and the poster must never present an anecdote as a researched frustration (dogfood F34). A sheet
// whose source file is still `status: draft` is watermarked "Draft".
//
// ── Licences ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The Business Model Canvas is Strategyzer AG's, licensed CC BY-SA 3.0: usable with "Strategyzer.com" visible under
// it, which the canvas carries. The Value Proposition Canvas is NOT licensed for software, so the value proposition
// sheet is our own layout (the customer's outcome, motivation and gaps against the product's promise) and never uses
// its name or shape.
//
// Exit codes: 0 rendered, or nothing to render yet (said in one line) · 2 usage or could not write.
// Zero deps — Node 18+.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './lib/project-root.mjs';
import { ONE_PAGERS_DIR, STRATEGY_DIR, parseFrontmatter, section } from './lib/strategy-files.mjs';

/** The persona block's fields, in the order the narrative template lists them under `### Persona`. */
export const PERSONA_FIELDS = [
  'Role',
  'Stage',
  'Background',
  'Goals',
  'Frustrations',
  'Drivers',
  'Moments they reach for it',
  'Where to find them',
  'Words to use',
  'Words to avoid',
  'Not this persona',
];

export const LABELS = ['true today', 'aspirational', 'agreed', 'sourced', 'hypothesis'];
export const NOT_WRITTEN = 'Not written yet';
export const BMC_CREDIT = 'The Business Model Canvas by Strategyzer.com, licensed CC BY-SA 3.0.';

/** Split a trailing `(label)` or `(sourced: <where>)` off a claim. An unknown or missing label is `null`. */
export function splitLabel(raw) {
  const text = String(raw ?? '').trim();
  const m = text.match(
    // The source may hold a markdown link or a URL with its own parentheses; a trailing full stop is allowed.
    /\s*\(\s*(true today|aspirational|agreed|hypothesis|sourced)(?:\s*:\s*((?:[^()]|\([^()]*\))*))?\s*\)\s*\.?\s*$/i
  );
  if (!m) return { text, label: null, source: null };
  return { text: text.slice(0, m.index).trim(), label: m[1].toLowerCase(), source: m[2]?.trim() || null };
}

/** A value the coach has not written: missing, or still the template's `<…>` placeholder. */
const unwritten = (v) => !v || /^<[^>]*>(?:\s*\([^)]*\))?$/.test(v.trim()); // a placeholder, maybe with its label hint
/** A value with any `<…>` placeholder fragment removed: half-filled template text never reaches a sheet. */
const fill = (v) =>
  String(v ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** `**Label:** value` lines inside `body`, by label. */
export function labelledLines(body) {
  const out = {};
  const lines = String(body ?? '').split('\n');
  const LABEL = /^\s*(?:[-*]\s+)?\*\*([^*]+?):\*\*\s*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LABEL);
    if (!m) continue;
    const parts = [m[2].trim()];
    const items = [];
    // A value may wrap onto following lines, or be a list of sub-bullets under an empty label: both are written
    // content, and dropping them would print "Not written yet" over something the maker wrote (review of #316).
    for (let k = i + 1; k < lines.length; k++) {
      const next = lines[k];
      if (!next.trim() || LABEL.test(next) || /^#{1,6} /.test(next)) break;
      const bullet = next.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (bullet && (!parts[0] || /^\s/.test(next))) items.push(bullet[1].trim());
      else if (!bullet && !items.length) parts.push(next.trim());
      else break;
    }
    const raw = [parts.join(' ').trim(), ...items.filter((x) => !unwritten(x))].filter(
      (x) => x && !unwritten(x)
    );
    const value = fill(raw.join(' · '));
    if (!unwritten(value)) out[m[1].trim()] = value;
  }
  return out;
}

/** The `- ` bullets directly under a `**Label:**` line (Gaps:), or every top-level bullet when no label is given. */
export function bullets(body, after = null) {
  const lines = String(body ?? '').split('\n');
  let start = 0;
  if (after) {
    start = lines.findIndex((l) => new RegExp(`^\\s*\\*\\*${after}:\\*\\*`).test(l));
    if (start === -1) return [];
    start += 1;
  }
  const out = [];
  for (const line of lines.slice(start)) {
    if (after && /^\s*\*\*[^*]+:\*\*/.test(line)) break;
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    // `- **Fast:** drafts next week` is a benefit too: keep it, as "Fast: drafts next week".
    // Placeholder check on the RAW text, before fill(): `<benefit> (true today | aspirational)` must not survive as
    // a benefit called "(true today | aspirational)" (review of #316, round 2).
    if (!m || unwritten(m[1])) continue;
    const item = fill(m[1].replace(/^\*\*([^*]+?):\*\*\s*/, '$1: '));
    if (item && !unwritten(item)) out.push(item);
  }
  return out;
}

/** The body of `### <heading>` inside an h2 section's text. */
function subsection(body, heading) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === `### ${heading}`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** A claim with its label; a persona line without one is a hypothesis (F34). */
function claim(raw, { defaultLabel = null } = {}) {
  const c = splitLabel(raw);
  return { ...c, label: c.label ?? defaultLabel };
}

/** Pure — everything the three sheets show, read from the three files' text (any may be null). */
export function readStrategy({ narrative = null, northStar = null, risk = null } = {}) {
  const n = narrative ?? '';
  const fm = parseFrontmatter(n);
  const problem = section(n, 'Problem to solve') ?? '';
  const audience = section(n, 'Target audience') ?? '';
  const vp = section(n, 'Value proposition') ?? '';
  const adv = section(n, 'Competitive advantage') ?? '';
  const growth = section(n, 'Growth strategy') ?? '';
  const bm = section(n, 'Business model') ?? '';
  const personaBody = subsection(audience, 'Persona');
  const personaLines = labelledLines(personaBody);
  const p = labelledLines(problem);
  const a = labelledLines(audience);
  const v = labelledLines(vp);
  const c = labelledLines(adv);
  const g = labelledLines(growth);
  const b = labelledLines(bm);

  const ns = northStar ?? '';
  const metricLine = (section(ns, 'North Star metric') ?? '')
    .split('\n')
    .find((l) => l.trim() && !l.startsWith('_'));
  const metric = metricLine?.match(/^\*\*([^*]+)\*\*\s*:?\s*(.*)$/);

  const r = risk ?? '';
  const domino = labelledLines(section(r, 'Highest domino'));

  // A claim the coach left unlabelled still shows what it is (review of #316): the maker approved it at the Strategy
  // gate when the file is agreed; until then it is unchecked. Persona lines stay hypothesis either way (F34).
  const N = { defaultLabel: fm.status === 'agreed' ? 'agreed' : 'hypothesis' };
  const benefits = bullets(vp).map((x) => claim(x, N));
  return {
    product: (n.match(/^# .*?—\s*(.+)$/m)?.[1] ?? '').replace(/^<.*>$/, '').trim() || null,
    status: {
      narrative: narrative === null ? null : fm.status || 'draft',
      northStar: northStar === null ? null : parseFrontmatter(ns).status || 'draft',
      risk: risk === null ? null : parseFrontmatter(r).status || 'draft',
    },
    persona:
      personaBody === null
        ? null
        : PERSONA_FIELDS.map((f) => ({
            field: f,
            ...(personaLines[f]
              ? claim(personaLines[f], { defaultLabel: 'hypothesis' })
              : { text: null, label: null }),
          })),
    outcome: p.Outcome ? claim(p.Outcome, N) : null,
    motivation: p.Motivation ? claim(p.Motivation, N) : null,
    gaps: bullets(problem, 'Gaps').map((x) => claim(x, N)),
    segmentsNow: a.Now ? claim(a.Now, N) : null,
    segmentsFuture: a.Future ? claim(a.Future, N) : null,
    tagline: v.Tagline ? claim(v.Tagline, N) : null,
    benefits,
    shortTerm: c['Short term'] ? claim(c['Short term'], N) : null,
    longTerm: c['Long term'] ? claim(c['Long term'], N) : null,
    channelsNow: g.Now ? claim(g.Now, N) : null,
    channelsLater: g.Later ? claim(g.Later, N) : null,
    revenue: b.Revenue ? claim(b.Revenue, N) : null,
    pricing: b.Pricing ? claim(b.Pricing, N) : null,
    costs: b.Costs ? claim(b.Costs, N) : null,
    partners: b['Key partners'] ? claim(b['Key partners'], N) : null,
    activities: b['Key activities'] ? claim(b['Key activities'], N) : null,
    resources: b['Key resources'] ? claim(b['Key resources'], N) : null,
    relationships: b['Customer relationships'] ? claim(b['Customer relationships'], N) : null,
    northStar:
      metric && !unwritten(metric[1])
        ? { name: metric[1].replace(/:\s*$/, '').trim(), definition: metric[2].trim() }
        : null,
    notClaimedYet: [
      ...(domino.Hypothesis
        ? [
            {
              text: domino.Hypothesis,
              label: 'hypothesis',
              source: null,
              why: `riskiest assumption${domino.Dimension ? ` (${domino.Dimension})` : ''}`,
            },
          ]
        : []),
      ...benefits
        .filter((x) => x.label === 'aspirational')
        .map((x) => ({ ...x, why: 'aspirational benefit' })),
    ],
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );

function chipHtml(c) {
  if (!c?.label) return '';
  const cls = c.label === 'hypothesis' || c.label === 'aspirational' ? 'hyp' : 'ok';
  const title = c.source ? ` title="${esc(c.source)}"` : '';
  return ` <span class="chip ${cls}"${title}>${esc(c.label)}</span>`;
}
const chipMd = (c) => (c?.label ? ` _(${c.label}${c.source ? `: ${c.source}` : ''})_` : '');

const lineHtml = (c) =>
  c?.text ? `${esc(c.text)}${chipHtml(c)}` : `<span class="muted">${NOT_WRITTEN}</span>`;
const lineMd = (c) => (c?.text ? `${c.text}${chipMd(c)}` : `_${NOT_WRITTEN}_`);
const listHtml = (cs) =>
  cs.length
    ? `<ul>${cs.map((c) => `<li>${lineHtml(c)}</li>`).join('')}</ul>`
    : `<p class="muted">${NOT_WRITTEN}</p>`;
const listMd = (cs) => (cs.length ? cs.map((c) => `- ${lineMd(c)}`).join('\n') : `_${NOT_WRITTEN}_`);

const CSS = `:root{--bg:#f3f3ef;--paper:#fff;--ink:#1a1916;--muted:#66625a;--line:#d8d5cc;--gold:#9c7000;--gold-bg:#fbf1d3;
--hyp:#7a4a00;--hyp-bg:#fff6e0;--ok:#2b6b3a;--ok-bg:#e3f2e6;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#11100e;--paper:#1a1916;--ink:#ecebe5;--muted:#a29e94;
--line:#2f2d29;--gold:#e5b53d;--gold-bg:rgba(229,181,61,.14);--hyp:#f0b35a;--hyp-bg:rgba(240,179,90,.12);--ok:#86d196;--ok-bg:rgba(134,209,150,.12);color-scheme:dark}}
:root[data-theme="dark"]{--bg:#11100e;--paper:#1a1916;--ink:#ecebe5;--muted:#a29e94;--line:#2f2d29;--gold:#e5b53d;
--gold-bg:rgba(229,181,61,.14);--hyp:#f0b35a;--hyp-bg:rgba(240,179,90,.12);--ok:#86d196;--ok-bg:rgba(134,209,150,.12);color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px}
.sheet{position:relative;max-width:1240px;margin:0 auto;background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:24px 26px;overflow:hidden}
header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 24px;border-bottom:2px solid var(--ink);padding-bottom:10px;margin-bottom:16px}
h1{font:800 28px/1.1 system-ui,sans-serif;margin:0}.kicker{display:block;font:600 11px system-ui;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
h2{font:700 12px system-ui;text-transform:uppercase;letter-spacing:.1em;margin:0 0 8px}
ul{margin:0;padding-left:16px}li{margin:0 0 5px}p{margin:0 0 6px}.muted{color:var(--muted)}
.chip{display:inline-block;font:600 10.5px system-ui;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:99px;vertical-align:1px}
.chip.ok{background:var(--ok-bg);color:var(--ok)}.chip.hyp{background:var(--hyp-bg);color:var(--hyp);border:1px dashed var(--hyp)}
.grid{display:grid;gap:12px}.box{border:1px solid var(--line);border-radius:6px;padding:12px 14px}
.bmc{grid-template-columns:repeat(5,1fr);grid-template-rows:auto auto auto}
.bmc .kp{grid-row:1/3}.bmc .vp{grid-row:1/3;grid-column:3}.bmc .cs{grid-row:1/3;grid-column:5}
.bmc .ka{grid-column:2}.bmc .kr{grid-column:2;grid-row:2}.bmc .cr{grid-column:4}.bmc .ch{grid-column:4;grid-row:2}
.bmc .co{grid-column:1/3;grid-row:3}.bmc .rs{grid-column:3/6;grid-row:3}
.two{grid-template-columns:1fr 1fr}.persona{grid-template-columns:repeat(3,1fr)}
.lead{font-size:18px;margin:0 0 12px}.ns{border:2px solid var(--gold);background:var(--gold-bg)}.ns b{color:var(--gold);font-size:18px;display:block}
footer{margin-top:16px;padding-top:8px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 18px}
.draft{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;font:900 140px system-ui;color:var(--hyp);opacity:.09;transform:rotate(-18deg)}
@media screen and (max-width:820px){.bmc,.two,.persona{grid-template-columns:1fr}.bmc>*{grid-column:auto!important;grid-row:auto!important}}
@media print{body{background:#fff;padding:0}.sheet{border:0;max-width:none;padding:8mm}@page{size:A4 landscape;margin:8mm}}`;

function page({ title, kicker, body, draft, sources, footer = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main class="sheet">${draft ? '<div class="draft" aria-hidden="true">Draft</div>' : ''}
<header><div><span class="kicker">${esc(kicker)}${draft ? ' · draft' : ''}</span><h1>${esc(title)}</h1></div>
<div class="muted">From ${esc(sources)}.</div></header>
${body}
<footer>${footer}<span>Rendered from the strategy files by one-pagers.mjs. Never edit this sheet; edit the file and render again.</span></footer></main></body></html>
`;
}

const isDraft = (...statuses) => statuses.some((s) => s && s !== 'agreed');
const named = (s, kind) => `${s.product ? `${s.product}: ` : ''}${kind}`;

/** Pure — the business model canvas, as { html, md }. */
export function renderCanvas(s) {
  const box = (cls, title, inner) => `<section class="box ${cls}"><h2>${title}</h2>${inner}</section>`;
  const one = (c) => `<p>${lineHtml(c)}</p>`;
  const segments = [
    s.segmentsNow && { ...s.segmentsNow, text: `Now: ${s.segmentsNow.text}` },
    s.segmentsFuture && { ...s.segmentsFuture, text: `Later: ${s.segmentsFuture.text}` },
  ].filter(Boolean);
  const channels = [
    s.channelsNow && { ...s.channelsNow, text: `Now: ${s.channelsNow.text}` },
    s.channelsLater && { ...s.channelsLater, text: `Later: ${s.channelsLater.text}` },
  ].filter(Boolean);
  const value = [s.tagline, ...s.benefits].filter(Boolean);
  const revenue = [s.revenue, s.pricing].filter(Boolean);
  const draft = isDraft(s.status.narrative);
  const html = page({
    title: named(s, 'Business model canvas'),
    kicker: 'Strategy one-pager',
    draft,
    sources: 'pmf-narrative.md',
    body: `<div class="grid bmc">${box('kp', 'Key partners', one(s.partners))}${box('ka', 'Key activities', one(s.activities))}${box('kr', 'Key resources', one(s.resources))}${box('vp', 'Value propositions', listHtml(value))}${box('cr', 'Customer relationships', one(s.relationships))}${box('ch', 'Channels', listHtml(channels))}${box('cs', 'Customer segments', listHtml(segments))}${box('co', 'Cost structure', one(s.costs))}${box('rs', 'Revenue streams', listHtml(revenue))}</div>`,
    footer: `<span>${esc(BMC_CREDIT)}</span>`,
  });
  const md = [
    `# ${named(s, 'Business model canvas')}${draft ? ' (draft)' : ''}`,
    '',
    ...[
      ['Key partners', lineMd(s.partners)],
      ['Key activities', lineMd(s.activities)],
      ['Key resources', lineMd(s.resources)],
      ['Value propositions', listMd(value)],
      ['Customer relationships', lineMd(s.relationships)],
      ['Channels', listMd(channels)],
      ['Customer segments', listMd(segments)],
      ['Cost structure', lineMd(s.costs)],
      ['Revenue streams', listMd(revenue)],
    ].flatMap(([h, v]) => [`## ${h}`, '', v, '']),
    `_${BMC_CREDIT}_`,
    '',
  ].join('\n');
  return { html, md };
}

/** Pure — the value proposition sheet (our own layout, never the reserved canvas), as { html, md }. */
export function renderValueSheet(s) {
  const draft = isDraft(s.status.narrative, s.status.northStar, s.status.risk);
  const ns = s.northStar
    ? `<section class="box ns"><h2>North Star</h2><b>${esc(s.northStar.name)}</b><p>${esc(s.northStar.definition)}</p></section>`
    : `<section class="box"><h2>North Star</h2><p class="muted">${NOT_WRITTEN}</p></section>`;
  const html = page({
    title: named(s, 'Value proposition sheet'),
    kicker: 'Strategy one-pager',
    draft,
    sources: 'pmf-narrative.md · north-star.md · risk-validation.md',
    body: `<p class="lead"><strong>${lineHtml(s.tagline)}</strong></p>
<div class="grid two"><section class="box"><h2>What the customer is after</h2><p><strong>Outcome:</strong> ${lineHtml(s.outcome)}</p><p><strong>Why:</strong> ${lineHtml(s.motivation)}</p><h2>What stands in the way</h2>${listHtml(s.gaps)}</section>
<section class="box"><h2>What the product promises</h2>${listHtml(s.benefits)}<h2>Why it wins</h2><p><strong>Today:</strong> ${lineHtml(s.shortTerm)}</p><p><strong>Over time:</strong> ${lineHtml(s.longTerm)}</p></section></div>
<div class="grid two" style="margin-top:12px">${ns}<section class="box"><h2>Not claimed yet</h2>${s.notClaimedYet.length ? `<ul>${s.notClaimedYet.map((c) => `<li>${esc(c.text)}${chipHtml(c)} <span class="muted">(${esc(c.why)})</span></li>`).join('')}</ul>` : '<p class="muted">Nothing marked as untested.</p>'}</section></div>`,
  });
  const md = [
    `# ${named(s, 'Value proposition sheet')}${draft ? ' (draft)' : ''}`,
    '',
    `**${lineMd(s.tagline)}**`,
    '',
    '## What the customer is after',
    '',
    `- **Outcome:** ${lineMd(s.outcome)}`,
    `- **Why:** ${lineMd(s.motivation)}`,
    '',
    '## What stands in the way',
    '',
    listMd(s.gaps),
    '',
    '## What the product promises',
    '',
    listMd(s.benefits),
    '',
    '## Why it wins',
    '',
    `- **Today:** ${lineMd(s.shortTerm)}`,
    `- **Over time:** ${lineMd(s.longTerm)}`,
    '',
    '## North Star',
    '',
    s.northStar ? `**${s.northStar.name}**: ${s.northStar.definition}` : `_${NOT_WRITTEN}_`,
    '',
    '## Not claimed yet',
    '',
    s.notClaimedYet.length
      ? s.notClaimedYet.map((c) => `- ${c.text}${chipMd(c)} (${c.why})`).join('\n')
      : '_Nothing marked as untested._',
    '',
  ].join('\n');
  return { html, md };
}

/** Pure — the persona poster, as { html, md }. Every line carries a label; an unlabelled one reads hypothesis. */
export function renderPersona(s) {
  const draft = isDraft(s.status.narrative);
  const rows = s.persona ?? PERSONA_FIELDS.map((field) => ({ field, text: null, label: null }));
  const role = rows.find((r) => r.field === 'Role');
  const html = page({
    title: named(s, `Persona${role?.text ? `: ${role.text}` : ''}`),
    kicker: 'Strategy one-pager',
    draft,
    sources: 'pmf-narrative.md (Target audience → Persona)',
    body: `<div class="grid persona">${rows
      .map((r) => `<section class="box"><h2>${esc(r.field)}</h2><p>${lineHtml(r)}</p></section>`)
      .join('')}</div>`,
    footer:
      '<span><span class="chip ok">sourced</span> / <span class="chip ok">agreed</span> = checked or confirmed · <span class="chip hyp">hypothesis</span> = not checked yet</span>',
  });
  const md = [
    `# ${named(s, `Persona${role?.text ? `: ${role.text}` : ''}`)}${draft ? ' (draft)' : ''}`,
    '',
    ...rows.flatMap((r) => [`## ${r.field}`, '', lineMd(r), '']),
  ].join('\n');
  return { html, md };
}

export const SHEETS = {
  'business-model-canvas': renderCanvas,
  'value-proposition-sheet': renderValueSheet,
  'persona-poster': renderPersona,
};

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function main(argv) {
  const root = projectRoot();
  const i = argv.indexOf('--out');
  if (i !== -1 && !argv[i + 1]) {
    process.stderr.write('usage: one-pagers.mjs [--out <dir>]\n');
    return 2;
  }
  const out = i !== -1 ? resolve(argv[i + 1]) : join(root, ONE_PAGERS_DIR);
  const file = (k) => readOrNull(join(root, STRATEGY_DIR, `${k}.md`));
  const narrative = file('pmf-narrative');
  if (narrative === null) {
    process.stdout.write(
      `one-pagers: nothing to render yet — the sheets come from ${STRATEGY_DIR}/pmf-narrative.md, which doesn't exist.\n`
    );
    return 0;
  }
  const s = readStrategy({ narrative, northStar: file('north-star'), risk: file('risk-validation') });
  try {
    mkdirSync(out, { recursive: true });
    const written = [];
    for (const [name, render] of Object.entries(SHEETS)) {
      const { html, md } = render(s);
      writeFileSync(join(out, `${name}.html`), html);
      writeFileSync(join(out, `${name}.md`), md);
      written.push(`${name}.html`);
    }
    const draft = isDraft(s.status.narrative, s.status.northStar, s.status.risk);
    process.stdout.write(
      `one-pagers: wrote ${written.join(', ')} (+ .md) to ${out}${draft ? ' — marked draft until the Strategy gate approves the files' : ''}.\n`
    );
    return 0;
  } catch (e) {
    process.stderr.write(`one-pagers: could not write to ${out}: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main(process.argv.slice(2));
