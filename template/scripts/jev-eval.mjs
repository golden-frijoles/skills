#!/usr/bin/env node
// jev-eval.mjs — the labelled eval set for the Jev guards, and the rot guard on shadow mode
// (jev-semantic-guards S1.4, D8).
//
//   node scripts/jev-eval.mjs                 offline (CI): replay every fixture's RECORDED Jev answers
//                                             through the real judge, assert the decision still matches the
//                                             recording, and fail if any rail is in shadow past its expiry.
//   node scripts/jev-eval.mjs --live          re-ask Jev for every fixture, REWRITE the recordings, and print
//                                             accuracy against the labels — regex vs Jev, per rail/family.
//   node scripts/jev-eval.mjs --rail prose    limit to one rail (or to `intent`, the intent-match question set).
//   node scripts/jev-eval.mjs --no-expiry     replay only: skip the shadow-expiry rot guard. For a blocking PR gate,
//                                             where a DATE would otherwise turn every unrelated PR red; the daily
//                                             expiry run (no flag) is what forces the decision.
//   node scripts/jev-eval.mjs --live --limit 10
//                                             the SETUP PROOF: ask Jev for only the first n fixtures of each
//                                             rail, print per-rail agreement with the labels, and WRITE
//                                             NOTHING. A partial run must never rewrite the committed
//                                             recordings (they would then cover n fixtures, not all), so
//                                             --limit is refused without --live and never touches the file.
//                                             It still needs `jev.egress` true and TYPESAFE_API_KEY.
//
// Why offline replay exists: a model bump, a threshold change, an edit to a judge's decide logic or to a
// question's WORDING must show up as a red CI run, not as a quietly different verdict on the next PR. Each
// recording stamps the hash of every question it answered (compiled-prompts D3); a stamp that no longer matches
// the live wording fails replay, naming the question. Why --live exists: the
// recordings are only as current as the model that produced them — run it before bumping `model`.
//
// The rot guard: a rail in `shadow` past `shadowExpires` fails this script, so shadow cannot quietly become
// the permanent "regex and Jev both" the product owner ruled out.
//
// The `intent` set (intent-match D15, C2) is evaluated here beside the rails without being one: it measures the
// wording of intent-match's questions on labelled items, and there is no regex to compare it with, no mode and no
// threshold. Its report adds how many answers were DECIDED (P ≤ 0.2 or ≥ 0.8) and how many of those were right.
//
// The `lint` rail (semantic-lint D8) is reported the same way — its selector picks candidates but has no verdict to
// compare with — and "decided" means raised or cleared at the rail's own threshold. Its question is project data, so a
// recording pins the wording's hash, and the fixtures live in the project's own jev-eval.lint.fixtures.json.
//
// Zero deps — Node 18+.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSection } from './lib/config.mjs';
import { loadJevConfig, parseJevConfig, RAILS, readApiKey, repoRoot } from './lib/jev.mjs';
import { questionHash } from './lib/jev-questions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_PATH = join(__dirname, 'jev-eval.fixtures.json');
/**
 * The `lint` set's fixtures are PROJECT data, like the rules they measure (semantic-lint D8, fresh review of #200):
 * this repo's rule-1 labels shipped in the shared file would fail any consumer whose own rule reused the id, and fail
 * every consumer with a rule but no such fixtures. So they live beside the script in a file the template never has.
 */
export const LINT_FIXTURES_PATH = join(__dirname, 'jev-eval.lint.fixtures.json');

/** Shadow is a short, expiring measurement: at most this many days out, ever. */
export const MAX_SHADOW_DAYS = 21;
/** A judge that exists must be proven on at least this many labelled cases (S1.4 acceptance). */
export const MIN_FIXTURES = 30;
/** What this harness evaluates: the Jev rails, plus intent-match's question set (not a rail — C2). */
export const EVAL_SETS = [...RAILS, 'intent'];
/** An intent answer counts as DECIDED when it sits this far from 0.5 — the band the report counts separately. */
export const DECIDED_MARGIN = 0.3;

const addDays = (ymd, n) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Shadow rails that fail the rot guard. Pure. `today` is the UTC date, YYYY-MM-DD (CI runs in UTC).
 * Past its date is expired; more than MAX_SHADOW_DAYS out is refused too — `2099-01-01` would otherwise
 * be a permanent shadow wearing an expiry date, and the gap only ever shrinks, so the cap is safe.
 */
