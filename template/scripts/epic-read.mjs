#!/usr/bin/env node
// epic-read.mjs — read an epic's result on its read date: draft the verdict with its evidence; write it on approval.
//
//   node scripts/epic-read.mjs --epic <slug>                               # when is the read, and what it needs
//   node scripts/epic-read.mjs --epic <slug> --actual 72 --evidence north-star:invoices_paid_on_time@2026-11-04
//   node scripts/epic-read.mjs --epic <slug> --evidence "traffic too low (n = 18)"          # no number: unclear
//   node scripts/epic-read.mjs --epic <slug> --verdict proven --evidence https://…           # an owner verdict
//   … --write                                                              # the approval: stamp verdict_* into the README
//   options: --today YYYY-MM-DD (default: today, UTC) · --repo-root <dir> · --json
//
// ── The shape (result-record D8) ─────────────────────────────────────────────────────────────────────────────────
// The agent does the legwork, the owner decides. Without `--write` this prints a draft and the exact command that
// approves it, and writes nothing. Inputs are flags, never a prompt: an agent asks the owner in the conversation and
// passes what they said.
//   • Before the read date it says when the read is due and stops — the date is the README's `read_date`, or, when none
//     was written, 30 days after shipping (lib/result-dates.mjs, the one place that rule lives).
//   • The draft: from `target_from` toward `target_to`; reached or passed → proven, short of it → disproven; no number
//     → unclear, with the reason in `--evidence`. `--verdict` is the owner's word over the draft, and is said as such.
//   • Proven and disproven need evidence that points somewhere (the contract's grammar: an https:// link,
//     `north-star:<input>@YYYY-MM-DD` or `ab:<experiment>`). `--write` runs the contract's own `validateResultFields` on
//     the record it is about to write, so a verdict the contract refuses never lands.
//   • More than 90 days after shipping, the read is still written, and said to be late (the extract marks it).
//   • An epic shipped with no target can be read too — an owner verdict and its evidence, one epic per run.
//
// ── With an account, and without ─────────────────────────────────────────────────────────────────────────────────
// No route reads a North Star reading or an A/B decision for a key yet (the lock checked: `gf north-star` only sets,
// `GET /api/v1/north-star` lists metrics and inputs with no values), so the actual always comes from the owner. With the
// project's key (the one `roadmap-push` uses) this asks that route whether `target_metric` is one of the project's
// inputs — grounded or not. No key, or any failure, is "could not check", and the read carries on.
//
// Zero deps — Node 18+.
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './lib/project-root.mjs';
import {
  VERDICTS,
  isEvidencePointer,
  parseDocFrontmatter,
  validateResultFields,
} from './lib/roadmap-contract.mjs';
import { READ_CAP_DAYS, isLate, readDateOf, todayUtc, isDay } from './lib/result-dates.mjs';
import { stampFrontmatter } from './lib/frontmatter-stamp.mjs';
import { buildRows } from './roadmap-extract.mjs';
import { apiKeyFrom } from './roadmap-push.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-11-04` → `4 Nov 2026`. */
export const longDay = (d) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

const fig = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/**
 * The draft verdict for a target and a number read. Pure.
 * From → to says the direction: a target above its start is met at or above it, one below at or below it.
 */
export function draftVerdict({ from, to, actual }) {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) return 'unclear';
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 'unclear';
  const up = to > from;
  return (up ? actual >= to : actual <= to) ? 'proven' : 'disproven';
}

/**
 * Everything the read decides, from the README's frontmatter, the extract's row and the flags. Pure — no I/O.
 * Returns `{ state, … }`: not-shipped · already-read · not-due · needs-input · refused · ready.
 */
