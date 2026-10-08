#!/usr/bin/env node
// strategy.mjs — what refine knows about the project's strategy (think-skills D5).
//
//   node "$REFINE/strategy.mjs"                 # from the project root
//   node "$REFINE/strategy.mjs" --root <dir>    # another project root
//
// The three strategy coaches (`pmf-narrative`, `north-star`, `risk-validation`) each leave one file in
// `Roadmap/00-strategy/`, shaped by the template that ships with the coach. This reads those files and prints the few
// facts a pitch can be tied to: the input metrics a seed could move, and the riskiest dimension a seed could test.
//
// ── Silence is the answer when there is no strategy ───────────────────────────────────────────────────────────────
// Most projects have never run the coaches. With no `Roadmap/00-strategy/` folder, or nothing in it this reads, this
// prints NOTHING and exits 0, and refine says nothing about strategy: no nag, no empty "Moves" line.
//
// ── A broken file is named, never fatal ───────────────────────────────────────────────────────────────────────────
// Grooming should not stop because a strategy file has a typo. A file this cannot read is reported by name, with the
// reason, and everything else is still printed.
//
// ── The templates are the contract ────────────────────────────────────────────────────────────────────────────────
// The headings read here are the ones in each coach's `templates/<name>.md`, and `strategy.test.mjs` parses those
// templates as its fixtures — so renaming a heading in a template turns this skill's test red, rather than leaving
// refine quietly reading nothing.
//
// Zero deps — Node 18+.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STRATEGY_DIR = join('Roadmap', '00-strategy');
export const KINDS = ['pmf-narrative', 'north-star', 'risk-validation'];

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** The body of `## <heading>`, up to the next `## `. Null when the heading is absent. */
export function section(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

/** The first column and the second column of each body row of the first table in `body`. */
function tableRows(body) {
  const rows = body
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
    );
  return rows.slice(2).filter((cells) => cells.length >= 2); // drop the header row and the --- row
}

