// frontmatter-stamp.mjs — set fields in a Roadmap doc's frontmatter, in place (zero deps beyond the contract).
//
// Written for `epic-actuals.mjs --write` (finops S1.4/S2.5) and moved here when `epic-read.mjs --write` needed the same
// stamp (result-record D8): two writers of one README must not each keep their own line editor.
import { formatScalar } from './roadmap-contract.mjs';

/**
 * Set `fields` in a doc's frontmatter: an existing `key:` line is replaced in place, a missing one is inserted just
 * before the closing fence. No other line is touched. Re-running with the same values is a no-op (idempotent).
 */
export function stampFrontmatter(md, fields) {
  const lines = md.split('\n');
  if (lines[0].trim() !== '---') throw new Error('no frontmatter');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) throw new Error('unterminated frontmatter');
  const missing = [];
  for (const [key, value] of Object.entries(fields)) {
    const line = `${key}: ${formatScalar(value)}`;
    const at = lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${key}:(\\s|$)`).test(l));
    if (at === -1) missing.push(line);
    else lines[at] = line;
  }
  lines.splice(end, 0, ...missing);
  return lines.join('\n');
}