export function expiredShadowRails(config, today) {
  const cap = addDays(today, MAX_SHADOW_DAYS);
  return Object.entries(config.rails)
    .filter(
      ([, r]) => r.mode === 'shadow' && r.shadowExpires && (r.shadowExpires < today || r.shadowExpires > cap)
    )
    .map(([name, r]) => ({
      rail: name,
      shadowExpires: r.shadowExpires,
      why: r.shadowExpires < today ? 'past its shadowExpires' : `more than ${MAX_SHADOW_DAYS} days out`,
    }));
}

/**
 * Coverage failures: fixtures with no judge to replay them (a renamed judge must not turn CI green), and a
 * judge with fewer than MIN_FIXTURES labelled cases. Pure.
 */
export function coverageFailures(fixtures, rails) {
  const out = [];
  for (const name of EVAL_SETS) {
    // A set that knows its own coverage rule (lint: per configured rule) answers for itself.
    if (rails[name]?.coverage) {
      out.push(...rails[name].coverage(fixtures[name] ?? []));
      continue;
    }
    const n = (fixtures[name] ?? []).length;
    if (!rails[name] && n)
      out.push(`${name}: ${n} fixture(s) but no judge to replay them — was the judge renamed?`);
    if (rails[name] && n < MIN_FIXTURES)
      out.push(`${name}: only ${n} labelled fixture(s); a judge needs ≥${MIN_FIXTURES}`);
  }
  return out;
}

/** An `ask` that answers ONLY from a recording — a missing answer is could-not-look, i.e. a stale fixture. */
export function replayAsk(recorded) {
  return async ({ questions }) => {
    const ids = Object.keys(questions);
    const missing = ids.filter((id) => !recorded?.answers?.[id]);
    if (missing.length)
      return {
        ok: false,
        state: 'could-not-look',
        error: `no recording for ${missing.slice(0, 3).join(', ')}`,
      };
    return {
      ok: true,
      answers: Object.fromEntries(ids.map((id) => [id, recorded.answers[id]])),
      usage: null,
      model: recorded.model,
    };
  };
}

/**
 * An `ask` that forwards to live Jev and captures every answer, so the recording can be rewritten. A
 * could-not-look is RECORDED as a failure: the judge would fall back to the regex, and scoring that as
 * Jev's answer — or baking it into the recording — would corrupt the flip gate (fresh review, PR #34).
 */
function recordingAsk(ask, sink) {
  return async (req) => {
    const r = await ask(req);
    if (r.ok) {
      Object.assign(sink.answers, r.answers);
      sink.model = r.model;
    } else sink.errors.push(r.error);
    return r;
  };
}

const SEMANTIC_CODES = [
  'unsupported-fix-claim',
  'invented-beneficiary',
  'flag-state-claim',
  'invented-commitment',
];
const sortedCodes = (findings) =>
  [...new Set((findings ?? []).map((f) => f.code).filter((c) => SEMANTIC_CODES.includes(c)))].sort();

/**
 * A recording answers for the WORDING that produced it, not only the model (compiled-prompts D3) — the guard the
 * lint rail already had, for every set. `hashes` maps question id → `questionHash`; `idsOf(answers, fx)` names the
 * questions a recording holds answers for. A recording with answers but no stamp is stale too: it cannot prove
 * which wording it answered.
 */
export function wordingHooks(hashes, idsOf) {
  return {
    stale: (fx) => {
      for (const id of idsOf(fx.recorded?.answers ?? {}, fx)) {
        const pinned = fx.recorded?.questionHashes?.[id];
        if (!pinned) return `recording has no wording stamp for ${id} — run --live`;
        if (pinned !== hashes[id]) return `recorded against another wording of ${id} — run --live`;
      }
      return null;
    },
    recordExtra: (fx, answers) => ({
      questionHashes: Object.fromEntries(idsOf(answers, fx).map((id) => [id, hashes[id]])),
    }),
  };
}

