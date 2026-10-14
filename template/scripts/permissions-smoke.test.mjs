import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASK_COMMANDS,
  CRITICAL_COMMANDS,
  REQUIRED_ASKS,
  REQUIRED_REFUSALS,
  bashRuleMatches,
  checkContract,
  describeUserMode,
  looksLiteral,
  refusedCommands,
  scoreLive,
  shadowCheck,
} from './permissions-smoke.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
const ledger = JSON.parse(readFileSync(join(root, '.claude', 'permissions-ledger.json'), 'utf8'));
const kinds = (f) => f.map((x) => x.kind).sort();

test('the committed settings + ledger satisfy the contract', () => {
  assert.deepEqual(checkContract({ settings, ledger }), []);
});

test('the deny list names the guardrails the process promises', () => {
  const deny = settings.permissions.deny;
  for (const probe of [
    'vercel deploy --prod',
    'vercel --prod --yes',
    'supabase db reset',
    'git push --force origin x',
    'rm -rf build',
  ]) {
    assert.ok(
      deny.some((r) => bashRuleMatches(r.slice(5, -1), probe)),
      `no deny rule refuses: ${probe}`
    );
  }
});

test('ordinary builder commands are NOT caught by the deny list (a guard must allow the negation)', () => {
  const deny = settings.permissions.deny.filter((r) => r.startsWith('Bash('));
  for (const ok of [
    // many-products S2.4 (2026-10-14): agents apply migrations with `db push`; `db reset` stays denied.
    'supabase db push',
    'npx supabase db push --linked',
    'git push origin feat/x',
    'git push -u origin feat/x',
    'git push origin --delete feat/x',
    'git commit --amend --no-edit',
    'git commit -m "fix: add -a flag docs"',
    'git add scripts/a.mjs',
    'git add -u scripts/',
    'git add -- scripts/a.mjs',
    'git add ./scripts/a.mjs',
    'rm -r build',
    'vercel env ls',
    'vercel ls --prod',
    'supabase migration list',
    'git push --follow-tags origin feat/x',
    'git push --force-with-lease origin feat/x-s2',
  ]) {
    assert.ok(!deny.some((r) => bashRuleMatches(r.slice(5, -1), ok)), `deny list wrongly refuses: ${ok}`);
  }
});

test('matcher: trailing " *" matches the bare command; a mid wildcard does not', () => {
  assert.equal(bashRuleMatches('git add -A *', 'git add -A'), true);
  assert.equal(bashRuleMatches('ls *', 'lsof'), false);
  assert.equal(bashRuleMatches('vercel *--prod*', 'vercel deploy --prod'), true);
  assert.equal(bashRuleMatches('git push * -f', 'git push origin main'), false);
});

test('deleting the whole deny list and its ledger together still fails (consistency is not coverage)', () => {
  const s = structuredClone(settings);
  s.permissions.deny = [];
  s.permissions.ask = [];
  const f = checkContract({ settings: s, ledger: { entries: [] } });
  assert.ok(
    f.length >= 7 && f.every((x) => x.kind === 'missing-guardrail' || x.kind === 'missing-ask'),
    JSON.stringify(kinds(f))
  );
});

test('an uncited deny rule fails', () => {
  const s = structuredClone(settings);
  s.permissions.deny.push('Bash(terraform destroy *)');
  assert.deepEqual(kinds(checkContract({ settings: s, ledger })), ['uncited-rule']);
});

test('a ledger entry whose rule was deleted fails as stale', () => {
  const s = structuredClone(settings);
  s.permissions.deny = s.permissions.deny.filter((r) => r !== 'Bash(git push *--mirror*)');
  assert.deepEqual(kinds(checkContract({ settings: s, ledger })), ['stale-ledger']);
});

test('deleting a rule that carries a REQUIRED refusal fails twice — stale ledger AND missing guardrail', () => {
  const s = structuredClone(settings);
  s.permissions.deny = s.permissions.deny.filter((r) => !r.includes('supabase db reset'));
  const f = kinds(checkContract({ settings: s, ledger }));
  assert.ok(f.includes('stale-ledger') && f.includes('missing-guardrail'), JSON.stringify(f));
});

test('every CRITICAL command is required in all three spellings — bare, assignment-prefixed and env', () => {
  // The gap this closes: `vercel deploy` and `rm -rf` had expansion-safe rules while `vercel --yes --prod`,
  // `rm -fr` and `supabase db reset` were bare-only, so a prefixed spelling matched nothing.
  for (const c of CRITICAL_COMMANDS) {
    assert.ok(REQUIRED_REFUSALS.includes(c));
    assert.ok(REQUIRED_REFUSALS.includes(`PATH=/x:$PATH ${c}`));
    assert.ok(REQUIRED_REFUSALS.includes(`env PATH=/x:$PATH ${c}`));
  }
  assert.deepEqual(kinds(checkContract({ settings, ledger })), []);
});

