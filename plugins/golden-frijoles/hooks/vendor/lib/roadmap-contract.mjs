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
// `~` or empty (→ null), `[]` (an empty list), an integer, a double-quoted JSON string, a single-quoted
// YAML string, or a bare string; any of them may carry a trailing ` # comment`. Booleans and floats are
// not in the subset (no contract field uses one). Anything else is a parse error, not guessed around.

export const PHASES = ['Shaping', 'Locking architecture', 'Building', 'Verifying', 'In review', 'Shipped'];
export const STORY_STATUSES = ['planned', 'in-progress', 'done'];
export const RISKS = ['low', 'high'];
export const TYPES = ['feature', 'spike', 'bug', 'chore'];

export const EPIC_FIELDS = ['title', 'area', 'risk', 'type', 'phase', 'sprints_total', 'stories_total'];
export const SPRINT_FIELDS = ['epic', 'sprint', 'title', 'risk', 'phase', 'stories_total', 'stories'];
export const STORY_FIELDS = ['id', 'title', 'as_a', 'i_want', 'so_that', 'risk', 'status'];

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
  if (BARE_SAFE.test(s) && !/^-?\d+$/.test(s) && !RESERVED.has(s.toLowerCase()) && !s.endsWith(' ')) return s;
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
