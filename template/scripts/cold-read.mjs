#!/usr/bin/env node
// cold-read.mjs — the deterministic half of the `cold-read` skill: the brief, the run, the seal and the compare
// (coaches-v2 D2–D4).
//
//   node scripts/cold-read.mjs brief [--out <file>]   print the agent's brief (the exclusion list is in it); --out
//                                                     tells a same-family agent to write the read there and reply
//                                                     only `written`, so the read never reaches the facilitator
//   node scripts/cold-read.mjs run                    run the brief on Codex, write + seal the read; exit 3 = no
//                                                     other model family reachable (the skill then runs it itself)
//   node scripts/cold-read.mjs seal <file>            record the read's sha256 beside it, as <file>.sha256; refuses
//                                                     a read missing its reading log, contamination or riskiest assumption
//   node scripts/cold-read.mjs verify <file>          exit 1 when the read changed after it was sealed
//   node scripts/cold-read.mjs compare <file> [--expect <hash>]
//                                                     verify (and match the hash the maker was shown), then write
//                                                     the compare skeleton next to it
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
  headings,
  parseFrontmatter,
  proposedSections,
  section,
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

/**
 * The frontmatter `run` puts on a read the other family wrote, so the file says who wrote it. `kind`, `family` and
 * `date` are ALWAYS ours: a read that arrives with its own frontmatter keeps its other keys, never its own family —
 * otherwise a Codex read that wrote `kind: cold-read` alone would be sealed with no family, and its compare would lose
 * the very independence it was run for (review of #314).
 */
export function stampRead(body, { family, date }) {
  let text = String(body).trim();
  const kept = [];
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    kept.push(...fm[1].split(/\r?\n/).filter((l) => l.trim() && !/^(kind|family|date)\s*:/.test(l)));
    text = text.slice(fm[0].length).trim();
  }
  return `---\nkind: cold-read\nfamily: ${family}\ndate: ${date}\n${kept.map((l) => `${l}\n`).join('')}---\n\n${text}\n`;
}

/**
 * The eleven sections `cold-read.prompt.md` asks for, matched by a word or two so a numbered or lightly reworded
 * heading ("## 2. Reading log", "## Who it's for") still counts. Keep in step with the prompt; the spec reads both.
 */
export const REQUIRED_SECTIONS = [
  ['Header', /header/i],
  ['Reading log', /reading log/i],
  ['What this product is', /what this product/i],
  ['Who it is for', /who it(?: i|')s for/i],
  ["The problem, in the customer's words", /problem/i],
  ['Market and competitors', /competitor|market/i],
  ['Positioning', /positioning/i],
  ['Growth and business model', /growth|business model/i],
  ['Riskiest assumption and the cheapest test', /riskiest assumption/i],
  ['Confidence and open questions', /confidence|open questions/i],
  ['Sources', /sources/i],
];

/**
 * Pure — the mandatory parts a read must have before it is sealed (D2, sprint-1 acceptance): a reading log that
 * discloses contamination, and the riskiest assumption with its cheapest test. Checked HERE because nobody else can:
 * the facilitator must not open the read before the compare. Headings may be numbered ("## 2. Reading log").
 */
export function missingSections(text) {
  const all = headings(text);
  // A heading with nothing under it is a missing section. Whether the words under it are any good is the compare's
  // judgement, not a script's: this only refuses the read that plainly isn't finished.
  const filled = (h) => (section(text, h) ?? '').trim() !== '';
  const missing = REQUIRED_SECTIONS.filter(([, re]) => !all.some((h) => re.test(h) && filled(h))).map(
    ([name]) => name
  );
  const log = all.find((h) => /reading log/i.test(h));
  // The disclosure has to be more than the word: a "Contamination" line followed by something.
  if (log && !/contamination\W*\s*\S+/i.test((section(text, log) ?? '').replace(/contamination\W*$/i, '')))
    missing.push('Contamination (inside the reading log)');
  return missing;
}

/** Where the brief tells the agent to put the read: back to the caller (Codex), or into a file (a subagent). */
export function deliveryTail(out) {
  if (!out) return '\n## Delivery\n\nReply with the document only. Change no file.\n';
  return `\n## Delivery\n\nWrite the document to \`${out}\`, opening with this frontmatter, then change no other file:\n\n\`\`\`\n---\nkind: cold-read\nfamily: claude (same family)\ndate: <today>\n---\n\`\`\`\n\nThen reply with the single word \`written\`. Do not repeat or summarise the read in your reply: the person you reply to must not see it yet.\n`;
}

/**
 * Pure — the compare skeleton (D4). Its sections are the reference compare's; the rows are the facilitator's to fill.
 * `coached` is `[{ path, text }]` for each strategy file that exists. A section a coach marked proposed is listed by
 * name as facilitator-authored, read from the file, so the compare never treats the coach's words as the maker's.
 */
export function renderCompare({ readPath, hash, family, date, coached, expected = false }) {
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
    ...(expected
      ? [
          `**Seal check (${date}):** verified. The cold read matches its seal (sha256 \`${hash}\`), and that seal is the`,
          'one the maker was shown when it was sealed.',
        ]
      : [
          `**Seal check (${date}): UNVERIFIED.** The cold read matches the seal beside it (sha256 \`${hash}\`), but no hash`,
          'from sealing time was checked, and a seal file can be replaced. Until the maker confirms this hash against the one',
          'they were shown, treat this compare as unverified.',
        ]),
    '',
    '**How independent were they?**',
    independence,
    ...(authored.length
      ? [
          '- **Facilitator-authored sections** (treat these rows as coach vs cold read, not maker vs cold read):',
          ...authored.map((l) => `  ${l}`),
        ]
      : [
          '- **Facilitator-authored sections:** none marked. Coaches mark a section they wrote for the maker from plugin 0.42.0; a file written before that may still hold one, so check by hand.',
        ]),
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
  const missing = missingSections(text);
  if (missing.length)
    return {
      code: 1,
      err: `cold-read: not sealed — ${file} is missing: ${missing.join('; ')}. Ask the agent that wrote it to finish it.`,
    };
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

function compare(file, root, expect) {
  const text = readOrNull(file);
  if (text === null) return { code: 2, err: `cold-read: could not read ${file}` };
  const v = verifySeal({ text, seal: readOrNull(`${file}.sha256`) });
  if (!v.ok) return { code: 1, err: `cold-read: refused — ${file}: ${v.reason}` };
  // The seal sits beside the read, so whoever can edit the read can replace the seal too. The hash the maker was
  // shown at sealing time is the check a swapped sidecar cannot pass (review of #314).
  // At least 12 hex characters: a shorter prefix could be matched by grinding a few edits of the read.
  if (expect !== null && (!/^[0-9a-f]{12,64}$/i.test(expect) || !v.sealed.startsWith(expect.toLowerCase())))
    return {
      code: 1,
      err: `cold-read: refused — the seal beside ${file} is ${v.sealed}, not the ${expect || '(empty)'} you were shown when it was sealed. The seal was replaced.`,
    };
  const coached = KINDS.map((k) => join(STRATEGY_DIR, `${k}.md`))
    .map((rel) => ({ path: rel.split('\\').join('/'), text: readOrNull(join(root, rel)) }))
    .filter((c) => c.text !== null);
  const date = localDate();
  // Named after its read, not the day: two reads sealed and compared on one day each get their own compare.
  const out = join(dirname(file), `${basename(file).replace(/\.md$/, '')}-compare.md`);
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
      expected: expect !== null,
    })
  );
  return {
    code: 0,
    out:
      expect !== null
        ? `cold-read: seal verified (${v.sealed}).\nWrote ${out}: fill each section from the two runs.`
        : `cold-read: UNVERIFIED — the read matches the seal beside it (${v.sealed}), but no hash from sealing time was given (--expect). Ask the maker to confirm this hash.\nWrote ${out}, marked unverified.`,
  };
}

