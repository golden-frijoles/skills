// roadmap-contract.mjs — THE machine-readable frontmatter contract for Roadmap epic docs, defined once
// (build-visualization-claude-mods D8). doc-format.mjs enforces it, roadmap-backfill.mjs writes it and
// build-state.mjs reads it; none of them restates a field list. Pure: zero I/O, zero dependencies.
//
// What it replaces: epic title/area/risk lived in a bold prose line, sprint files had NO frontmatter
// at all, and a story's identity and user story were prose under a `### Story N.M —` heading that
// came in six shapes across the corpus. A tool that scrapes those reports confidently while wrong.
//
// ── The shape ──────────────────────────────────────────────────────────────────────────────────────
// Epic README frontmatter — the lifecycle `status:` (scaffolded|in-progress|shipped|archived, the
// board's SSOT, untouched by this contract) plus:
//   title · area · risk · type · phase · sprints_total · stories_total   (and the existing slug, build_order)
// sprint-N.md frontmatter:
//   epic · sprint · title · risk · phase · stories_total · stories
// Each `stories:` entry (D1 — a list in the sprint frontmatter, one flat map per story):
//   id · title · as_a · i_want · so_that · risk · status
// The three user-story fields are the prose's own words, article included, so they render back as
// "As <as_a>, I want <i_want>, so that <so_that>." — `as_a: a buyer's agent`, `as_a: the product owner`.
//
// ── Why the ladder is `phase:` and not `status:` (D6) ─────────────────────────────────────────────
// An epic README's `status:` is the lifecycle every roadmap tool reads, and an unknown value there
// hard-fails the extractor. On a sprint file, a frontmatter `status:` line would be captured by the
// extractor's case-insensitive `^Status:` regex before the prose Status line, silently re-deriving
// the board. So the executive ladder is its own field on both.
//
// ── The YAML subset ────────────────────────────────────────────────────────────────────────────────
// Deliberately small, so a zero-dependency parser owns it completely: top-level `key: scalar` lines
// (an unquoted value may carry a trailing ` # comment`), whole-line `#` comments at any indent, and a
// top-level `key:` followed by a list of flat maps (`  - k: v` then `    k: v`). A scalar is `null`,
// `~` or empty (→ null), `[]` (an empty list), an integer, a decimal (`38.42`, finops D17 — the FinOps
// fields carry dollars), a double-quoted JSON string, a single-quoted YAML string, or a bare string; any of
// them may carry a trailing ` # comment`. Booleans are not in the subset (no contract field uses one), and
// neither are exponents or a bare `.5`. Anything else is a parse error, not guessed around.

export const PHASES = ['Shaping', 'Locking architecture', 'Building', 'Verifying', 'In review', 'Shipped'];
export const STORY_STATUSES = ['planned', 'in-progress', 'done'];
export const RISKS = ['low', 'high'];
export const TYPES = ['feature', 'spike', 'bug', 'chore'];

export const EPIC_FIELDS = ['title', 'area', 'risk', 'type', 'phase', 'sprints_total', 'stories_total'];
export const SPRINT_FIELDS = ['epic', 'sprint', 'title', 'risk', 'phase', 'stories_total', 'stories'];
export const STORY_FIELDS = ['id', 'title', 'as_a', 'i_want', 'so_that', 'risk', 'status'];

// finops D6/D17 — an epic's quote (written at refining) and its actual (stamped at close), declared ONCE here.
// All optional: an epic scaffolded before FinOps has none, and an absent field is never a zero (D4). The numeric
// ones are numbers >= 0 or null; a `*_basis` says where the number came from, in words.
export const FINOPS_NUMERIC_FIELDS = ['quote_low_usd', 'quote_high_usd', 'actual_usd', 'actual_mtok'];
// `actual_models` (why-as-a-story D6) is text too, validated here but NOT in FINOPS_FIELDS: it stays in the README for the
// retrospective's Crew line and is never pushed, so the hosted push schema does not change.
export const FINOPS_BASIS_FIELDS = ['quote_basis', 'actual_basis', 'actual_models'];
export const FINOPS_FIELDS = [
  'quote_low_usd',
  'quote_high_usd',
  'quote_basis',
  'actual_usd',
  'actual_mtok',
  'actual_basis',
];

