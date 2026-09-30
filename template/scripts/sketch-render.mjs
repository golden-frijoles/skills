#!/usr/bin/env node
// sketch-render.mjs — draw every `surface` block in a file as a plain grey wireframe (sketch-specs D16).
//
//   node scripts/sketch-render.mjs Roadmap/00-ideas/seeds/<seed>.md [--out <file.html>]
//   node scripts/sketch-render.mjs apps/web/design-system/surfaces/<state>.surface
//
// The product owner approves a PICTURE, not a text list, so each state becomes one grey section: boxes in the
// order the blocks are written, with the words that matter and the facts drawn (a count as that many boxes, a
// list's column words over placeholder rows). Without --out the page goes to the OS temp folder, so a render never
// litters `Roadmap/`; the path is printed either way.
//
// ⚠️ **Deliberately grey, and deliberately blind to any design system (D4).** A wireframe in brand colours gets
// reviewed for its colours, and a renderer that imports the project's components becomes a second component
// library that drifts from the first. So this file imports only `node:*` and the parser, every colour is a grey,
// and a test fails on anything else. Zero deps.

import { realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSurface, parseSurfaces, SurfaceError } from './lib/surface.mjs';

// Above this a count stops being a shape and becomes noise; the true number is printed beside the boxes.
const MAX_BOXES = 12;

const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );

// A kind whose words are missing still draws its shape: a grey bar where the words would be.
const words = (block, tag = 'span', cls = 'w') =>
  block.words === null
    ? `<span class="bar"></span>`
    : `<${tag} class="${cls}">${escape(block.words)}</${tag}>`;

function boxes(count, cls, fill = () => '<span class="bar"></span>') {
  const drawn = Math.min(count, MAX_BOXES);
  const items = Array.from({ length: drawn }, (_, i) => `<div class="${cls}">${fill(i)}</div>`).join('');
  return items + (count > MAX_BOXES ? `<span class="more">×${count}</span>` : '');
}

const DRAW = {
  head: (b) =>
    `<div class="row">${words(b, 'h2', 'title')}${
      b.action === undefined ? '' : `<span class="button">${escape(b.action)}</span>`
    }</div>`,
  answer: (b) => words(b, 'p', 'answer'),
  summary: (b) => `<div class="row wrap">${boxes(b.count ?? 0, 'stat')}</div>`,
  tiles: (b) =>
    `<div class="grid">${boxes(b.count ?? 0, 'tile', () => '<span class="bar"></span><span class="bar short"></span>')}</div>`,
  steps: (b) =>
    `<div class="row steps">${boxes(b.count ?? 3, 'step', (i) => `<span class="dot">${i + 1}</span>`)}</div>`,
  toolbar: () =>
    '<div class="row"><span class="search">Search</span><span class="pill"></span><span class="pill"></span></div>',
  list: (b) => {
    const columns = b.columns ?? null;
    const cells = columns === null ? 1 : columns.length;
    const head =
      columns === null
        ? ''
        : `<div class="lrow lhead">${columns.map((c) => `<span>${escape(c)}</span>`).join('')}</div>`;
    const row = `<div class="lrow">${'<span><span class="bar"></span></span>'.repeat(cells)}</div>`;
    return `<div class="listbox">${head}${row.repeat(3)}</div>`;
  },
  empty: (b) => `<div class="empty">${words(b)}</div>`,
  card: (b) => `<div class="card">${words(b)}</div>`,
  field: (b) => `<label class="field">${words(b)}<span class="input"></span></label>`,
  tabs: (b) => {
    const labels = b.words === null ? ['', '', ''] : b.words.split('|').map((t) => t.trim());
    return `<div class="row tabs">${labels
      .map(
        (t, i) =>
          `<span class="tab${i === 0 ? ' on' : ''}">${t === '' ? '<span class="bar"></span>' : escape(t)}</span>`
      )
      .join('')}</div>`;
  },
  note: (b) => words(b, 'p', 'note'),
};

