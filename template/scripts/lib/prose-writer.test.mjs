// prose-writer — the routing + guard-and-retry orchestration.
//
// Every writer here is injected, so these tests never touch a network, a CLI or a temp file. What
// they pin is the POLICY: who is tried in what order, what happens to a rejected draft, and — most
// importantly — that a draft which never satisfies the guard is still returned to the caller WITH
// its findings rather than silently swallowed or silently passed off as clean.
//
// The block at the bottom pins the SIGNATURE ADAPTATION, which is the one thing this port could get
// wrong invisibly: our cross-agent-cli runners return a string-or-null, not `{ ok, text }`. Reading
// a falsy return as success would make every capped writer look like a clean draft.
//
// ⚠️ WHEN YOU ADD A WRITER, stub it in EVERY test that passes `has: () => true`. Adding codex broke
// two specs here that stubbed only devin/agy — `has` reported the new writer available, nothing
// stubbed it, and the real CLI ran (7s and 14s). That is the same trap the retry spec below already
// records for agy; a third writer proved it recurs, so it is now stated once at the top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planWriters,
  writeProse,
  buildWriterPrompt,
  loadLessons,
  draftWithDevin,
  draftWithAgy,
  draftWithCodex,
  PROSE_MODEL,
} from './prose-writer.mjs';
import { checkProse } from './prose-guard.mjs';

// writeProse is async since jev-semantic-guards S3.2 and its default guard is judgeProse. These specs pin
// the WRITER's behaviour, so they inject the regex guard explicitly: with a consumer's jev.config.json in
// `jev` and a key in .env.local, the default would otherwise reach the network from a unit test.
const writeProseOffline = (args, deps = {}) => writeProse(args, { guard: checkProse, ...deps });


const CLEAN =
  'Whoever ships next gets faster feedback, and a whole class of mistake is caught before it lands.';
const DIRTY = 'Tenants are delighted that the bug is fixed.';

const okWriter = (text) => () => ({ ok: true, text });
const failWriter = (error, retryable = false) => () => ({ ok: false, text: '', error, retryable });
const silent = () => {};

// ── The router ──────────────────────────────────────────────────────────────────────────────

test('planWriters: DEVIN leads, agy follows — the division of labour, expressed as policy', async () => {
  // Devin is the dedicated prose writer so agy's and codex's quota stays free for review and
  // building. This assertion IS the policy: if it changes, every report in the repo changes writer.
  assert.deepEqual(planWriters({ devinAvailable: true, agyAvailable: true }), ['devin', 'agy']);
});

test('planWriters: devin carries it alone when agy is missing (a real, separate quota pool)', async () => {
  assert.deepEqual(planWriters({ devinAvailable: true, agyAvailable: false }), ['devin']);
});

test('planWriters: agy carries it alone when devin is missing', async () => {
  assert.deepEqual(planWriters({ devinAvailable: false, agyAvailable: true }), ['agy']);
});

test('planWriters: an explicit preference wins, and yields nothing when unavailable', async () => {
  assert.deepEqual(planWriters({ devinAvailable: true, agyAvailable: true, preferred: 'agy' }), ['agy']);
  assert.deepEqual(planWriters({ devinAvailable: false, agyAvailable: true, preferred: 'devin' }), []);
});

// ── Guard-and-retry ─────────────────────────────────────────────────────────────────────────

test('a clean first draft is returned immediately, with one attempt', async () => {
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    { devin: okWriter(CLEAN), agy: failWriter('should not be reached'), has: () => true, warn: silent }
  );
  assert.equal(r.ok, true);
  assert.equal(r.writer, 'devin');
  assert.equal(r.attempts, 1);
});

