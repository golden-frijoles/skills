// emit-kickoff.test.mjs — pure-logic coverage for the Stage-8 kickoff generator. No filesystem
// walking of a real Roadmap tree: small fixture strings stand in for README.md / sprint-N.md.
// (The script guards main() with an isMain check — importing it here must be side-effect-free.)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  sub,
  parseFrontmatter,
  stripFrontmatter,
  parseEpicTitle,
  parseSprintHeader,
  parseStoryHeadings,
  buildStoryList,
  buildKickoff,
} from './emit-kickoff.mjs';

test('parseArgs: flags with values and boolean flags', () => {
  const a = parseArgs(['--epic', 'ssrf-dns-pinning', '--sprint', '1', '--dry-run']);
  assert.equal(a.epic, 'ssrf-dns-pinning');
  assert.equal(a.sprint, '1');
  assert.equal(a['dry-run'], true);
});

test('sub: replaces known placeholders, leaves unknown ones untouched', () => {
  const out = sub('Hello {{NAME}}, {{MISSING}}!', { NAME: 'World' });
  assert.equal(out, 'Hello World, {{MISSING}}!');
});

test('parseFrontmatter: simple key: value block between --- fences', () => {
  const text = '---\nstatus: scaffolded\nslug: my-epic\n---\n\n# Epic: My Epic\n';
  const fm = parseFrontmatter(text);
  assert.equal(fm.status, 'scaffolded');
  assert.equal(fm.slug, 'my-epic');
});

test('parseFrontmatter: no leading fence returns empty object', () => {
  assert.deepEqual(parseFrontmatter('# Epic: My Epic\n'), {});
});

test('parseFrontmatter: strips a YAML inline comment from a value (would otherwise false-mismatch the slug check)', () => {
  const text =
    '---\nstatus: in-progress   # AUTHORITATIVE epic status (SSOT)\nslug: my-epic   # note\n---\n\n# Epic: My Epic\n';
  const fm = parseFrontmatter(text);
  assert.equal(fm.status, 'in-progress');
  assert.equal(fm.slug, 'my-epic');
});

test('parseEpicTitle: strips the "Epic: " prefix from the H1', () => {
  const text = '---\nstatus: scaffolded\nslug: x\n---\n\n# Epic: Process token-diet\n\n## Why\n';
  assert.equal(parseEpicTitle(text), 'Process token-diet');
});

test('parseEpicTitle: returns null when no H1 present', () => {
  assert.equal(parseEpicTitle('no heading here\n'), null);
});

test('stripFrontmatter: removes the fenced block, leaves the body untouched', () => {
  const text = '---\nstatus: x\n---\n\n# Real Title\n\nbody\n';
  assert.equal(stripFrontmatter(text), '\n# Real Title\n\nbody\n');
});

test('stripFrontmatter: no leading fence returns the text unchanged', () => {
  assert.equal(stripFrontmatter('# Real Title\n'), '# Real Title\n');
});

// Cross-agent review (Antigravity, PR #4) blocking finding: a `# `-led YAML comment INSIDE the
// frontmatter block (real-world example: ssrf-dns-pinning's README has
// `status: in-progress   # AUTHORITATIVE epic status (SSOT) — …`) used to win the H1 regex before
// the real title, silently poisoning EPIC_TITLE. parseEpicTitle must search only the body after
// the frontmatter fence.
test('parseEpicTitle: a "# " comment INSIDE frontmatter is not mistaken for the H1', () => {
  const text = [
    '---',
    'status: in-progress   # AUTHORITATIVE epic status (SSOT) — comment with a bare # word',
    'slug: ssrf-dns-pinning',
    '# a bare full-line comment, also inside frontmatter',
    '---',
    '',
    '# Epic: SSRF hardening — DNS-pin the resolved IP instead of resolve-then-fetch',
    '',
    '## Why',
  ].join('\n');
  assert.equal(parseEpicTitle(text), 'SSRF hardening — DNS-pin the resolved IP instead of resolve-then-fetch');
});

test('parseSprintHeader: parses epic title, sprint number, and sprint title', () => {
  const text = '# Process token-diet — Sprint 1: Script the boilerplate, flip the review policy\n\n**Status:** not started\n';
  const h = parseSprintHeader(text);
  assert.deepEqual(h, {
    epicTitle: 'Process token-diet',
    sprintNum: '1',
    sprintTitle: 'Script the boilerplate, flip the review policy',
  });
});

test('parseSprintHeader: epic title itself containing an em-dash still parses (non-greedy match)', () => {
  const text = '# Homepage Polish — Dirección B — Sprint 1: Icon language migration\n';
  const h = parseSprintHeader(text);
  assert.equal(h.epicTitle, 'Homepage Polish — Dirección B');
  assert.equal(h.sprintNum, '1');
  assert.equal(h.sprintTitle, 'Icon language migration');
});

test('parseSprintHeader: returns null when the H1 does not match the expected shape', () => {
  assert.equal(parseSprintHeader('# Just a title\n'), null);
});

// Cross-agent review should-fix: the separator regex used to mandate an em-dash and CRASHED
// ("couldn't parse the H1") on a plain hyphen or en-dash. Loosened to accept all three.
test('parseSprintHeader: accepts a plain hyphen separator, not just an em-dash', () => {
  const h = parseSprintHeader('# Process token-diet - Sprint 1: Script the boilerplate\n');
  assert.deepEqual(h, { epicTitle: 'Process token-diet', sprintNum: '1', sprintTitle: 'Script the boilerplate' });
});