export function planRead({ fm, shippedAt, shipped, today, actual = null, evidence = null, verdict = null }) {
  const target = {
    hypothesis: fm.hypothesis ?? null,
    metric: fm.target_metric ?? null,
    from: typeof fm.target_from === 'number' ? fm.target_from : null,
    to: typeof fm.target_to === 'number' ? fm.target_to : null,
  };
  if (fm.verdict)
    return { state: 'already-read', target, verdict: fm.verdict, verdictAt: fm.verdict_at ?? null };
  if (!shipped) return { state: 'not-shipped', target };
  if (verdict !== null && !VERDICTS.includes(verdict))
    return {
      state: 'refused',
      target,
      reasons: [`--verdict must be one of ${VERDICTS.join(' | ')}, got "${verdict}"`],
    };

  const { readDate, derived } = readDateOf({
    readDate: fm.read_date,
    targetMetric: target.metric,
    shippedAt,
  });
  if (target.metric && readDate && today < readDate) return { state: 'not-due', target, readDate, derived };

  const owner = verdict !== null;
  if (!target.metric && !owner)
    return {
      state: 'needs-input',
      target,
      need: 'This epic shipped with no target. An owner verdict is allowed, one epic at a time: --verdict <proven|disproven|unclear> --evidence <pointer, or for unclear the reason> (and --actual <n> for proven/disproven).',
    };
  const drafted = target.metric ? draftVerdict({ from: target.from, to: target.to, actual }) : null;
  const chosen = owner ? verdict : drafted;
  if (chosen === 'unclear' && !evidence)
    return {
      state: 'needs-input',
      target,
      drafted,
      readDate,
      derived,
      need:
        actual === null
          ? `Ask the owner for the number read for ${target.metric ?? 'this epic'} (--actual <n>) and where it came from (--evidence <https://… | north-star:<input>@YYYY-MM-DD | ab:<experiment>>), or why it cannot be told yet (--evidence "<reason>").`
          : 'Unclear needs the reason in --evidence (e.g. "traffic too low to tell (n = 18)").',
    };
  if ((chosen === 'proven' || chosen === 'disproven') && !evidence)
    return {
      state: 'needs-input',
      target,
      drafted,
      readDate,
      derived,
      need: `${chosen} needs evidence that points somewhere: --evidence <https://… | north-star:<input>@YYYY-MM-DD | ab:<experiment>>.`,
    };

  const fields = {
    verdict: chosen,
    verdict_actual: actual === null || actual === undefined ? null : actual,
    verdict_evidence: evidence,
    verdict_at: today,
  };
  const offenses = validateResultFields({ ...fm, ...fields }).map((o) => o.detail);
  const late = isLate({ verdictAt: today, shippedAt });
  if (offenses.length) return { state: 'refused', target, drafted, fields, reasons: offenses, late };
  return { state: 'ready', target, drafted, owner, fields, late, readDate, derived };
}

