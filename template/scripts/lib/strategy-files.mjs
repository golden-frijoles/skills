// strategy-files.mjs — where the strategy coaches' files live, and the few shapes every strategy script reads
// (coaches-v2 D1, D4, D7).
//
// refine's own reader (`skills/refine/strategy.mjs`) ships inside the plugin and cannot import from the kit, so it keeps
// its own STRATEGY_DIR and KINDS; `skills/scripts/strategy-templates.test.mjs` fails while the two disagree, so a
// rename lands in both or in neither.
//
// Zero deps — Node 18+.
import { join } from 'node:path';

export const STRATEGY_DIR = join('Roadmap', '00-strategy');
/** The three coached files, in the order the coaches run. */
export const KINDS = ['pmf-narrative', 'north-star', 'risk-validation'];
export const COLD_READ_DIR = join(STRATEGY_DIR, 'cold-read');
export const ONE_PAGERS_DIR = join(STRATEGY_DIR, 'one-pagers');

/**
 * The line a coach puts first under a heading the maker handed over (D7). Until the maker picks, the section is the
 * coach's work, not the maker's: the compare lists it as facilitator-authored and the Strategy gate asks about it.
 */
export const PROPOSED_LINE = '_Proposed by the coach, not decided yet._';

/** Flat `key: value` frontmatter. `{}` when there is none. A value keeps any trailing `# comment` stripped. */
export function parseFrontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0)
      out[line.slice(0, at).trim()] = line
        .slice(at + 1)
        .replace(/\s+#.*$/, '')
        .trim();
  }
  return out;
}

/** The body of `## <heading>`, up to the next `## `. Null when the heading is absent. */
export function section(text, heading) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

/** Every `## ` heading in order. */
export const headings = (text) => [...String(text).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

/** The headings whose section opens with PROPOSED_LINE: the parts the coach wrote and the maker has not decided. */
export function proposedSections(text) {
  return headings(text).filter((h) => (section(text, h) ?? '').split('\n')[0].trim() === PROPOSED_LINE);
}
