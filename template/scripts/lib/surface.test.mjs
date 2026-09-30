import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSurface, parseSurfaces, SURFACE_KINDS, SurfaceError, validateMap } from './surface.mjs';

const SHIP_FEATURES = [
  'state: ship-features',
  'route: /app/flags/[projectSlug]',
  '- head "Features" action "+ New feature"',
  '- answer "Which features are live, and which are dark?"',
  '- summary count 4',
  '- toolbar',
  '- list columns "feature | state in production | type & risk | on / off"',
  '- note "Showing 2 rows"',
].join('\n');

/** Assert a parse fails with this line number and a reason matching `pattern`. */
function refuses(text, line, pattern) {
  assert.throws(
    () => parseSurface(text, 'x.surface'),
    (error) => {
      assert.ok(error instanceof SurfaceError, `expected a SurfaceError, got ${error}`);
      assert.equal(error.line, line, `line: ${error.message}`);
      assert.match(error.message, new RegExp(`^x\\.surface:${line}: `));
      assert.match(error.reason, pattern);
      return true;
    }
  );
}

const withBlock = (block) => `state: s\nroute: /r\n${block}`;

test('parses the acceptance shape: state, route and ordered blocks with words and facts', () => {
  const surface = parseSurface(SHIP_FEATURES, 'x.surface');
  assert.equal(surface.state, 'ship-features');
  assert.equal(surface.route, '/app/flags/[projectSlug]');
  assert.deepEqual(
    surface.blocks.map(({ line: _line, ...block }) => block),
    [
      { kind: 'head', words: 'Features', action: '+ New feature' },
      { kind: 'answer', words: 'Which features are live, and which are dark?' },
      { kind: 'summary', words: null, count: 4 },
      { kind: 'toolbar', words: null },
      { kind: 'list', words: null, columns: ['feature', 'state in production', 'type & risk', 'on / off'] },
      { kind: 'note', words: 'Showing 2 rows' },
    ]
  );
  assert.deepEqual(
    surface.blocks.map((block) => block.line),
    [3, 4, 5, 6, 7, 8]
  );
});

test('a trailing bar is an unlabelled column, kept as ""', () => {
  const [list] = parseSurface(withBlock('- list columns "key | what it may do | where · expires |"')).blocks;
  assert.deepEqual(list.columns, ['key', 'what it may do', 'where · expires', '']);
});

test('facts come in any order, header lines in either order, comments and blank lines are skipped', () => {
  const surface = parseSurface(
    '# a sketch\n\nroute: /r\nstate: s\n\n- head action "Go" \n# between\n- tiles count 0'
  );
  assert.equal(surface.state, 's');
  assert.equal(surface.blocks[0].action, 'Go');
  assert.equal(surface.blocks[0].words, null);
  assert.equal(surface.blocks[1].count, 0);
});

test('escapes: \\" and \\\\ only', () => {
  const [head] = parseSurface(withBlock('- head "Say \\"hi\\" \\\\ bye"')).blocks;
  assert.equal(head.words, 'Say "hi" \\ bye');
  refuses(withBlock('- head "a \\n b"'), 3, /unknown escape/);
});

test('an unknown kind names the nearest kind and lists all twelve', () => {
  refuses(withBlock('- lsit columns "a | b"'), 3, /unknown kind `lsit` — did you mean `list`\?/);
  refuses(
    withBlock('- lsit columns "a | b"'),
    3,
    new RegExp(`Known kinds: ${Object.keys(SURFACE_KINDS).join(', ')}\\.`)
  );
  // Far from everything: no guess, still the list.
  refuses(withBlock('- carousel'), 3, /^unknown kind `carousel` Known kinds: head,/);
});

test('names Object.prototype carries are not kinds (#210 review)', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    refuses(withBlock(`- ${name}`), 3, /^unknown kind/);
    refuses(withBlock(`- ${name} count 3`), 3, /^unknown kind/);
  }
  assert.equal(validateMap({ kinds: { toString: 'list' } }).length, 1);
});

test('the vocabulary is the twelve kinds D10 names, with their facts', () => {
  assert.deepEqual(SURFACE_KINDS, {
    head: ['action'],
    answer: [],
    summary: ['count'],
    tiles: ['count'],
    toolbar: [],
    list: ['columns'],
    empty: [],
    card: [],
    steps: ['count'],
    field: [],
    tabs: [],
    note: [],
  });
});

test('fact refusals: wrong kind, repeated, unknown, missing value, wrong type', () => {
  refuses(withBlock('- answer "x" count 3'), 3, /`answer` carries no `count` \(it carries no facts\)/);
  refuses(withBlock('- head count 3'), 3, /`head` carries no `count` \(it carries: action\)/);
  refuses(withBlock('- tiles count 3 count 4'), 3, /`count` given twice/);
  refuses(withBlock('- tiles size 3'), 3, /unknown fact `size`/);
  refuses(withBlock('- tiles count'), 3, /`count` needs a value/);
  refuses(withBlock('- tiles count -1'), 3, /whole number, got `-1`/);
  refuses(withBlock('- tiles count "4"'), 3, /whole number/);
  refuses(withBlock('- tiles count 007'), 3, /whole number, got `007`/);
  refuses(withBlock('- tiles count 99999999999999999999'), 3, /whole number/);
  refuses(withBlock('- head action Go'), 3, /takes a quoted string, got `Go`/);
  refuses(withBlock('- head "a" "b"'), 3, /a second quoted string/);
});