// result-record D1/D2 — the result record: what an epic should move (written at refining) and its verdict (written at
// the read), declared ONCE here. All optional: no target is "no target", never an error. Dates are calendar days.
export const VERDICTS = ['proven', 'disproven', 'unclear'];
export const TARGET_FIELDS = ['hypothesis', 'target_metric', 'target_from', 'target_to', 'read_date'];
export const VERDICT_FIELDS = ['verdict', 'verdict_actual', 'verdict_evidence', 'verdict_at'];
export const RESULT_FIELDS = [...TARGET_FIELDS, ...VERDICT_FIELDS];
export const RESULT_NUMERIC_FIELDS = ['target_from', 'target_to', 'verdict_actual'];
export const RESULT_DAY_FIELDS = ['read_date', 'verdict_at'];
export const RESULT_TEXT_FIELDS = ['hypothesis', 'target_metric', 'verdict_evidence'];

// D2 — what proven or disproven must point at, checked offline as syntax only: a link, a North Star input's reading
// on a day, or an experiment's A/B decision record. Keys are the platform's own shape (lowercase, digits, _ . -).
// Case-SENSITIVE on purpose (codex review, #290): with `/i`, `HTTPS:///` matched here and then skipped the URL parse
// below, which keys on the lowercase scheme. Keys take either case; the scheme and prefixes are lowercase.
export const EVIDENCE_POINTER_RE =
  /^(?:https:\/\/\S+|north-star:[A-Za-z0-9][A-Za-z0-9_.-]*@\d{4}-\d{2}-\d{2}|ab:[A-Za-z0-9][A-Za-z0-9_.-]*)$/;

// Zero dependencies is load-bearing: projects and fixtures copy this file on its own. So the day check lives here and
// `result-dates.mjs` imports it, not the other way round.
/** Whether `v` is a real calendar day written `YYYY-MM-DD` (`2026-02-30` is not), read in UTC. */
export function isDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Whether `v` is an evidence pointer (D2). A `north-star:` pointer's day must be a real calendar day. */
export function isEvidencePointer(v) {
  if (typeof v !== 'string' || !EVIDENCE_POINTER_RE.test(v.trim())) return false;
  const t = v.trim();
  // A link must PARSE (codex review, #290): the regex alone lets `https:///` through. The WHATWG parser refuses an
  // https URL with no host, so a successful parse is the whole check — the scheme was already matched above.
  if (t.startsWith('https://')) {
    try {
      new URL(t);
      return true;
    } catch {
      return false;
    }
  }
  const day = /@(\d{4}-\d{2}-\d{2})$/.exec(t)?.[1];
  return !day || isDay(day);
}