function run(root) {
  const brief = readFileSync(join(kitRoot(), PROMPT_FILE), 'utf8') + deliveryTail(null);
  const date = localDate();
  const dir = join(root, COLD_READ_DIR);
  const file = join(dir, `${date}-cold-read.md`);
  // Before the Codex call, not after: a second run on the same day must not spend a whole read to then discard it.
  if (existsSync(file))
    return { code: 1, err: `cold-read: ${file} exists; a sealed read is never replaced.` };
  if (!hasCmd('codex')) {
    return {
      code: 3,
      err: 'cold-read: no other model family reachable (codex is not installed). Run the brief with a same-family agent and record `family: claude (same family)`.',
    };
  }
  // Codex reads the repository it is started in. Under `frijoles-kit --root <dir>` that is not this process's cwd, so move
  // there first: otherwise it reads one repo and the read is sealed into another's strategy folder (review of #314).
  process.chdir(root);
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
  const read = stampRead(r.text, { family: 'codex', date });
  // Checked BEFORE anything is written: an unfinished read on disk would block every retry today (the same-day guard
  // above), and nobody may open it to see why (review of #314, round 2). Only a sealable read ever lands.
  const missing = missingSections(read);
  if (missing.length)
    return {
      code: 1,
      err: `cold-read: Codex returned an unfinished read (missing: ${missing.join('; ')}); nothing was written. Run it again, or use a same-family agent (exit 3's route).`,
    };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, read);
  const s = seal(file);
  return { code: s.code, out: `cold-read: Codex wrote ${file}.\n${s.out ?? ''}`, err: s.err };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? '');
}

function main(argv) {
  const [cmd, file] = argv;
  const root = projectRoot();
  let r;
  if (cmd === 'brief')
    r = {
      code: 0,
      out: (readFileSync(join(kitRoot(), PROMPT_FILE), 'utf8') + deliveryTail(flag(argv, '--out'))).trimEnd(),
    };
  else if (cmd === 'run') r = run(root);
  else if (['seal', 'verify', 'compare'].includes(cmd) && file) {
    const path = resolve(file); // a path the maker typed is relative to where they typed it
    r =
      cmd === 'seal'
        ? seal(path)
        : cmd === 'verify'
          ? verify(path)
          : compare(path, root, flag(argv, '--expect'));
  } else
    r = {
      code: 2,
      err: 'usage: cold-read.mjs brief [--out <file>] | run | seal <file> | verify <file> | compare <file> [--expect <hash>]',
    };
  if (r.out) process.stdout.write(`${r.out}\n`);
  if (r.err) process.stderr.write(`${r.err}\n`);
  return r.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main(process.argv.slice(2));