/** A labelled line inside a section: `**Dimension:** Business model`. */
function labelled(body, label) {
  const match = body.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

/** A value the coach has not filled in: missing, or still the template's `<…>` placeholder. */
const unfilled = (value) => !value || /^<.*>$/.test(value);

export function parseNorthStar(text) {
  const body = section(text, 'Sync payload');
  if (body === null) throw new Error('no "## Sync payload" section');
  const fences = [...body.matchAll(/^```json\n([\s\S]*?)\n```$/gm)];
  if (fences.length !== 1)
    throw new Error(`expected one json block under "## Sync payload", found ${fences.length}`);
  let payload;
  try {
    payload = JSON.parse(fences[0][1]);
  } catch (err) {
    throw new Error(`the json block does not parse: ${err.message}`);
  }
  const metric = payload?.metric;
  const inputs = payload?.inputs;
  if (!metric || typeof metric.key !== 'string' || !Array.isArray(inputs)) {
    throw new Error('the json block has no metric.key or no inputs list');
  }
  // A draft straight from the template must not turn `<input_key>` into an input a pitch claims to move.
  return {
    metric: unfilled(metric.key)
      ? null
      : { key: metric.key, name: typeof metric.name === 'string' ? metric.name : metric.key },
    inputs: inputs
      .filter((input) => input && typeof input.key === 'string' && !unfilled(input.key))
      .map((input) => ({
        key: input.key,
        name: typeof input.name === 'string' ? input.name : input.key,
        // gates-in-plain-agile D4 — the Plan gate's "Measured by" line is this event, and only ever this event: an
        // input pushed from outside, or one still holding the template's placeholder, has none.
        event:
          input.valueSource === 'telemetry_event' && typeof input.sourceEvent === 'string' && !unfilled(input.sourceEvent)
            ? input.sourceEvent
            : null,
      })),
  };
}

export function parseRiskValidation(text) {
  const domino = section(text, 'Highest domino');
  const map = section(text, 'Conviction map');
  const dimension = domino === null ? null : labelled(domino, 'Dimension');
  const hypothesis = domino === null ? null : labelled(domino, 'Hypothesis');
  return {
    domino: unfilled(dimension) ? null : { dimension, hypothesis: unfilled(hypothesis) ? null : hypothesis },
    lowConviction:
      map === null
        ? []
        : tableRows(map)
            .filter(([, conviction]) => /^low$/i.test(conviction))
            .map(([d]) => d),
  };
}

export function parsePmfNarrative(text) {
  const dimensions = [
    'Problem to solve',
    'Target audience',
    'Value proposition',
    'Competitive advantage',
    'Growth strategy',
    'Business model',
  ];
  return { dimensions: dimensions.filter((heading) => section(text, heading) !== null) };
}

const PARSERS = {
  'pmf-narrative': parsePmfNarrative,
  'north-star': parseNorthStar,
  'risk-validation': parseRiskValidation,
};

/** Read every strategy file under `root`. `files` is empty when there is no strategy at all. */
export function readStrategy(root) {
  const dir = join(root, STRATEGY_DIR);
  const files = [];
  if (!existsSync(dir)) return { files };
  for (const kind of KINDS) {
    const path = join(dir, `${kind}.md`);
    if (!existsSync(path)) continue;
    const entry = { kind, file: `${STRATEGY_DIR}/${kind}.md`, status: null, updated: null };
    try {
      // Inside the try: an unreadable file (permissions, a directory named like one) is reported, not fatal.
      const text = readFileSync(path, 'utf8');
      const fm = parseFrontmatter(text);
      entry.status = fm.status ?? null;
      entry.updated = fm.updated ?? null;
      Object.assign(entry, PARSERS[kind](text));
    } catch (err) {
      entry.problem = err.message;
    }
    files.push(entry);
  }
  return { files };
}

/** The text refine keeps for the pitch line. '' when there is no strategy, which is refine's cue to say nothing. */
export function formatStrategy({ files }) {
  if (files.length === 0) return '';
  const out = [`Strategy (${STRATEGY_DIR}/):`];
  for (const f of files) {
    const stamp = [f.status, f.updated].filter(Boolean).join(', ');
    const head = `  ${f.kind}.md${stamp ? ` (${stamp})` : ''}`;
    if (f.problem) {
      out.push(`${head} — could not read: ${f.problem}`);
    } else if (f.kind === 'north-star') {
      out.push(
        `${head} — North Star: ${f.metric ? `${f.metric.key} ("${f.metric.name}")` : 'not filled in yet'}`
      );
      out.push(
        `    inputs a seed can move: ${f.inputs.map((i) => `${i.key} ("${i.name}"${i.event ? `, event ${i.event}` : ''})`).join(' · ') || 'none'}`
      );
    } else if (f.kind === 'risk-validation') {
      const domino = f.domino
        ? `${f.domino.dimension}${f.domino.hypothesis ? ` — "${f.domino.hypothesis}"` : ''}`
        : 'not chosen yet';
      out.push(`${head} — highest domino: ${domino}`);
      if (f.lowConviction.length) out.push(`    low conviction: ${f.lowConviction.join(' · ')}`);
    } else {
      out.push(`${head} — dimensions: ${f.dimensions.join(' · ') || 'none written'}`);
    }
  }
  out.push('Pitch line: Moves: <input key> · Tests: <dimension>   (or: Moves · Tests: neither — <why>)');
  // result-record D4 — the Stage 1.5 target offers these same inputs by key; anything else is free text, "not grounded".
  const keys = files.flatMap((f) => (f.kind === 'north-star' && !f.problem ? f.inputs.map((i) => i.key) : []));
  out.push(
    `Target (Stage 1.5): target_metric ${keys.length ? `one of ${keys.join(' · ')} (or free text: not grounded)` : 'free text (not grounded: no North Star inputs)'}` +
      ' · target_from → target_to · read_date (blank = 30 days after shipping)'
  );
  return out.join('\n');
}

function main(argv) {
  const at = argv.indexOf('--root');
  if (at !== -1 && !argv[at + 1]) {
    console.error('strategy: --root needs a directory');
    return 1;
  }
  const root = resolve(at === -1 ? process.cwd() : argv[at + 1]);
  const text = formatStrategy(readStrategy(root));
  if (text) console.log(text);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