/** The result-record fields of an epic's frontmatter data → offenses (`contract-result-invalid`). Absent is fine. */
export function validateResultFields(fm) {
  const offenses = [];
  const bad = (detail) => offenses.push({ rule: 'contract-result-invalid', detail });
  const has = (key) => fm[key] !== undefined && fm[key] !== null;
  for (const key of RESULT_NUMERIC_FIELDS)
    if (has(key) && (typeof fm[key] !== 'number' || !Number.isFinite(fm[key])))
      bad(`${key}: "${fm[key]}" is not a number (or null)`);
  for (const key of RESULT_DAY_FIELDS)
    if (has(key) && !isDay(fm[key])) bad(`${key}: "${fm[key]}" is not a day written YYYY-MM-DD (or null)`);
  for (const key of RESULT_TEXT_FIELDS)
    if (has(key) && (typeof fm[key] !== 'string' || !fm[key].trim()))
      bad(`${key}: "${fm[key]}" is not text (or null)`);
  // A target is the three together — which number, from what, to what (fresh review, #290): from/to or a read date
  // with no metric would never come due (everything keys off target_metric), and a metric with no numbers has no
  // direction to judge. A hypothesis on its own is allowed: a sentence is not a target.
  const targetKeys = ['target_metric', 'target_from', 'target_to', 'read_date'];
  if (targetKeys.some(has)) {
    for (const key of ['target_metric', 'target_from', 'target_to'])
      if (!has(key))
        bad(`a target needs target_metric, target_from and target_to together — ${key} is missing`);
  }
  if (has('target_from') && has('target_to') && fm.target_from === fm.target_to)
    bad(`target_from and target_to are both ${fm.target_from}: a target has to move the number`);
  if (has('verdict') && !VERDICTS.includes(fm.verdict))
    bad(`verdict: "${fm.verdict}" is not one of ${VERDICTS.join(' | ')}`);
  if (!has('verdict')) {
    for (const key of VERDICT_FIELDS.slice(1)) if (has(key)) bad(`${key} is set but there is no verdict`);
  } else {
    if (!has('verdict_at')) bad('a verdict needs verdict_at (the day it was read)');
    if (!has('verdict_evidence'))
      bad('a verdict needs verdict_evidence (a pointer, or for unclear, the reason)');
    if (fm.verdict === 'proven' || fm.verdict === 'disproven') {
      if (!has('verdict_actual'))
        bad(`verdict: ${fm.verdict} needs verdict_actual (the number that was read)`);
      if (has('verdict_evidence') && !isEvidencePointer(fm.verdict_evidence))
        bad(
          `verdict: ${fm.verdict} needs evidence that points somewhere: an https:// link, ` +
            `north-star:<input>@YYYY-MM-DD or ab:<experiment>, not "${fm.verdict_evidence}"`
        );
    }
  }
  return offenses;
}

// one-epic-page D11 — the epic's flag, decided at refine Stage 6b and copied into the README by the scaffold. The SDK's
// flag-key grammar (`FLAG_KEY` in apps/web/lib/flag-admin-operation.ts). Optional: `flag_key: null` (no flag) is the
// default and never an error; a value that is not a key is named, never pushed (the extract sends null for it).
export const FLAG_KEY_RE = /^[a-z][a-z0-9_.-]{0,127}$/;

/** `flag_key:` → offenses (`contract-flag-key-invalid`). Absent or null is fine. */
export function validateFlagKey(fm) {
  const v = fm.flag_key;
  if (v === undefined || v === null) return [];
  // The string "null" fits the grammar but means "no flag": named here as the push schema refuses it (codex, #297).
  if (typeof v === 'string' && v !== 'null' && FLAG_KEY_RE.test(v)) return [];
  return [
    {
      rule: 'contract-flag-key-invalid',
      detail: `flag_key: "${v}" is not a flag key (a lowercase letter, then a-z 0-9 _ . -; at most 128) — or null`,
    },
  ];
}

// grounded-bets D1 — `grounded:` is the founder's word at Stage 1.5: true (traced to a North Star input), false (funded
// anyway, and `grounded_reason` says why), or absent/null (a Bug, a Chore, or an epic refined before it existed).
// Whether a bet COUNTS as grounded is derived from its target (bets-grounded.mjs, D2), never from this field alone.
// one-bet-wired D1 — a bet's measurement: what its flag funnel reads. Optional as a whole; once any field is set it
// needs a flag and an adoption event, the only segment is `everyone` (named segments are tars-segments), and the window
// is 1–90 whole days. Event names are tokens: what the SDK sends.
export const BET_FIELDS = [
  'target_segment',
  'adopted_event',
  'retained_event',
  'retention_days',
  'satisfied_event',
];
export const BET_SEGMENTS = ['everyone'];
const EVENT_NAME = /^[A-Za-z0-9_.:$-]{1,200}$/;

