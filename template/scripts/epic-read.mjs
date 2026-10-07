#!/usr/bin/env node
// epic-read.mjs — read an epic's result on its read date: draft the verdict with its evidence; write it on approval.
//
//   node scripts/epic-read.mjs --epic <slug>                               # fetches the number through gf, drafts
//   node scripts/epic-read.mjs --epic <slug> --experiment smart-defaults   # … and cites the A/B decision record
//   node scripts/epic-read.mjs --epic <slug> --actual 72 --evidence north-star:invoices_paid_on_time@2026-11-04
//   node scripts/epic-read.mjs --epic <slug> --evidence "traffic too low (n = 18)"          # no number: unclear
//   node scripts/epic-read.mjs --epic <slug> --verdict proven --evidence https://…           # an owner verdict
//   … --write                                                              # the approval: stamp verdict_* into the README
//   options: --project <slug> (gf's; default: the remembered one) · --today YYYY-MM-DD (default: today, UTC)
//            · --repo-root <dir> · --json · GF_BIN=<path to gf> (default: gf on PATH)
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
// ── The agent fetches the number (result-record S3, D17) ─────────────────────────────────────────────────────────
// With a target and no `--actual`, this runs `gf north-star readings <target_metric> --to <today> --json` and takes
// `latest`: the actual is its value, the evidence `north-star:<input>@<its day>`. A reading dated before the epic shipped
// is no evidence for it. `--experiment <key>` also runs `gf experiments decision <key> --json`; a recorded decision
// becomes the evidence, `ab:<key>`. gf is spawned without a shell (`$GF_BIN`, else `gf` on PATH), so a shell alias of
// the same name never applies. `--actual` / `--evidence` still win: they are the owner's word. No gf, not signed in, no
// project chosen, or any failure is one "could not fetch (why)" line, and the read asks the owner as before — it never
// fails because the platform is not linked. Grounded is now "the readings route knows this input".

// Zero deps — Node 18+.
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './lib/project-root.mjs';
import {
  VERDICTS,
  isEvidencePointer,
  parseDocFrontmatter,
  validateResultFields,
} from './lib/roadmap-contract.mjs';
import { READ_CAP_DAYS, addDays, dayOf, isLate, readDateOf, todayUtc, isDay } from './lib/result-dates.mjs';
import { stampFrontmatter } from './lib/frontmatter-stamp.mjs';
import { buildRows } from './roadmap-extract.mjs';

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

/** Run one `gf … --json` and read its single JSON document. Never throws; `why` says what went wrong in words. */
export function runGf(args, { env = process.env, spawnFn = spawnSync } = {}) {
  const bin = env.GF_BIN || 'gf';
  const res = spawnFn(bin, [...args, '--json'], { encoding: 'utf8', timeout: 30_000, env, shell: false });
  if (res.error)
    return {
      ok: false,
      why:
        res.error.code === 'ENOENT'
          ? 'gf is not installed (npm i -g @golden-frijoles/cli, then gf login)'
          : `gf did not run: ${res.error.message}`,
    };
  let body = null;
  try {
    body = JSON.parse(res.stdout || 'null');
  } catch {
    body = null;
  }
  if (body && body.ok === true) return { ok: true, body };
  if (res.status === 2) return { ok: false, code: 'unauthorized', why: 'gf is not signed in (run gf login)' };
  const code = body?.code ?? null;
  return { ok: false, code, why: body?.error ?? `gf exited ${res.status}` };
}

/**
 * The number and its evidence, fetched through gf (D17). Pure apart from the injected `run`.
 * Returns `{ fetched, actual?, evidence?, reading?, decision?, grounded, why? }`.
 */
export function fetchEvidence({ metric, experiment = null, today, shippedAt, project = null, run }) {
  const scope = project ? ['--project', project] : [];
  const out = { fetched: false, grounded: null };
  const readings = run(['north-star', 'readings', metric, '--to', today, ...scope]);
  if (!readings.ok) {
    // `not_found` is also what an unknown or foreign PROJECT answers; only the input's own sentence means "not grounded".
    if (readings.code === 'not_found' && /No North Star input/.test(readings.why ?? '')) out.grounded = false;
    out.why = readings.why;
  } else {
    out.grounded = true;
    const latest = readings.body.latest;
    const shipped = dayOf(shippedAt);
    if (!latest) out.why = `no reading of ${metric} yet`;
    else if (shipped && latest.date < shipped)
      out.why = `no reading of ${metric} since it shipped (the latest is ${latest.date})`;
    else {
      out.fetched = true;
      out.reading = latest;
      out.actual = latest.value;
      out.evidence = `north-star:${metric}@${latest.date}`;
    }
  }
  if (experiment) {
    const decision = run(['experiments', 'decision', experiment, ...scope]);
    if (decision.ok && decision.body.decisions?.state === 'decided') {
      out.decision = decision.body.decisions.current;
      out.evidence = `ab:${experiment}`; // the decision record is the stronger pointer; the reading stays the actual
    } else if (decision.ok) out.decisionWhy = `${experiment} has no decision recorded yet`;
    else out.decisionWhy = decision.why;
  }
  return out;
}