test('a rejected draft is RETRIED with the findings, not discarded', async () => {
  // The core behaviour: the guard's job is to trigger a correction, not merely to say no.
  const prompts = [];
  const writer = (prompt) => {
    prompts.push(prompt);
    return { ok: true, text: prompts.length === 1 ? DIRTY : CLEAN };
  };
  // BOTH writers stubbed, always. golden-beans' version of this test stubbed only `devin` and
  // relied on devin running first, so the day the router order flipped it reached the REAL agy CLI
  // and hung for two minutes. A unit test that can invoke a network CLI when a policy constant
  // changes is a trap for whoever changes the constant.
  const r = await writeProseOffline(
    { prompt: 'BASE', evidence: {} },
    { agy: writer, devin: writer, has: () => true, warn: silent }
  );

  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.text, CLEAN);
  // The retry prompt must carry the rejected draft AND the numbered findings, or the writer is
  // just guessing again.
  //
  // Matched on the HEADING, not on the bare phrase. golden-beans' original asserted
  // /Your previous draft/, which the revision note's own opening line ("Your previous draft was
  // rejected by an automated check…") satisfies all by itself — so the spec passed even with the
  // heading deleted, and the draft could have gone missing unnoticed. Proved by mutation.
  assert.match(prompts[1], /^## Your previous draft$/m, 'the rejected draft must be labelled');
  assert.match(prompts[1], /Tenants are delighted/, 'and actually included');
  assert.match(prompts[1], /^\d+\./m, 'with the findings numbered');
  assert.ok(
    prompts[1].indexOf('Tenants are delighted') < prompts[1].search(/^1\./m),
    'the draft comes first, then what is wrong with it'
  );
});

test('the LATEST draft is kept as the fallback, never the first', async () => {
  // golden-beans' cross-review caught exactly this: an `if (!best)` pinned the pass-0 draft, so a
  // revision that also tripped a rule was thrown away and the UNREVISED text was returned — making
  // the whole retry pass pure cost. The revision is better informed even when still imperfect.
  const drafts = ['Tenants are delighted that the bug is fixed.', 'Customers are delighted, honestly.'];
  let i = 0;
  const writer = () => ({ ok: true, text: drafts[Math.min(i++, drafts.length - 1)] });
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    { devin: writer, agy: failWriter('unavailable'), has: (c) => c === 'devin', warn: silent }
  );
  assert.equal(r.ok, false);
  assert.equal(r.text, drafts[1], 'the revision must win, not the original');
  assert.equal(r.attempts, 2);
});

test('a writer that FAILS is skipped without burning its retry on a revision note', async () => {
  // A broken CLI is not fixed by being told its prose was bad; move to the next writer instead.
  let firstCalls = 0;
  const failing = () => {
    firstCalls++;
    return { ok: false, text: '', error: 'the lead writer exploded', retryable: false };
  };
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    { devin: failing, agy: okWriter(CLEAN), has: () => true, warn: silent }
  );
  assert.equal(firstCalls, 1, 'a non-retryable failed writer must not be called again');
  assert.equal(r.ok, true);
  assert.equal(r.writer, 'agy', 'the fallback picked it up');
});

test('a RETRYABLE failure buys exactly one more attempt before demoting the writer', async () => {
  // Measured transient (2026-07-25): devin exited 0 with empty stdout on a 9 KB prompt and the
  // identical prompt succeeded moments later. Falling straight through would cost the better writer
  // for a hiccup — but a genuine outage must still demote, so it is ONE retry, not a loop.
  let calls = 0;
  const flaky = () => {
    calls++;
    return calls === 1
      ? { ok: false, text: '', error: 'devin returned no output', retryable: true }
      : { ok: true, text: CLEAN };
  };
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    { devin: flaky, agy: failWriter('must not be reached'), has: () => true, warn: silent }
  );
  assert.equal(calls, 2);
  assert.equal(r.ok, true);
  assert.equal(r.writer, 'devin', 'the transient must not have cost us the lead writer');
  assert.equal(r.attempts, 2);
});

test('a persistent retryable failure still demotes — the retry is resilience, not denial', async () => {
  let calls = 0;
  const dead = () => {
    calls++;
    return { ok: false, text: '', error: 'devin returned no output', retryable: true };
  };
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    { devin: dead, agy: okWriter(CLEAN), has: () => true, warn: silent }
  );
  assert.equal(calls, 2, 'exactly one retry, then move on');
  assert.equal(r.writer, 'agy');
});

test('runs agy alone when devin is not installed at all', async () => {
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    { devin: failWriter('never called'), agy: okWriter(CLEAN), has: (c) => c === 'agy', warn: silent }
  );
  assert.equal(r.ok, true);
  assert.equal(r.writer, 'agy');
});

