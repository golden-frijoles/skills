#!/usr/bin/env node
// epic-phase.mjs — the architecture lock as a command (live-build-view S2.3, D10).
//
//   node scripts/epic-phase.mjs lock --epic <slug> [--repo-root <dir>] [--now <iso>]
//
// Stamps the epic README's `phase: Building` and `locked_at: "<ISO>"`, and sprint 1's `phase: Building`. From the lock
// on, every rung of the band is set by a trigger (this command, a commit, a PR), never by an agent deciding to write a
// phase. It REFUSES (exit 1) when the README body names no `D1` — a lock with nothing locked — and when the epic is
// already locked (it says when; the stamp is a fact, re-stamping would move it).
//
// It rewrites only the lines it owns: each value keeps its trailing `# comment`, every other byte stays as it was.
// Exit codes: 0 locked, 1 refused, 2 usage / could not look.
//
// Node 18+; validates `--now` with the contract's own validateLockedAt, so the stamp it writes is the one doc-format accepts.

import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLockedAt } from './lib/roadmap-contract.mjs';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/** Split a doc into its frontmatter text and its body; null frontmatter when there is none. */
function split(text) {
  const m = FRONTMATTER_RE.exec(text);
  return m ? { fm: m[1], body: text.slice(m[0].length), head: m[0] } : { fm: null, body: text, head: '' };
}

/**
 * Set `key: value` in a frontmatter block, keeping the line's trailing comment (and its column, when it fits).
 * A key that is absent is appended after `after` (or at the end). Pure.
 */
export function setField(fm, key, value, { after = null } = {}) {
  const lines = fm.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i !== -1) {
    const m = /^([^:]+:\s*)(.*?)(\s+#.*)?$/.exec(lines[i]);
    const comment = m[3] ?? '';
    const lead = `${key}: ${value}`;
    // Keep the comment where it was when the new value fits before it, else one space after.
    const col = comment ? lines[i].length - comment.length : 0;
    lines[i] = comment ? `${lead.padEnd(Math.max(col, lead.length))}${comment}` : lead;
    return lines.join('\n');
  }
  let at = after ? lines.findIndex((l) => new RegExp(`^${after}:`).test(l)) : -1;
  // Skip the comment-only continuation lines that belong to `after` (the README's `phase:` carries two).
  if (at !== -1) while (at + 1 < lines.length && /^\s+#/.test(lines[at + 1])) at += 1;
  const line = `${key}: ${value}`;
  if (at === -1) lines.push(line);
  else lines.splice(at + 1, 0, line);
  return lines.join('\n');
}

/** Read one frontmatter key's raw value (comment and quotes stripped). Pure. */
export function getField(fm, key) {
  const line = fm.split('\n').find((l) => new RegExp(`^${key}:`).test(l));
  if (!line) return null;
  const v = line
    .replace(/^[^:]+:\s*/, '')
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^"(.*)"$/, '$1');
  return v === '' || v === 'null' ? null : v;
}

/** The README body names a numbered decision — the one thing a lock must contain. */
export function namesDecisions(body) {
  return /\bD1\b/.test(body);
}

/**
 * The lock, as a pure transformation: { readme, sprint1 } texts in, { ok, readme, sprint1, why } out.
 * `now` is an ISO string.
 */
export function lockEpic({ readme, sprint1, now }) {
  const r = split(readme);
  if (r.fm === null) return { ok: false, why: 'the epic README has no frontmatter' };
  const already = getField(r.fm, 'locked_at');
  if (already)
    return {
      ok: false,
      why: `already locked at ${already} — the stamp is a fact; edit it by hand only to correct it`,
    };
  if (!namesDecisions(r.body))
    return {
      ok: false,
      why: 'the README names no D1 — write the architecture lock (D1…Dn) before stamping it',
    };
  let fm = setField(r.fm, 'phase', 'Building');
  fm = setField(fm, 'locked_at', `"${now}"`, { after: 'phase' });
  const out = { ok: true, readme: `---\n${fm}\n---\n${r.body}`, sprint1: null, why: `locked at ${now}` };
  if (sprint1 !== null) {
    const s = split(sprint1);
    if (s.fm !== null) out.sprint1 = `---\n${setField(s.fm, 'phase', 'Building')}\n---\n${s.body}`;
  }
  return out;
}

function findEpicDir(root, slug) {
  const roadmap = join(root, 'Roadmap');
  if (!existsSync(roadmap)) return null;
  const hits = readdirSync(roadmap)
    .filter((m) => /^\d{2}-/.test(m))
    .filter((m) => existsSync(join(roadmap, m, slug, 'README.md')));
  return hits.length === 1 ? join(roadmap, hits[0], slug) : hits.length ? 'ambiguous' : null;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? null : (rest[i + 1] ?? null);
  };
  const slug = flag('epic');
  // A slug, never a path: `--epic ../../apps/web` would otherwise resolve outside Roadmap/ (vibe, #241).
  if (cmd !== 'lock' || !slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    process.stderr.write(
      'usage: node scripts/epic-phase.mjs lock --epic <slug> [--repo-root <dir>] [--now <iso>]\n'
    );
    return 2;
  }
  const here = fileURLToPath(new URL('..', import.meta.url));
  const root = resolve(flag('repo-root') ?? here);
  const dir = findEpicDir(root, slug);
  if (dir === null) {
    process.stderr.write(`epic-phase: no Roadmap/*/${slug}/README.md under ${root}\n`);
    return 2;
  }
  if (dir === 'ambiguous') {
    process.stderr.write(`epic-phase: "${slug}" is under more than one Roadmap/ area\n`);
    return 2;
  }
  const now = flag('now') ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (validateLockedAt({ locked_at: now }).length) {
    process.stderr.write(`epic-phase: --now "${now}" is not an ISO date-time (e.g. 2026-10-03T20:34:34Z)\n`);
    return 2;
  }
  const sprintPath = join(dir, 'sprint-1.md');
  const res = lockEpic({
    readme: readFileSync(join(dir, 'README.md'), 'utf8'),
    sprint1: existsSync(sprintPath) ? readFileSync(sprintPath, 'utf8') : null,
    now,
  });
  if (!res.ok) {
    process.stderr.write(`epic-phase: refused — ${res.why}\n`);
    return 1;
  }
  writeFileSync(join(dir, 'README.md'), res.readme);
  if (res.sprint1 !== null) writeFileSync(sprintPath, res.sprint1);
  process.stdout.write(
    `epic-phase: ${slug} ${res.why} — README phase: Building${res.sprint1 !== null ? ', sprint 1 phase: Building' : ''}. Commit it: it is what moves the band to Building.\n`
  );
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
if (isMain) process.exit(main(process.argv.slice(2)));