const STYLE = `
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:#f4f4f4;color:#222;font:14px/1.45 system-ui,sans-serif}
main{max-width:960px;margin:0 auto}h1{font-size:15px;color:#666;font-weight:600;margin:0 0 16px}
section{background:#fff;border:1px solid #ccc;border-radius:8px;padding:20px;margin:0 0 28px}
header{font:12px ui-monospace,monospace;color:#777;border-bottom:1px dashed #ccc;padding-bottom:8px;margin-bottom:16px}
.block{margin:0 0 14px}.row{display:flex;gap:10px;align-items:center}.wrap{flex-wrap:wrap}
.title{font-size:22px;margin:0;flex:1}.button{border:1px solid #555;border-radius:6px;padding:6px 12px;background:#e6e6e6;font-weight:600}
.answer{font-size:16px;font-style:italic;margin:0;color:#333}.note{font-size:12px;color:#777;margin:0}
.bar{display:inline-block;height:10px;width:120px;max-width:100%;background:#ddd;border-radius:3px}.bar.short{width:60px}
.stat{border:1px solid #ccc;border-radius:6px;padding:10px;min-width:90px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.tile{border:1px solid #ccc;border-radius:6px;padding:16px;display:flex;flex-direction:column;gap:8px;min-height:80px}
.more{font-size:12px;color:#777;align-self:center}
.steps .step{display:flex;align-items:center;gap:10px}.steps .step+.step::before{content:"";width:28px;border-top:1px solid #aaa}
.dot{display:inline-flex;width:26px;height:26px;border-radius:50%;border:1px solid #777;align-items:center;justify-content:center;font-size:12px}
.search{flex:1;max-width:320px;border:1px solid #bbb;border-radius:6px;padding:6px 10px;color:#999}
.pill{width:70px;height:26px;border:1px solid #bbb;border-radius:13px}
.listbox{border:1px solid #ccc;border-radius:6px;overflow:hidden}.lrow{display:flex;border-top:1px solid #e4e4e4}
.lrow:first-child{border-top:0}.lrow>span{flex:1;min-width:0;padding:10px;min-height:38px}
.lhead{overflow-wrap:anywhere;background:#eee;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#555;font-weight:600}
.empty{border:2px dashed #bbb;border-radius:8px;padding:32px;text-align:center;color:#666}
.card{border:1px solid #bbb;border-radius:8px;padding:16px}
.field{display:flex;flex-direction:column;gap:6px;max-width:420px}.input{height:34px;border:1px solid #aaa;border-radius:6px;background:#fafafa}
.tabs{gap:0;border-bottom:1px solid #ccc}.tab{padding:8px 14px;color:#777}.tab.on{color:#222;border-bottom:2px solid #222;font-weight:600}
`;

/** One self-contained grey page, a section per surface. */
export function renderSketch(surfaces, { title = 'Sketch' } = {}) {
  const sections = surfaces
    .map(
      (surface) =>
        `<section><header>${escape(surface.state)} · ${escape(surface.route)}</header>${surface.blocks
          // `block.kind` is one of the parser's twelve (an own-property check there), so it is safe as an attribute
          // and always has a drawing.
          .map((block) => `<div class="block" data-kind="${block.kind}">${DRAW[block.kind](block)}</div>`)
          .join('\n')}</section>`
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${escape(title)} — grey wireframe, ${surfaces.length} state${surfaces.length === 1 ? '' : 's'}</h1>
${sections}
</main></body></html>
`;
}

const USAGE = 'usage: node scripts/sketch-render.mjs <file.md|file.surface> [--out <file.html>]';

export function main(argv) {
  const args = [...argv];
  let out = null;
  let file = null;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--out') {
      out = args.shift() ?? null;
      if (out === null) return { code: 2, stderr: USAGE };
    } else if (arg.startsWith('-') || file !== null) {
      return { code: 2, stderr: `unknown argument \`${arg}\`\n${USAGE}` };
    } else {
      file = arg;
    }
  }
  if (file === null) return { code: 2, stderr: USAGE };

  const text = readFileSync(file, 'utf8');
  let surfaces;
  try {
    surfaces = extname(file) === '.surface' ? [parseSurface(text, file)] : parseSurfaces(text, file);
  } catch (error) {
    if (error instanceof SurfaceError) return { code: 1, stderr: error.message };
    throw error;
  }
  if (surfaces.length === 0) return { code: 1, stderr: `${file}: no \`surface\` block to draw` };

  const name = basename(file, extname(file));
  const target = out ?? join(tmpdir(), `sketch-${name}.html`);
  writeFileSync(target, renderSketch(surfaces, { title: `Sketch — ${name}` }));
  return { code: 0, stdout: target };
}

// realpath on both sides: through a symlinked path a plain compare is false and the script exits 0 having done
// nothing (#189 review).
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
  const { code, stdout, stderr } = main(process.argv.slice(2));
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  process.exitCode = code;
}
