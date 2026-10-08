#!/usr/bin/env node
// cold-read.mjs — the deterministic half of the `cold-read` skill: the brief, the run, the seal and the compare
// (coaches-v2 D2–D4).
//
//   node scripts/cold-read.mjs brief                  print the agent's brief (the exclusion list is in it)
//   node scripts/cold-read.mjs run                    run the brief on Codex, write + seal the read; exit 3 = no
//                                                     other model family reachable (the skill then runs it itself)
//   node scripts/cold-read.mjs seal <file>            record the read's sha256 beside it, as <file>.sha256
//   node scripts/cold-read.mjs verify <file>          exit 1 when the read changed after it was sealed
//   node scripts/cold-read.mjs compare <file>         verify, then write the compare skeleton next to it
//
// ── Why a seal ────────────────────────────────────────────────────────────────────────────────────────────────────
// The cold read is worth something only if nobody edited it after the coaches started: a read quietly "corrected"
// towards the coached answers would turn every disagreement into agreement. So the read is sealed when written, the
// hash is printed to the maker, and the compare refuses to start while the file no longer matches it. A seal is
// never replaced: a read worth changing is a new read, with a new date.
//
// ── Why another model family ──────────────────────────────────────────────────────────────────────────────────────
// Two runs of one model agree for reasons that have nothing to do with the product. `run` asks Codex (another family)
// when it is installed and signed in; otherwise it says so and exits 3, and the skill writes the read with a
// same-family agent and records `family: claude (same family)`, so the compare can discount the agreement.
//
// Exit codes: 0 ok · 1 refused (hash changed, not sealed, already sealed differently, file exists) · 2 usage or
// could not read · 3 no other family reachable.
//
// Zero deps — Node 18+.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCmd, tryCodex } from './lib/cross-agent-cli.mjs';
import { kitRoot, projectRoot } from './lib/project-root.mjs';
import {
  COLD_READ_DIR,
  KINDS,
  STRATEGY_DIR,
  parseFrontmatter,
  proposedSections,
} from './lib/strategy-files.mjs';

export const PROMPT_FILE = 'cold-read.prompt.md';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** `shasum -a 256` format, so `shasum -a 256 -c <file>.sha256` checks it with no tool of ours. */
export const sealLine = (hash, file) => `${hash}  ${basename(file)}\n`;

/** The hash in a seal file, or null when it is not one. */
export function parseSealLine(text) {
  const match = String(text).match(/^([0-9a-f]{64}) {2}\S/);
  return match ? match[1] : null;
}

/** Pure — the verdict on a read against its seal. */
export function verifySeal({ text, seal }) {
  if (seal === null || seal === undefined)
    return { ok: false, reason: 'not sealed: no .sha256 file beside it' };
  const sealed = parseSealLine(seal);
  if (!sealed) return { ok: false, reason: 'the .sha256 file is not a seal (want "<64 hex>  <name>")' };
  const now = sha256(text);
  if (now !== sealed) return { ok: false, reason: `hash changed: sealed ${sealed}, now ${now}`, sealed, now };
  return { ok: true, sealed };
}

/** Today in local time, YYYY-MM-DD — the date a maker would write on the file. */
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The frontmatter `run` puts on a read the other family wrote, so the file says who wrote it. */
export function stampRead(body, { family, date }) {
  const text = String(body).trim();
  if (text.startsWith('---\n')) return `${text}\n`;
  return `---\nkind: cold-read\nfamily: ${family}\ndate: ${date}\n---\n\n${text}\n`;
}

/**
 * Pure — the compare skeleton (D4). Its sections are the reference compare's; the rows are the facilitator's to fill.
 * `coached` is `[{ path, text }]` for each strategy file that exists. A section a coach marked proposed is listed by
 * name as facilitator-authored, read from the file, so the compare never treats the coach's words as the maker's.
 */