/** Prose answers are keyed `s<unit>_<family key>`; the question is the family. */
const proseIds = (answers) =>
  [...new Set(Object.keys(answers).map((id) => /^s\d+_(.+)$/.exec(id)?.[1] ?? id))].sort();

/**
 * The rails this harness can evaluate. Each judge is looked up by name so a rail whose judge has not
 * landed yet is SKIPPED loudly instead of failing the import.
 */
export async function loadRails({ lintRules = [] } = {}) {
  const rails = {};
  const review = await import('./lib/review-guard.mjs');
  if (typeof review.judgeReviewOutput === 'function')
    rails.review = {
      ...wordingHooks(
        Object.fromEntries(Object.entries(review.REVIEW_QUESTIONS).map(([id, q]) => [id, questionHash(q)])),
        (answers) => Object.keys(answers).sort()
      ),
      run: (fx, deps) => review.judgeReviewOutput(fx.text, {}, deps),
      regex: (fx) => review.assertReviewOutput(fx.text).ok,
      predicted: (d) => d.ok,
      expected: (fx) => fx.label,
      summary: (d) => ({ ok: d.ok, decider: d.decider }),
    };
  const prose = await import('./lib/prose-guard.mjs');
  if (typeof prose.judgeProse === 'function')
    rails.prose = {
      ...wordingHooks(
        Object.fromEntries(
          prose.PROSE_FAMILIES.map((f) => [
            f.key,
            questionHash({ type: 'noul', instructions: f.question, criteria: f.criteria }),
          ])
        ),
        proseIds
      ),
      run: (fx, deps) => prose.judgeProse(fx.draft, fx.evidence ?? {}, deps),
      regex: (fx) => sortedCodes(prose.checkProse(fx.draft, fx.evidence ?? {}).findings),
      predicted: (d) => sortedCodes(d.findings),
      expected: (fx) => [...fx.label].sort(),
      summary: (d) => ({ codes: sortedCodes(d.findings), decider: d.decider }),
    };
  const intent = await import('./intent-match.mjs');
  if (typeof intent.judgeItem === 'function')
    rails.intent = {
      // One question per fixture (`fx.question`); its answer id is `<prefix>_<item>`, so the fixture names it.
      ...wordingHooks(
        Object.fromEntries(Object.entries(intent.INTENT_QUESTIONS).map(([id, q]) => [id, questionHash(q)])),
        (answers, fx) => (Object.keys(answers).length ? [fx.question] : [])
      ),
      run: (fx, deps) => intent.judgeItem(fx, deps),
      regex: null, // no deterministic rule to compare with — the score has none (C2)
      predicted: (d) => d.value,
      expected: (fx) => fx.label,
      summary: (d) => ({ value: d.value, p: d.p, decider: d.decider }),
    };
  // semantic-lint D8. The QUESTION is the project's own data (`lint.rules`), so a fixture is replayed against the
  // rule this project has; one whose rule it lacks (the template's own run) is skipped and counted, never scored.
  const lint = await import('./semantic-lint.mjs');
  if (typeof lint.judgeCandidate === 'function') {
    const byId = new Map(lintRules.map((r) => [r.id, r]));
    rails.lint = {
      // Never replayed (there is no question to replay it against) — and `coverage` below fails it, so a renamed or
      // removed rule cannot go green by skipping every fixture it had (fresh review of #200).
      skip: (fx) => (byId.has(fx.rule) ? null : `no rule "${fx.rule}" in this project's lint config`),
      coverage: (cases) => [
        ...[...new Set(cases.filter((fx) => !byId.has(fx.rule)).map((fx) => fx.rule))].map(
          (id) => `lint: fixtures for "${id}", which this project's lint config does not define — renamed or removed?`
        ),
        ...[...byId.keys()]
          .map((id) => [id, cases.filter((fx) => fx.rule === id).length])
          .filter(([, n]) => n < MIN_FIXTURES)
          .map(([id, n]) => `lint/${id}: only ${n} labelled fixture(s); a rule needs ≥${MIN_FIXTURES}`),
      ],
      // A recording answers the wording that produced it: an edited question replaying green would prove nothing.
      stale: (fx) =>
        fx.recorded?.questionHash === lint.questionHash(byId.get(fx.rule))
          ? null
          : `recorded against another wording of ${fx.rule}'s question — run --live`,
      recordExtra: (fx) => ({ questionHash: lint.questionHash(byId.get(fx.rule)) }),
      run: (fx, deps) =>
        lint.judgeCandidate(
          { rule: byId.get(fx.rule), file: fx.file, hunk: fx.hunk },
          { ask: deps.ask, threshold: lint.thresholdFor(deps.config.rails.lint, fx.rule) }
        ),
      regex: null, // the selector only picks candidates; it has no verdict of its own to compare with
      predicted: (d) => (d.outcome === 'raise' ? true : d.outcome === 'clear' ? false : null),
      expected: (fx) => fx.label,
      // Decided = raised or cleared at THIS rail's threshold, not intent's fixed margin.
      decided: (d) => d.outcome === 'raise' || d.outcome === 'clear',
      summary: (d) => ({ outcome: d.outcome, p: d.p }),
    };
  }
  return rails;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Jev config for evaluation: the rail forced to `jev` so Jev's answer — not the regex — is what is scored.
 *
 * `egress` is forced to `true` too — for REPLAY, which sends nothing; `evaluate` refuses a live run without a
 * committed `true` — for the same reason `mode` is forced (golden-frijoles-plugin D12,
 * S5.4): this harness measures what Jev WOULD decide against a replayed or live answer, never gated by
 * whether this checkout's OWN `jev.config.json` has answered the egress question yet. `projectRoot()`
 * resolves to `template/` for a script run as `node template/scripts/…` (D2's documented copied-mode
 * root for this repo's own dogfooding), so `template/jev.config.json`'s tri-state `egress` IS this
 * process's live config — and its new default (`null`, unanswered) would otherwise score every fixture
 * as if the rail were off, which is a fact about this repo's own config, not about Jev's accuracy.
 */
const evalConfig = (base, rail) =>
  parseJevConfig({
    model: base.model,
    egress: true,
    rails: { ...base.rails, [rail]: { ...base.rails[rail], mode: 'jev', shadowExpires: null } },
  });

/**
 * Evaluate. Returns { failures, report, fixtures } — pure over its deps apart from the judge calls.
 * live=false replays recordings; live=true re-asks through deps.ask and rewrites them.
 */
export async function evaluate({
  fixtures,
  rails,
  config,
  live = false,
  ask = null,
  only = null,
  limit = null,
}) {
  // Replay forces egress on (evalConfig) because it sends nothing. LIVE sends every fixture to TypeSafe, so it needs
  // the project's explicit yes: `egress: true`, never null (unanswered) or false (D12; cross-review of #50 — the
  // CLI refused this, but a caller of this export did not).
  if (live && config?.egress !== true)
    throw new Error(
      `jev-eval live: egress is ${JSON.stringify(config?.egress ?? null)}, not true — refusing to send fixtures to Jev.`
    );
  const failures = [];
  const report = {};
  for (const [name, rail] of Object.entries(rails)) {
    if (only && only !== name) continue;
    const cases = limit == null ? (fixtures[name] ?? []) : (fixtures[name] ?? []).slice(0, limit);
    // Only a rail has a config entry to force on; the intent set reads nothing from it (C2).
    const cfg = RAILS.includes(name) ? evalConfig(config, name) : config;
    const tally = { n: cases.length, jevRight: 0, regexRight: 0, disagreements: 0, families: {} };
    if (!rail.regex) Object.assign(tally, { regexRight: null, disagreements: null, decided: 0, decidedRight: 0 });
    for (const fx of cases) {
      const skip = rail.skip?.(fx);
      if (skip) {
        tally.n--;
        tally.skipped = (tally.skipped ?? 0) + 1;
        tally.skipWhy = skip;
        continue;
      }
      const sink = { answers: {}, model: null, errors: [] };
      const deps = {
        config: cfg,
        key: 'eval',
        log: () => {},
        ask: live ? recordingAsk(ask, sink) : replayAsk(fx.recorded),
      };
      // A recording answers for the model that produced it. Replaying it under a bumped `model` would pass
      // while proving nothing about the new one (codex, PR #34): re-record with --live first.
      if (!live && fx.recorded?.model !== config.model) {
        failures.push(
          `${name}/${fx.id}: recorded by ${fx.recorded?.model ?? 'nothing'}, config pins ${config.model} — run --live`
        );
        continue;
      }
      const stale = live ? null : rail.stale?.(fx);
      if (stale) {
        failures.push(`${name}/${fx.id}: ${stale}`);
        continue;
      }
      const decision = await rail.run(fx, deps);
      const summary = rail.summary(decision);
      if (live && sink.errors.length) {
        failures.push(
          `${name}/${fx.id}: jev could not look (${sink.errors[0]}) — not scored, recording kept`
        );
        tally.n--;
        continue;
      }
      if (live) {
        // A draft the judge needed no answers for (e.g. a heading-only unit, which is never asked about) is
        // recorded as answered by the pinned model with no answers — replaying it asks nothing.
        fx.recorded = {
          model: sink.model ?? cfg.model,
          answers: sink.answers,
          ...(rail.recordExtra?.(fx, sink.answers) ?? {}),
        };
        fx.decision = summary;
      } else if (!same(summary, fx.decision)) {
        failures.push(
          `${name}/${fx.id}: replay gave ${JSON.stringify(summary)}, recorded ${JSON.stringify(fx.decision)}`
        );
      }
      const expected = rail.expected(fx);
      const jevRight = same(rail.predicted(decision), expected);
      tally.jevRight += jevRight;
      if (!rail.regex) {
        const decided = rail.decided
          ? rail.decided(decision)
          : typeof decision.p === 'number' && Math.abs(decision.p - 0.5) >= DECIDED_MARGIN;
        if (decided) {
          tally.decided++;
          tally.decidedRight += jevRight;
        }
        continue;
      }
      const regexRight = same(rail.regex(fx), expected);
      tally.regexRight += regexRight;
      tally.disagreements += !same(rail.predicted(decision), rail.regex(fx));
      if (name === 'prose')
        for (const code of SEMANTIC_CODES) {
          const f = (tally.families[code] ??= { jevRight: 0, regexRight: 0, n: 0 });
          const want = expected.includes(code);
          f.n++;
          f.jevRight += rail.predicted(decision).includes(code) === want;
          f.regexRight += rail.regex(fx).includes(code) === want;
        }
    }
    report[name] = tally;
  }
  return { failures, report, fixtures };
}

const pct = (a, n) => (n ? `${((100 * a) / n).toFixed(1)}%` : 'n/a');

export function formatReport(report) {
  const lines = [];
  for (const [rail, t] of Object.entries(report)) {
    if (t.regexRight === null) {
      lines.push(
        `${rail}: ${t.n} labelled · jev ${pct(t.jevRight, t.n)} · decided ${t.decided}/${t.n}, ${t.decidedRight} right · no deterministic rule` +
          (t.skipped ? ` · ${t.skipped} skipped (${t.skipWhy})` : '')
      );
      continue;
    }
    lines.push(
      `${rail}: ${t.n} labelled · jev ${pct(t.jevRight, t.n)} · regex ${pct(t.regexRight, t.n)} · ${t.disagreements} disagreement(s)`
    );
    for (const [code, f] of Object.entries(t.families))
      lines.push(`  ${code.padEnd(24)} jev ${pct(f.jevRight, f.n)} · regex ${pct(f.regexRight, f.n)}`);
  }
  return lines.join('\n');
}

/** The one line that refuses a live run, or null when it may go. Egress first, and the key is not even read until the yes is in. */
export function liveRefusal(config, getKey) {
  if (config.egress !== true)
    // false: no text leaves this machine; null: nobody has said yes yet (D12). `--live` sends fixtures.
    return `jev-eval --live: jev.egress is ${JSON.stringify(config.egress)}, not true — refusing to send fixtures to Jev. Say yes with \`frijoles-kit config set jev.egress true\` first.`;
  if (!getKey())
    return 'jev-eval --live needs TYPESAFE_API_KEY: put TYPESAFE_API_KEY=… in .env.local (or the environment).';
  return null;
}

/** Pure — `--limit <n>` as a positive integer, null when absent, or { error } when malformed. */
export function parseLimit(argv) {
  const ix = argv.indexOf('--limit');
  if (ix < 0) return null;
  const n = Number(argv[ix + 1]);
  if (!/^\d+$/.test(argv[ix + 1] ?? '') || n < 1) return { error: '--limit needs a positive whole number' };
  return n;
}

/**
 * The CLI, with every side effect injected so a spec can watch it: returns the exit code. `io` carries
 * { root, config, fixtures, rails, key, makeAsk, writeFixtures, stdout, stderr, today }.
 */
export async function run(argv, io = {}) {
  const { config, fixtures, rails, stdout, stderr } = io;
  const live = argv.includes('--live');
  const railIx = argv.indexOf('--rail');
  const only = railIx >= 0 ? argv[railIx + 1] : null;
  if (railIx >= 0 && !EVAL_SETS.includes(only)) {
    stderr(`jev-eval: --rail must be one of ${EVAL_SETS.join(', ')}\n`);
    return 2;
  }
  const limit = parseLimit(argv);
  if (limit?.error) {
    stderr(`jev-eval: ${limit.error}\n`);
    return 2;
  }
  if (limit != null && !live) {
    stderr('jev-eval: --limit only makes sense with --live (a setup proof against real Jev).\n');
    return 2;
  }
  const expired = argv.includes('--no-expiry')
    ? []
    : expiredShadowRails(config, io.today ?? new Date().toISOString().slice(0, 10));
  for (const name of ['review', 'prose'])
    if (!rails[name]) stdout(`${name}: no judge in this checkout yet — skipped\n`);

  let ask = null;
  if (live) {
    const refusal = liveRefusal(config, io.key);
    if (refusal) {
      stderr(`${refusal}\n`);
      return 2;
    }
    ask = io.makeAsk({ key: io.key(), model: config.model });
  }

  const { failures, report } = await evaluate({ fixtures, rails, config, live, ask, only, limit });
  // A partial run is not held to the per-rail fixture floor: that floor is about the committed set.
  if (limit == null) failures.push(...coverageFailures(fixtures, rails));
  const n = Object.values(report).reduce((s, t) => s + t.n, 0);
  if (live && limit != null) {
    stdout(
      `live proof: asked Jev for the first ${limit} fixture(s) of each rail (${n} scored) against ${config.model}; ` +
        'nothing written — the committed recordings are untouched.\n'
    );
  } else if (live && failures.length) {
    stderr('jev-eval --live: failures below — the recordings were NOT rewritten.\n');
  } else if (live) {
    io.writeFixtures(fixtures);
    stdout(`live: re-scored ${n} fixtures against ${config.model}; recordings rewritten.\n`);
  } else {
    stdout(`offline: ${n - failures.length}/${n} fixtures match recordings\n`);
  }
  stdout(`${formatReport(report)}\n`);
  for (const f of failures) stderr(`✗ ${f}\n`);
  for (const e of expired)
    stderr(`✗ rails.${e.rail} is in shadow ${e.why} (${e.shadowExpires}) — promote it to jev or set it off.\n`);
  return failures.length || expired.length ? 1 : 0;
}

async function main() {
  const root = repoRoot();
  const { askJev } = await import('./lib/jev.mjs');
  const { parseLintRules } = await import('./semantic-lint.mjs');
  const code = await run(process.argv.slice(2), {
    root,
    config: loadJevConfig({ root }),
    fixtures: {
      ...JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')),
      lint: existsSync(LINT_FIXTURES_PATH) ? JSON.parse(readFileSync(LINT_FIXTURES_PATH, 'utf8')) : [],
    },
    // A malformed lint section throws here: CI must go red on it, not replay against no rules.
    rails: await loadRails({ lintRules: parseLintRules(readSection('lint', { root }).raw) }),
    key: () => readApiKey({ root }),
    makeAsk: ({ key, model }) => (req) => askJev(req, { key, model }),
    writeFixtures: ({ lint, ...shared }) => {
      writeFileSync(FIXTURES_PATH, `${JSON.stringify(shared, null, 2)}\n`);
      if (lint.length) writeFileSync(LINT_FIXTURES_PATH, `${JSON.stringify(lint, null, 2)}\n`);
    },
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    today: new Date().toISOString().slice(0, 10),
  });
  if (code) process.exit(code);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  main().catch((e) => {
    process.stderr.write(`jev-eval: ${e.message}\n`);
    process.exit(1);
  });