/** The bet's measurement fields → offenses (`contract-bet-invalid`). All absent is fine. */
export function validateBet(fm) {
  const offenses = [];
  const bad = (detail) => offenses.push({ rule: 'contract-bet-invalid', detail });
  const has = (key) => fm[key] !== undefined && fm[key] !== null;
  if (!BET_FIELDS.some(has)) return offenses;
  if (!has('flag_key')) bad('a bet with measurement needs a flag_key (the flag whose funnel it reads)');
  if (!has('adopted_event')) bad('a bet with measurement needs an adopted_event (what counts as adopting)');
  if (has('target_segment') && !BET_SEGMENTS.includes(fm.target_segment))
    bad(
      `target_segment: "${fm.target_segment}" is not one of ${BET_SEGMENTS.join(' | ')} (named segments come with tars-segments)`
    );
  for (const key of ['adopted_event', 'retained_event', 'satisfied_event'])
    if (has(key) && !(typeof fm[key] === 'string' && EVENT_NAME.test(fm[key])))
      bad(`${key}: "${fm[key]}" is not an event name (letters, digits, _ . : $ -)`);
  if (
    has('retention_days') &&
    !(Number.isInteger(fm.retention_days) && fm.retention_days >= 1 && fm.retention_days <= 90)
  )
    bad(`retention_days: "${fm.retention_days}" is not a whole number of days from 1 to 90`);
  return offenses;
}

// why-as-a-story D2/D4 — the Why is read in full, so it must fit what shows it. The build view gives the Why WHY_ROOM
// columns (80, less its 11-column label) and WHY_LINES_MAX lines; `wrapWords` is the ONE wrap both the view and the
// guard use, so "passes the guard" and "shows in full" cannot drift apart. The rest of the guard keeps it plain words:
// what a script can tell (a path, a backtick, a code name, a short list of internal words). Whether it reads as a story
// is a judgment (intent-match's advisory question), never this.
export const WHY_ROOM = 69;
export const WHY_LINES_MAX = 5;
export const WHY_INTERNAL_WORDS = Object.freeze([
  'wiring',
  'wired',
  'seam',
  'endpoint',
  'frontmatter',
  'schema',
  'payload',
  'middleware',
  'refactor',
]);

