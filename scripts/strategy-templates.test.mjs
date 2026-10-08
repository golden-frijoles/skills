// strategy-templates.test.mjs — the three strategy coaches' output contracts (think-skills D3, D4).
//
// Each coach writes `Roadmap/00-strategy/<name>.md` from its own `templates/<name>.md`, and that template IS the
// contract: `groom` reads the headings (think-skills D5) and `frijoles north-star set` reads the sync block (D6). So these
// tests pin the template, and the SKILL.md that points at it, rather than a copy of the contract anywhere else. The
// payload's SHAPE is checked against the engine's real schema on the app side (apps/web/lib/north-star-template.test.ts),
// because this mirror cannot import the app.
//
// Zero deps — node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'golden-frijoles', 'skills');
const read = (...parts) => readFileSync(join(SKILLS, ...parts), 'utf8');

/** The six PMF dimensions, as `pmf-narrative` names them. Risk Validation's rows must use the same words. */
const DIMENSIONS = [
  'Problem to solve',
  'Target audience',
  'Value proposition',
  'Competitive advantage',
  'Growth strategy',
  'Business model',
];

const CONTRACTS = {
  'pmf-narrative': ['Initial insight', ...DIMENSIONS],
  'north-star': [
    'The game',
    'North Star statement',
    'North Star metric',
    'Input metrics',
    'Lagging indicators',
    'Sync payload',
  ],
  'risk-validation': [
    'Broad validation',
    'Conviction map',
    'Highest domino',
    'Targeted technique',
    'Execution rationale',
  ],
};

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'the template opens with a frontmatter block');
  return Object.fromEntries(
    match[1].split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
  );
}

const h2 = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

for (const [name, headings] of Object.entries(CONTRACTS)) {
  test(`${name}: the template carries the frontmatter contract`, () => {
    const fm = frontmatter(read(name, 'templates', `${name}.md`));
    assert.equal(fm.kind, name);
    assert.equal(fm.status, 'draft');
    assert.equal(fm.updated, 'YYYY-MM-DD');
  });

  test(`${name}: the template's headings are the contract, in order`, () => {
    assert.deepEqual(h2(read(name, 'templates', `${name}.md`)), headings);
  });

  test(`${name}: the skill writes its file from its template, and asks before overwriting an agreed one`, () => {
    const skill = read(name, 'SKILL.md');
    assert.match(skill, new RegExp(`^name: ${name}$`, 'm'));
    assert.ok(skill.includes(`\`templates/${name}.md\``), 'names its template');
    assert.ok(skill.includes(`\`Roadmap/00-strategy/${name}.md\``), 'names the file it writes');
    assert.ok(skill.includes('`status: draft`'), 'writes a draft');
    assert.match(skill, /`status: agreed`[^\n]*ask before overwriting/, 'asks before overwriting an agreed file');
  });
}

