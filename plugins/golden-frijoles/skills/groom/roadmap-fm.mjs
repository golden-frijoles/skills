// roadmap-fm.mjs — read and edit one field of a Roadmap doc's frontmatter, in place (zero deps).
// Shared by the groom helpers that write funding and lifecycle (fund.mjs, scaffold-epic.mjs). Line-level on purpose:
// a value is replaced where it sits and its trailing `# comment` is kept, so an edit never reflows a hand-written block.
// Every replacement is a FUNCTION: a string replacement expands `$&`, `$'` and `` $` `` inside a title or a quote.

const FM = /^---\n([\s\S]*?)\n---(?:\n|$)/;

const keyLine = (key) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');

/** A field's value with quotes and any trailing comment stripped; `null` for absent, empty or `null`. */
export function readField(text, key) {
  const fm = FM.exec(text)?.[1];
  if (fm == null) return null;
  const raw = keyLine(key).exec(fm)?.[1];
  if (raw == null) return null;
  let v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(/^"(?:[^"\\]|\\.)*"/.exec(v)[0]);
    } catch {
      return v;
    }
  }
  v = v.replace(/\s+#.*$/, '').trim();
  if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
  return v === '' || v === 'null' || v === '~' ? null : v;
}

/** `text` with `key` set to the YAML scalar `value` (written as given). An absent key is added at the block's end. */
export function setField(text, key, value) {
  const m = FM.exec(text);
  if (!m) throw new Error(`no frontmatter block to set "${key}" in`);
  const fm = m[1];
  const line = keyLine(key).exec(fm);
  let next;
  if (line) {
    const comment = /(\s+#.*)$/.exec(line[1].startsWith('"') ? line[1].replace(/^"(?:[^"\\]|\\.)*"/, '') : line[1]);
    // Keep the comment's column when the new value fits in the old value's room.
    let tail = '';
    if (comment) {
      const oldValue = line[1].slice(0, line[1].length - comment[1].length);
      const pad = Math.max(1, oldValue.length + /^\s*/.exec(comment[1])[0].length - String(value).length);
      tail = ' '.repeat(pad) + comment[1].trimStart();
    }
    next = fm.replace(keyLine(key), () => `${key}: ${value}${tail}`);
  } else {
    next = `${fm}\n${key}: ${value}`;
  }
  return text.replace(FM, () => `---\n${next}\n---\n`);
}

/** `text` with the `key` line removed from the frontmatter (no-op when absent). */
export function dropField(text, key) {
  const m = FM.exec(text);
  if (!m) return text;
  const next = m[1].split('\n').filter((l) => !new RegExp(`^${key}:`).test(l)).join('\n');
  return text.replace(FM, () => `---\n${next}\n---\n`);
}

/** A double-quoted YAML scalar (a JSON string is valid YAML), so a colon or `#` can never change the parse. */
export const yamlString = (s) => JSON.stringify(String(s));