/** Words into lines of at most `room` characters; past `max` lines, the last one ends in "…". Pure. */
export function wrapWords(text, room = WHY_ROOM, max = WHY_LINES_MAX) {
  const lines = [];
  let line = '';
  for (const word of String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= room) line = next;
    else {
      if (line) lines.push(line);
      // One word wider than the room is the only thing ever cut mid-word.
      line = word.length > room ? `${word.slice(0, room - 1)}…` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  const last = kept[max - 1];
  kept[max - 1] = last.length < room ? `${last}…` : `${last.slice(0, room - 1)}…`;
  return kept;
}

/** A Why (a Feature's `hypothesis`) → what keeps it from reading in full and in plain words. Empty = fine. Pure. */
export function whyProblems(text) {
  const why = String(text ?? '').trim();
  if (!why) return ['the Why is empty'];
  const problems = [];
  if (/^[>|][1-9]?[+-]?[1-9]?$/.test(why))
    return ['it is a folded YAML block the readers cannot see: write the Why on one line, in quotes'];
  // A word wider than a line is cut mid-word in the view, so it fails here too (verifier #343).
  const wide = why.split(/\s+/).find((w) => w.length > WHY_ROOM);
  if (wide)
    problems.push(`one word is wider than a line ("${wide.slice(0, 24)}…"): shorten it or leave it out`);
  const lines = wrapWords(why, WHY_ROOM, Infinity).length;
  if (lines > WHY_LINES_MAX)
    problems.push(
      `it takes ${lines} lines on screen; the build view shows ${WHY_LINES_MAX} (about 320 characters)`
    );
  if (why.includes('`')) problems.push('it has a backtick: write the words, not code');
  const path = why.match(
    // A file with a code extension (not `.js`: Next.js and Node.js are product names), or a path rooted at `/`, `./` or
    // `../`. A bare `reader/writer/editor` or `and/or` is prose (verifier #343).
    /\b[\w-]+\.(?:mjs|cjs|tsx?|md|json|sql|ya?ml)\b|(?:^|\s)\.{0,2}\/[\w.-]+(?:\/[\w.-]+)+/
  );
  if (path) problems.push(`it names a file or path ("${path[0].trim()}")`);
  const ident = why.match(
    // snake_case (and dotted keys holding one, `bets.flag_funnels_enabled`), or camelCase with a lowercase run of two or
    // more before the hump and a lowercase after it, so iPhone, eBay, iOS and macOS stay prose (verifier #343).
    /\b[a-z][a-z0-9]*(?:[._][a-z0-9]+)*_[a-z0-9]+\b|\b[a-z]{2,}[A-Z][a-z][A-Za-z0-9]*\b/
  );
  if (ident) problems.push(`it names a code identifier ("${ident[0]}")`);
  const words = why.toLowerCase().match(/[a-z]+/g) ?? [];
  const internal = WHY_INTERNAL_WORDS.filter((w) => words.includes(w));
  if (internal.length)
    problems.push(`it uses internal words (${internal.join(', ')}): say what changes for the person`);
  return problems;
}

/** `grounded:` as a boolean: the frontmatter readers keep a bare `true` as the string "true". Null when absent or neither. */
export function groundedValue(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

/** `grounded:` and `grounded_reason:` → offenses (`contract-grounded-invalid`). Absent or null is fine. */
export function validateGrounded(fm) {
  const offenses = [];
  const bad = (detail) => offenses.push({ rule: 'contract-grounded-invalid', detail });
  const raw = fm.grounded;
  const g = groundedValue(raw);
  const reason = fm.grounded_reason;
  const hasReason = reason !== undefined && reason !== null;
  if (raw !== undefined && raw !== null && g === null) bad(`grounded: "${raw}" is not true, false or null`);
  if (hasReason && (typeof reason !== 'string' || !reason.trim()))
    bad(`grounded_reason: "${reason}" is not text (or null)`);
  if (g === false && !hasReason)
    bad('grounded: false needs grounded_reason (why it was funded anyway, one sentence)');
  if (g !== false && hasReason) bad('grounded_reason is set but grounded is not false');
  return offenses;
}

// live-build-view D10 — `locked_at:` is stamped by `scripts/epic-phase.mjs lock` when the architecture lock is written;
// the build view reads its absence as "Locking architecture". Optional (no epic before it has one), an ISO date-time
// string when present: the command writes `"2026-10-03T20:34:34Z"` (quoted, so the frontmatter parser keeps the colons).
export const LOCKED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An epic's `locked_at` → offenses (`contract-locked-at-invalid`). Absent/null is fine. */
export function validateLockedAt(fm) {
  const v = fm.locked_at;
  if (v === undefined || v === null) return [];
  if (typeof v === 'string' && LOCKED_AT_RE.test(v) && !Number.isNaN(Date.parse(v))) return [];
  return [
    {
      rule: 'contract-locked-at-invalid',
      detail: `locked_at: "${v}" is not an ISO date-time (e.g. "2026-10-03T20:34:34Z")`,
    },
  ];
}

/** The FinOps fields of an epic's frontmatter data → offenses (`contract-finops-invalid`). Absent/null is fine. */
export function validateFinopsFields(fm) {
  const offenses = [];
  for (const key of FINOPS_NUMERIC_FIELDS) {
    const v = fm[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      offenses.push({
        rule: 'contract-finops-invalid',
        detail: `${key}: "${v}" is not a number >= 0 (or null)`,
      });
  }
  for (const key of FINOPS_BASIS_FIELDS) {
    const v = fm[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string')
      offenses.push({ rule: 'contract-finops-invalid', detail: `${key}: "${v}" is not a string (or null)` });
  }
  const lo = fm.quote_low_usd;
  const hi = fm.quote_high_usd;
  if (typeof lo === 'number' && typeof hi === 'number' && lo > hi)
    offenses.push({
      rule: 'contract-finops-invalid',
      detail: `quote_low_usd ${lo} is above quote_high_usd ${hi}`,
    });
  if ((typeof lo === 'number') !== (typeof hi === 'number'))
    offenses.push({
      rule: 'contract-finops-invalid',
      detail: 'a quote needs both quote_low_usd and quote_high_usd',
    });
  return offenses;
}

// A story id names its sprint: S<sprint>.<ordinal>. The commit convention D2 derives from uses it.
export const STORY_ID_RE = /^S(\d+)\.(\d+)$/;

// ── Parse ────────────────────────────────────────────────────────────────────────────────────────

function parseScalar(raw, where) {
  let v = raw.trim();
  // A trailing ` # comment` is allowed after any value — quoted ones included, so a hand-edit that
  // annotates a quoted title does not turn into a parse error.
  const quoted = v.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:\s+#.*)?$/);
  if (quoted) v = quoted[1];
  else {
    const hash = v.search(/\s#/);
    if (hash >= 0) v = v.slice(0, hash).trim();
  }
  if (v === '' || v === 'null' || v === '~') return null;
  if (v === '[]') return [];
  if (/^-?\d+$/.test(v)) return Number(v);
  // finops D17 — decimals. The corpus held no bare decimal frontmatter value when this was added (2026-10-02),
  // so no existing reading changed.
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`${where}: malformed double-quoted value ${v}`);
    }
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) throw new Error(`${where}: malformed single-quoted value ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/**
 * Split a markdown doc into its frontmatter data and body.
 * Returns { hasFrontmatter, data, body, raw, error } — `error` is a parse error message (the data is
 * then partial); `raw` is the text between the fences.
 */
export function parseDocFrontmatter(md) {
  const lines = md.split('\n');
  if (lines[0].trim() !== '---') return { hasFrontmatter: false, data: {}, body: md, raw: null, error: null };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1)
    return { hasFrontmatter: false, data: {}, body: md, raw: null, error: 'unterminated frontmatter' };
  const block = lines.slice(1, end);
  const data = {};
  let error = null;
  let list = null; // the list currently being filled
  let item = null; // the map currently being filled
  try {
    for (let i = 0; i < block.length; i++) {
      const line = block[i];
      const where = `frontmatter line ${i + 2}`;
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      const top = line.match(/^(\w+):(?:\s+(.*))?$/);
      if (top) {
        const [, key, rest = ''] = top;
        if (
          rest.trim() === '' &&
          /^\s+-\s/.test(block.slice(i + 1).find((l) => l.trim() && !/^\s*#/.test(l)) || '')
        ) {
          list = data[key] = [];
          item = null;
        } else {
          data[key] = parseScalar(rest, where);
          list = null;
          item = null;
        }
        continue;
      }
      const start = line.match(/^\s+-\s+(\w+):(?:\s+(.*))?$/);
      if (start && list) {
        item = {};
        list.push(item);
        item[start[1]] = parseScalar(start[2] || '', where);
        continue;
      }
      const field = line.match(/^\s+(\w+):(?:\s+(.*))?$/);
      if (field && item) {
        item[field[1]] = parseScalar(field[2] || '', where);
        continue;
      }
      throw new Error(`${where}: not in the contract's YAML subset: "${line.trim()}"`);
    }
  } catch (e) {
    error = e.message;
  }
  return { hasFrontmatter: true, data, body: lines.slice(end + 1).join('\n'), raw: block.join('\n'), error };
}

// ── Serialize ────────────────────────────────────────────────────────────────────────────────────

const BARE_SAFE = /^[A-Za-z0-9][A-Za-z0-9 _.,/()&+-]*$/;
const RESERVED = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', '~']);

/** One scalar in the subset's syntax: bare when unambiguous, else a double-quoted JSON string. */
export function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (BARE_SAFE.test(s) && !/^-?\d+(\.\d+)?$/.test(s) && !RESERVED.has(s.toLowerCase()) && !s.endsWith(' '))
    return s;
  return JSON.stringify(s);
}