test('an over-broad deny that swallows a safe negation fails', () => {
  // `--force-with-lease` is an ASK: a deny that also matches it cannot be approved even once, and a guard
  // that rejects correct output is worse than one that misses a rare fault.
  const s = structuredClone(settings);
  const l = structuredClone(ledger);
  s.permissions.deny.push('Bash(*=* git push *--force*)');
  l.entries.push({
    list: 'deny',
    rule: 'Bash(*=* git push *--force*)',
    probe: 'PATH=/x:$PATH git push origin main --force',
    cites: 'over-broad on purpose, for this test',
  });
  const f = kinds(checkContract({ settings: s, ledger: l }));
  assert.ok(f.includes('over-broad-deny'), JSON.stringify(f));
});

test('a probe its own rule does not match fails (catches a typo in the rule)', () => {
  const l = structuredClone(ledger);
  l.entries.find((e) => e.rule === 'Bash(vercel promote*)').probe = 'vercel promot dpl_1';
  assert.deepEqual(kinds(checkContract({ settings, ledger: l })), ['probe-mismatch']);
});

test('a file-tool deny rule protecting a path that does not exist fails', () => {
  // One finding, not two: the paired `Write(<path>)` rule is gone — Claude Code never checked it.
  const f = checkContract({ settings, ledger, exists: (rel) => rel !== 'Roadmap/00-ideas/BUILD-ORDER.md' });
  assert.deepEqual(kinds(f), ['probe-mismatch']);
});

test('staging or committing the whole tree by any common spelling is refused', () => {
  const deny = settings.permissions.deny.filter((r) => r.startsWith('Bash('));
  for (const probe of [
    'git add -A',
    'git add -Av',
    'git add .',
    'git add :/',
    'git add -u',
    'git add --update',
    'git commit -a -m x',
    'git commit -am x',
    'git commit -qam x',
    'git commit -av',
    'git commit --all -m x',
    'git commit -m x -a',
    'git add -- .',
    'git add -- ./',
    'git add -- :/',
    'git add ./',
    'git add -v .',
  ]) {
    assert.ok(
      deny.some((r) => bashRuleMatches(r.slice(5, -1), probe)),
      `not refused: ${probe}`
    );
  }
});

test('force pushes, recursive deletes and CLI deploys are refused in the spellings agents actually write', () => {
  const deny = settings.permissions.deny.filter((r) => r.startsWith('Bash('));
  for (const probe of [
    'git push -fu origin x',
    'git push origin x -f',
    'git push --mirror origin',
    'git -C ../r push -f origin x',
    'git -C ../r push origin +main',
    'rm -fR build',
    'rm -rfv build',
    'rm -vrf build',
    'rm -R -f build',
    'rm -r --force build',
    'rm --recursive --force build',
    'vercel --yes',
    'vercel .',
    'npx vercel --prod',
    'npx supabase db reset',
    'supabase --debug db reset',
  ]) {
    assert.ok(
      deny.some((r) => bashRuleMatches(r.slice(5, -1), probe)),
      `not refused: ${probe}`
    );
  }
});

test('a lease push to your own branch ASKS rather than being denied (a deny cannot be approved once)', () => {
  const probe = 'git push --force-with-lease origin feat/x-s2';
  assert.ok(settings.permissions.ask.some((r) => bashRuleMatches(r.slice(5, -1), probe)));
  assert.ok(
    !settings.permissions.deny.some((r) => r.startsWith('Bash(') && bashRuleMatches(r.slice(5, -1), probe))
  );
});

test('the allow list never pre-approves a command that destroys uncommitted work (allowed commands skip the classifier)', () => {
  const allow = settings.permissions.allow.filter((r) => r.startsWith('Bash('));
  for (const bad of [
    'git checkout -- .',
    'git checkout -f main',
    'git restore .',
    'git stash clear',
    'git stash drop',
    'git branch -D feat/x',
    'git worktree remove --force x',
    'git reset --hard',
    'git clean -fd',
    "sed -n -i 's/a/b/' f",
    'sort -o f f',
  ]) {
    assert.ok(!allow.some((r) => bashRuleMatches(r.slice(5, -1), bad)), `allow list pre-approves: ${bad}`);
  }
});

