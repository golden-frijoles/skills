#!/usr/bin/env node
// owed-ledger.mjs — turn scattered "owed to <the product owner>" comments into one generated, categorised number.
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────────
// The manual-QA debt has only ever been countable by grepping, which means it is quoted from memory
// and drifts. An external audit counted 80 occurrences across 75 files on 2026-07-24; two days later
// the real numbers were 76 and 71. Neither was wrong when written — a hand-counted number is simply
// stale on arrival, and the drift IS the argument for generating it.
//
// ── Follows build-order.mjs, deliberately ─────────────────────────────────────────────────────
// Generator + `--check` staleness mode + a committed artifact, the pattern already proven twice here
// (build-order.mjs, build-order-sync.mjs). Nothing new to learn, and the same CI-guard shape applies.
//
// ── Re-derive the population; never trust a list ──────────────────────────────────────────────
// LEARNINGS' "guard the population, not the door you found": a sweep that enumerates by hand misses
// the siblings nobody thought of, and that shipped a real consent hole. So this walks the spec tree
// mechanically every run. There is no allow-list, and a marker that matches is counted whether or not
// anyone expected it.
//
// ── Nothing is silently dropped ───────────────────────────────────────────────────────────────
// The categoriser is heuristic and will misfile things. An uncategorised marker lands in `other`,
// never in the bin: a ledger that quietly loses items is worse than the comments it replaced, because
// it looks authoritative. A test asserts input count === output count.
//
// ── Project values (plugin-audit-and-extraction S2.5) ──────────────────────────────────────────
// WHO checks are owed to, and WHERE the specs live, come from reporting.config.json's optional `owed`
// section: `{ "owners": ["the product owner"], "specDirs": ["apps/web/e2e"] }`. Owners default to the
// role name the templates use ("the product owner"); list a person's name too if your specs say it.
// Spec dirs default to every `apps/*/e2e` that exists — derived, like everything else here.
// (The origin's numbers above: 76 markers across 71 files, all of them "owed to <one person>".)
//
// ── The epic docs too (launch-sweep audit §3, 2026-10-13) ─────────────────────────────────────
// Most owed items never reach a spec: they are written in an epic's RETROSPECTIVE.md when it closes. So
// `owed.docDirs` (default: `Roadmap`, when it exists) is walked for `RETROSPECTIVE.md` and `sprint-*.md`. A
// sprint doc counts only while its epic has no retrospective: the retro's "Owed" list is the close-out summary
// of every sprint's walkthrough, and counting both would count one walkthrough several times.
//
// An item is CLEARED, and leaves the count, when it opens with `✅` or a strike (`~~…~~`); a strike further in
// clears that part only: edit the line
// where it was written, never this file's output. Lines inside an HTML comment (template placeholders) are
// not markers. Each item also gets a KIND — who can clear it — beside its category (what it touches).
//
// Usage:
//   node scripts/owed-ledger.mjs             # write the markdown + json artifacts
//   node scripts/owed-ledger.mjs --check     # exit 1 if the committed artifact is stale (CI/hook)
//   node scripts/owed-ledger.mjs --json      # print the JSON to stdout, write nothing

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
import { loadReportingConfig, ReportingConfigError, configPath } from './lib/reporting-config.mjs';
import { readSection } from './lib/config.mjs';
const OUT_MD = join(ROOT, 'Roadmap/00-ideas/OWED-LEDGER.md');
const OUT_JSON = join(ROOT, 'Roadmap/00-ideas/OWED-LEDGER.json');

// Case-insensitive, and tolerant of the real shapes: "owed to <owner>", "Owed (<owner>…)", "stay owed to
// <owner>". One alternation per configured owner name; spacing inside a name is flexible.
export function markerFor(owners) {
  const names = owners.map((o) =>
    o
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+')
  );
  // The name ends at a non-word character: "Jordan" is not "Jordana".
  return new RegExp(`owed\\s*(?:to|\\()?\\s*(?:${names.join('|')})(?!\\w)`, 'i');
}
export const DEFAULT_OWNERS = ['the product owner'];

const sectionPresent = (root) => {
  try {
    return readSection('reporting', { root }).present;
  } catch {
    return true; // a malformed config file is present, and the error above is the one to surface
  }
};