export function renderCompare({ readPath, hash, family, date, coached }) {
  const independence = !family
    ? '- **Model family not recorded.** Treat agreement as weaker evidence than it looks.'
    : /same family|claude/i.test(family)
      ? '- **Same model family.** The cold read and the coach are the same family, so agreement is weaker evidence than it looks, and disagreement is stronger.'
      : `- **Different model family** (${family}). Agreement counts as independent evidence.`;
  const authored = coached.flatMap(({ path, text }) =>
    proposedSections(text).map(
      (h) => `- \`${path}\` → **${h}**: written by the coach, not decided by the maker.`
    )
  );
  const fm = [
    '---',
    'kind: cold-read-compare',
    'status: draft',
    `updated: ${date}`,
    `cold_read: ${readPath}`,
    `cold_read_sha256: ${hash}`,
    `family: ${family || 'not recorded'}`,
    `coached: [${coached.map((c) => c.path).join(', ')}]`,
    '---',
  ];
  return [
    ...fm,
    '',
    "# Cold read vs coached: what agreed, what didn't, what each missed",
    '',
    `**Seal check (${date}):** the cold read still matches the hash recorded when it was sealed (\`${hash.slice(0, 12)}…\`).`,
    'It was not edited after sealing.',
    '',
    '**How independent were they?**',
    independence,
    ...(authored.length
      ? [
          '- **Facilitator-authored sections** (treat these rows as coach vs cold read, not maker vs cold read):',
          ...authored.map((l) => `  ${l}`),
        ]
      : ['- **Facilitator-authored sections:** none; every coached section was decided by the maker.']),
    "- **The cold read's own contamination:** copy its *Contamination* paragraph here.",
    '',
    '---',
    '',
    '## 1. Where they converged',
    '',
    '| Topic | Cold read | Coached | Read |',
    '|---|---|---|---|',
    '',
    '## 2. Where they diverged',
    '',
    '| Topic | Cold read | Coached | Which is stronger, and why |',
    '|---|---|---|---|',
    '',
    '## 3. What only the cold read saw',
    '',
    '## 4. What only the coached run saw',
    '',
    '## 5. Decisions for the maker',
    '',
    '<Numbered, one decision each. An edit to an agreed strategy file is a decision, never a silent change.>',
    '',
    '## 6. Did the cold read earn its place?',
    '',
    '<What it changed, what it cost, and whether to run one next time.>',
    '',
  ].join('\n');
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function seal(file) {
  const text = readOrNull(file);
  if (text === null) return { code: 2, err: `cold-read: could not read ${file}` };
  const hash = sha256(text);
  const sealPath = `${file}.sha256`;
  const existing = readOrNull(sealPath);
  if (existing !== null) {
    const was = parseSealLine(existing);
    if (was === hash) return { code: 0, out: `cold-read: already sealed, unchanged. sha256 ${hash}` };
    return {
      code: 1,
      err: `cold-read: ${file} is already sealed as ${was ?? '(unreadable seal)'}; a seal is never replaced. A changed read is a new read: write it under a new name.`,
    };
  }
  writeFileSync(sealPath, sealLine(hash, file));
  return {
    code: 0,
    out: `cold-read: sealed ${file}\nsha256 ${hash}\nKeep this hash: the compare refuses the file if it changes.`,
  };
}

function verify(file) {
  const text = readOrNull(file);
  if (text === null) return { code: 2, err: `cold-read: could not read ${file}` };
  const v = verifySeal({ text, seal: readOrNull(`${file}.sha256`) });
  if (!v.ok) return { code: 1, err: `cold-read: refused — ${file}: ${v.reason}` };
  return { code: 0, out: `cold-read: seal holds. sha256 ${v.sealed}` };
}

function compare(file, root) {
  const text = readOrNull(file);
  if (text === null) return { code: 2, err: `cold-read: could not read ${file}` };
  const v = verifySeal({ text, seal: readOrNull(`${file}.sha256`) });
  if (!v.ok) return { code: 1, err: `cold-read: refused — ${file}: ${v.reason}` };
  const coached = KINDS.map((k) => join(STRATEGY_DIR, `${k}.md`))
    .map((rel) => ({ path: rel.split('\\').join('/'), text: readOrNull(join(root, rel)) }))
    .filter((c) => c.text !== null);
  const date = localDate();
  const out = join(dirname(file), `${date}-compare.md`);
  if (existsSync(out))
    return { code: 1, err: `cold-read: ${out} exists; edit it rather than starting again.` };
  writeFileSync(
    out,
    renderCompare({
      readPath: relative(root, file).split('\\').join('/'),
      hash: v.sealed,
      family: parseFrontmatter(text).family,
      date,
      coached,
    })
  );
  return {
    code: 0,
    out: `cold-read: seal holds (${v.sealed}).\nWrote ${out}: fill each section from the two runs.`,
  };
}

function run(root) {
  const brief = readFileSync(join(kitRoot(), PROMPT_FILE), 'utf8');
  if (!hasCmd('codex')) {
    return {
      code: 3,
      err: 'cold-read: no other model family reachable (codex is not installed). Run the brief with a same-family agent and record `family: claude (same family)`.',
    };
  }
  const r = tryCodex(brief, '');
  if (!r.ok || !r.text) {
    const why = r.capped
      ? 'codex is at its usage cap'
      : r.authFailed
        ? 'codex is signed out'
        : r.cliOutdated
          ? 'codex is out of date'
          : 'codex failed';
    return {
      code: 3,
      err: `cold-read: no other model family reachable (${why}). Run the brief with a same-family agent and record \`family: claude (same family)\`.`,
    };
  }
  const date = localDate();
  const dir = join(root, COLD_READ_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}-cold-read.md`);
  if (existsSync(file))
    return { code: 1, err: `cold-read: ${file} exists; a sealed read is never replaced.` };
  writeFileSync(file, stampRead(r.text, { family: 'codex', date }));
  const s = seal(file);
  return { code: s.code, out: `cold-read: Codex wrote ${file}.\n${s.out ?? ''}`, err: s.err };
}

function main(argv) {
  const [cmd, file] = argv;
  const root = projectRoot();
  let r;
  if (cmd === 'brief') r = { code: 0, out: readFileSync(join(kitRoot(), PROMPT_FILE), 'utf8').trimEnd() };
  else if (cmd === 'run') r = run(root);
  else if (['seal', 'verify', 'compare'].includes(cmd) && file) {
    const path = resolve(file); // a path the maker typed is relative to where they typed it
    r = cmd === 'seal' ? seal(path) : cmd === 'verify' ? verify(path) : compare(path, root);
  } else
    r = { code: 2, err: 'usage: cold-read.mjs brief | run | seal <file> | verify <file> | compare <file>' };
  if (r.out) process.stdout.write(`${r.out}\n`);
  if (r.err) process.stderr.write(`${r.err}\n`);
  return r.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main(process.argv.slice(2));
