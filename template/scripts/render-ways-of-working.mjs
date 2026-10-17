#!/usr/bin/env node
// render-ways-of-working.mjs — WAYS-OF-WORKING.md is GENERATED, so dieting the template reaches every
// project instead of widening a fork (ways-of-work-lean-pass S3.5).
//
//   node scripts/render-ways-of-working.mjs           # write Roadmap/WAYS-OF-WORKING.md
//   node scripts/render-ways-of-working.mjs --check   # CI: fail if the committed file has drifted
//
// Source: `Roadmap/WAYS-OF-WORKING.template.md` (what every project shares, with `{{fill:key}}` slots)
// + `Roadmap/fill-ins.yml` (what this project's own is). Two consuming projects had been hand-editing
// their copies for months; the slots are how a project keeps its own paragraphs without forking the rest.
//
// ── The rules that keep regeneration boring ───────────────────────────────────────────────────────
//   • Rendering twice with no source change is a BYTE-FOR-BYTE no-op. Same discipline pack-skills.mjs
//     has: a generator whose output churns is one nobody reruns, and a file nobody reruns forks.
//   • A slot with no value is a HARD ERROR, never an empty string. A silently-empty slot deletes a
//     project's deploy rail or its language policy from its own process doc.
//   • A fill-in nobody uses is a HARD ERROR too — a stale key is a promise the rendered file no longer
//     keeps, the same reason permissions-smoke.mjs fails on a stale ledger entry.
//
// The YAML subset is deliberate and tiny — `key: |` block scalars and `key: "quoted"` scalars, nothing
// else — so this stays zero-dependency. Anything richer fails loudly rather than being half-parsed.
//
// Zero deps — Node 18+.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSection } from './lib/config.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
export const TEMPLATE_PATH = join(REPO, 'Roadmap', 'WAYS-OF-WORKING.template.md');
export const FILLINS_PATH = join(REPO, 'Roadmap', 'fill-ins.yml');
// `ways.fillIns` in golden-frijoles.config.json may move the prose file (X15); the file itself stays the prose's home.
// It must stay inside the project: this file's lines are echoed in parse errors, so `../.env.local` would leak.
const fillInsPath = () => {
  const moved = readSection('ways', { root: REPO }).raw?.fillIns;
  const abs = moved ? resolve(REPO, moved) : FILLINS_PATH;
  // The file's lines are echoed in parse errors, so whatever is read must be a fill-ins YAML INSIDE the project —
  // lexically, through symlinks, and by extension: `Roadmap/../.env.local` is inside the project, and a
  // `fill-ins.yml` symlink to it passes a containment check alone (security lens on #49). A missing file is left to
  // the reader, which reports it as missing. The default path gets the same checks.
  const realRepo = realpathSync(REPO);
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  const inside = (p, root) => p.startsWith(root + sep);
  const shown = moved ?? 'Roadmap/fill-ins.yml';
  if (!inside(abs, REPO) || (existsSync(abs) && !inside(real, realRepo))) {
    throw new Error(`ways.fillIns "${shown}" resolves outside the project; refusing to read it.`);
  }
  if (!/\.ya?ml$/i.test(real)) {
    throw new Error(`ways.fillIns "${shown}" is not a .yml/.yaml file; refusing to read it.`);
  }
  return real;
};
export const OUT_PATH = join(REPO, 'Roadmap', 'WAYS-OF-WORKING.md');

const BANNER =
  '<!-- GENERATED FILE — do not edit by hand.\n' +
  '     Source: Roadmap/WAYS-OF-WORKING.template.md + Roadmap/fill-ins.yml\n' +
  '     Regenerate: node scripts/render-ways-of-working.mjs   (CI checks it with --check)\n' +
  "     Shared process text belongs in the .template.md; this project's own belongs in fill-ins.yml. -->\n";

/**
 * The YAML subset, parsed strictly:
 *   key: |            → a block scalar; every following line indented by 2+ spaces, dedented
 *   key: "text"       → a quoted one-liner
 *   # comment / blank → ignored
 * Anything else throws with its line number. Half-understanding a config is how a slot silently empties.
 */
export function parseFillIns(text) {
  const out = {};
  const lines = String(text).split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim()) {
      i++;
      continue;
    }
    if (raw.startsWith('#')) {
      // A column-0 `#` line is a comment ONLY when what follows is another comment, a key, or the end of
      // the file. An unindented `# Heading` meant as block content is followed by the block's indented
      // lines — and silently eating it as a comment would delete a heading from the rendered doc, the one
      // thing this renderer promises never to do (found by the fresh review of dobby-foundation#17).
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && /^\s{2,}\S/.test(lines[k])) {
        throw new Error(
          `fill-ins.yml line ${i + 1}: '${raw.trim().slice(0, 40)}' is at column 0 but is followed by indented block text — indent it 2 spaces if it is content, or move it above a key if it is a comment`
        );
      }
      i = k;
      continue;
    }
    const block = /^([A-Za-z_][\w-]*):\s*\|\s*$/.exec(raw);
    const scalar = /^([A-Za-z_][\w-]*):\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(raw);
    if (block) {
      const key = block[1];
      const body = [];
      i++;
      while (i < lines.length && (lines[i].trim() === '' || /^\s{2,}/.test(lines[i]))) {
        body.push(lines[i].replace(/^ {2}/, ''));
        i++;
      }
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      if (key in out) throw new Error(`fill-ins.yml line ${i}: duplicate key '${key}'`);
      out[key] = body.join('\n');
      continue;
    }
    if (scalar) {
      if (scalar[1] in out) throw new Error(`fill-ins.yml line ${i + 1}: duplicate key '${scalar[1]}'`);
      out[scalar[1]] = scalar[2].replace(/\\"/g, '"');
      i++;
      continue;
    }
    throw new Error(
      `fill-ins.yml line ${i + 1}: only 'key: |' block scalars and 'key: "text"' are supported, got: ${raw.trim().slice(0, 60)}`
    );
  }
  return out;
}