/** The project's owners, spec dirs and doc dirs: reporting.config.json's `owed`, else the defaults (derived dirs). */
export function resolveOwedConfig({
  root = ROOT,
  load = loadReportingConfig,
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
  let owed = {};
  try {
    owed = load({ root }).owed || {};
  } catch (e) {
    // ABSENT config → the defaults. A PRESENT but invalid one is an error: silently dropping a configured
    // owner would change the count with no signal — the "quietly loses items" failure this file exists
    // to prevent. (Fresh-reviewer finding on PR #21.)
    // "Present" means the reporting section exists in EITHER file (golden-frijoles-plugin D9, review of #49).
    if (!(e instanceof ReportingConfigError) || exists(configPath({ root, env: {} })) || sectionPresent(root))
      throw e;
  }
  const owners = owed.owners?.length ? owed.owners : DEFAULT_OWNERS;
  let specDirs = owed.specDirs;
  if (!specDirs?.length) {
    const apps = join(root, 'apps');
    specDirs = exists(apps)
      ? readdir(apps)
          .map((a) => join('apps', a, 'e2e'))
          .filter((d) => exists(join(root, d)))
      : [];
  }
  const docDirs = owed.docDirs?.length ? owed.docDirs : exists(join(root, 'Roadmap')) ? ['Roadmap'] : [];
  return { owners, specDirs, docDirs };
}

export const CATEGORIES = ['money-path', 'auth-path', 'admin-only', 'other'];

export const KINDS = ['publish', 'credential', 'ops', 'judgment', 'signed-in', 'interactive', 'unsorted'];

/** What each kind means, and who clears it. Rendered as the ledger's first table. */
export const KIND_MEANING = {
  publish: 'A package publish (npm 2FA): the product owner today, a CI job once trusted publishing is on',
  credential: 'Mints or uses a production credential: only the product owner, named every time',
  ops: "On the product owner's own accounts or machine",
  judgment: 'An answer only the product owner can give: an _Intent_, an approval, a decision',
  'signed-in': 'A signed-in production walkthrough: an agent can run it once a smoke account exists',
  interactive: 'An interactive plugin or terminal walkthrough: an agent can script it in a scratch repo',
  unsorted: 'Nothing above matched — **not a bin, a to-triage list**',
};

/**
 * Who can clear one marker, by rule, from its text. PURE.
 *
 * Order matters, most specific first: a line naming an npm publish is a publish even when it also says
 * "smoke"; a credential beats a walkthrough because the credential is the step only one person can do.
 */
export function kindOf({ text }) {
  const t = String(text ?? '').toLowerCase();
  if (/\bnpm publish\b|\b2fa\b|\bpublish(?:es|ed)? (?:to npm|the (?:cli|sdk|kit))\b/.test(t))
    return 'publish';
  if (
    /\bshare links?\b|\bmint(?:s|ed|ing)?\b|\bproduction (?:write|credential)s?\b|\bprod(?:uction)? write smoke\b/.test(
      t
    )
  ) {
    return 'credential';
  }
  if (
    /\bnotion\b|\bfolder move\b|\.git\b|\broutine key\b|\bprovision(?:ing)?\b|\baccount step\b|\baccount copies\b|\bthe folder\b/.test(
      t
    )
  )
    return 'ops';
  if (
    /(?:^|[^a-z])intent(?![a-z])|\bwhat was meant\b|\bapprov(?:e|al|als)\b|\bre-approv|\bdecide\b|\bdecision\b|\bpromote\b|\bjudg(?:e|e?ment)\b/.test(
      t
    )
  ) {
    return 'judgment';
  }
  if (
    /\bsigned[- ]in\b|\bsign in\b|\bbrowser smoke\b|\bon production\b|\bauthed\b|\bconsole\b|https?:\/\/\S*\/app\b/.test(
      t
    )
  )
    return 'signed-in';
  if (
    /\binteractive\b|\bterminal\b|\bband\b|\bstatus line\b|\bsession\b|\bsetup\b|\bgroom\b|\brefine\b|\bplugin\b|\bwalkthrough\b|\binstall\b|\broutines?\b|\btelegram\b/.test(
      t
    )
  ) {
    return 'interactive';
  }
  return 'unsorted';
}

/**
 * Categorise one marker by rule, from its file path + the surrounding comment text.
 *
 * Order matters: money beats auth beats admin. A checkout smoke that also needs a login is money —
 * that is the one a human should run first, and the most expensive to get wrong.
 */
export function categorise({ file, text }) {
  const hay = `${file} ${text}`.toLowerCase();
  // Word boundaries throughout. Substring matching filed a pin-ORDERing check as money-path because
  // "order" appears inside "ordering" — caught by this module's own test. "border", "reorder" and
  // "recorded" are the same trap, and a miscategorised money-path item is the most misleading kind:
  // it is the bucket a human is told to run FIRST.
  if (
    /\b(?:checkout|payments?|stripe|mercadopago|money|prices?|pricing|refunds?|payouts?|orders?|carts?|subscriptions?)\b/.test(
      hay
    )
  ) {
    return 'money-path';
  }
  if (/\b(?:auth|authed|sign-?in|log-?in|sessions?|clerk|credentials?|tokens?)\b/.test(hay)) {
    return 'auth-path';
  }
  if (/\b(?:admin|moderation|contenido|seleccion)\b/.test(hay)) return 'admin-only';
  return 'other';
}

const isSpec = (name) => /\.spec\.ts$/.test(name);
const isEpicDoc = (name) => name === 'RETROSPECTIVE.md' || /^sprint-[^/]*\.md$/.test(name);

/** Recursively list spec files. Pure-ish: I/O injected so the walk is testable. */
export function listSpecFiles(dir, deps = {}) {
  const { read = readdirSync, stat = statSync, match = isSpec } = deps;
  const out = [];
  // Cross-review caught this: swallowing an unreadable subtree emitted a SMALLER ledger as
  // authoritative. A ledger that under-reports is worse than one that fails — it is the same
  // "confident empty result" this repo deleted two test scripts for. Collect and surface instead.
  const unreadable = [];
  const walk = (d) => {
    let entries;
    try {
      entries = read(d);
    } catch (e) {
      unreadable.push(`${d}: ${e.code || e.message}`);
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      let s;
      try {
        s = stat(p);
      } catch (e) {
        // A name that vanished between the listing and the stat (or a dangling link) holds nothing to count; any
        // other failure is a file we could not look at, and the count must not read as complete.
        if (e?.code !== 'ENOENT') unreadable.push(`${p}: ${e?.code || e?.message}`);
        continue;
      }
      if (s.isDirectory()) walk(p);
      else if (match(name)) out.push(p);
    }
  };
  walk(dir);
  if (unreadable.length) {
    const err = new Error(
      `owed-ledger: ${unreadable.length} directory/ies could not be read, so the ledger would ` +
        `UNDER-report:\n  ${unreadable.join('\n  ')}\n` +
        `Refusing to emit a count that looks authoritative but is incomplete.`
    );
    err.code = 'UNREADABLE_SUBTREE';
    throw err;
  }
  return out.sort();
}

/**
 * The epic docs under one dir: every RETROSPECTIVE.md, and each sprint-*.md whose epic has no retrospective
 * yet (the retro summarises its sprints' owed steps; see the header). Same throw-don't-under-report walk.
 */
export function listDocFiles(dir, deps = {}) {
  const { readFile = (f) => readFileSync(f, 'utf8') } = deps;
  const files = listSpecFiles(dir, { ...deps, match: isEpicDoc });
  // The scaffolder writes RETROSPECTIVE.md on day one, so a retro only summarises its sprints once it is CLOSED
  // (`_Closed: <a real date>_`). Until then the sprint docs are where the owed steps live, and they count.
  const closed = new Set(
    files.filter((f) => /RETROSPECTIVE\.md$/.test(f) && isClosedRetro(readFile(f))).map((f) => dirname(f))
  );
  return files.filter((f) => /RETROSPECTIVE\.md$/.test(f) || !closed.has(dirname(f)));
}

/** A retro is closed when its `_Closed:` line holds a date, not the template's `<date>`. */
export const isClosedRetro = (contents) => /^_Closed: \d{4}-\d{2}-\d{2}/m.test(String(contents ?? ''));

/** An item's text in the report is capped: the ledger is a list to act on, the source keeps the whole note. */
const MAX_TEXT = 280;

/**
 * An item is cleared where it was written: it OPENS with a tick (`✅`) or a strike (`~~`). A strike further in
 * clears that part only (one of two steps done), so the item stays open and is classified on what is left.
 */
export const isCleared = (prose) => /^(?:\*\*|_)?\s*(?:✅|~~)/.test(String(prose ?? '').trim());
const unstruck = (text) => String(text ?? '').replace(/~~[^~]+~~/g, ' ');

/**
 * Extract every marker from one file's contents. PURE.
 *
 * Captures the line and a little surrounding context, because the comment text is what makes the
 * categorisation possible and what makes the ledger readable.
 */
export function extractMarkers(contents, file, marker = markerFor(DEFAULT_OWNERS)) {
  const lines = String(contents ?? '').split('\n');
  const isMd = /\.md$/.test(file);
  const ITEM = /^(\s*)(?:[-*+]|\d+\.)\s/;
  const found = [];
  // A markdown item wraps: its text (and a tick or strike on a later line) runs until a blank line, a heading or
  // the next item. Without this a retro's owed item is cut mid-sentence and classified on half its words.
  const wrapped = (i) => {
    let whole = lines[i];
    let j = i + 1;
    if (isMd) {
      for (; j < lines.length && !/^\s*$|^\s*(?:#|[-*+]\s|\d+\.\s|<!--|```|~~~)/.test(lines[j]); j++) {
        whole += ` ${lines[j].trim()}`;
        taken.add(j);
      }
    }
    return whole;
  };
  const push = (i, whole) => {
    // Strip comment and list punctuation so the text reads as prose in the report.
    const prose = whole.replace(/^\s*(?:\/\/|\/\*+|\*+\/?|#+|[-*+]\s|\d+\.\s)\s*/, '').trim();
    // The whole text is kept: the kind and category read all of it (a strike near the end included); only the
    // rendered list is capped.
    found.push({ file, line: i + 1, text: prose, ...(isCleared(prose) ? { cleared: true } : {}) });
  };
  let inHtmlComment = false;
  let inFence = false;
  const taken = new Set(); // a line already counted (as a child, or inside a wrapped item) is never counted again
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // A marker inside a code fence is an example, not an owed check.
    if (isMd && /^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || taken.has(i)) continue;
    // A template's `<!-- … owed to the product owner … -->` placeholder is guidance, not an owed check. Only the
    // text INSIDE a comment is dropped: "Owed to … <!-- after launch -->" is still a real marker.
    let visible = '';
    let rest = raw;
    while (rest.length) {
      if (inHtmlComment) {
        const end = rest.indexOf('-->');
        if (end === -1) break;
        rest = rest.slice(end + 3);
        inHtmlComment = false;
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) {
          visible += rest;
          break;
        }
        visible += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inHtmlComment = true;
      }
    }
    if (!marker.test(visible)) continue;
    const whole = wrapped(i);
    // "None owed to …", or a spec that replaces a smoke that "would otherwise be owed": a mention, not a debt.
    if (
      /\b(?:none|nothing)\b[^.]*\bowed\b|\bowed\b[^.]*:\s*(?:\*\*)?\s*(?:none|nothing)\b|\botherwise\s+be\s+owed\b|\breplaces\b[^.]*\bowed\b/i.test(
        whole
      )
    )
      continue;
    // A heading-shaped marker ("**Owed to the product owner:**") owns the list under it: each item is its own
    // check, so one can be cleared without the rest, and the header itself is not counted.
    if (isMd && /:\s*(?:\*\*|_)?\s*$/.test(whole)) {
      const own = (raw.match(ITEM)?.[1] ?? '').length;
      const isList = ITEM.test(raw);
      const children = [];
      let j = i + 1;
      if (j < lines.length && /^\s*$/.test(lines[j])) j++;
      for (; j < lines.length; j++) {
        const m = lines[j].match(ITEM);
        if (m && (!isList || m[1].length > own)) children.push(j);
        else if (/^\s*$/.test(lines[j])) {
          // A loose list: a blank line between items. It goes on only if the next line is another child.
          const next = lines[j + 1]?.match(ITEM);
          if (!children.length || !next || (isList && next[1].length <= own)) break;
        } else if (m || /^\s*#/.test(lines[j]) || !/^\s/.test(lines[j])) break;
      }
      if (children.length) {
        for (const c of children) {
          taken.add(c);
          push(c, wrapped(c));
        }
        continue;
      }
    }
    push(i, whole);
  }
  return found;
}

/** Group open markers by category and by kind. PURE. Asserts nothing is lost: open + cleared = in. */
export function buildLedger(markers) {
  const open = markers.filter((m) => !m.cleared);
  const cleared = markers.length - open.length;
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  const byKind = Object.fromEntries(KINDS.map((k) => [k, []]));
  for (const m of open) {
    const left = { ...m, text: unstruck(m.text) };
    const item = { ...m, category: categorise(left), kind: kindOf(left) };
    byCategory[item.category].push(item);
    byKind[item.kind].push(item);
  }
  const count = (groups) => Object.values(groups).reduce((n, arr) => n + arr.length, 0);
  // A ledger that loses items is worse than the scattered comments it replaced.
  if (count(byCategory) + cleared !== markers.length || count(byKind) + cleared !== markers.length) {
    throw new Error(
      `owed-ledger: ${markers.length} markers in, ${count(byCategory)} + ${cleared} cleared out — categorisation dropped items.`
    );
  }
  return {
    total: open.length,
    cleared,
    files: new Set(open.map((m) => m.file)).size,
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, byCategory[c].length])),
    byKind: Object.fromEntries(KINDS.map((k) => [k, byKind[k].length])),
    items: byCategory,
    itemsByKind: byKind,
  };
}

