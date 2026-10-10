#!/usr/bin/env node
// intent-match.mjs — how well a refined pitch captured the ask it was written from (intent-match S1, D9–D15).
//
//   node scripts/intent-match.mjs <seed.md>             print the score, the band and a route for each gap
//   node scripts/intent-match.mjs <seed.md> --json      the same, as JSON on stdout (the report goes to stderr)
//   node scripts/intent-match.mjs <seed.md> --write     also put `intent_match:` and `## Intent match` into the seed
//   node scripts/intent-match.mjs <seed.md> --no-route  skip the second call that routes each gap to an artifact
//
// ── ADVISORY, NEVER A GATE (D1) ──────────────────────────────────────────────────────────────────────────────
// The score can add a step to a refinement; it never blocks a scaffold and never removes the product owner's approval.
// Nothing reads the exit code as a verdict: 0 means "scored", 2 means "could not look", 1 means a usage error.
//
// ── ONE STATISTIC PER QUESTION (D2, D11) ─────────────────────────────────────────────────────────────────────
// Each signal is one number over Jev Noul/Score answers, so a later calibration can fit weights and bands without
// re-asking anything (the jev-reanchor spike's lesson). Coverage in = mean P(true) over the ask's claims; coverage
// out = mean P(true) over the pitch's acceptance criteria; clarity = mean Score ÷ 3 over the same criteria;
// teach-back = the product owner's answer to refine's Stage 1 mirror (yes 1 · partly 0.5 · no 0). The total is
// 100 × the equal-weight mean of the signals PRESENT, and it always says "uncalibrated" and which signals it used:
// the 80 / 60 bands are placeholders until `intent-outcomes` has twenty answered epics to fit them against.
//
// ── THREE STATES, NEVER TWO ──────────────────────────────────────────────────────────────────────────────────
// No key, `jev.egress` not `true`, a state over Jev's budget, a timeout or a malformed answer all print "could not
// look" and NO number. A partial score dressed as a whole one is worse than none: it is the number a refinement would
// quote. The pitch is never truncated to fit — `askJev` refuses an over-budget state, and so do we.
//
// ── NOT A JEV RAIL (C2) ──────────────────────────────────────────────────────────────────────────────────────
// A rail (`review`, `prose`) is a guard with a regex to fall back to and an off/shadow/jev switch. This decides
// nothing and has no fallback, so it only reads `jev.egress` and `jev.model`: egress must be an explicit `true`.
//
// The seed format this parses is the contract in the epic README's D9 (and refine's `templates/scope-seed.md`):
// `## The ask, as given` → `### Claims` (a numbered list) → `**Teach-back:** yes | partly | no`, and the list under
// the first `## Acceptance…` heading. Zero deps — Node 18+.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  askJev,
  loadJevConfig,
  logDecision,
  readApiKey,
  repoRoot,
  stateSize,
  STATE_CHAR_BUDGET,
} from './lib/jev.mjs';
import { needSetting } from './lib/config.mjs';
import { loadQuestions, wireQuestion } from './lib/jev-questions.mjs';

export const EXIT_SCORED = 0;
export const EXIT_USAGE = 1;
export const EXIT_COULD_NOT_LOOK = 2;

/** One call carries 40-odd questions; the guards' 8 s default is sized for two (D10). */
export const INTENT_TIMEOUT_MS = 30_000;

/** Placeholder bands (D3, D11) — the calibration fits them. Never read one as a threshold anything enforces. */
export const BANDS = Object.freeze([
  { min: 80, label: 'build' },
  { min: 60, label: 'resolve the follow-ups first' },
  { min: 0, label: 'sketch or spike first' },
]);

/** The artifacts a gap can be routed to (D14) — the visuals rule (refine Stage 4.6) draws from the same words. */
export const ROUTES = Object.freeze({
  copy_deck: 'copy deck',
  wireframe: 'wireframe',
  flow: 'flow',
  data_sample: 'data sample',
  state_machine: 'state machine',
  sequence: 'sequence',
  container_diagram: 'container diagram',
  spike: 'spike',
  // think-skills D9: the label only. The `think_chain` choice text Jev reads is a stamped wording in intent.json.
  think_chain:
    'think chain (worth doing? run `pmf-narrative`, then `risk-validation`; any other trade-off, reason it in writing)',
});