test('north-star: exactly one json fence, and it sits under ## Sync payload', () => {
  const text = read('north-star', 'templates', 'north-star.md');
  const fences = [...text.matchAll(/^```json$/gm)];
  assert.equal(fences.length, 1);
  assert.ok(fences[0].index > text.indexOf('\n## Sync payload\n'));
  const body = text.slice(fences[0].index).match(/^```json\n([\s\S]*?)\n```$/m)[1];
  const payload = JSON.parse(body);
  assert.ok(payload.metric && Array.isArray(payload.inputs) && payload.inputs.length > 0);
});

test('risk-validation: every dimension row uses the narrative\'s own heading names', () => {
  const text = read('risk-validation', 'templates', 'risk-validation.md');
  for (const table of ['## Broad validation', '## Conviction map']) {
    const section = text.slice(text.indexOf(table)).split('\n## ')[0];
    const rows = [...section.matchAll(/^\| ([^|]+?) \|/gm)].map((m) => m[1]).slice(1); // drop the header row
    assert.deepEqual(rows.filter((row) => !row.startsWith('---')), DIMENSIONS, table);
  }
});

// The chain (D4): each coach offers the next; nothing auto-invokes.
test('the chain: pmf-narrative offers north-star, north-star offers risk-validation, risk-validation offers groom', () => {
  assert.match(read('pmf-narrative', 'SKILL.md'), /offering the North Star workshop \(the `north-star` skill\)/);
  assert.match(read('north-star', 'SKILL.md'), /offering risk validation \(the `risk-validation` skill\)/);
  assert.match(read('risk-validation', 'SKILL.md'), /\(the `groom` skill\)/);
});

test('risk-validation reads the narrative before asking for it', () => {
  const skill = read('risk-validation', 'SKILL.md');
  const step1 = skill.slice(skill.indexOf('### Step 1'), skill.indexOf('### Step 2'));
  assert.ok(step1.includes('`Roadmap/00-strategy/pmf-narrative.md`'));
  for (const dimension of DIMENSIONS) assert.ok(step1.includes(dimension), dimension);
});

// The mis-trigger this epic was groomed to fix: the account copy's description was Risk Validation's, word for word.
test('north-star describes a North Star workshop, not risk validation', () => {
  const description = (name) => read(name, 'SKILL.md').match(/^description: >\n((?: {2}.+\n)+)/m)[1];
  const northStar = description('north-star');
  assert.match(northStar, /North Star/);
  assert.match(northStar, /input metrics/);
  assert.doesNotMatch(northStar, /riskiest|validation technique/);
  assert.notEqual(northStar, description('risk-validation'));
});

// D4: an offer is a sentence. Nothing auto-invokes the next coach (S1 review nit: deleting this rule left every test green).
test('every coach offers the next without starting it', () => {
  for (const name of Object.keys(CONTRACTS)) {
    assert.match(read(name, 'SKILL.md'), /Offer it; don't start it unasked\./, name);
  }
});

// Grooming D7 + the D1 amendment: each public skill credits its sources by name and URL, never a local path.
test('every coach credits its sources by name and URL', () => {
  for (const name of Object.keys(CONTRACTS)) {
    const line = read(name, 'SKILL.md').match(/^> \*\*Sources\.\*\* (.+)$/m);
    assert.ok(line, `${name} has a Sources line under its title`);
    assert.match(line[1], /https:\/\/\S+/, name);
    assert.doesNotMatch(line[1], /references\//, name);
  }
});

// think-skills S3 (D10): the North Star coach names the one command that sends its file, pinned to the CLI version
// that has it, and leaves running it to the user (the skill never writes to an engine itself).
test('north-star names `frijoles north-star set`, pinned, as the user\'s step', () => {
  const skill = read('north-star', 'SKILL.md');
  // The version is derived from packages/cli by the monorepo's render-plugin-release.mjs (coaches-v2 D12), which this
  // mirror cannot see; here only the command's shape is pinned.
  assert.match(skill, /`npx -y @golden-frijoles\/cli@\d+\.\d+\.\d+ north-star set Roadmap\/00-strategy\/north-star\.md`/);
  assert.match(skill, /Do not run the command yourself\./);
});

// coaches-v2 D1: groom's strategy reader ships inside the plugin and cannot import from the kit, so it keeps its own
// copy of the folder and the three file names. They must agree with the kit's, or a rename lands in only one.
test('groom/strategy.mjs and the kit\'s lib/strategy-files.mjs agree on the folder and the three files', async () => {
  const groom = await import('../plugins/golden-frijoles/skills/groom/strategy.mjs');
  const kit = await import('../template/scripts/lib/strategy-files.mjs');
  assert.equal(groom.STRATEGY_DIR, kit.STRATEGY_DIR);
  assert.deepEqual(groom.KINDS, kit.KINDS);
});

// coaches-v2 S2 (D5–D9): one shared reference every coach reads, and the few exact strings the scripts depend on.
const COACH_STEPS = { 'pmf-narrative': 8, 'north-star': 7, 'risk-validation': 6 };

for (const [name, steps] of Object.entries(COACH_STEPS)) {
  test(`${name}: reads the shared coaching reference, and its X is its real step count (${steps})`, () => {
    const skill = read(name, 'SKILL.md');
    assert.ok(skill.includes("groom's `references/coaching.md`"), 'points at the shared reference');
    assert.equal((skill.match(/^### Step \d+/gm) ?? []).length, steps, 'counted ### Step headings');
    assert.ok(skill.includes(`\`Step N of ${steps} · <step name>\``), 'states X once');
    assert.ok(skill.includes(`this coach has\n> ${steps} steps`) || skill.includes(`this coach has ${steps} steps`));
    assert.match(skill, /requires_scripts:\n(?: {2}- .+\n)*? {2}- strategy-private\.mjs\n/, 'declares the private-folder script');
  });
}