export function renderMarkdown(ledger, generatedAt) {
  const l = [];
  l.push('# Owed ledger — manual verification still outstanding');
  l.push('');
  l.push('> **GENERATED — do not hand-edit.** `node scripts/owed-ledger.mjs`.');
  l.push('> Re-derived from the spec tree and the epic docs on every run, never from a maintained list.');
  l.push(
    '> To clear an item, tick (`✅`) or strike (`~~…~~`) its line where it was written, then regenerate.'
  );
  l.push('');
  l.push(`_Generated: ${generatedAt}_`);
  l.push('');
  l.push(
    `**${ledger.total} check(s) owed across ${ledger.files} file(s)** · ${ledger.cleared ?? 0} cleared.`
  );
  l.push('');
  l.push('| Who can clear it | Count | What it means |');
  l.push('|---|---|---|');
  for (const k of KINDS) l.push(`| ${k} | ${ledger.byKind?.[k] ?? 0} | ${KIND_MEANING[k]} |`);
  l.push('');
  l.push('| Category | Count | What it means |');
  l.push('|---|---|---|');
  l.push(
    `| money-path | ${ledger.byCategory['money-path']} | Touches checkout, payment or order state — run these first |`
  );
  l.push(
    `| auth-path | ${ledger.byCategory['auth-path']} | Needs a real signed-in session a script cannot mint against production |`
  );
  l.push(`| admin-only | ${ledger.byCategory['admin-only']} | Behind an admin surface |`);
  l.push(
    `| other | ${ledger.byCategory.other} | Everything the rules could not confidently place — **not a bin, a to-triage list** |`
  );
  l.push('');
  for (const k of KINDS) {
    const items = ledger.itemsByKind?.[k] ?? [];
    if (!items.length) continue;
    l.push(`## ${k} (${items.length})`);
    l.push('');
    for (const it of items) {
      const text = it.text.length > MAX_TEXT ? `${it.text.slice(0, MAX_TEXT - 1).trimEnd()}…` : it.text;
      l.push(`- \`${it.file}:${it.line}\` · ${it.category} — ${text}`);
    }
    l.push('');
  }
  return `${l.join('\n')}\n`;
}

