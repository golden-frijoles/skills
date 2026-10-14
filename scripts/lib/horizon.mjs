// horizon.mjs — a product's destinations, declared in its own repo (many-products D14).
//
// `Roadmap/horizon.md` lists the end states a product walks toward, one `## <id> — <title>` heading each
// with a one-line description under it, in display order. An epic README names the ones it lights with
// `destination: <id>` or `destination: <id>, <id>` (the flat frontmatter parser reads a string, so a list is a
// comma-separated string). The extractor stamps `destinations` on each epic row; the push carries the declared list as
// the envelope's optional `horizon`. Pure and dependency-free: both the extractor and the push import it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const HORIZON_FILE = 'Roadmap/horizon.md';
/** The envelope's ceiling. Mirrored by `apps/web/lib/roadmap-artifact-schema.ts` (HORIZON_MAX). */
export const HORIZON_MAX = 50;
/** lowercase-kebab. Mirrored by the schema's regex. */
export const HORIZON_ID_RE = /^[a-z][a-z0-9-]*$/;

const HEADING_RE = /^##\s+(\S+)\s+(?:—|–|-)\s+(.+?)\s*$/;

/**
 * `horizon.md` text → `[{ id, title, description }]`, in file order. Throws, naming the line, on a `##` heading that is
 * not `## <id> — <title>`, a bad or repeated id, a destination with no description, or more than HORIZON_MAX.
 * Text outside a `##` section (the H1, a preamble) is ignored; only the FIRST non-blank line under a heading is the
 * description.
 */
export function parseHorizonMd(md) {
  const out = [];
  let current = null;
  const lines = String(md).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('## ') || line === '##') {
      const m = HEADING_RE.exec(line);
      if (!m)
        throw new Error(
          `${HORIZON_FILE}:${i + 1}: a destination heading is "## <id> — <title>" (got "${line}")`
        );
      const [, id, title] = m;
      if (!HORIZON_ID_RE.test(id))
        throw new Error(
          `${HORIZON_FILE}:${i + 1}: destination id "${id}" must be lowercase-kebab (a-z, 0-9, -)`
        );
      if (out.some((d) => d.id === id))
        throw new Error(`${HORIZON_FILE}:${i + 1}: destination "${id}" is declared twice`);
      current = { id, title, description: '' };
      out.push(current);
      return;
    }
    if (line.startsWith('#')) {
      current = null; // another heading level closes the section
      return;
    }
    if (current && !current.description && line) current.description = line;
  });
  const bare = out.find((d) => !d.description);
  if (bare)
    throw new Error(
      `${HORIZON_FILE}: destination "${bare.id}" has no one-line description under its heading`
    );
  if (out.length > HORIZON_MAX)
    throw new Error(`${HORIZON_FILE}: ${out.length} destinations — the push carries at most ${HORIZON_MAX}`);
  return out;
}

/** An epic's `destination:` value → ids. One id or a comma-separated list; blanks and repeats dropped. */
export function destinationIds(value) {
  if (typeof value !== 'string') return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

/** The project's declared destinations, or `null` when it has no horizon.md (no horizon, not an error). */
export function readHorizon(root) {
  const file = join(root, HORIZON_FILE);
  if (!existsSync(file)) return null;
  const list = parseHorizonMd(readFileSync(file, 'utf8'));
  return list.length ? list : null;
}

/**
 * The ids an epic names that the horizon does not declare. Empty means fine. A malformed id is reported as unknown too.
 * `horizon` may be null (no file): then every named id is unknown.
 */
export function unknownDestinations(ids, horizon) {
  const known = new Set((horizon ?? []).map((d) => d.id));
  return ids.filter((id) => !known.has(id));
}
