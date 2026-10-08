#!/usr/bin/env node
// intent-reader.mjs — an OPTIONAL second-family read of a pitch at the architecture lock (intent-match D4, D16).
//
//   node scripts/intent-reader.mjs --epic <slug> [--timeout <seconds>]
//
// The epic kickoff's lock step names this command on every run. With `intent.reader` off — the default — it prints
// one line and exits before touching any CLI, so it costs nothing. Turned on (`frijoles-kit config set intent.reader on`),
// it hands the epic's seed (the pitch file, nothing else) to the first of codex, agy and vibe that is installed,
// once, with a hard timeout, and asks Jev one Noul: would that reader build the same thing as the lock's plan? The
// answer is the fifth signal, "agreement", and it is written into the epic README's `## Intent match` section.
//
// ── IT NEVER GETS IN THE WAY ─────────────────────────────────────────────────────────────────────────────────
// Any failure — no reader CLI, a capped or logged-out CLI, a timeout, an empty or unstructured reply, Jev unable to
// look — prints exactly ONE line, `reader skipped: <why>`, and exits 0. There is no retry and no second family after
// one has been asked: free-tier CLIs can be finicky, and three reads of every pitch cost more time than they return
// (the product owner's call at grooming). Exit 1 is kept for a usage error only.
//
// ── NEVER CLAUDE ─────────────────────────────────────────────────────────────────────────────────────────────
// Planning and building run on Claude; a Claude reader adds no independent read. `FAMILIES` holds no Claude entry
// and a spec pins that.
//
// Every CLI is spawned directly with `timeout`, from the argv builders `lib/cross-agent-cli.mjs` exports — never
// through `runCodex`/`runAntigravity`/`runVibe`, which have no deadline, retry agy on a second model and print their
// own warning line (C4). Zero deps — Node 18+.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGY_ARG_LIMIT,
  agyArgs,
  codexExecArgs,
  hasCmd,
  VIBE_ARG_LIMIT,
  vibeArgs,
} from './lib/cross-agent-cli.mjs';
import { getKey } from './lib/config.mjs';
import { collectSecretValues, findSecretLeaks } from './lib/secret-guard.mjs';
import { askJev, loadJevConfig, readApiKey, repoRoot, stateSize, STATE_CHAR_BUDGET } from './lib/jev.mjs';
import {
  componentsFrom,
  INTENT_QUESTIONS,
  INTENT_TIMEOUT_MS,
  SIGNAL_NAMES,
  setFrontmatterKey,
  totalOf,
  upsertIntentSection,
} from './intent-match.mjs';

export const DEFAULT_TIMEOUT_S = 120;

/** The reader families, in preference order (review-route's order). NEVER Claude (D4). */
export const FAMILIES = Object.freeze([
  {
    id: 'codex',
    bin: 'codex',
    argv: (prompt) => ({ args: codexExecArgs(prompt.head), input: prompt.body, limit: null }),
  },
  {
    id: 'agy',
    bin: 'agy',
    argv: (prompt) => ({ args: agyArgs(prompt.full), input: '', limit: AGY_ARG_LIMIT }),
  },
  {
    id: 'vibe',
    bin: 'vibe',
    argv: (prompt) => ({ args: vibeArgs(prompt.full), input: '', limit: VIBE_ARG_LIMIT }),
  },
]);

/** The fixed prompt (D16): the reader gets the pitch file and these three headings, nothing else. */
export const READER_PROMPT = `You are reading a product pitch you did not write, before anyone builds it. Do not open, run or change any file: the pitch is given to you below. Answer in exactly three sections, with exactly these headings:

## Will build
- each thing you would build from this pitch, one bullet each

## Won't build
- each thing this pitch leaves out on purpose, or that you would not build from it

## First question
- the one question you would ask the person who wrote it before you started

Keep it short. No preamble, no other sections.`;

const HEADINGS = [
  /^#+\s*will build\b/im,
  /^#+\s*won['’]?t build\b|^#+\s*will not build\b/im,
  /^#+\s*first question\b/im,
];

/** Does a reply carry the three headings the prompt asked for? Pure. */
export const isStructured = (text) => HEADINGS.every((re) => re.test(String(text ?? '')));

/** The one line every skip prints. Pure. */
export const skipLine = (why) => `reader skipped: ${why}`;