function gather({ owners, specDirs, docDirs = [] }, root = ROOT) {
  const marker = markerFor(owners);
  const markers = [];
  // A Set: two configured dirs that overlap ("Roadmap" and "Roadmap/01-…") must not count one file twice.
  const files = [
    ...new Set([
      ...specDirs.flatMap((dir) => listSpecFiles(join(root, dir))),
      ...docDirs.flatMap((dir) => listDocFiles(join(root, dir))),
    ]),
  ];
  for (const f of files)
    markers.push(...extractMarkers(readFileSync(f, 'utf8'), relative(root, f).split(sep).join('/'), marker));
  return buildLedger(markers);
}

/**
 * Why a ledger cannot be emitted from this config, or null when it can. The ONE refusal rule: `main()` and the push
 * (`owedForPush`) both read it. A spec tree can live in a separate, gitignored checkout; its absence is a real
 * possibility (a fresh clone of the root repo alone), and it must not read as "zero owed".
 */
export function refusalFor(owedConfig, root = ROOT, exists = existsSync) {
  const missing = [...owedConfig.specDirs, ...owedConfig.docDirs].filter((d) => !exists(join(root, d)));
  if (!owedConfig.specDirs.length)
    return 'no spec directory found (apps/*/e2e, or reporting.config.json → owed.specDirs)';
  if (missing.length) return `${missing.join(', ')} not found`;
  return null;
}