test('parseSprintHeader: accepts an en-dash separator too', () => {
  const h = parseSprintHeader('# Process token-diet – Sprint 1: Script the boilerplate\n');
  assert.deepEqual(h, { epicTitle: 'Process token-diet', sprintNum: '1', sprintTitle: 'Script the boilerplate' });
});

test('parseSprintHeader: skips a frontmatter fence before finding the H1', () => {
  const text = '---\nstatus: x   # a comment\n---\n\n# Process token-diet — Sprint 1: Title\n';
  const h = parseSprintHeader(text);
  assert.equal(h.epicTitle, 'Process token-diet');
});

test('parseStoryHeadings: collects every "### Story N.M — <title>" heading in order', () => {
  const text = [
    '## Stories',
    '',
    '### Story 1.1 — Kickoff-prompt generator',
    'body text here',
    '',
    '### Story 1.2 — Smoke-walkthrough skeleton in the scaffolder',
    'more body',
  ].join('\n');
  const headings = parseStoryHeadings(text);
  assert.deepEqual(headings, [
    'Story 1.1 — Kickoff-prompt generator',
    'Story 1.2 — Smoke-walkthrough skeleton in the scaffolder',
  ]);
});

test('parseStoryHeadings: empty array when none found', () => {
  assert.deepEqual(parseStoryHeadings('## Stories\nnone here\n'), []);
});

// Cross-agent review blocking finding: the em-dash-only regex silently DROPPED every story
// heading typed with a plain hyphen — no error, just a complete-looking kickoff with zero
// stories (the worst failure shape: silent + plausible). Loosened to accept hyphen/en-dash/em-dash.
test('parseStoryHeadings: a plain-hyphen heading is not silently dropped', () => {
  const text = '### Story 1.1 - Kickoff-prompt generator\nbody\n### Story 1.2 - Smoke skeleton\n';
  assert.deepEqual(parseStoryHeadings(text), [
    'Story 1.1 - Kickoff-prompt generator',
    'Story 1.2 - Smoke skeleton',
  ]);
});

test('parseStoryHeadings: an en-dash heading is also accepted', () => {
  const text = '### Story 1.1 – Kickoff-prompt generator\n';
  assert.deepEqual(parseStoryHeadings(text), ['Story 1.1 – Kickoff-prompt generator']);
});

test('parseStoryHeadings: mixed dash styles in the same doc all parse', () => {
  const text = [
    '### Story 1.1 — Em-dash story',
    '### Story 1.2 - Hyphen story',
    '### Story 1.3 – En-dash story',
  ].join('\n');
  assert.deepEqual(parseStoryHeadings(text), [
    'Story 1.1 — Em-dash story',
    'Story 1.2 - Hyphen story',
    'Story 1.3 – En-dash story',
  ]);
});

test('buildStoryList: renders a bullet per heading', () => {
  const out = buildStoryList(['Story 1.1 — A', 'Story 1.2 — B']);
  assert.equal(out, '- Story 1.1 — A\n- Story 1.2 — B');
});

test('buildStoryList: says so plainly when there are no headings', () => {
  const out = buildStoryList([]);
  assert.match(out, /no `### Story N\.M/);
});

test('buildKickoff: substitutes macro/slug/sprint/epic-title/sprint-title/story-list into the template', () => {
  const templateText = 'Roadmap/{{MACRO}}/{{SLUG}}/sprint-{{N}}.md — "{{EPIC_TITLE}}" — "{{SPRINT_TITLE}}"\n{{STORY_LIST}}';
  const out = buildKickoff({
    macro: '09-platform-infra',
    slug: 'process-token-diet',
    sprintNum: '1',
    epicTitle: 'Process token-diet',
    sprintTitle: 'Script the boilerplate, flip the review policy',
    storyList: '- Story 1.1 — A',
    templateText,
  });
  assert.equal(
    out,
    'Roadmap/09-platform-infra/process-token-diet/sprint-1.md — "Process token-diet" — "Script the boilerplate, flip the review policy"\n- Story 1.1 — A'
  );
});

test('S1.4 — the per-sprint kickoff STARTS with pushing feat/<slug>-s<N> (board-sinks-and-scrumban)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const out = buildKickoff({
    macro: '09-platform-infra',
    slug: 'demo',
    sprintNum: 3,
    epicTitle: 'Demo',
    sprintTitle: 'Three',
    storyList: '- Story 3.1 — A',
    templateText: readFileSync(join(here, 'templates', 'kickoff.md'), 'utf8'),
  });
  const [first, second] = out.split('\n');
  assert.match(first, /^Start by pushing this sprint's branch, before anything else/);
  assert.equal(second, '`git switch -c feat/demo-s3 origin/feat/demo-s2 && git push -u origin feat/demo-s3` (stacked on the previous sprint; branch from');
});

test('S1.4 — sprint 1 is the epic branch off main, sprint 2 stacks on it (WAYS-OF-WORKING: feat/<slug> → -s2)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const templateText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'templates', 'kickoff.md'), 'utf8');
  const second = (n) =>
    buildKickoff({ macro: 'm', slug: 'demo', sprintNum: n, epicTitle: 'D', sprintTitle: 'T', storyList: '', templateText }).split('\n')[1];
  assert.match(second(1), /^`git switch -c feat\/demo origin\/main && git push -u origin feat\/demo`/);
  assert.match(second(2), /^`git switch -c feat\/demo-s2 origin\/feat\/demo && git push -u origin feat\/demo-s2`/);
});