const lastLine = (t) =>
  String(t ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop() ?? '';

/**
 * Ask ONE family, once. Returns { ok: true, text } or { ok: false, why }. Never throws. The spawn result is read the
 * way spawnSync reports a deadline: `error.code === 'ETIMEDOUT'` (with `timeout` set, the child is killed).
 */
export function askReader(family, pitch, { spawn = spawnSync, timeoutMs }) {
  const prompt = { head: READER_PROMPT, body: pitch, full: `${READER_PROMPT}\n\n---\n\n${pitch}\n` };
  const { args, input, limit } = family.argv(prompt);
  if (limit && Buffer.byteLength(prompt.full, 'utf8') > limit)
    return { ok: false, why: `${family.id}: the pitch is over its ${limit / 1024} KB argument limit` };
  let r;
  try {
    r = spawn(family.bin, args, {
      input,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, why: `${family.id}: could not start (${e?.message || e})` };
  }
  if (r?.error?.code === 'ETIMEDOUT')
    return { ok: false, why: `${family.id}: timed out after ${timeoutMs / 1000}s` };
  if (r?.error?.code === 'ENOBUFS') return { ok: false, why: `${family.id}: the reply was over 16 MB` };
  if (r?.error) return { ok: false, why: `${family.id}: could not start (${r.error.message})` };
  if (r?.status !== 0)
    return {
      ok: false,
      why: `${family.id}: exited ${r?.status ?? r?.signal ?? '?'}${lastLine(r?.stderr) ? ` — ${lastLine(r.stderr).slice(0, 160)}` : ''}`,
    };
  const text = String(r.stdout ?? '').trim();
  if (!text) return { ok: false, why: `${family.id}: empty reply` };
  if (!isStructured(text))
    return {
      ok: false,
      why: `${family.id}: unstructured reply (no Will build / Won't build / First question)`,
    };
  return { ok: true, text };
}

/** The first family whose binary is installed, or null. Missing is the ONLY reason to move to the next one. */
export function pickFamily(has = hasCmd) {
  return FAMILIES.find((f) => has(f.bin)) ?? null;
}

const f2 = (n) => n.toFixed(2);

/** The README's `## Intent match` section, with agreement. Pure. */
export function readerSection({ family, agreement, seedComponents, seedTotal, date, reply }) {
  const withAgreement = totalOf({ ...(seedComponents ?? {}), agreement });
  const seedLine = seedComponents
    ? `- Seed score: **${seedTotal ?? '—'}** (${Object.entries(seedComponents)
        .map(([k, v]) => `${SIGNAL_NAMES[k]} ${f2(v)}`)
        .join(' · ')})`
    : '- Seed score: none recorded (run `node scripts/intent-match.mjs <seed> --write` at refine Stage 3.5)';
  const lines = [
    '## Intent match',
    '',
    '_Advisory and uncalibrated (intent-match D1, D3). Agreement written by `intent-reader.mjs` at the architecture lock._',
    '',
    seedLine,
    `- Agreement (reader: ${family}, ${date}): **${f2(agreement)}** — P(the reader, given only the pitch, would build what this plan builds)`,
  ];
  if (seedComponents) lines.push(`- Total with agreement: **${withAgreement.total} / 100** — uncalibrated`);
  const clipped = reply.length > 4000 ? `${reply.slice(0, 4000)}\n…[truncated]` : reply;
  // Indented, never fenced: a reply is model output, and a fence it carries (``` or ~~~) would close ours and leave its
  // own `## ` headings outside the section, where the next run cannot find them (fresh review of #197).
  lines.push(
    '',
    "<details><summary>The reader's reply</summary>",
    '',
    ...clipped.split('\n').map((l) => `    ${l}`),
    '',
    '</details>',
    ''
  );
  lines.push(
    `<!-- intent-match: ${JSON.stringify({ ...(seedComponents ?? {}), agreement: Math.round(agreement * 1000) / 1000, total: seedComponents ? withAgreement.total : null })} -->`,
    ''
  );
  return { text: lines.join('\n'), total: seedComponents ? withAgreement.total : null };
}

/** Roadmap/<macro>/<slug>/README.md and the seed, or { error }. */
export function locateEpic(
  root,
  slug,
  { exists = existsSync, list = (d) => readdirSync(d, { withFileTypes: true }) } = {}
) {
  const roadmap = join(root, 'Roadmap');
  if (!exists(roadmap)) return { error: `no Roadmap/ under ${root}` };
  const hits = list(roadmap)
    .filter((d) => d.isDirectory() && exists(join(roadmap, d.name, slug, 'README.md')))
    .map((d) => join(roadmap, d.name, slug, 'README.md'));
  if (hits.length !== 1)
    return {
      error: hits.length ? `"${slug}" is under more than one macro` : `no epic "${slug}" under Roadmap/*/`,
    };
  const seed = join(roadmap, '00-ideas', 'seeds', `${slug}.md`);
  return { readme: hits[0], seed: exists(seed) ? seed : null };
}

export function parseArgs(argv) {
  const out = { epic: null, timeout: DEFAULT_TIMEOUT_S, help: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--epic') out.epic = argv[++i] ?? null;
    else if (a === '--timeout') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) out.bad = '--timeout needs a positive number of seconds';
      else out.timeout = n;
    } else out.bad = `unknown argument ${a}`;
  }
  if (!out.help && !out.bad && !out.epic) out.bad = '--epic <slug> is required';
  return out;
}