/**
 * EVERY question this script (and the reader at the lock) asks Jev (D13) — now DATA in `lib/jev-questions/intent.json`
 * (compiled-prompts D7), each with its measurement beside it. `{item}` is replaced by the backticked state path of the
 * claim or criterion being asked about (`claims.c3`, `criteria.a2`) — the item's text is in the state, never in the
 * question. Wording history worth keeping: coverage_out's first wording ("does this check trace back to a claim?") was
 * as right but decided only 4 of 8 — a check on a DETAIL of a claim sat at 0.47–0.51 until the question named "a
 * detail of how the plan delivers it". Re-running one request moved a clarity answer across 0.8 (0.79 ↔ 0.81), so
 * "decided" counts are ±1. A recording pins the wording by hash: re-measure with
 * `node scripts/jev-eval.mjs --live --rail intent` after changing a word.
 */
export const INTENT_QUESTIONS = Object.freeze(
  Object.fromEntries(loadQuestions('intent').map((q) => [q.id, wireQuestion(q)]))
);

// ── Parsing the seed (D9) ─────────────────────────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

/**
 * A fence line, by CommonMark's rule: at most THREE spaces of indent. A line indented four or more is code, never a
 * fence — and the reader writes its reply indented, so a `\s*` here let an odd fence line in a reply flip the scanner
 * and make the next write delete every section after `## Intent match` (fresh review round 2, #197).
 */
