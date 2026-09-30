// surface.mjs — the `surface` block: one screen state written as an ordered list of blocks (sketch-specs D8–D10).
//
//   ```surface
//   state: ship-features
//   route: /app/flags/[projectSlug]
//   - head "Features" action "+ New feature"
//   - summary count 4
//   - list columns "feature | state in production | type & risk | on / off"
//   ```
//
// One description serves three readers: the product owner (sketch-render.mjs draws it grey), the review (it is text
// in a seed) and a project's state contract (a project maps the generic kinds onto its own and compares the built
// page). So the grammar records only what survives a change of data: the kind of each block in order, the words
// that matter, and three facts — a primary action's words, a count, a list's column words. Never a value, a row
// count or a pixel.
//
// A line grammar rather than YAML because the kit has zero dependencies and no YAML parser; a hand-rolled YAML
// subset would accept things YAML readers reject and the other way round. Zero deps; no side effects at import.

/**
 * The generic vocabulary: twelve kinds, each with the facts it may carry (D10).
 *
 * A fact on a kind that cannot carry it is an error, not ignored: a `count` on an `answer` means the author
 * believes something is counted, and a sketch that silently drops it approves a picture of a different screen.
 */
export const SURFACE_KINDS = Object.freeze({
  head: ['action'],
  answer: [],
  summary: ['count'],
  tiles: ['count'],
  toolbar: [],
  list: ['columns'],
  empty: [],
  card: [],
  steps: ['count'],
  field: [],
  tabs: [],
  note: [],
});

export const SURFACE_FACTS = Object.freeze(['action', 'count', 'columns']);

const KIND_NAMES = Object.keys(SURFACE_KINDS);

// OWN properties only. `kind in SURFACE_KINDS` also answers true for `toString`, `constructor` and `__proto__`, which
// then parsed as kinds and crashed the renderer with a raw TypeError instead of a line-numbered error (#210 review).
const isKind = (name) => Object.hasOwn(SURFACE_KINDS, name);
const STATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADER = /^([A-Za-z][\w-]*):\s*(.*)$/;

/** A parse error that knows where it happened. `message` is `<file>:<line>: <reason>`, ready to print. */
export class SurfaceError extends Error {
  constructor(file, line, reason) {
    super(`${file}:${line}: ${reason}`);
    this.name = 'SurfaceError';
    this.file = file;
    this.line = line;
    this.reason = reason;
  }
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function unknownKind(kind) {
  const [nearest] = KIND_NAMES.map((name) => [name, distance(kind, name)]).sort((x, y) => x[1] - y[1]);
  const hint = nearest[1] <= 2 ? ` — did you mean \`${nearest[0]}\`?` : '';
  return `unknown kind \`${kind}\`${hint} Known kinds: ${KIND_NAMES.join(', ')}.`;
}

/**
 * Split the rest of a block line into quoted strings and bare words.
 * Throws a plain string (the reason) so the caller attaches the line number once.
 */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    if (text[i] === '"') {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= text.length) throw 'unterminated string — a quoted string closes on the same line';
        const char = text[i];
        if (char === '\\') {
          const next = text[i + 1];
          if (next !== '"' && next !== '\\')
            throw `unknown escape \`\\${next ?? ''}\` — only \\" and \\\\ are escapes`;
          value += next;
          i += 2;
        } else if (char === '"') {
          i += 1;
          break;
        } else {
          value += char;
          i += 1;
        }
      }
      tokens.push({ quoted: true, value });
      continue;
    }
    let word = '';
    while (i < text.length && !/\s/.test(text[i])) {
      if (text[i] === '"') throw `a quote inside \`${word}"\` — put a space before a quoted string`;
      word += text[i];
      i += 1;
    }
    tokens.push({ quoted: false, value: word });
  }
  return tokens;
}

/** Parse one block line (`<kind> ["words"] [fact value]…`, without its leading `- `). */
function parseBlockLine(rest) {
  // The shape the seed template shipped before this grammar existed (`- heading: "Orders"`). Named, because the
  // generic "unknown kind `heading:`" would send the author looking for a kind rather than at the format.
  if (/^[a-z][\w-]*:(\s|$)/.test(rest)) {
    throw (
      '`- <kind>: "…"` is the old list shape — write `- <kind> "words"` (for example `- head "Orders"`); ' +
      'see groom/references/intent-and-visuals.md'
    );
  }
  const tokens = tokenize(rest);
  const first = tokens.shift();
  if (first === undefined || first.quoted) throw 'a block line starts with its kind: `- <kind> …`';
  const kind = first.value;
  if (!isKind(kind)) throw unknownKind(kind);

  const block = { kind, words: null };
  if (tokens[0]?.quoted) block.words = tokens.shift().value;

  while (tokens.length > 0) {
    const name = tokens.shift();
    if (name.quoted)
      throw 'a second quoted string — a block has one words string; facts are `name value` pairs';
    if (name.value === 'when:' || name.value === 'when') {
      throw 'a surface is ONE state, so a block has no `when:` — write that state as its own surface block';
    }
    if (!SURFACE_FACTS.includes(name.value)) {
      throw `unknown fact \`${name.value}\` — the facts are ${SURFACE_FACTS.join(', ')}`;
    }
    if (!SURFACE_KINDS[kind].includes(name.value)) {
      const carries = SURFACE_KINDS[kind];
      throw (
        `\`${kind}\` carries no \`${name.value}\`` +
        (carries.length > 0 ? ` (it carries: ${carries.join(', ')})` : ' (it carries no facts)')
      );
    }
    if (Object.hasOwn(block, name.value)) throw `\`${name.value}\` given twice`;
    const value = tokens.shift();
    if (value === undefined) throw `\`${name.value}\` needs a value`;
    if (name.value === 'count') {
      // No leading zeros and no number past exact integers: `1e23` would be compared with a count read off a page.
      if (value.quoted || !/^(0|[1-9]\d*)$/.test(value.value) || !Number.isSafeInteger(Number(value.value))) {
        throw `\`count\` is a whole number, got \`${value.value}\``;
      }
      block.count = Number(value.value);
    } else {
      if (!value.quoted) throw `\`${name.value}\` takes a quoted string, got \`${value.value}\``;
      if (name.value === 'action') block.action = value.value;
      // A trailing bar is an unlabelled column — how a list's actions column reads today — so it is kept as "".
      else block.columns = value.value.split('|').map((column) => column.trim());
    }
  }
  return block;
}