test('a literal past command in allow fails; verb classes pass', () => {
  assert.equal(looksLiteral(`Bash(sed -n '1,60p' app/page.tsx)`), true);
  assert.equal(looksLiteral('Bash(echo "tsc exit=$?")'), true);
  assert.equal(looksLiteral('Read(//Users/someone/**)'), true);
  assert.equal(looksLiteral('Bash(rm -rf .git)'), true, 'an exact command with no wildcard is a one-off');
  assert.equal(looksLiteral('Bash(npm ci)'), false);
  assert.equal(looksLiteral('Bash(codex --version)'), false);
  assert.equal(looksLiteral('Bash(npm run *)'), false);
  assert.equal(looksLiteral('Bash(node scripts/*)'), false);
  const s = structuredClone(settings);
  s.permissions.allow.push(`Bash(sed -n '1,60p' x.ts)`);
  assert.deepEqual(kinds(checkContract({ settings: s, ledger })), ['literal-allow']);
});

test('a one-off approval in the untracked local file is swept too — that is where accretion happens', () => {
  const local = {
    path: '.claude/settings.local.json',
    json: {
      permissions: {
        allow: ['Bash(vercel --prod --yes)', "Bash(sed -n '1,60p' app/page.tsx)", 'Bash(npm run *)'],
      },
    },
  };
  const f = checkContract({ settings, ledger, projectFiles: [local] });
  assert.deepEqual(
    f.map((x) => x.kind),
    ['literal-local-allow', 'literal-local-allow']
  );
  assert.match(f[0].detail, /settings\.local\.json/);
});

test('auto or bypass mode in a PROJECT settings file fails (it is ignored and masks the user default)', () => {
  for (const mode of ['auto', 'bypassPermissions']) {
    const f = checkContract({
      settings,
      ledger,
      projectFiles: [{ path: '.claude/settings.json', json: { permissions: { defaultMode: mode } } }],
    });
    assert.deepEqual(kinds(f), ['project-mode']);
  }
  assert.deepEqual(
    checkContract({
      settings,
      ledger,
      projectFiles: [{ path: '.claude/settings.json', json: { permissions: { defaultMode: 'plan' } } }],
    }),
    []
  );
});

test('user mode has three states — unreadable is unavailable, never "fine"', () => {
  assert.equal(describeUserMode(() => ({ permissions: { defaultMode: 'auto' } })).state, 'auto');
  assert.equal(describeUserMode(() => ({})).state, 'other');
  assert.equal(
    describeUserMode(() => {
      throw new Error('ENOENT');
    }).state,
    'unavailable'
  );
});

test('live scoring: refused only when denied AND the shim never ran; control must run', () => {
  const probes = ['vercel deploy --prod', 'rm -rf smoke-victim', 'supabase db push'];
  const refused = refusedCommands({
    permission_denials: [
      { tool_input: { command: 'vercel deploy --prod' } },
      { tool_input: { command: 'rm -rf smoke-victim' } },
    ],
  });
  const s = scoreLive({ probes, refused, shimLog: ['probe-ok control', 'supabase db push'] });
  assert.equal(s.ok, false);
  assert.deepEqual(
    s.results.map((r) => r.verdict),
    ['refused', 'refused', 'RAN']
  );
  const silent = scoreLive({
    probes: ['vercel deploy --prod'],
    refused: new Set(['vercel deploy --prod']),
    shimLog: [],
  });
  assert.equal(silent.ok, false, 'a session that ran nothing proves nothing');
  const good = scoreLive({
    probes: ['vercel deploy --prod'],
    refused: new Set(['vercel deploy --prod']),
    shimLog: ['probe-ok control'],
  });
  assert.equal(good.ok, true);
});

test('live scoring sees an assignment-prefixed probe run — the shim never logs the assignment', () => {
  const probe = 'PATH=/x:$PATH vercel deploy --prod';
  const s = scoreLive({
    probes: [probe],
    refused: new Set(),
    shimLog: ['probe-ok control', 'vercel deploy --prod'],
    expect: 'ran',
  });
  assert.equal(s.ok, true);
  const leaked = scoreLive({
    probes: [probe],
    refused: new Set(),
    shimLog: ['probe-ok control', 'vercel deploy --prod'],
  });
  assert.equal(
    leaked.results[0].verdict,
    'RAN',
    'an escaped deny rule must read as RAN, not as not-attempted'
  );
});

