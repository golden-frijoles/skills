// screensaver-view.test.mjs — the Client module's logic (screensaver D3/D4), driven with fake pieces and a mock
// surface. node:test, Node 20: the real catalog is TypeScript, so it is not imported here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICK_MS, createSaverView as realCreate } from './screensaver-view-core.mjs';

// The hook sends `fits` ([{ id, rows, anchor }], screensaver.mjs fitPieces); these specs say the ids, uncropped.
const asFits = (props) => (props && Array.isArray(props.ids) ? { ...props, fits: props.ids.map((id) => ({ id })) } : props);
const createSaverView = (pieces, opts) => {
  const view = realCreate(pieces, opts);
  return (props, surface) => view(asFits(props), surface);
};

// The props the engine accepts on Box and Text (claude-code.d.ts): a prop outside them makes the whole tree refused.
const TEXT = new Set(['hover', 'color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap', 'children']);
const BOX = new Set(['key', 'hover', 'position', 'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'justifyContent', 'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight', 'padding', 'paddingX', 'paddingY', 'margin', 'overflow', 'children']);

function piece(id, cols, rows, make) {
  const frame = (t) => Array.from({ length: rows }, (_, r) => `${id}${r}`.padEnd(cols, '·').slice(0, cols) + (r === 0 ? '' : '')).join('\n');
  return { id, meta: { name: id.replace('-', ' '), cols, rows }, make: make ?? (() => frame) };
}

function surface(columns = 80) {
  const bad = [];
  const mk = (type, allowed) => (props) => {
    for (const k of Object.keys(props)) if (!allowed.has(k)) bad.push(`${type}.${k}`);
    return { type, props };
  };
  const timers = [];
  const s = {
    columns, rows: 0, bad, timers, states: [],
    elements: { Box: mk('Box', BOX), Text: mk('Text', TEXT) },
    every: (ms, fn) => (timers.push({ ms, fn }), () => {}),
    setState: (v) => s.states.push(v),
    // D4: the region takes no keys and no pointer, so it never holds the focus. Touching either is a failure.
    onKey: () => assert.fail('the screensaver must not register onKey'),
    onPointer: () => assert.fail('the screensaver must not register onPointer'),
  };
  return s;
}
const lines = (tree) => tree.props.children.map((c) => c.props.children[0]);
const tickFor = (s, seconds) => { for (let i = 0; i < Math.round((seconds * 1000) / TICK_MS); i++) s.timers[0].fn(); };

const A = piece('aaa', 20, 4);
const B = piece('bbb', 30, 3);
const View = createSaverView([A, B]);

test('draws the picture and a caption, centred, in dim text, with only props the engine accepts', () => {
  const s = surface(40);
  const tree = View({ ids: ['aaa'], rotateS: 45, seed: 0 }, s);
  const out = lines(tree);
  assert.equal(out.length, A.meta.rows + 1, 'rows + the caption');
  assert.ok(out[0].startsWith(' '.repeat(10) + 'aaa0'), 'centred: (40-20)/2 = 10 spaces');
  assert.match(out.at(-1), /ascii\.rest · aaa — type to wake/);
  assert.ok(tree.props.children.every((c) => c.props.dimColor === true), 'quiet: dim');
  assert.deepEqual(s.bad, []);
});

test('one clock per instance, started once; each tick advances time and asks for a redraw', () => {
  const s = surface();
  View({ ids: ['aaa'], rotateS: 45, seed: 0 }, s);
  View({ ids: ['aaa'], rotateS: 45, seed: 0 }, s); // the engine calls again after a setState
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0].ms, TICK_MS);
  tickFor(s, 1);
  assert.equal(s.states.length, 20, '1 s at 50 ms');
  assert.deepEqual(s.states.slice(0, 3), [1, 2, 3], 'a counter: any new value redraws');
});

test('the piece gets the elapsed seconds, and starts at zero', () => {
  const seen = [];
  const P = piece('clk', 10, 1, () => (t) => (seen.push(t), 'x'.repeat(10)));
  const V = createSaverView([P]);
  const s = surface();
  V({ ids: ['clk'], rotateS: 45, seed: 0 }, s);
  tickFor(s, 1);
  V({ ids: ['clk'], rotateS: 45, seed: 0 }, s);
  assert.equal(seen[0], 0);
  assert.ok(Math.abs(seen.at(-1) - 1) < 1e-9, `t=${seen.at(-1)}`);
});