/** `key: value` lines (and `key:` + a list of maps) for the given keys, in order. No fences. */
export function serializeFields(data, keys) {
  const out = [];
  for (const key of keys) {
    const v = data[key];
    if (Array.isArray(v) && !v.length) {
      out.push(`${key}: []`); // an empty list stays a list on the way back in
    } else if (Array.isArray(v)) {
      out.push(`${key}:`);
      for (const entry of v) {
        Object.keys(entry).forEach((k, i) =>
          out.push(`${i === 0 ? '  - ' : '    '}${k}: ${formatScalar(entry[k])}`)
        );
      }
    } else {
      out.push(`${key}: ${formatScalar(v)}`);
    }
  }
  return out.join('\n');
}

// ── Validate ─────────────────────────────────────────────────────────────────────────────────────
// Each validator returns a list of { rule, detail } offenses — the shape doc-format.mjs reports.

const isInt = (v) => Number.isInteger(v) && v >= 0;
const oneOf = (v, set) => set.includes(v);

/**
 * An epic README's frontmatter. `ctx.sprintCount` / `ctx.storyCount`, when given, are cross-checked
 * against the declared totals. An `archived` epic is frozen record and exempt from the new fields.
 */
export function validateEpicFrontmatter(parsed, ctx = {}) {
  const offenses = [];
  if (!parsed.hasFrontmatter) return offenses; // frontmatter-missing is doc-format's existing rule
  if (parsed.error) return [{ rule: 'contract-parse', detail: parsed.error }];
  const fm = parsed.data;
  if (fm.status === 'archived') return offenses;
  for (const key of EPIC_FIELDS) {
    if (!(key in fm) || fm[key] === null)
      offenses.push({ rule: 'contract-epic-field-missing', detail: `no \`${key}:\`` });
  }
  if (fm.phase != null && !oneOf(fm.phase, PHASES))
    offenses.push({
      rule: 'contract-phase-invalid',
      detail: `phase: "${fm.phase}" is not one of ${PHASES.join(' | ')}`,
    });
  if (fm.risk != null && !oneOf(fm.risk, RISKS))
    offenses.push({
      rule: 'contract-risk-invalid',
      detail: `risk: "${fm.risk}" is not one of ${RISKS.join(' | ')}`,
    });
  if (fm.type != null && !oneOf(fm.type, TYPES))
    offenses.push({
      rule: 'contract-type-invalid',
      detail: `type: "${fm.type}" is not one of ${TYPES.join(' | ')}`,
    });
  for (const key of ['sprints_total', 'stories_total']) {
    if (fm[key] != null && !isInt(fm[key]))
      offenses.push({ rule: 'contract-total-invalid', detail: `${key}: "${fm[key]}" is not a whole number` });
  }
  offenses.push(...validateFinopsFields(fm));
  offenses.push(...validateResultFields(fm));
  offenses.push(...validateFlagKey(fm));
  offenses.push(...validateGrounded(fm));
  offenses.push(...validateBet(fm));
  offenses.push(...validateLockedAt(fm));
  if (isInt(fm.sprints_total) && isInt(ctx.sprintCount) && fm.sprints_total !== ctx.sprintCount)
    offenses.push({
      rule: 'contract-total-mismatch',
      detail: `sprints_total: ${fm.sprints_total}, but the epic has ${ctx.sprintCount} sprint-N.md file(s)`,
    });
  if (isInt(fm.stories_total) && isInt(ctx.storyCount) && fm.stories_total !== ctx.storyCount)
    offenses.push({
      rule: 'contract-total-mismatch',
      detail: `stories_total: ${fm.stories_total}, but its sprints declare ${ctx.storyCount} stories`,
    });
  return offenses;
}