/** Every `{{fill:key}}` the template asks for, in order of appearance, de-duplicated. */
export function slotsIn(template) {
  return [...new Set([...String(template).matchAll(/\{\{fill:([A-Za-z_][\w-]*)\}\}/g)].map((m) => m[1]))];
}

/**
 * Slots that carry a RULE, so an empty value deletes it: `deploy_rail: ""` rendered a process doc with no
 * deploy rail at all, and `--check` called that current (found by codex on dobby-foundation#17). Every other
 * slot may legitimately be empty — each says "this does not apply to me": no posture override, no
 * kill-switch practice, no extra project sections, nothing to add about review scope. A test pins this list
 * against the template's actual slots, so a rename cannot quietly empty it.
 */
export const REQUIRED_FILLS = [
  'product_owner',
  'design_is_scope',
  'deploy_rail',
  'security_floor',
  'language_policy',
  'tooling_table',
];

/**
 * THE RENDERER. Pure: template + values → the rendered file. Throws on a missing or unused key.
 * A slot alone on its line renders as a block (and an empty value removes the line entirely, which is
 * how a project says "this section does not apply to me" deliberately rather than by omission).
 */
export function render(template, values) {
  const slots = slotsIn(template);
  const missing = slots.filter((s) => !(s in values));
  if (missing.length) {
    throw new Error(
      `fill-ins.yml is missing: ${missing.join(', ')} — a slot with no value would silently delete that paragraph`
    );
  }
  const emptied = slots.filter((s) => REQUIRED_FILLS.includes(s) && !String(values[s] ?? '').trim());
  if (emptied.length) {
    throw new Error(
      `fill-ins.yml leaves required slot(s) EMPTY: ${emptied.join(', ')} — that deletes the rule from the rendered file. Fill them, or take the key out of REQUIRED_FILLS with a reason.`
    );
  }
  const unused = Object.keys(values).filter((k) => !slots.includes(k));
  if (unused.length) {
    throw new Error(
      `fill-ins.yml has keys the template no longer asks for: ${unused.join(', ')} — a stale key is a promise the rendered file does not keep`
    );
  }
  let out = template
    // A slot alone on its line: drop the line when the value is empty, else substitute the block.
    .replace(/^[ \t]*\{\{fill:([A-Za-z_][\w-]*)\}\}[ \t]*\n/gm, (_, key) =>
      values[key].trim() ? `${values[key].replace(/\n+$/, '')}\n` : ''
    )
    .replace(/\{\{fill:([A-Za-z_][\w-]*)\}\}/g, (_, key) => values[key].trim());
  // Strip the source file's own instructions to the maintainer: they are about the template, not the
  // process, and a rendered file that tells you to edit it by hand is worse than no banner at all.
  out = out.replace(/^<!--[\s\S]*?-->\n/, '');
  // Tidy the seams a removed slot leaves behind, so an empty slot cannot churn the diff.
  out = out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
  return `${BANNER}${out.startsWith('\n') ? out.slice(1) : out}`;
}

function main() {
  const check = process.argv.includes('--check');
  let template;
  let values;
  try {
    template = readFileSync(TEMPLATE_PATH, 'utf8');
  } catch {
    process.stderr.write(
      `✗ missing ${TEMPLATE_PATH} — this project's WAYS-OF-WORKING is not rendered here.\n`
    );
    process.exit(1);
  }
  try {
    values = parseFillIns(readFileSync(fillInsPath(), 'utf8'));
  } catch (e) {
    process.stderr.write(`✗ ${e.message}\n`);
    process.exit(1);
  }
  let rendered;
  try {
    rendered = render(template, values);
  } catch (e) {
    process.stderr.write(`✗ ${e.message}\n`);
    process.exit(1);
  }
  const current = (() => {
    try {
      return readFileSync(OUT_PATH, 'utf8');
    } catch {
      return null;
    }
  })();
  if (check) {
    if (current === rendered) {
      process.stdout.write(
        `✓ WAYS-OF-WORKING.md matches its source (${rendered.split('\n').length} lines, ${slotsIn(template).length} slots).\n`
      );
      return;
    }
    process.stderr.write(
      current === null
        ? `✗ Roadmap/WAYS-OF-WORKING.md does not exist. Run: node scripts/render-ways-of-working.mjs\n`
        : `✗ Roadmap/WAYS-OF-WORKING.md has DRIFTED from its source — someone hand-edited the generated file, or the source changed without a re-render. Run: node scripts/render-ways-of-working.mjs\n`
    );
    process.exit(1);
  }
  if (current === rendered) {
    process.stdout.write('✓ no change — the rendered file is already current.\n');
    return;
  }
  writeFileSync(OUT_PATH, rendered);
  process.stdout.write(
    `✓ wrote Roadmap/WAYS-OF-WORKING.md (${rendered.split('\n').length} lines from ${slotsIn(template).length} slots).\n`
  );
}

if (isMain(import.meta.url)) main();