// ── owed-on-screen D1–D3: the ledger rides the roadmap push ───────────────────────────────────────────────
// The committed OWED-LEDGER.json holds COUNTS only, so the push derives the items here, live, with the same functions
// that wrote the file. The file's PRESENCE is the opt-in: a project that never ran the ledger pushes exactly as before.

/** The committed ledger the push treats as the opt-in. Relative to the project root. */
export const OWED_LEDGER_JSON = 'Roadmap/00-ideas/OWED-LEDGER.json';
/** An item's text on the push is cut here; the source keeps the whole note (the schema's bound, lib/roadmap-artifact-schema.ts). */
export const OWED_PUSH_TEXT_MAX = 500;
/**
 * The push's other bounds. ⚠️ COPIES of `OWED_MAX`, `OWED_MAX_PER_EPIC` and the `file` pattern in
 * apps/web/lib/roadmap-artifact-schema.ts (`roadmap-owed-schema.test.ts` pins them): the server refuses the WHOLE push
 * past any of them, so the producer must never send what it would refuse (verifier, #375).
 */
export const OWED_PUSH_MAX = 1000;
export const OWED_PUSH_MAX_PER_EPIC = 100;
export const OWED_PUSH_FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/**
 * Keep only the items the push contract accepts, and say how many were left out. PURE. A file the schema cannot carry
 * (`(group)`, `[slug]`, a space), an empty text, or a check past a cap is dropped from the PUSH only — it stays in the
 * ledger and its markdown, where the full list lives.
 */