export const FENCE_RE = /^ {0,3}(```|~~~)/;

/** Flat frontmatter → { key: value } (comment-stripped, quotes stripped). The same rule epic-dod uses. */
export function frontmatterOf(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(String(text));
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Split a markdown body at its `## ` headings: [{ heading, lines }], the preamble first with heading null. */
export function sections(body) {
  const out = [{ heading: null, lines: [] }];
  let fence = false;
  for (const line of String(body).split('\n')) {
    if (FENCE_RE.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) out.push({ heading: line.slice(3).trim(), lines: [] });
    else out.at(-1).lines.push(line);
  }
  return out;
}

/**
 * The top-level items of a markdown list: `- x`, `* x`, `1. x`, `1) x`, with indented or wrapped lines folded into
 * the item they belong to. A nested bullet is part of its parent, not an item of its own — a criterion's sub-points
 * are how a builder tests it, and scoring them separately would double-count one check.
 */
export function listItems(lines, { numbered = false } = {}) {
  const items = [];
  const top = numbered ? /^(\d+)[.)]\s+(.*)$/ : /^(?:[-*+]|\d+[.)])\s+(.*)$/;
  let fence = false;
  for (const raw of lines) {
    if (FENCE_RE.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = top.exec(raw);
    if (m) {
      items.push((numbered ? m[2] : m[1]).trim());
      continue;
    }
    if (!items.length) continue;
    if (!raw.trim()) {
      items.push(null); // a blank line ends the item; a later unindented paragraph is not part of it
      continue;
    }
    // An indented line, or markdown's lazy continuation of an unindented one, belongs to the open item.
    if (items.at(-1) !== null && !/^#/.test(raw)) items[items.length - 1] += ` ${raw.trim()}`;
  }
  return items.filter((i) => i !== null && i.length);
}

const ASK_HEADING = /^the ask, as given\b/i;
const TEACH_BACK_LINE = /\*\*Teach-back:\*\*/i;
const INTENT_HEADING = /^intent match\b/i;
const ACCEPTANCE_HEADING = /^acceptance\b/i;

/**
 * Parse a seed into what the score needs. Pure. HTML comments are template guidance, not pitch: stripped first.
 * Returns { frontmatter, ask, claims, teachBack, criteria, pitch }. An absent section leaves its field empty/null —
 * never a default that would score as zero (D9).
 */
export function parseSeed(text) {
  // CRLF would defeat every `$` below and parse to "no claims" (fresh review of #196): normalise first.
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const frontmatter = frontmatterOf(src);
  const body = src.replace(FRONTMATTER_RE, '').replace(/<!--[\s\S]*?-->/g, '');
  const secs = sections(body);
  const askSec = secs.find((s) => s.heading && ASK_HEADING.test(s.heading));
  let ask = null;
  let claims = [];
  let teachBack = null;
  if (askSec) {
    const claimsAt = askSec.lines.findIndex((l) => /^###\s+claims\b/i.test(l));
    const askLines = claimsAt < 0 ? askSec.lines : askSec.lines.slice(0, claimsAt);
    ask =
      askLines
        .filter((l) => !/\*\*Teach-back:\*\*/i.test(l))
        .join('\n')
        .trim() || null;
    if (claimsAt >= 0) {
      const after = askSec.lines.slice(claimsAt + 1);
      // The claims end at the next sub-heading OR the teach-back line: a `**Teach-back:**` written directly under the
      // last claim would otherwise fold into it as a lazy continuation (fresh review of #196).
      const end = after.findIndex((l) => /^###\s/.test(l) || TEACH_BACK_LINE.test(l));
      claims = listItems(end < 0 ? after : after.slice(0, end), { numbered: true });
    }
    // `yes | partly | no` is the template's format string, not an answer: a word followed by `|` never counts
    // (the same rule D17 applies to the retro's `_Intent:_` line).
    const tb = askSec.lines.join('\n').match(/\*\*Teach-back:\*\*\s*(yes|partly|no)\b(?!\s*\|)/i);
    teachBack = tb ? tb[1].toLowerCase() : null;
  }
  const accSec = secs.find((s) => s.heading && ACCEPTANCE_HEADING.test(s.heading));
  const criteria = accSec ? listItems(accSec.lines) : [];
  // C5: the pitch Jev reads never holds the ask itself (coverage-in would find every claim in it) or a previous
  // score (the model would grade its own earlier answer).
  const pitch = secs
    .filter((s) => !(s.heading && (ASK_HEADING.test(s.heading) || INTENT_HEADING.test(s.heading))))
    .map((s) => (s.heading ? [`## ${s.heading}`, ...s.lines] : s.lines).join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { frontmatter, ask, claims, teachBack, criteria, pitch };
}

// ── The request (D10) ─────────────────────────────────────────────────────────────────────────────────────────

const itemQuestion = (id, path, extra = {}) => {
  const q = INTENT_QUESTIONS[id];
  let instructions = q.instructions.replace('{item}', `\`${path}\``);
  for (const [k, v] of Object.entries(extra)) instructions = instructions.replace(`{${k}}`, v);
  return { type: q.type, instructions, criteria: q.criteria };
};

const claimKey = (i) => `c${i + 1}`;
const criterionKey = (j) => `a${j + 1}`;

/** The state every question reads: the pitch without the ask, and the items keyed so a question can name them. */
export function stateOf(parsed) {
  return {
    pitch: parsed.pitch,
    claims: Object.fromEntries(parsed.claims.map((c, i) => [claimKey(i), c])),
    criteria: Object.fromEntries(parsed.criteria.map((a, j) => [criterionKey(j), a])),
    // why-as-a-story D3: the Why, asked about on its own (advisory, outside the total). Only when the seed has one.
    ...(whyOf(parsed) ? { why: whyOf(parsed) } : {}),
  };
}

/** The seed's Why (`hypothesis`), or null when it has none. Pure. */
export function whyOf(parsed) {
  const v = parsed.frontmatter?.hypothesis;
  return typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : null;
}

/**
 * The scoring request. Pure. Claims are required — without the ask there is nothing to match against, so the
 * caller reports "could not look" rather than a clarity-only number wearing the name "intent match".
 */
export function buildRequest(parsed) {
  const questions = {};
  parsed.claims.forEach((_, i) => {
    questions[`in_${claimKey(i)}`] = itemQuestion('coverage_in', `claims.${claimKey(i)}`);
  });
  parsed.criteria.forEach((_, j) => {
    questions[`out_${criterionKey(j)}`] = itemQuestion('coverage_out', `criteria.${criterionKey(j)}`);
    questions[`clar_${criterionKey(j)}`] = itemQuestion('clarity', `criteria.${criterionKey(j)}`);
  });
  if (whyOf(parsed)) questions.why_story = itemQuestion('why_story', 'why');
  return { state: stateOf(parsed), questions };
}

// ── Scoring (D11) ─────────────────────────────────────────────────────────────────────────────────────────────

const isUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const TEACH_BACK = { yes: 1, partly: 0.5, no: 0 };
export const SIGNAL_NAMES = Object.freeze({
  coverage_in: 'coverage in',
  coverage_out: 'coverage out',
  clarity: 'clarity',
  teach_back: 'teach-back',
  agreement: 'agreement',
});

export function band(total) {
  return BANDS.find((b) => total >= b.min).label;
}

/** The total from whatever signals are present (the reader step reuses this to add agreement). Pure. */
export function totalOf(signals) {
  const present = Object.entries(signals).filter(([, v]) => isUnit(v));
  if (!present.length) return null;
  return { total: Math.round(100 * mean(present.map(([, v]) => v))), present: present.map(([k]) => k) };
}

/**
 * Turn Jev's answers into the score. Pure. ANY answer that is not the right shape makes the whole result
 * could-not-look: a Noul must be a probability in [0,1] and a Score a number in [0,3] — `Number(true)` scoring as
 * a certainty is the bug the guards already shipped once (LEARNINGS, jev-semantic-guards).
 */
export function scoreAnswers(parsed, answers) {
  const bad = [];
  // The answer's own `type` must match the question's too: a `{ type: 'score', noul: 0.9 }` is not a Noul answer,
  // and reading its `.noul` anyway would turn a malformed reply into a number (codex on #196).
  const noul = (id) => {
    const a = answers?.[id];
    if (a?.type !== 'noul' || !isUnit(a.noul)) bad.push(id);
    return a?.noul;
  };
  const score = (id) => {
    const a = answers?.[id];
    const v = a?.score;
    if (a?.type !== 'score' || !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 3))
      bad.push(id);
    return v / 3;
  };
  const claims = parsed.claims.map((text, i) => ({ id: claimKey(i), text, p: noul(`in_${claimKey(i)}`) }));
  const criteria = parsed.criteria.map((text, j) => ({
    id: criterionKey(j),
    text,
    traced: noul(`out_${criterionKey(j)}`),
    clarity: score(`clar_${criterionKey(j)}`),
  }));
  if (bad.length) return { ok: false, error: `malformed answer(s): ${bad.slice(0, 3).join(', ')}` };
  const signals = {
    coverage_in: claims.length ? mean(claims.map((c) => c.p)) : null,
    coverage_out: criteria.length ? mean(criteria.map((a) => a.traced)) : null,
    clarity: criteria.length ? mean(criteria.map((a) => a.clarity)) : null,
    teach_back: parsed.teachBack ? TEACH_BACK[parsed.teachBack] : null,
  };
  const { total, present } = totalOf(signals);
  const gaps = [
    ...claims
      .filter((c) => c.p < 0.5)
      .map((c) => ({ id: c.id, kind: 'uncovered', value: c.p, text: c.text })),
    ...criteria
      .filter((a) => a.clarity < 0.5)
      .map((a) => ({ id: a.id, kind: 'unclear', value: a.clarity, text: a.text })),
  ];
  const untraced = criteria
    .filter((a) => a.traced < 0.5)
    .map((a) => ({ id: a.id, value: a.traced, text: a.text }));
  // why-as-a-story D3: advisory and outside the total. A missing or malformed answer is "could not look", never a
  // failure of the whole score: the total's calibration must not move because this question exists.
  const w = answers?.why_story;
  // Not asked (no Why in the seed) is undefined, so the report leaves the line out (verifier #343).
  const whyStory = !whyOf(parsed) ? undefined : w?.type === 'noul' && isUnit(w.noul) ? w.noul : null;
  return { ok: true, signals, total, present, band: band(total), claims, criteria, gaps, untraced, whyStory };
}

const GAP_WORDS = {
  uncovered: 'the requester asked for this and the plan does not deliver it',
  unclear: 'the plan says it will check this, but two builders could not test it the same way',
};

/** The routing request: one Choice per gap (D14). Pure. */
export function buildRouteRequest(parsed, gaps) {
  const questions = {};
  for (const g of gaps) {
    const path = g.id.startsWith('c') ? `claims.${g.id}` : `criteria.${g.id}`;
    questions[`route_${g.id}`] = itemQuestion('route', path, { gap: GAP_WORDS[g.kind] });
  }
  return { state: stateOf(parsed), questions };
}

/** Attach each gap's route, or "could not look" for that gap. A route never changes the score. Pure. */
export function applyRoutes(gaps, res) {
  return gaps.map((g) => {
    const choice = res?.ok ? res.answers?.[`route_${g.id}`]?.choice : undefined;
    return { ...g, route: Object.hasOwn(ROUTES, choice ?? '') ? choice : null };
  });
}

// ── Output ────────────────────────────────────────────────────────────────────────────────────────────────────

const f2 = (n) => n.toFixed(2);
const clip = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const itemLabel = (id) => (id.startsWith('c') ? `claim ${id.slice(1)}` : `criterion ${id.slice(1)}`);

/** The human report. Pure. `agreement` is the reader's P(same build), or undefined ("pending"). */
export function formatReport(result, { source = 'the seed', agreement, reader } = {}) {
  const s = result.signals;
  const row = (name, v, detail) => `  ${name.padEnd(13)} ${v == null ? '—   ' : f2(v)}  ${detail}`;
  const lines = [
    `Intent match — ${source}`,
    row(
      'coverage in',
      s.coverage_in,
      `(${result.claims.length} claim${result.claims.length === 1 ? '' : 's'})`
    ),
    row(
      'coverage out',
      s.coverage_out,
      result.criteria.length ? `(${result.criteria.length} criteria)` : '(no acceptance list)'
    ),
    row(
      'clarity',
      s.clarity,
      result.criteria.length ? `(${result.criteria.length} criteria)` : '(no acceptance list)'
    ),
    row(
      'teach-back',
      s.teach_back,
      s.teach_back == null ? '(not recorded)' : `(${{ 1: 'yes', 0.5: 'partly', 0: 'no' }[s.teach_back]})`
    ),
    agreement == null
      ? '  agreement     pending  (the optional reader at the architecture lock)'
      : row('agreement', agreement, reader ? `(reader: ${reader})` : ''),
    ...(result.whyStory === undefined
      ? []
      : [
          result.whyStory === null
            ? '  why story     —     (could not look; advisory, not in the total)'
            : row(
                'why story',
                result.whyStory,
                `(advisory, not in the total${result.whyStory < 0.5 ? ': rewrite the Why as a story' : ''})`
              ),
        ]),
    `Total ${result.total} / 100 — uncalibrated · signals: ${result.present.map((k) => SIGNAL_NAMES[k]).join(', ')}`,
    `Band: ${result.band} (placeholder bands: 80 build · 60 resolve follow-ups · below 60 sketch or spike)`,
  ];
  if (result.gaps.length) {
    lines.push('Gaps:');
    for (const g of result.gaps)
      lines.push(
        `  ${itemLabel(g.id)} — ${g.kind} (${f2(g.value)}): "${clip(g.text)}" → ${g.route ? ROUTES[g.route] : 'route: could not look'}`
      );
  } else lines.push('Gaps: none');
  if (result.untraced.length) {
    lines.push('Untraced (trace it to the ask or cut it):');
    for (const u of result.untraced) lines.push(`  ${itemLabel(u.id)} (${f2(u.value)}): "${clip(u.text)}"`);
  }
  return lines.join('\n');
}

/** The components, machine-readable, for the seed's `## Intent match` comment (D12). Pure. */
export function componentsOf(result) {
  const round = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  return Object.fromEntries(Object.entries(result.signals).map(([k, v]) => [k, round(v)]));
}

/**
 * The components a `--write` stored in a seed's `<!-- intent-match: {…} -->` comment, or null. Pure. Only unit
 * numbers survive, so a hand-edited comment can never smuggle a non-number into a total.
 */
export function componentsFrom(text) {
  const m = /<!-- intent-match: (\{[^\n]*?\}) -->/.exec(String(text ?? ''));
  if (!m) return null;
  let raw;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const out = {};
  for (const k of Object.keys(SIGNAL_NAMES)) if (isUnit(raw?.[k])) out[k] = raw[k];
  return Object.keys(out).length ? out : null;
}

/** The `## Intent match` section `--write` puts in the seed. Pure. */
export function intentSection(result, opts = {}) {
  return [
    '## Intent match',
    '',
    '_Advisory and uncalibrated (intent-match D1, D3): it can add a step, never block one. Regenerate with `node scripts/intent-match.mjs <this seed> --write`._',
    '',
    '```text',
    formatReport(result, opts),
    '```',
    '',
    `<!-- intent-match: ${JSON.stringify({ ...componentsOf(result), total: result.total })} -->`,
    '',
  ].join('\n');
}

/** Set `key: value` in a document's frontmatter — replaced, or added before the closing fence. Pure. */
export function setFrontmatterKey(text, key, value, { onlyIfAbsent = false } = {}) {
  const src = String(text);
  const fm = FRONTMATTER_RE.exec(src);
  if (!fm) return src;
  let block = fm[0];
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(block)) {
    if (!onlyIfAbsent) block = block.replace(re, `${key}: ${value}`);
  } else block = block.replace(/\n---\n?$/, `\n${key}: ${value}\n---\n`);
  return block + src.slice(fm[0].length);
}

/** Replace the `## Intent match` section (up to the next `## `), or append it. Pure. */
export function upsertIntentSection(text, section) {
  const src = String(text);
  const lines = src.split('\n');
  // Fence-aware, like sections(): a `## Intent match` inside a code block is an example, and treating it as the
  // section deleted everything up to the next heading, closing fence included (fresh review of #196).
  const headingAt = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (FENCE_RE.test(l)) fence = !fence;
    else if (!fence && /^## /.test(l)) headingAt.push(i);
  });
  const start = headingAt.find((i) => INTENT_HEADING.test(lines[i].slice(3).trim())) ?? -1;
  if (start < 0) return `${src.replace(/\s*$/, '')}\n\n${section}`;
  const end = headingAt.find((i) => i > start) ?? lines.length;
  return [...lines.slice(0, start), ...section.replace(/\n$/, '').split('\n'), '', ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Put the score into the seed text. Pure. `intent_match:` goes into the frontmatter, `intent_ask: verbatim` is added
 * when the seed has an ask and no `intent_ask:` yet, and `## Intent match` replaces any earlier one or is appended.
 */
export function writeIntoSeed(text, result, opts = {}) {
  let src = setFrontmatterKey(text, 'intent_match', result.total);
  if (opts.hasAsk) src = setFrontmatterKey(src, 'intent_ask', 'verbatim', { onlyIfAbsent: true });
  return upsertIntentSection(src, intentSection(result, opts));
}

// ── The run, every side effect injected ───────────────────────────────────────────────────────────────────────

const couldNotLook = (why) => ({ state: 'could-not-look', why });

/**
 * Score one seed's text. Returns { state: 'scored', result } or { state: 'could-not-look', why }. Never throws for
 * a Jev problem. deps: { config, key, ask, route=true, onCount }.
 */
export async function scoreSeed(text, deps) {
  const { config, key, ask, route = true, onCount = () => {} } = deps;
  const parsed = parseSeed(text);
  if (!parsed.claims.length)
    return couldNotLook(
      'no claims to match against — the seed needs `## The ask, as given` with a `### Claims` list'
    );
  if (config.egress !== true)
    return couldNotLook(`jev.egress is ${JSON.stringify(config.egress)}, not true — nothing is sent to Jev`);
  if (!key) return couldNotLook('no TYPESAFE_API_KEY');
  const req = buildRequest(parsed);
  // Checked here as well as in askJev so the refusal names the pitch, and happens before the count is printed.
  if (stateSize(req.state) > STATE_CHAR_BUDGET)
    return couldNotLook(
      `the pitch is over Jev's state budget (${stateSize(req.state)} > ${STATE_CHAR_BUDGET} chars); it is never truncated`
    );
  onCount(Object.keys(req.questions).length, parsed);
  const res = await ask(req);
  if (!res?.ok) return couldNotLook(`jev: ${res?.error ?? 'no answer'}`);
  const result = scoreAnswers(parsed, res.answers);
  if (!result.ok) return couldNotLook(`jev: ${result.error}`);
  if (route && result.gaps.length)
    result.gaps = applyRoutes(result.gaps, await ask(buildRouteRequest(parsed, result.gaps)));
  else result.gaps = result.gaps.map((g) => ({ ...g, route: null }));
  return { state: 'scored', result, parsed, model: res.model ?? null };
}

/**
 * One labelled fixture, judged the way the scorer asks it — the `intent` set in jev-eval (D15). A fixture is
 * { question: 'coverage_in' | 'coverage_out' | 'clarity', pitch, claims, criteria, item, label }. Returns
 * { value: boolean | null, p, decider }: value is the answer as a yes/no (P ≥ 0.5, or clarity ≥ 0.5).
 */
export async function judgeItem(fx, deps) {
  const prefix = { coverage_in: 'in', coverage_out: 'out', clarity: 'clar' }[fx.question];
  if (!prefix) return { value: null, p: null, decider: 'could-not-look' };
  const path = `${fx.item.startsWith('c') ? 'claims' : 'criteria'}.${fx.item}`;
  const id = `${prefix}_${fx.item}`;
  const res = await deps.ask({
    state: { pitch: fx.pitch, claims: fx.claims ?? {}, criteria: fx.criteria ?? {} },
    questions: { [id]: itemQuestion(fx.question, path) },
  });
  const a = res?.ok ? res.answers?.[id] : undefined;
  const want = INTENT_QUESTIONS[fx.question].type;
  const p =
    a?.type !== want
      ? undefined
      : want === 'score'
        ? typeof a.score === 'number'
          ? a.score / 3
          : undefined
        : a.noul;
  if (!isUnit(p)) return { value: null, p: null, decider: 'could-not-look' };
  return { value: p >= 0.5, p: Math.round(p * 1000) / 1000, decider: 'jev' };
}

export async function run(argv, io) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const unknown = [...flags].filter((f) => !['--json', '--write', '--no-route', '--help'].includes(f));
  if (flags.has('--help') || args.length !== 1 || unknown.length) {
    io.stderr(
      `${unknown.length ? `intent-match: unknown flag ${unknown.join(', ')}\n` : ''}usage: node scripts/intent-match.mjs <seed.md> [--json] [--write] [--no-route]\n`
    );
    return EXIT_USAGE;
  }
  const path = args[0];
  let text;
  try {
    // Normalised ONCE, before parse and write: a CRLF seed used to score and then have `--write` miss its frontmatter
    // and still report the write (fresh review round 2, #196). The seed is written back with LF endings.
    text = io.read(path).replace(/\r\n?/g, '\n');
  } catch (e) {
    io.stderr(`intent-match: cannot read ${path} (${e.code ?? e.message})\n`);
    return EXIT_USAGE;
  }
  const config = io.config();
  // Unanswered egress is a question to ask once, not a silent "off" forever (golden-frijoles-plugin D11/D12).
  if (config.egress === null) io.needEgress();
  // The key is not even read until egress is a yes (the jev-eval rule): an unanswered project reads no secret.
  const key = config.egress === true ? io.key() : null;
  const out = await scoreSeed(text, {
    config,
    key,
    ask: io.makeAsk({ model: config.model, key }),
    route: !flags.has('--no-route'),
    onCount: (n, parsed) =>
      io.stderr(
        `intent-match: asking Jev ${n} question(s) — ${parsed.claims.length} claim(s), ${parsed.criteria.length} criteria${flags.has('--no-route') ? '' : ', then one more per gap to route it'}.\n`
      ),
  });
  if (out.state !== 'scored') {
    const line = `intent match: could not look (${out.why}) — no score.`;
    if (flags.has('--json')) io.stdout(`${JSON.stringify({ state: out.state, why: out.why })}\n`);
    io.stderr(`${line}\n`);
    return EXIT_COULD_NOT_LOOK;
  }
  const { result, parsed } = out;
  const report = formatReport(result, { source: path });
  if (flags.has('--json')) {
    io.stdout(
      `${JSON.stringify({ state: 'scored', total: result.total, band: result.band, signals: componentsOf(result), present: result.present, gaps: result.gaps, untraced: result.untraced, uncalibrated: true, model: out.model })}\n`
    );
    io.stderr(`${report}\n`);
  } else io.stdout(`${report}\n`);
  if (flags.has('--write')) {
    io.write(path, writeIntoSeed(text, result, { source: path, hasAsk: Boolean(parsed.ask) }));
    io.stderr(`intent-match: wrote intent_match: ${result.total} and ## Intent match into ${path}\n`);
  }
  io.log({
    rail: 'intent',
    mode: 'advisory',
    decider: 'jev',
    confidence: result.total / 100,
    text: path,
    source: path,
    evidence: {
      signals: componentsOf(result),
      present: result.present,
      gaps: result.gaps.length,
      untraced: result.untraced.length,
    },
  });
  return EXIT_SCORED;
}

async function main() {
  const root = repoRoot();
  const code = await run(process.argv.slice(2), {
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, t) => writeFileSync(p, t),
    config: () => loadJevConfig({ root }),
    key: () => readApiKey({ root }),
    needEgress: () => needSetting('jev.egress', { blocking: false, root }),
    makeAsk:
      ({ model, key }) =>
      (req) =>
        askJev(req, { key, model, timeoutMs: INTENT_TIMEOUT_MS }),
    log: (entry) => logDecision(entry, { root }),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  });
  process.exitCode = code;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  main().catch((e) => {
    process.stderr.write(`intent-match: ${e.message}\n`);
    process.exitCode = EXIT_USAGE;
  });