test('rotates to the next piece after rotateS, and wraps; each new piece is built fresh', () => {
  let builds = 0;
  const C = piece('ccc', 10, 1, () => (builds++, () => 'c'.repeat(10)));
  const V = createSaverView([A, C]);
  const s = surface();
  let tree = V({ ids: ['aaa', 'ccc'], rotateS: 2, seed: 0 }, s);
  assert.match(lines(tree).at(-1), /aaa/);
  tickFor(s, 2);
  tree = V({ ids: ['aaa', 'ccc'], rotateS: 2, seed: 0 }, s);
  assert.match(lines(tree).at(-1), /ccc/);
  assert.equal(builds, 1);
  tickFor(s, 2);
  tree = V({ ids: ['aaa', 'ccc'], rotateS: 2, seed: 0 }, s);
  assert.match(lines(tree).at(-1), /aaa/, 'wrapped');
  tickFor(s, 2);
  V({ ids: ['aaa', 'ccc'], rotateS: 2, seed: 0 }, s);
  assert.equal(builds, 2, 'back on ccc: a new Frame, so a stateful piece restarts');
});

test('the seed picks where a run starts, so it is not always the same piece', () => {
  const at = (seed) => lines(View({ ids: ['aaa', 'bbb'], rotateS: 45, seed }, surface())).at(-1);
  assert.match(at(0), /aaa/);
  assert.match(at(1), /bbb/);
  assert.match(at(2), /aaa/);
  assert.match(at(-1), /bbb/, 'a negative or odd seed still lands on a piece');
  assert.match(at(NaN), /aaa/);
});

test('a resize that changes the fitting list moves to a valid piece and keeps going', () => {
  const s = surface();
  View({ ids: ['aaa', 'bbb'], rotateS: 45, seed: 1 }, s); // on bbb
  const tree = View({ ids: ['aaa'], rotateS: 45, seed: 1 }, s); // bbb no longer fits
  assert.match(lines(tree).at(-1), /aaa/);
});

test('nothing that fits, or unknown ids: draws nothing, not a blank row', () => {
  for (const props of [{ ids: [] }, { ids: ['nope'] }, {}, undefined]) {
    const tree = View(props, surface());
    assert.deepEqual(tree.props, { height: 0 });
  }
});

test('a piece that throws does not take the band down: it says so on screen', () => {
  const bad = piece('bad', 10, 1, () => () => { throw new Error('boom'); });
  const broken = piece('broken', 10, 1, () => { throw new Error('no build'); });
  for (const p of [bad, broken]) {
    const out = lines(createSaverView([p])({ ids: [p.id], rotateS: 45, seed: 0 }, surface()));
    assert.match(out[0], new RegExp(`screensaver: ${p.id} failed`));
  }
});

test('before the first layout (columns 0) the picture is drawn uncentred; a too-narrow region clips, never throws', () => {
  assert.ok(lines(View({ ids: ['aaa'], rotateS: 45, seed: 0 }, surface(0)))[0].startsWith('aaa0'));
  const clipped = lines(View({ ids: ['aaa'], rotateS: 45, seed: 0 }, surface(12)));
  assert.ok(clipped.slice(0, A.meta.rows).every((l) => [...l].length <= 12));
});

test('a bad rotateS falls back to 45 s instead of rotating every tick', () => {
  const s = surface();
  View({ ids: ['aaa', 'bbb'], rotateS: 0, seed: 0 }, s);
  tickFor(s, 10);
  assert.match(lines(View({ ids: ['aaa', 'bbb'], rotateS: 0, seed: 0 }, s)).at(-1), /aaa/);
});

test('D3: a fit with fewer rows crops the frame from its anchored side; never scaled', () => {
  const tall = piece('tal', 10, 6);
  const V = realCreate([tall]);
  const at = (anchor) => lines(V({ fits: [{ id: 'tal', rows: 4, anchor }], rotateS: 45, seed: 0 }, surface(10)));
  assert.deepEqual(at('bottom').slice(0, 4), ['tal2······', 'tal3······', 'tal4······', 'tal5······']);
  assert.deepEqual(at('middle').slice(0, 4).map((l) => l.slice(0, 4)), ['tal1', 'tal2', 'tal3', 'tal4']);
  assert.equal(at('top').length, 4 + 1, 'four rows and the caption');
});

test('the caption carries the hook\'s hint when there is one, and only then', () => {
  const caption = (hint) => lines(View({ ids: ['aaa'], rotateS: 45, seed: 0, hint }, surface(80))).at(-1);
  assert.match(caption('goldenfrijoles.com'), /type to wake · goldenfrijoles\.com$/);
  assert.match(caption(null), /type to wake$/);
});
