#!/usr/bin/env node
// session-line.mjs — the budget line at a refinement approval gate, for surfaces with no mod (session-budget D6).
//
//   node "$REFINE/session-line.mjs" --asks-open 2 --questions-waiting 1 --gates-passed 1
//   → 2 asks open · 1 question waiting · 1 gate passed · context: not measured here → keep going
//
// Cowork has no build view and no `$.session`, so it cannot see its own context fill. Refine counts what it
// CAN see and this prints the line with the same `sessionVerdict()` the Claude Code mod uses — one threshold
// table, two surfaces. It advises; it never ends or compacts anything (D5).
//
// Each run appends one row to `.golden-frijoles/session-budget.jsonl` (D7), gitignored by the folder's own
// `.gitignore`. A failed write warns on stderr and still prints the line: a log must never cost the gate.
//
// Zero deps — Node 18+.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_DIR, LOG_FILE, LOG_GITIGNORE, budgetRow, coworkLine, sessionVerdict } from './session-budget.mjs';

const FLAGS = { '--asks-open': 'asksOpen', '--questions-waiting': 'questionsWaiting', '--gates-passed': 'gatesPassed' };
const USAGE =
  'Usage: node session-line.mjs [--asks-open <n>] [--questions-waiting <n>] [--gates-passed <n>] [--root <dir>] [--no-log]';

export function parseArgs(argv) {
  const out = { counts: {}, root: process.cwd(), log: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-log') out.log = false;
    else if (a === '--root') {
      out.root = argv[++i];
      if (!out.root || out.root.startsWith('--')) throw new Error('--root takes a directory');
    }
    else if (a in FLAGS) {
      const raw = argv[++i];
      if (!/^\d+$/.test(String(raw))) throw new Error(`${a} takes a whole number, got ${JSON.stringify(raw)}`);
      out.counts[FLAGS[a]] = Number(raw);
    } else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return out;
}

export function appendRow(root, row) {
  mkdirSync(join(root, LOG_DIR), { recursive: true });
  const ignore = join(root, LOG_GITIGNORE.path);
  if (!existsSync(ignore)) writeFileSync(ignore, LOG_GITIGNORE.text);
  appendFileSync(join(root, LOG_FILE), `${row}\n`);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`session-line: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const verdict = sessionVerdict({ questionsWaiting: args.counts.questionsWaiting });
  console.log(coworkLine(args.counts, verdict));
  if (!args.log) return;
  try {
    appendRow(args.root, budgetRow({ at: Date.now(), surface: 'cowork', figures: args.counts, verdict }));
  } catch (err) {
    console.error(`⚠ session-line: could not append to ${LOG_FILE} (${err.message}) — the line above still stands.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