test('a draft that never satisfies the guard is STILL RETURNED, flagged, never silently passed', async () => {
  // The most important case. Returning nothing would make the caller fail closed with no output to
  // learn from; returning it as `ok` would launder a known-bad draft into the channel. So: return
  // it, with ok:false and the findings attached, and let the caller surface them (D3).
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    { devin: okWriter(DIRTY), agy: okWriter(DIRTY), codex: okWriter(DIRTY), has: () => true, warn: silent }
  );
  assert.equal(r.ok, false);
  assert.equal(r.text, DIRTY, 'the draft must be handed back for a human to fix');
  assert.ok(r.guard.findings.length > 0, 'and it must carry the reasons');
  assert.ok(r.guard.findings.some((f) => f.code === 'invented-beneficiary'));
});

test('the evidence pack reaches the guard — a flag-OFF claim is caught through the rail', async () => {
  // The whole point of threading `evidence` through: D6's rule is only as good as the pack the
  // writer rail hands it.
  const draft = 'The partner portfolio is live, and every shop owner can see it right now.';
  const r = await writeProseOffline(
    { prompt: 'p', evidence: { allowsBeneficiary: true, liveFlags: [], minWords: 1 } },
    { devin: okWriter(draft), agy: okWriter(draft), codex: okWriter(draft), has: () => true, warn: silent }
  );
  assert.equal(r.ok, false);
  assert.ok(r.guard.findings.some((f) => f.code === 'flag-state-claim'), JSON.stringify(r.guard));
});

test('no writer available is an honest failure, not an empty success', async () => {
  const r = await writeProseOffline({ prompt: 'p', evidence: {} }, { has: () => false, warn: silent });
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.equal(r.attempts, 0);
  assert.match(r.error, /no prose writer available/);
});

// ── Prompt assembly + lessons ───────────────────────────────────────────────────────────────

test('buildWriterPrompt orders style → lessons → task, and omits an empty lessons block', async () => {
  const withLessons = buildWriterPrompt({ style: 'STYLE', lessons: 'LESSON', task: 'TASK' });
  assert.ok(withLessons.indexOf('STYLE') < withLessons.indexOf('LESSON'));
  assert.ok(withLessons.indexOf('LESSON') < withLessons.indexOf('TASK'));
  assert.match(withLessons, /Lessons from previous drafts/);

  const without = buildWriterPrompt({ style: 'STYLE', lessons: '', task: 'TASK' });
  assert.ok(!without.includes('Lessons from previous drafts'), 'an empty lessons block must be omitted');
});

test('loadLessons strips the notes-to-humans header above the first ---', async () => {
  const raw = '<!-- how to use this file -->\n---\nNever invent a beneficiary.';
  const out = loadLessons({ read: () => raw, exists: () => true, path: 'x' });
  assert.equal(out, 'Never invent a beneficiary.');
  assert.ok(!out.includes('how to use this file'));
});

test('loadLessons degrades to empty when the file is absent — never kills a report', async () => {
  // Deliberately NOT loadPromptBody, which die()s. A missing lessons file is a legitimate state.
  const out = loadLessons({
    exists: () => false,
    read: () => {
      throw new Error('must not read a missing lessons file');
    },
    path: 'x',
  });
  assert.equal(out, '');
});

// ── The signature adaptation (our runners return string-or-null, not { ok, text }) ───────────

test('draftWithDevin: a string return is a draft; a NULL return is a failure, not an empty success', async () => {
  // Getting this backwards makes every capped/unauthenticated writer look like a clean draft, and
  // the guard would then be checking an empty string. `soft: true` must be passed or the runner
  // die()s the whole process instead of returning.
  const opts = [];
  const ok = draftWithDevin('p', { run: (_p, o) => (opts.push(o), '  drafted  ') });
  assert.deepEqual(opts, [{ soft: true }], 'soft mode is mandatory — otherwise the runner exits the process');
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'drafted', 'the text is trimmed');

  const bad = draftWithDevin('p', { run: () => null });
  assert.equal(bad.ok, false);
  assert.equal(bad.text, '');
  assert.equal(bad.retryable, true, 'a devin failure is worth exactly one retry');
});

test('draftWithAgy: runs the SINGLE prose model, in soft mode', async () => {
  let seen;
  const r = draftWithAgy('p', { run: (_p, o) => ((seen = o), 'drafted') });
  assert.deepEqual(seen.models, [PROSE_MODEL], 'one model — a second one would silently change the voice');
  assert.equal(seen.soft, true);
  assert.equal(r.ok, true);
  assert.equal(r.model, PROSE_MODEL, 'the model is reported so the banner can name what actually wrote it');
});