export function conformOwedForPush(items) {
  const kept = [];
  const perEpic = new Map();
  let badFile = 0;
  let empty = 0;
  let overEpic = 0;
  let overTotal = 0;
  for (const it of items) {
    if (!OWED_PUSH_FILE_RE.test(it.file) || it.file.split('/').includes('..')) {
      badFile++;
      continue;
    }
    if (!it.text) {
      empty++;
      continue;
    }
    if (it.epic !== null) {
      const n = perEpic.get(it.epic) ?? 0;
      if (n >= OWED_PUSH_MAX_PER_EPIC) {
        overEpic++;
        continue;
      }
      perEpic.set(it.epic, n + 1);
    }
    if (kept.length >= OWED_PUSH_MAX) {
      overTotal++;
      continue;
    }
    kept.push(it);
  }
  const parts = [
    badFile && `${badFile} with a file path the push cannot carry`,
    empty && `${empty} with no text`,
    overEpic && `${overEpic} past ${OWED_PUSH_MAX_PER_EPIC} on one epic`,
    overTotal && `${overTotal} past ${OWED_PUSH_MAX} in all`,
  ].filter(Boolean);
  return {
    kept,
    note: parts.length ? `owed checks left off the push (still in the ledger): ${parts.join(', ')}` : null,
  };
}

/**
 * The epic an item belongs to: the epic folder holding its file (`Roadmap/<NN-area>/<slug>/…`), when that slug is one
 * of the pushed epics; else null (a spec under apps/<app>/e2e, or a doc outside any epic). PURE.
 */
export function epicOfOwedFile(file, epicSlugs) {
  const m = /^Roadmap\/\d{2}-[^/]+\/([^/]+)\//.exec(String(file ?? ''));
  return m && epicSlugs.has(m[1]) ? m[1] : null;
}

/** One open ledger item as the push carries it. PURE. */
export function owedPushItem(item, epicSlugs) {
  const text = String(item.text ?? '').trim();
  return {
    epic: epicOfOwedFile(item.file, epicSlugs),
    text: text.length > OWED_PUSH_TEXT_MAX ? `${text.slice(0, OWED_PUSH_TEXT_MAX - 1).trimEnd()}…` : text,
    kind: item.kind,
    category: item.category,
    file: item.file,
    line: item.line,
  };
}