/**
 * Parse one bare surface block — the whole of a `.surface` file, or the body of a fence.
 *
 * @param {string} text the block's lines
 * @param {string} file the name errors carry
 * @param {number} firstLine the FILE line number of the text's first line, so an error inside a fenced block in a
 *   long seed points at the seed's line rather than the block's
 * @returns {{ state: string, route: string, line: number, blocks: Array<{ kind: string, words: string|null,
 *   line: number, action?: string, count?: number, columns?: string[] }> }}
 */
export function parseSurface(text, file = '<surface>', firstLine = 1) {
  const surface = { state: null, route: null, line: firstLine, blocks: [] };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = firstLine + index;
    const content = raw.trim();
    if (content === '' || content.startsWith('#')) return;
    try {
      if (content.startsWith('- ') || content === '-') {
        surface.blocks.push({ ...parseBlockLine(content.slice(1).trim()), line });
        return;
      }
      const header = HEADER.exec(content);
      if (header === null)
        throw `expected \`state:\`, \`route:\` or a block line \`- <kind> …\`, got \`${content}\``;
      const [, key, value = ''] = header;
      if (key === 'blocks') {
        throw 'no `blocks:` list — each block is its own line, `- <kind> "words"`, straight after `state:` and `route:`';
      }
      if (key === 'when')
        throw 'a surface is ONE state, so it has no `when:` — write each state as its own block';
      if (key !== 'state' && key !== 'route')
        throw `unknown header \`${key}:\` — a surface has \`state:\` and \`route:\``;
      if (surface.blocks.length > 0) throw `\`${key}:\` comes before the first block line`;
      if (surface[key] !== null) throw `\`${key}:\` given twice`;
      const trimmed = value.trim();
      if (key === 'state' && !STATE_ID.test(trimmed)) {
        throw `state id \`${trimmed}\` must be lower-case words joined by hyphens (e.g. \`ship-features-empty\`)`;
      }
      if (key === 'route' && !trimmed.startsWith('/')) throw `route \`${trimmed}\` must start with /`;
      surface[key] = trimmed;
    } catch (reason) {
      if (typeof reason !== 'string') throw reason;
      throw new SurfaceError(file, line, reason);
    }
  });
  if (surface.state === null)
    throw new SurfaceError(file, firstLine, 'no `state:` line — every surface names its state id');
  if (surface.route === null)
    throw new SurfaceError(file, firstLine, 'no `route:` line — every surface names its route');
  if (surface.blocks.length === 0) {
    throw new SurfaceError(file, firstLine, 'no blocks — a surface lists at least one `- <kind> …` line');
  }
  return surface;
}

// CommonMark fences: up to three spaces of indent (four is an indented code block), three or more backticks or
// tildes. EVERY fence is tracked, not only `surface` ones, because a seed shows examples inside a longer fence
// (```` … ````) and a `surface` fence inside one is text, not a block.
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** Every fenced `surface` block in a markdown file, in order. */
export function parseSurfaces(markdown, file = '<markdown>') {
  const lines = markdown.split(/\r?\n/);
  const surfaces = [];
  let open = null;
  lines.forEach((raw, index) => {
    const fence = FENCE.exec(raw);
    if (open === null) {
      if (fence === null) return;
      const [, , marks, info] = fence;
      // A backtick fence's info string may not contain a backtick (CommonMark), so ```x``` is inline code.
      if (marks[0] === '`' && info.includes('`')) return;
      open = {
        char: marks[0],
        length: marks.length,
        surface: info.trim() === 'surface',
        line: index + 1,
        body: [],
      };
      return;
    }
    const closes =
      fence !== null && fence[2][0] === open.char && fence[2].length >= open.length && fence[3].trim() === '';
    if (!closes) {
      open.body.push(raw);
      return;
    }
    if (open.surface) surfaces.push(parseSurface(open.body.join('\n'), file, open.line + 1));
    open = null;
  });
  if (open?.surface) {
    throw new SurfaceError(file, open.line, 'this `surface` fence is never closed');
  }
  return surfaces;
}

/**
 * Check a project's `surface.map.json` (D11): `{ kinds: { <generic kind>: <project kind> } }`.
 * Returns the problems, empty when the map is usable. Whether each VALUE is one of the project's own kinds only the
 * project can say, so that half of the check lives with the project.
 */
export function validateMap(map) {
  if (
    map === null ||
    typeof map !== 'object' ||
    map.kinds === null ||
    typeof map.kinds !== 'object' ||
    Array.isArray(map.kinds)
  ) {
    return ['the map has no `kinds` object'];
  }
  const problems = [];
  for (const [generic, target] of Object.entries(map.kinds)) {
    if (!isKind(generic)) problems.push(unknownKind(generic));
    if (typeof target !== 'string' || target.trim() === '') {
      problems.push(`\`${generic}\` maps to ${JSON.stringify(target)}, not a kind name`);
    }
  }
  return problems;
}