/** A sprint-N.md's frontmatter. `ctx.n` is the file's sprint number, `ctx.slug` its epic's slug. */
export function validateSprintFrontmatter(parsed, ctx = {}) {
  if (!parsed.hasFrontmatter)
    return [
      {
        rule: 'contract-sprint-frontmatter-missing',
        detail: 'no --- frontmatter block at the top of the sprint file',
      },
    ];
  if (parsed.error) return [{ rule: 'contract-parse', detail: parsed.error }];
  const offenses = [];
  const fm = parsed.data;
  for (const key of SPRINT_FIELDS) {
    if (!(key in fm) || (fm[key] === null && key !== 'stories'))
      offenses.push({ rule: 'contract-sprint-field-missing', detail: `no \`${key}:\`` });
  }
  if (ctx.slug && fm.epic != null && fm.epic !== ctx.slug)
    offenses.push({
      rule: 'contract-sprint-epic-mismatch',
      detail: `epic: "${fm.epic}", but the file is in "${ctx.slug}"`,
    });
  if (isInt(ctx.n) && fm.sprint != null && fm.sprint !== ctx.n)
    offenses.push({
      rule: 'contract-sprint-number-mismatch',
      detail: `sprint: ${fm.sprint}, but the file is sprint-${ctx.n}.md`,
    });
  if (fm.phase != null && !oneOf(fm.phase, PHASES))
    offenses.push({
      rule: 'contract-phase-invalid',
      detail: `phase: "${fm.phase}" is not one of ${PHASES.join(' | ')}`,
    });
  if (fm.risk != null && !oneOf(fm.risk, RISKS))
    offenses.push({
      rule: 'contract-risk-invalid',
      detail: `risk: "${fm.risk}" is not one of ${RISKS.join(' | ')}`,
    });

  // A sprint with no stories says so with `stories: []`. A bare `stories:` (null) or a scalar is not a
  // list, and would let `stories_total: 0` pass with nothing machine-readable behind it (found by the
  // codex pass on golden-beans#156).
  if ('stories' in fm && !Array.isArray(fm.stories)) {
    offenses.push({
      rule: 'contract-stories-invalid',
      detail: '`stories:` must be a list of story maps (write `stories: []` for none)',
    });
    return offenses;
  }
  const stories = fm.stories || [];
  if (fm.stories_total != null && (!isInt(fm.stories_total) || fm.stories_total !== stories.length))
    offenses.push({
      rule: 'contract-total-mismatch',
      detail: `stories_total: ${fm.stories_total}, but \`stories:\` lists ${stories.length}`,
    });
  const seen = new Set();
  stories.forEach((s, i) => {
    const label = s.id ? `story ${s.id}` : `story #${i + 1}`;
    for (const key of STORY_FIELDS) {
      if (!(key in s))
        offenses.push({ rule: 'contract-story-field-missing', detail: `${label}: no \`${key}:\`` });
    }
    const m = typeof s.id === 'string' ? s.id.match(STORY_ID_RE) : null;
    if (!m)
      offenses.push({
        rule: 'contract-story-id-invalid',
        detail: `${label}: id must look like S<sprint>.<n>`,
      });
    else if (isInt(ctx.n) && Number(m[1]) !== ctx.n)
      offenses.push({
        rule: 'contract-story-id-invalid',
        detail: `${label}: id names sprint ${m[1]}, but the file is sprint-${ctx.n}.md`,
      });
    if (s.id && seen.has(s.id))
      offenses.push({ rule: 'contract-story-id-duplicate', detail: `${label} appears twice` });
    seen.add(s.id);
    if ('risk' in s && !oneOf(s.risk, RISKS))
      offenses.push({
        rule: 'contract-risk-invalid',
        detail: `${label}: risk "${s.risk}" is not one of ${RISKS.join(' | ')}`,
      });
    if ('status' in s && !oneOf(s.status, STORY_STATUSES))
      offenses.push({
        rule: 'contract-story-status-invalid',
        detail: `${label}: status "${s.status}" is not one of ${STORY_STATUSES.join(' | ')}`,
      });
  });
  return offenses;
}