test('string refusals: unterminated, glued to a word', () => {
  refuses(withBlock('- head "Features'), 3, /unterminated string/);
  refuses(withBlock('- head action"Go"'), 3, /put a space before a quoted string/);
});

test('header refusals: missing, repeated, unknown, late, malformed', () => {
  refuses('route: /r\n- head', 1, /no `state:` line/);
  refuses('state: s\n- head', 1, /no `route:` line/);
  refuses('state: s\nroute: /r', 1, /no blocks/);
  refuses('state: s\nstate: t\nroute: /r\n- head', 2, /`state:` given twice/);
  refuses('state: s\nroute: /r\ntitle: x\n- head', 3, /unknown header `title:`/);
  refuses('state: s\n- head\nroute: /r', 3, /comes before the first block line/);
  refuses('state: Ship Features\nroute: /r\n- head', 1, /lower-case words joined by hyphens/);
  refuses('state: s\nroute: app\n- head', 2, /must start with \//);
  refuses('state: s\nroute: /r\nhead "x"', 3, /expected `state:`, `route:` or a block line/);
  refuses('state: s\nroute: /r\n-', 3, /starts with its kind/);
});

test('when: is refused — a surface is one state', () => {
  refuses(withBlock('- empty "No features yet"   when: empty'), 3, /a surface is ONE state/);
  refuses('state: s\nroute: /r\nwhen: empty\n- head', 3, /a surface is ONE state/);
});

test('the old template shape is refused with a pointer to the new one', () => {
  const legacy =
    'route: /orders\nstate: empty\nblocks:\n  - heading: "Orders"\n  - empty-state: "No orders yet."';
  refuses(legacy, 3, /no `blocks:` list/);
  refuses(withBlock('  - heading: "Orders"'), 3, /old list shape — write `- <kind> "words"`/);
});

test('parseSurfaces: every surface fence in order, with FILE line numbers', () => {
  const markdown = [
    '# Seed', //                                  1
    '', //                                        2
    '```surface', //                              3
    'state: a', //                                4
    'route: /a', //                               5
    '- head "A"', //                              6
    '```', //                                     7
    'prose', //                                   8
    '~~~surface', //                              9
    'state: b', //                                10
    'route: /b', //                               11
    '- lsit', //                                  12
    '~~~', //                                     13
  ].join('\n');
  assert.throws(
    () => parseSurfaces(markdown, 'seed.md'),
    (error) => error.message.startsWith('seed.md:12: unknown kind `lsit`')
  );
  const fixed = parseSurfaces(markdown.replace('- lsit', '- list'), 'seed.md');
  assert.deepEqual(
    fixed.map((s) => [s.state, s.line, s.blocks[0].line]),
    [
      ['a', 4, 6],
      ['b', 10, 12],
    ]
  );
});

test('parseSurfaces: a surface fence inside a longer fence is an example, not a block', () => {
  const markdown = ['````', '```surface', 'state: a', 'route: /a', '- lsit', '```', '````'].join('\n');
  assert.deepEqual(parseSurfaces(markdown), []);
});

test('parseSurfaces: CommonMark fence rules — indent, info string, closing length', () => {
  // Four spaces is an indented code block, never a fence.
  assert.deepEqual(parseSurfaces('    ```surface\n    state: a\n    route: /a\n    - head\n    ```'), []);
  // Three spaces is a fence.
  assert.equal(parseSurfaces('   ```surface\nstate: a\nroute: /a\n- head\n   ```').length, 1);
  // The info string must be exactly `surface`.
  assert.deepEqual(parseSurfaces('```surfaces\nstate: a\n```\n```js surface\nx\n```'), []);
  // A shorter or different closing fence does not close it.
  const long = '````surface\nstate: a\nroute: /a\n```\n~~~~\n- head\n````';
  assert.throws(() => parseSurfaces(long), /expected `state:`/);
});

test('parseSurfaces: an unclosed surface fence fails at its opening line', () => {
  assert.throws(
    () => parseSurfaces('text\n```surface\nstate: a\nroute: /a\n- head', 'seed.md'),
    (error) => error.line === 2 && /never closed/.test(error.message)
  );
});

test('validateMap: keys are generic kinds, values are names', () => {
  assert.deepEqual(validateMap({ kinds: { head: 'head', list: 'listcard' } }), []);
  assert.deepEqual(validateMap({}), ['the map has no `kinds` object']);
  assert.deepEqual(
    validateMap({ kinds: [] }),
    ['the map has no `kinds` object'],
    'an array is not a map (#210 review, Codex)'
  );
  const problems = validateMap({ kinds: { lsit: 'list', head: '', note: 3 } });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /unknown kind `lsit` — did you mean `list`/);
  assert.match(problems[1], /`head` maps to "", not a kind name/);
  assert.match(problems[2], /`note` maps to 3/);
});
