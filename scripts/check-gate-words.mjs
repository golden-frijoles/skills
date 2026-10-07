#!/usr/bin/env node
// check-gate-words.mjs — the bookkeeping words stay off the screen (gates-in-plain-agile S2.2, D9).
//
// The gates a person reads (Strategy, Plan, Build) live once, as fenced ```gate <name>``` blocks in groom's
// `references/gates.md`. That file's screen-word table says which words never reach the screen (fund, scaffold,
// underwritten, displaced, cycle, kickoff, epic mode, agreed, draft …) and its Was | Now table names the retired
// options ("approve (fund + scaffold)", "approve, don't fund"). This check reads BOTH lists from that file, never from
// a copy of them in code, and fails when:
//   (a) a gate block contains a never-on-screen word. Inline code and `<placeholders>` are exempt: a gate may show
//       `Roadmap/00-ideas/seeds/x.md` or `status: agreed` as a path or a value, never as a word;
//   (b) any scanned file still names a retired option (outside gates.md's own Was | Now table);
//   (c) two files carry a gate block of the same name with different text — one gate, one wording;
//   (d) gates.md has lost a table or one of the three gates, so the check cannot pass by reading nothing.
//
// Scanned: every *.md under plugins/ and template/Roadmap/, and this repo's own Roadmap copies (WAYS-OF-WORKING,
// SESSION-KICKOFFS, the bets/ and 00-ideas/ READMEs). The kit skeleton is built from template/, so template/ covers
// it. `--also <path>…` adds files outside this tree (the monorepo's root Roadmap copies), resolved from the cwd.
//
// This is the plugin repo's own tooling; it does not ship to projects. Zero deps — Node 18+.
//
//   node scripts/check-gate-words.mjs [--also <path> …]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GATES_REF = 'plugins/golden-frijoles/skills/groom/references/gates.md';
export const REQUIRED_GATES = ['strategy', 'plan', 'build'];
const ROADMAP_COPIES = [
  'Roadmap/WAYS-OF-WORKING.md',
  'Roadmap/WAYS-OF-WORKING.template.md',
  'Roadmap/SESSION-KICKOFFS.md',
  'Roadmap/bets/README.md',
  'Roadmap/00-ideas/README.md',
];

/** The 1-based line numbers of the first table whose header row has a cell equal to `header` (header to last row). */
export function tableLines(text, header) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!cells.includes(header)) continue;
    const out = [];
    for (let j = i; j < lines.length && lines[j].trim().startsWith('|'); j++) out.push(j + 1);
    return out;
  }
  return [];
}

/** The cells of every body row of the first table whose header row has a cell equal to `header`. */
function tableColumn(text, header) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const col = cells(lines[i]).indexOf(header);
    if (col === -1) continue;
    const out = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) out.push(cells(lines[j])[col] ?? '');
    return out;
  }
  return null;
}

/** gates.md's two lists: the never-on-screen words and the retired options. Throws when either table is gone. */
export function parseGatesRef(text) {
  const never = tableColumn(text, 'Never on screen');
  const was = tableColumn(text, 'Was');
  if (!never) throw new Error(`${GATES_REF} has no table with a "Never on screen" column`);
  if (!was) throw new Error(`${GATES_REF} has no "Was | Now" table`);
  const words = never
    .flatMap((cell) => cell.split(','))
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w && w !== '—' && w !== '-');
  const retired = was.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) throw new Error(`${GATES_REF}'s "Never on screen" column is empty`);
  if (retired.length === 0) throw new Error(`${GATES_REF}'s "Was" column is empty`);
  return { words: [...new Set(words)], retired };
}

/** Every ```gate <name>``` block: `{ name, body, line }` (line is 1-based, the opening fence). */
export function gateBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^```gate\s+([a-z][a-z0-9-]*)\s*$/);
    if (!open) continue;
    const end = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l));
    if (end === -1) {
      out.push({ name: open[1], body: null, line: i + 1 });
      break;
    }
    out.push({ name: open[1], body: lines.slice(i + 1, end).join('\n'), line: i + 1 });
    i = end;
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPattern = (w) => new RegExp(`(?<![\\w-])${w.split(/\s+/).map(escape).join('\\s+')}(?![\\w-])`, 'i');

/** What a person reads of a gate line: inline code and `<placeholders>` removed. */
export const screenText = (line) => line.replace(/`[^`]*`/g, ' ').replace(/<[^<>]*>/g, ' ');