test('live baseline: without rules every probe must RUN — a refusal there means something else is refusing', () => {
  const probes = ['vercel deploy --prod', 'supabase db push'];
  const polluted = scoreLive({
    probes,
    refused: new Set(['vercel deploy --prod']),
    shimLog: ['probe-ok control', 'supabase db push'],
    expect: 'ran',
  });
  assert.equal(polluted.ok, false);
  const clean = scoreLive({
    probes,
    refused: new Set(),
    shimLog: ['probe-ok control', ...probes],
    expect: 'ran',
  });
  assert.equal(clean.ok, true);
});

test('live shadow check: a program resolving outside the shim dir blocks every probe', () => {
  const bin = '/tmp/x/bin';
  const ok = shadowCheck({
    shimLog: ['resolve vercel /tmp/x/bin/vercel', 'resolve git /tmp/x/bin/git'],
    programs: ['vercel', 'git'],
    binDir: bin,
  });
  assert.equal(ok.ok, true);
  const bad = shadowCheck({
    shimLog: ['resolve vercel /opt/homebrew/bin/vercel', 'resolve git /tmp/x/bin/git'],
    programs: ['vercel', 'git', 'gcloud'],
    binDir: bin,
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(
    bad.unsafe.map((u) => u.prog),
    ['vercel', 'gcloud']
  );
});

test('a Write(path) rule is reported as inert — only Edit(path) is checked for file tools', () => {
  // Observed live: a nested `claude -p` REFUSES TO START while a Write rule is present, and outside that
  // path the rule silently protects nothing.
  const s2 = structuredClone(settings);
  const l2 = structuredClone(ledger);
  s2.permissions.deny.push('Write(/Roadmap/00-ideas/BUILD-ORDER.md)');
  l2.entries.push({
    list: 'deny',
    rule: 'Write(/Roadmap/00-ideas/BUILD-ORDER.md)',
    cites: 'generated file',
    probe: 'n/a',
  });
  const f = kinds(checkContract({ settings: s2, ledger: l2, exists: () => true }));
  assert.ok(f.includes('inert-write-rule'), JSON.stringify(f));
  assert.deepEqual(kinds(checkContract({ settings, ledger, exists: () => true })), []);
});

test('an ask that only exists in the bare spelling is a finding — an escaped ask is not a stricter outcome', () => {
  // The prefix escape applies to `ask` exactly as to `deny`: `PATH=/x:$PATH gcloud run deploy …` would run
  // on the classifier's judgement instead of stopping for a human (found by the security lens on #17).
  for (const c of ASK_COMMANDS) {
    assert.ok(REQUIRED_ASKS.includes(`PATH=/x:$PATH ${c}`));
    assert.ok(REQUIRED_ASKS.includes(`env PATH=/x:$PATH ${c}`));
  }
  const s2 = structuredClone(settings);
  const l2 = structuredClone(ledger);
  const gone = s2.permissions.ask.filter((r) => r.includes('gcloud run deploy') && r.startsWith('Bash(*=*'));
  assert.equal(gone.length, 1);
  s2.permissions.ask = s2.permissions.ask.filter((r) => !gone.includes(r));
  l2.entries = l2.entries.filter((e) => !gone.includes(e.rule));
  const f = kinds(checkContract({ settings: s2, ledger: l2 }));
  assert.ok(f.includes('missing-ask'), JSON.stringify(f));
});

test('a deny rule may not swallow a command that is meant to ASK', () => {
  const s2 = structuredClone(settings);
  const l2 = structuredClone(ledger);
  s2.permissions.deny.push('Bash(gcloud run deploy *)');
  l2.entries.push({
    list: 'deny',
    rule: 'Bash(gcloud run deploy *)',
    probe: 'gcloud run deploy svc --image x',
    cites: 'over-broad on purpose, for this test',
  });
  const f = kinds(checkContract({ settings: s2, ledger: l2 }));
  assert.ok(f.includes('ask-swallowed-by-deny'), JSON.stringify(f));
});

test('the narrow prefixed rules leave ordinary reads alone', () => {
  // A `*=* vercel*` catch-all refused `grep -rn --include=*.json vercel .` — `*=*` matches an `=` anywhere.
  const deny = settings.permissions.deny.filter((r) => r.startsWith('Bash('));
  for (const safe of [
    'grep -rn --include=*.json vercel .claude/',
    'rg --glob=!node_modules vercel .',
    'env | grep vercel',
    'rm -f build/one-file.txt',
    'git push origin HEAD:main',
  ]) {
    const hit = deny.find((r) => bashRuleMatches(r.slice(5, -1), safe));
    assert.equal(hit, undefined, `${safe} refused by ${hit}`);
  }
});