/** The text a person reads. Pure. */
export function renderPlan(plan, { slug, fetched, write, written }) {
  const out = [];
  const t = plan.target;
  const head = t.metric
    ? `${slug}: ${t.metric}${t.from !== null && t.to !== null ? ` ${fig(t.from)} → ${fig(t.to)}` : ''}${t.hypothesis ? ` — "${t.hypothesis}"` : ''}`
    : `${slug}: no target`;
  out.push(head);
  if (fetched) {
    if (fetched.grounded === true)
      out.push(`  grounded: ${t.metric} is one of the project's North Star inputs`);
    if (fetched.grounded === false)
      out.push(`  not grounded: ${t.metric} is not one of the project's North Star inputs`);
    if (fetched.fetched)
      out.push(
        `  fetched:  ${fig(fetched.reading.value)} on ${longDay(fetched.reading.date)} (gf north-star readings)`
      );
    else if (fetched.why) out.push(`  could not fetch the number: ${fetched.why}`);
    if (fetched.decision)
      out.push(
        `  decision: ${fetched.decision.outcome ?? 'recorded'}${fetched.decision.chosenVariantKey ? ` (${fetched.decision.chosenVariantKey})` : ''} (gf experiments decision)`
      );
    else if (fetched.decisionWhy) out.push(`  decision: ${fetched.decisionWhy}`);
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

export async function main(argv, { spawnFn = spawnSync, env = process.env, stdout = process.stdout } = {}) {
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
  const shippedAt = row?.shipped_at ?? null;
  const evidenceFlag = arg(argv, '--evidence');
  const base = {
    fm: parsed.data,
    shippedAt,
    shipped: row?.stage === 'Shipped',
    today,
    verdict: arg(argv, '--verdict'),
  };
  let plan = planRead({ ...base, actual, evidence: evidenceFlag });
  // D17 — fetch only when there is a read to make and the owner has not given the number: never before the read date,
  // never for an epic already read or not shipped, never over the owner's own --actual.
  let fetched = null;
  const readable = !['already-read', 'not-shipped', 'not-due'].includes(plan.state);
  // The owner's word wins: a number (--actual), a reason or pointer (--evidence) or a verdict (--verdict) means the
  // owner has answered, and a fetched number must not overrule them (fresh review, #293).
  const ownerAnswered = actual !== null || evidenceFlag !== null || base.verdict !== null;
  if (readable && plan.target.metric && !ownerAnswered) {
    fetched = fetchEvidence({
      metric: plan.target.metric,
      experiment: arg(argv, '--experiment'),
      // Complete days only: today's telemetry count is a partial day (fresh review, #293).
      today: addDays(today, -1),
      shippedAt,
      project: arg(argv, '--project'),
      run: (args) => runGf(args, { env, spawnFn }),
    });
    // Only a reading is a number to draft from; a decision on its own only names the pointer for the owner to confirm.
    if (fetched.fetched)
      plan = planRead({
        ...base,
        actual: fetched.actual ?? null,
        evidence: evidenceFlag ?? fetched.evidence ?? null,
      });
  }
  const write = argv.includes('--write');
  let written = null;
  if (write && plan.state === 'ready') {
    const next = stampFrontmatter(md, plan.fields);
    // The stamped file must still satisfy the contract as a whole — a second check on what actually lands.
    const after = parseDocFrontmatter(next);
    const offenses = after.error ? [after.error] : validateResultFields(after.data).map((o) => o.detail);
    if (offenses.length) {
      const refused = { ...plan, state: 'refused', reasons: offenses };
      stdout.write(
        argv.includes('--json')
          ? `${JSON.stringify({ slug, ...refused, fetched, written: null })}\n`
          : `${renderPlan(refused, { slug, fetched, write })}\n`
      );
      return 1;
    }
    writeFileSync(path, next);
    written = path.slice(root.length + 1);
  }
  if (argv.includes('--json')) stdout.write(`${JSON.stringify({ slug, ...plan, fetched, written })}\n`);
  else stdout.write(`${renderPlan(plan, { slug, fetched, write, written })}\n`);
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