test('the shared reference carries the exact marker, labels and commands the scripts and the gate read', async () => {
  const { PROPOSED_LINE } = await import('../template/scripts/lib/strategy-files.mjs');
  const coaching = read('groom', 'references', 'coaching.md');
  for (const s of [
    PROPOSED_LINE,
    '`(true today)`',
    '`(aspirational)`',
    '`(hypothesis)`',
    '`> Parked (step N): <their words>`',
    '`node scripts/strategy-private.mjs ensure`',
    '`cold-read`',
  ])
    assert.ok(coaching.includes(s), s);
  for (const [name, steps] of Object.entries(COACH_STEPS)) assert.ok(coaching.includes(`\`${name}\` ${steps}`), `${name} ${steps}`);
  assert.ok(read('groom', 'references', 'gates.md').includes(PROPOSED_LINE), 'the Strategy gate asks about proposed sections');
});

// coaches-v2 S3: the per-coach fixes, the one-pagers, and the voice.
test('pmf-narrative: distil and test, one person before the problem, ladder up, and the persona block', () => {
  const skill = read('pmf-narrative', 'SKILL.md');
  for (const s of ['**Distil and test**', '**One person first:**', '**Ladder up every example**', '`### Persona` block'])
    assert.ok(skill.includes(s), s);
  assert.ok(skill.indexOf('**One person first:**') < skill.indexOf('**Question:** Ask: "What is the ultimate **outcome**'), 'the person is picked before the problem is asked');
});

test('north-star: the scenario table comes before the pick; risk-validation reads the North Star and carries risks forward', () => {
  const ns = read('north-star', 'SKILL.md');
  const table = ns.indexOf('**Run the candidates against customer scenarios, before anyone picks.**');
  assert.ok(table > ns.indexOf('### Step 4') && table < ns.indexOf('### Step 5'), 'inside Step 4');
  const risk = read('risk-validation', 'SKILL.md');
  assert.ok(risk.includes('**Read the narrative and the North Star first:**') && risk.includes('`north-star.md`'));
  assert.ok(risk.includes('**Carry the earlier risks forward:**'));
});

test('every coach renders the one-pagers at its last write, and so does the Strategy gate\'s Approve', () => {
  for (const name of ['pmf-narrative', 'north-star', 'risk-validation']) {
    const skill = read(name, 'SKILL.md');
    assert.ok(skill.includes('`node scripts/one-pagers.mjs`'), name);
    assert.match(skill, /requires_scripts:\n(?: {2}- .+\n)*? {2}- one-pagers\.mjs\n/, `${name} declares it`);
  }
  assert.ok(read('groom', 'references', 'gates.md').includes('`node scripts/one-pagers.mjs`'));
});

test('voice: no outside method or brand in coach text, except the one Sources line that credits it (D11)', () => {
  const BRANDS = /Reforge|Amplitude|Strategyzer|Deliberate Startup|Deliberate Risk|7 Powers|Helmer|Finding PMF Loop|North Star Framework facilitator/;
  const files = [
    ...['pmf-narrative', 'north-star', 'risk-validation'].flatMap((n) => [[n, 'SKILL.md'], [n, 'templates', `${n}.md`]]),
    ['groom', 'references', 'coaching.md'],
    ['cold-read', 'SKILL.md'],
  ];
  for (const parts of files) {
    const offending = read(...parts)
      .split('\n')
      .filter((line) => BRANDS.test(line) && !line.startsWith('> **Sources.**'));
    assert.deepEqual(offending, [], parts.join('/'));
  }
});