/** `metric` against the project's North Star inputs, through the existing read route. Never throws. */
export async function groundedCheck({ metric, apiKey, baseUrl, fetchFn = fetch }) {
  if (!metric) return { checked: false, why: 'no target metric' };
  if (!apiKey)
    return { checked: false, why: 'no project key (SELF_PROJECT_API_KEY / GROWTH_ENGINE_API_KEY)' };
  try {
    const res = await fetchFn(`${String(baseUrl).replace(/\/$/, '')}/api/v1/north-star`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { checked: false, why: `the engine answered ${res.status}` };
    const body = await res.json();
    const keys = (body?.metrics ?? []).flatMap((m) => (m?.inputs ?? []).map((i) => i?.key)).filter(Boolean);
    return { checked: true, grounded: keys.includes(metric), keys };
  } catch (err) {
    return { checked: false, why: `could not reach ${baseUrl}: ${err?.message ?? err}` };
  }
}

/** The text a person reads. Pure. */
export function renderPlan(plan, { slug, grounded, write, written }) {
  const out = [];
  const t = plan.target;
  const head = t.metric
    ? `${slug}: ${t.metric}${t.from !== null && t.to !== null ? ` ${fig(t.from)} → ${fig(t.to)}` : ''}${t.hypothesis ? ` — "${t.hypothesis}"` : ''}`
    : `${slug}: no target`;
  out.push(head);
  if (grounded) {
    if (grounded.checked)
      out.push(
        grounded.grounded
          ? `  grounded: ${t.metric} is one of the project's North Star inputs`
          : `  not grounded: ${t.metric} is not one of the project's North Star inputs (${grounded.keys.join(', ') || 'none'})`
      );
    else if (t.metric) out.push(`  could not check the metric against the North Star (${grounded.why})`);
  }
  switch (plan.state) {
    case 'already-read':
      out.push(
        `  already read: ${plan.verdict}${plan.verdictAt ? ` on ${longDay(plan.verdictAt)}` : ''}. Nothing to do.`
      );
      break;
    case 'not-shipped':
      out.push('  not shipped yet: there is nothing out there to read.');
      break;
    case 'not-due':
      out.push(
        `  read due ${longDay(plan.readDate)}${plan.derived ? ' (30 days after shipping — no read_date was written)' : ''}. Not yet: come back then.`
      );
      break;
    case 'needs-input':
      if (plan.drafted) out.push(`  draft so far: ${plan.drafted}`);
      out.push(`  needs: ${plan.need}`);
      break;
    case 'refused':
      out.push('  refused — nothing written:');
      for (const r of plan.reasons) out.push(`    · ${r}`);
      break;
    case 'ready': {
      const f = plan.fields;
      const word =
        plan.owner && plan.drafted && plan.drafted !== f.verdict
          ? `${f.verdict} (owner's verdict; drafted ${plan.drafted})`
          : plan.owner
            ? `${f.verdict} (owner's verdict)`
            : f.verdict;
      out.push(`  verdict:  ${word}`);
      if (f.verdict_actual !== null)
        out.push(`  actual:   ${fig(f.verdict_actual)}${t.to !== null ? ` (target ${fig(t.to)})` : ''}`);
      out.push(
        `  evidence: ${f.verdict_evidence}${isEvidencePointer(f.verdict_evidence) ? '' : ' (a reason, not a pointer)'}`
      );
      out.push(`  read on:  ${longDay(f.verdict_at)}`);
      if (plan.late)
        out.push(
          `  late: more than ${READ_CAP_DAYS} days after shipping — it is recorded, and it will not count for the North Star.`
        );
      if (written)
        out.push(
          `  written to ${written}. Commit it, then push the roadmap (node scripts/roadmap-push.mjs).`
        );
      else if (!write) out.push('  Not written. If the owner approves, run the same command with --write.');
      break;
    }
  }
  return out.join('\n');
}

function epicReadme(root, slug) {
  const roadmap = join(root, 'Roadmap');
  for (const macro of existsSync(roadmap) ? readdirSync(roadmap).sort() : []) {
    if (!/^\d{2}-/.test(macro)) continue;
    const p = join(roadmap, macro, slug, 'README.md');
    if (existsSync(p)) return p;
  }
  return null;
}

const arg = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

export async function main(argv, { fetchFn = fetch, env = process.env, stdout = process.stdout } = {}) {
  const slug = arg(argv, '--epic');
  if (!slug) {
    process.stderr.write('epic-read: --epic <slug> is required\n');
    return 2;
  }
  const root = resolve(arg(argv, '--repo-root') ?? projectRoot());
  const today = arg(argv, '--today') ?? todayUtc();
  if (!isDay(today)) {
    process.stderr.write(`epic-read: --today must be a day written YYYY-MM-DD, got "${today}"\n`);
    return 2;
  }
  const actualRaw = arg(argv, '--actual');
  const actual = actualRaw === null ? null : Number(actualRaw);
  if (actualRaw !== null && !Number.isFinite(actual)) {
    process.stderr.write(`epic-read: --actual must be a number, got "${actualRaw}"\n`);
    return 2;
  }
  const path = epicReadme(root, slug);
  if (!path) {
    process.stderr.write(`epic-read: no Roadmap/*/${slug}/README.md under ${root}\n`);
    return 2;
  }
  const md = readFileSync(path, 'utf8');
  const parsed = parseDocFrontmatter(md);
  if (!parsed.hasFrontmatter || parsed.error) {
    process.stderr.write(`epic-read: cannot read ${path}'s frontmatter: ${parsed.error ?? 'none'}\n`);
    return 2;
  }
  const row = buildRows({ root, facts: { mode: 'docs', prs: [], branches: [] } }).find(
    (r) => r.grain === 'Epic' && r.slug === slug
  );
  const plan = planRead({
    fm: parsed.data,
    shippedAt: row?.shipped_at ?? null,
    shipped: row?.stage === 'Shipped',
    today,
    actual,
    evidence: arg(argv, '--evidence'),
    verdict: arg(argv, '--verdict'),
  });
  const grounded =
    plan.state === 'already-read' || plan.state === 'not-shipped'
      ? null
      : await groundedCheck({
          metric: plan.target.metric,
          apiKey: apiKeyFrom(env),
          baseUrl: env.GROWTH_ENGINE_URL || 'http://localhost:3000',
          fetchFn,
        });
  const write = argv.includes('--write');
  let written = null;
  if (write && plan.state === 'ready') {
    const next = stampFrontmatter(md, plan.fields);
    // The stamped file must still satisfy the contract as a whole — a second check on what actually lands.
    const after = parseDocFrontmatter(next);
    const offenses = after.error ? [after.error] : validateResultFields(after.data).map((o) => o.detail);
    if (offenses.length) {
      stdout.write(
        renderPlan({ ...plan, state: 'refused', reasons: offenses }, { slug, grounded, write }) + '\n'
      );
      return 1;
    }
    writeFileSync(path, next);
    written = path.slice(root.length + 1);
  }
  if (argv.includes('--json')) stdout.write(`${JSON.stringify({ slug, ...plan, grounded, written })}\n`);
  else stdout.write(`${renderPlan(plan, { slug, grounded, write, written })}\n`);
  if (plan.state === 'refused') return 1;
  if (write && plan.state !== 'ready') return 1; // asked to write, and there was nothing approvable to write
  return 0;
}

const isMain = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`epic-read: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 2;
  }
}