/**
 * Check `files` ({ path, text }[]) against gates.md's lists. Returns `{ findings: string[] }`, empty when clean.
 * `refPath` names which file is gates.md, whose own Was | Now table may name the retired options.
 */
export function checkGateWords({ files, refText, refPath = GATES_REF }) {
  const { words, retired } = parseGatesRef(refText);
  const findings = [];
  const refBlocks = gateBlocks(refText);
  for (const name of REQUIRED_GATES) {
    if (!refBlocks.some((b) => b.name === name && b.body !== null))
      findings.push(`${refPath}: the \`gate ${name}\` block is missing, so nothing would be checked for it`);
  }
  const patterns = words.map((w) => [w, wordPattern(w)]);
  const wasTable = new Set(tableLines(refText, 'Was')); // the one place a retired option may be named
  const seen = new Map(); // gate name → { path, body }
  for (const { path, text } of files) {
    for (const block of gateBlocks(text)) {
      if (block.body === null) {
        findings.push(`${path}:${block.line}: \`gate ${block.name}\` is never closed`);
        continue;
      }
      block.body.split('\n').forEach((line, k) => {
        const shown = screenText(line);
        for (const [w, re] of patterns) {
          if (re.test(shown))
            findings.push(`${path}:${block.line + 1 + k}: gate ${block.name} shows "${w}", a word that never reaches the screen`);
        }
      });
      const first = seen.get(block.name);
      if (!first) seen.set(block.name, { path, body: block.body });
      else if (first.body !== block.body)
        findings.push(`${path}:${block.line}: gate ${block.name} differs from the one in ${first.path}; one gate, one wording`);
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line, k) => {
      if (path === refPath && wasTable.has(k + 1)) return; // gates.md's Was | Now table names them on purpose
      const lower = line.toLowerCase();
      for (const phrase of retired) {
        if (lower.includes(phrase))
          findings.push(`${path}:${k + 1}: names the retired option "${phrase}" (gates.md: Was | Now)`);
      }
    });
  }
  return { findings };
}

function markdownUnder(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownUnder(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** The files this repo ships or keeps as copies of the gate wording. */
export function defaultFiles(root = ROOT) {
  const abs = [
    ...markdownUnder(join(root, 'plugins')),
    ...markdownUnder(join(root, 'template', 'Roadmap')),
    ...ROADMAP_COPIES.map((rel) => join(root, rel)).filter((p) => existsSync(p)),
  ];
  return [...new Set(abs)].sort();
}

export function run(argv, { root = ROOT, cwd = process.cwd(), log = console.log, error = console.error } = {}) {
  const also = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--also') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) also.push(resolve(cwd, argv[++i]));
    } else {
      error(`check-gate-words: unknown argument ${argv[i]}\nusage: node scripts/check-gate-words.mjs [--also <path> …]`);
      return 2;
    }
  }
  const missing = also.filter((p) => !existsSync(p));
  if (missing.length) {
    error(`check-gate-words: --also names a file that does not exist: ${missing.join(', ')}`);
    return 2;
  }
  let refText;
  try {
    refText = readFileSync(join(root, GATES_REF), 'utf8');
  } catch (err) {
    error(`check-gate-words: could not read ${GATES_REF}: ${err.message}`);
    return 2;
  }
  const paths = [...new Set([...defaultFiles(root), ...also])];
  const files = paths.map((p) => ({ path: relative(cwd, p) || p, text: readFileSync(p, 'utf8') }));
  let result;
  try {
    result = checkGateWords({ files, refText, refPath: relative(cwd, join(root, GATES_REF)) });
  } catch (err) {
    error(`check-gate-words: ${err.message}`);
    return 2;
  }
  if (result.findings.length) {
    error(`check-gate-words: ${result.findings.length} finding(s):`);
    for (const f of result.findings) error(`  ${f}`);
    error(`The words on screen are gates.md's "On screen" column; files, keys and values keep their names.`);
    return 1;
  }
  const blocks = files.reduce((n, f) => n + gateBlocks(f.text).length, 0);
  log(`check-gate-words: clean (${files.length} files, ${blocks} gate blocks).`);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(run(process.argv.slice(2)));