test('PROSE_MODEL is the GPT-OSS model, and emphatically NOT a Gemini one', async () => {
  // `gemini-3.5-flash-high` was prose-draft.mjs's default until this sprint, and it is the exact
  // constant golden-beans found had silently destroyed the register of every report. Pinned here so
  // restoring "a Gemini fallback for resilience" has to argue with a test. Resilience lives at the
  // WRITER level (devin → agy, two separate quota pools), not inside the agy path.
  assert.equal(PROSE_MODEL, 'gpt-oss-120b-medium');
  assert.ok(!/gemini/i.test(PROSE_MODEL));
});

test('draftWithAgy: an oversized prompt fails NON-retryably and never reaches the CLI', async () => {
  // A second identical attempt cannot shrink the prompt — retrying is pure latency, and it delays
  // the fall-through to devin, which rides --prompt-file and has no cap at all.
  const r = draftWithAgy('x'.repeat(50), {
    limit: 10,
    run: () => {
      throw new Error('must not spawn agy with an oversized prompt');
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.error, /argv cap/);
});

// ── The THIRD writer: codex (2026-07) ────────────────────────────────────────────────────────
//
// What these pin is the ROUTER POLICY (codex is a last resort, not a peer) and the failure
// CLASSIFICATION — an auth lapse and a stale CLI mean codex cannot run here at all, so retrying is
// pure latency on the last writer in the chain. Same "empty success" trap as the block above: exit
// 0 with no text is a real codex failure mode and must never reach the guard as a clean draft.

test('planWriters: codex is LAST — the review quota is the scarce one', async () => {
  assert.deepEqual(
    planWriters({ devinAvailable: true, agyAvailable: true, codexAvailable: true }),
    ['devin', 'agy', 'codex']
  );
  assert.deepEqual(
    planWriters({ devinAvailable: false, agyAvailable: false, codexAvailable: true }),
    ['codex'],
    'codex alone still writes — a third pool is the point'
  );
});

test('writeProse: falls through to codex when BOTH devin and agy are capped', async () => {
  // The measured case: the merge-report log shows devin refusing with "high demand for this model",
  // and agy shares its pool with the review layer.
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    {
      devin: failWriter('capped'),
      agy: failWriter('capped'),
      codex: okWriter(CLEAN),
      has: () => true,
      warn: silent,
    }
  );
  assert.equal(r.ok, true);
  assert.equal(r.writer, 'codex');
});

test('draftWithCodex: the prompt rides STDIN, never argv', async () => {
  // execCodex puts its `prompt` arg in argv — the exact cap that already bites agy. A prose prompt
  // carries the persona, the lessons and a full evidence pack, so it must not go there.
  let seen;
  const big = 'x'.repeat(300 * 1024);
  const r = draftWithCodex(big, {
    run: (directive, stdin) => ((seen = { directive, stdin }), { ok: true, text: 'drafted' }),
  });
  assert.equal(r.ok, true);
  assert.equal(seen.stdin, big, 'the material goes on stdin');
  assert.ok(seen.directive.length < 500, 'argv stays a short constant directive');
  assert.ok(!seen.directive.includes('xxx'), 'the material must never reach argv');
});

test('draftWithCodex: an AUTH lapse is non-retryable — a second try cannot log codex in', async () => {
  const r = draftWithCodex('p', { run: () => ({ ok: false, text: '', authFailed: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.error, /codex login/);
});

test('draftWithCodex: a STALE CLI is non-retryable and names the doctor script', async () => {
  const r = draftWithCodex('p', { run: () => ({ ok: false, text: '', cliOutdated: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.error, /cross-agent-doctor/);
});

test('draftWithCodex: a quota cap IS retryable — that is the recoverable case', async () => {
  const r = draftWithCodex('p', { run: () => ({ ok: false, text: '', stderr: 'rate limited' }) });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, true);
});

test('draftWithCodex: exit 0 with EMPTY text is a failure, not an empty success', async () => {
  // The signature-adaptation trap again: `ok: true` with no text would hand the guard "" and call
  // it a clean draft.
  const r = draftWithCodex('p', { run: () => ({ ok: true, text: '   ' }) });
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.equal(r.retryable, true);
});

// ── The project's stack names reach EVERY writeProse caller (review of the origin's migration) ─────
// The names left the guard's built-in list for reporting.config.json; only the standup and weekly
// recap passed them back, so the merge report silently stopped blocking them. writeProse now applies
// them itself — these pin that a caller who passes nothing still gets them.

test('writeProse applies the project-configured stack names even when the caller passes none', async () => {
  const seen = [];
  const r = await writeProseOffline(
    { prompt: 'p', evidence: {} },
    {
      devin: okWriter('The Acmecart cart now survives a refresh.'),
      has: (c) => c === 'devin',
      warn: silent,
      extraBannedToolNames: () => ['acmecart'],
      guard: (draft, ev) => {
        seen.push(ev.extraBannedToolNames);
        return { ok: false, findings: [{ code: 'names-implementation', note: 'x' }] };
      },
    }
  );
  assert.deepEqual(seen[0], ['acmecart'], 'the guard never saw the configured names');
  assert.equal(r.guard.ok, false);
});

test('a caller-supplied list wins over the configured one', async () => {
  let got;
  await writeProseOffline(
    { prompt: 'p', evidence: { extraBannedToolNames: ['explicit'] } },
    {
      devin: okWriter(CLEAN),
      has: (c) => c === 'devin',
      warn: silent,
      extraBannedToolNames: () => ['configured'],
      guard: (d, ev) => ((got = ev.extraBannedToolNames), { ok: true, findings: [] }),
    }
  );
  assert.deepEqual(got, ['explicit']);
});

test('projectBannedToolNames: no reporting config means none configured, not a crash', async () => {
  const { projectBannedToolNames } = await import('./prose-writer.mjs');
  const { ReportingConfigError } = await import('./reporting-config.mjs');
  assert.deepEqual(projectBannedToolNames({ load: () => { throw new ReportingConfigError('absent'); } }), []);
  assert.deepEqual(projectBannedToolNames({ load: () => ({ prose: { extraBannedToolNames: ['x'] } }) }), ['x']);
  assert.throws(() => projectBannedToolNames({ load: () => { throw new TypeError('real bug'); } }), /real bug/);
});

test('the retry loop AWAITS an async guard (judgeProse is async) — a rejected draft is revised', async () => {
  const seen = [];
  let n = 0;
  const guard = async (text) => {
    seen.push(text);
    await new Promise((r) => setTimeout(r, 1));
    return n++ === 0 ? { ok: false, findings: [{ code: 'invented-commitment', note: 'no dates' }] } : { ok: true, findings: [] };
  };
  const drafts = ['first draft.', 'second draft.'];
  const r = await writeProse(
    { prompt: 'p', evidence: {} },
    { has: (c) => c === 'devin', devin: () => ({ ok: true, text: drafts.shift() }), guard, warn: () => {}, extraBannedToolNames: () => [] }
  );
  assert.equal(r.ok, true);
  assert.equal(r.text, 'second draft.');
  assert.deepEqual(seen, ['first draft.', 'second draft.']);
});

// ── Every caller AWAITS writeProse (2026-10-03) ──────────────────────────────────────────────────────
// writeProse went async in #159; commit-report and standup-report kept calling it bare, so `result.text` was
// undefined and the 📝 rail died silently for ten days. Pinned for the whole class, not the two instances.
// Line-based on purpose: it catches the shape that actually shipped. An import alias or a call split across lines
// can slip past it; `return writeProse(` / `.then(` are flagged though correct — await them instead.
test('no script calls writeProse without await', async () => {
  const { readdirSync, readFileSync: read } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bare = [];
  const files = ['', 'lib/'].flatMap((d) =>
    readdirSync(join(root, d))
      .filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
      .map((n) => `${d}${n}`)
  );
  for (const f of files) {
    read(join(root, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/\bwriteProse\(/.test(line) && !/\b(await\s+|function\s+)writeProse\(/.test(line) && !/^\s*(\/\/|\*)/.test(line))
          bare.push(`${f}:${i + 1}`);
      });
  }
  assert.deepEqual(bare, [], `writeProse is async — await it: ${bare.join(', ')}`);
});