/**
 * The open owed items for the roadmap push, or `{ owed: null, note }` when there are none to send: no committed ledger
 * (the opt-in), or a ledger that cannot be derived here (the refusal rule, or a walk that would under-report). A push
 * never fails because of the ledger — the board must still update — but the reason is returned, never swallowed.
 * `epicSlugs` are the Epic rows the push carries, so every non-null `epic` names one of them (the schema's rule).
 */
export function owedForPush({ root = ROOT, epicSlugs = [], exists = existsSync } = {}) {
  if (!exists(join(root, OWED_LEDGER_JSON))) return { owed: null, note: null };
  try {
    const owedConfig = resolveOwedConfig({ root });
    const refusal = refusalFor(owedConfig, root, exists);
    if (refusal) return { owed: null, note: `owed checks not pushed: ${refusal}` };
    const ledger = gather(owedConfig, root);
    const slugs = new Set(epicSlugs);
    const { kept, note } = conformOwedForPush(
      KINDS.flatMap((k) => ledger.itemsByKind[k]).map((it) => owedPushItem(it, slugs))
    );
    return { owed: kept, note };
  } catch (e) {
    return { owed: null, note: `owed checks not pushed: ${e.message}` };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const jsonOnly = argv.includes('--json');

  const owedConfig = resolveOwedConfig();
  const refusal = refusalFor(owedConfig);
  if (refusal) {
    process.stderr.write(
      `owed-ledger: ${refusal}.\n` + `  Refusing to emit a ledger that would read as "nothing is owed".\n`
    );
    process.exit(jsonOnly || check ? 1 : 0);
  }

  const ledger = gather(owedConfig);
  const generatedAt = new Date().toISOString().slice(0, 10);

  if (jsonOnly) {
    const { items: _items, itemsByKind, ...counts } = ledger;
    const list = KINDS.flatMap((k) => itemsByKind[k]);
    process.stdout.write(`${JSON.stringify({ ...counts, items: list, generatedAt }, null, 2)}\n`);
    return;
  }

  const md = renderMarkdown(ledger, generatedAt);
  // The JSON is what the standup's evidence pack reads; keep it small and stable.
  const json = `${JSON.stringify({ total: ledger.total, cleared: ledger.cleared, files: ledger.files, byCategory: ledger.byCategory, byKind: ledger.byKind, generatedAt }, null, 2)}\n`;

  if (check) {
    // Counts are compared rather than the whole JSON because `generatedAt` changes daily and would
    // make every run look stale — which is how a staleness gate gets disabled.
    //
    // But the MARKDOWN is a committed artifact too, and cross-review caught that comparing counts
    // alone let a stale/edited/missing OWED-LEDGER.md pass green whenever the totals happened to be
    // unchanged — e.g. an item moving between categories with the same per-category totals, or the
    // file being hand-edited. That is precisely the false-green this script exists to remove, so the
    // markdown is compared too, with only the volatile date line normalised away.
    const stripDate = (t) =>
      String(t ?? '').replace(/^_Generated: \d{4}-\d{2}-\d{2}_$/m, '_Generated: <date>_');
    const prev = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, 'utf8')) : null;
    const prevMd = existsSync(OUT_MD) ? readFileSync(OUT_MD, 'utf8') : null;
    const same =
      prev &&
      prevMd !== null &&
      prev.total === ledger.total &&
      prev.cleared === ledger.cleared &&
      prev.files === ledger.files &&
      JSON.stringify(prev.byCategory) === JSON.stringify(ledger.byCategory) &&
      JSON.stringify(prev.byKind) === JSON.stringify(ledger.byKind) &&
      stripDate(prevMd) === stripDate(md);
    if (!same) {
      process.stderr.write(
        `owed-ledger: the committed ledger is stale — run \`node scripts/owed-ledger.mjs\`.\n` +
          `  committed: ${prev ? `${prev.total} owed` : '(missing)'} · actual: ${ledger.total} owed\n`
      );
      process.exit(1);
    }
    process.stdout.write(`owed-ledger: up to date (${ledger.total} owed).\n`);
    return;
  }

  writeFileSync(OUT_MD, md, 'utf8');
  writeFileSync(OUT_JSON, json, 'utf8');
  process.stdout.write(
    `owed-ledger: ${ledger.total} owed across ${ledger.files} files — ` +
      `${KINDS.map((k) => `${ledger.byKind[k]} ${k}`).join(', ')} · ${ledger.cleared} cleared\n`
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