/**
 * The run. Every side effect injected; returns the exit code (0, or 1 for usage). io = { root, setting, config, key,
 * has, spawn, ask, read, write, out, today }.
 */
export async function run(argv, io) {
  const args = parseArgs(argv);
  if (args.help || args.bad) {
    if (args.bad) io.out(`intent-reader: ${args.bad}`);
    io.out('usage: node scripts/intent-reader.mjs --epic <slug> [--timeout <seconds>]');
    return args.help ? 0 : 1;
  }
  // OFF first, before anything is read or spawned: the default costs nothing and waits for nothing (D4).
  const setting = io.setting();
  if (setting !== 'on') {
    io.out(
      `intent reader: off (intent.reader: ${JSON.stringify(setting)}) — no reader asked. Turn it on with \`frijoles-kit config set intent.reader on\`.`
    );
    return 0;
  }
  const skip = (why) => {
    io.out(skipLine(why));
    return 0;
  };
  const where = locateEpic(io.root, args.epic);
  if (where.error) return skip(where.error);
  if (!where.seed)
    return skip(
      `no seed at Roadmap/00-ideas/seeds/${args.epic}.md — the reader reads the pitch, and there is none`
    );
  // Agreement is a Jev answer. Check Jev can be asked BEFORE spending up to two minutes on a reader.
  const config = io.config();
  if (config.egress !== true)
    return skip(`Jev cannot score agreement (jev.egress is ${JSON.stringify(config.egress)}, not true)`);
  const key = io.key();
  if (!key) return skip('Jev cannot score agreement (no TYPESAFE_API_KEY)');
  const family = pickFamily(io.has);
  if (!family) return skip('no reader CLI on PATH (codex, agy or vibe)');
  const pitch = io.read(where.seed);
  const plan = io.read(where.readme);
  const reply = askReader(family, pitch, { spawn: io.spawn, timeoutMs: args.timeout * 1000 });
  if (!reply.ok) return skip(reply.why);
  // The reply is about to leave this process twice: to Jev, then into a README that may be public. A reader can READ
  // host files (codex's sandbox allows reads; agy has no tool restriction), so a secret-shaped reply is skipped before
  // either, as cross-review does (lib/secret-guard.mjs). Names only: a value is never printed.
  const leaks = io.secrets(reply.text).leaks;
  if (leaks.length)
    return skip(
      `${family.id}: the reply carried secret-shaped text (${leaks.map((l) => l.name).join(', ')}); nothing sent, nothing written`
    );
  const state = { plan, reading: reply.text };
  if (stateSize(state) > STATE_CHAR_BUDGET)
    return skip(`the plan and the reading are over Jev's state budget (${stateSize(state)} chars)`);
  const res = await io.ask(
    { state, questions: { agreement: INTENT_QUESTIONS.agreement } },
    { key, model: config.model }
  );
  const a = res?.ok ? res.answers?.agreement : undefined;
  if (a?.type !== 'noul' || typeof a.noul !== 'number' || !(a.noul >= 0 && a.noul <= 1))
    return skip(
      `Jev could not look (${res?.ok ? 'malformed agreement answer' : (res?.error ?? 'no answer')})`
    );
  const seedText = pitch;
  const seedComponents = componentsFrom(seedText);
  const seedTotal = seedComponents ? totalOf(seedComponents)?.total : null;
  const section = readerSection({
    family: family.id,
    agreement: a.noul,
    seedComponents,
    seedTotal,
    date: io.today,
    reply: reply.text,
  });
  let next = upsertIntentSection(plan, section.text);
  if (section.total != null) next = setFrontmatterKey(next, 'intent_match', section.total);
  io.write(where.readme, next);
  io.out(
    `intent reader: ${family.id} read the pitch — agreement ${f2(a.noul)}${section.total != null ? `; total ${section.total} (seed ${seedTotal})` : ''}, written to ${relative(io.root, where.readme)}`
  );
  return 0;
}

async function main() {
  const root = repoRoot();
  const code = await run(process.argv.slice(2), {
    root,
    setting: () => getKey('intent.reader', { root }),
    config: () => loadJevConfig({ root }),
    key: () => readApiKey({ root }),
    has: hasCmd,
    secrets: (text) => findSecretLeaks(text, { values: collectSecretValues({ root }) }),
    spawn: spawnSync,
    ask: (req, { key, model }) => askJev(req, { key, model, timeoutMs: INTENT_TIMEOUT_MS }),
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, t) => writeFileSync(p, t),
    out: (l) => process.stdout.write(`${l}\n`),
    today: new Date().toISOString().slice(0, 10),
  });
  process.exitCode = code;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  main().catch((e) => {
    // Even an unexpected crash is one skip line and exit 0: the reader never stops a lock (D4). A malformed config
    // is the one thing a person must see, and it is still only one line.
    process.stdout.write(`${skipLine(`internal error (${e?.message || e})`)}\n`);
    process.exitCode = 0;
  });
