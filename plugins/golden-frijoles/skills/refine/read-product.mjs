#!/usr/bin/env node
// read-product.mjs — what the product itself says and already measures, each fact with its file (setup-drafts-strategy
// D1–D3). Setup runs it before drafting the strategy, so every line of the draft can cite a source.
//
//   node "$REFINE/read-product.mjs"            # the facts, for a person
//   node "$REFINE/read-product.mjs" --json     # the same, for the agent
//   … --root <dir>                            # another project root (default: cwd)
//
// ── What it reads (D2) ────────────────────────────────────────────────────────────────────────────────────────────
// The README (title, first paragraph, headings); package.json's name, description and keywords; the landing copy (the
// root page's <title>, h1/h2 and metadata description); the routes (Next.js app/ and pages/, also under apps/*);
// analytics calls already in the code, with the event name when it is a string literal; feature flags in the code.
//
// ── What it never does (D3) ───────────────────────────────────────────────────────────────────────────────────────
// Read-only: it writes nothing, uses no network and never reads stdin. It never opens `.env*`, `*.pem`, `*.key` or a
// path naming a secret, and never prints a line that looks like a key. It is bounded (MAX_FILES, MAX_BYTES) and says
// what it skipped.
//
// Zero deps — Node 18+.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStack } from './read-repo.mjs';

export const MAX_FILES = 4000;
export const MAX_BYTES = 256 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor', 'coverage', '.turbo', '.vercel', 'Roadmap']);
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|rb|html)$/;
/** A file never opened: environment files, keys and certificates, anything named for a secret. */
// Matched against the FILE NAME only: a folder named for credentials (a `flag-credentials/` route) is not a secret file.
export const SECRET_PATH = /(?:^|[\\/])(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_[a-z0-9]+|[^\\/]*\.(?:pem|key|p8|p12|pfx|crt|tfstate)|[^\\/]*(?:secret|credential|private[-_]?key)[^\\/]*)$/i;
// The token prefixes `scripts/lib/config.mjs` refuses (TOKEN_PREFIXES), plus a long opaque string after `key =`: a
// line matching either is never printed. Copied, not imported: refine's scripts ship inside the plugin.
const KEYISH = /(?:sk-|sk_|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|AKIA|npm_|glpat-|tsk_|gf_pat_|gk_)[A-Za-z0-9_-]{8,}|(?:key|token|secret|password)\s*[:=]\s*['"][^'"]{16,}['"]/i;

// A string literal: the same quote opens and closes it (group `q`), and it is not the start of a concatenation.
const LIT = "(?<q>['\"\\x60])(?<lit>(?:(?!\\k<q>).)*)\\k<q>(?!\\s*\\+)";
const ARG2 = "(?:\\s*,\\s*(?<q2>['\"\\x60])(?<lit2>(?:(?!\\k<q2>).)*)\\k<q2>(?!\\s*\\+))?";
const call = (callee) => new RegExp(`\\b${callee}\\(\\s*(?:${LIT}${ARG2})?`, 'g');

/**
 * Analytics calls: [vendor, pattern, idFirst]. The pattern's `lit` is the first string argument and `lit2` the second.
 * `idFirst` marks the server libraries whose first argument is the user id (PostHog's and Segment's Python and Node
 * server clients: `capture(distinct_id, event)`): there the event is the second literal, never the first.
 */
export const ANALYTICS = [
  ['PostHog', call(String.raw`posthog\??\.capture`), true],
  ['Segment', call(String.raw`analytics\??\.track`), true],
  ['Google Analytics', new RegExp(`\\bgtag\\(\\s*['"]event['"]\\s*,\\s*(?:${LIT})?`, 'g'), false],
  ['Mixpanel', call(String.raw`mixpanel\??\.track`), false],
  ['Amplitude', call(String.raw`(?:amplitude|ampli)\??\.(?:track|logEvent)`), false],
  ['Plausible', call('plausible'), false],
  ['Golden Frijoles', call(String.raw`(?:engine|growth|gf)\??\.track(?:Adoption)?`), false],
];
/** Feature flag reads: [provider, pattern]; `lit` is the flag key when it is a plain literal. */
export const FLAGS = [
  ['LaunchDarkly', call(String.raw`(?:ld|ldClient|launchDarkly|launchdarkly)\??\.variation`), false],
  ['PostHog', call(String.raw`posthog\??\.(?:isFeatureEnabled|getFeatureFlag|feature_enabled|get_feature_flag)`), false],
  ['Unleash', call(String.raw`unleash\??\.isEnabled`), false],
  ['GrowthBook', call(String.raw`growthbook\??\.(?:isOn|getFeatureValue)`), false],
  ['Golden Frijoles', call(String.raw`(?:flags|provider)\??\.(?:getBooleanValue|isEnabled|evaluate)`), false],
];

const posix = (p) => p.split(sep).join('/');
/** A file read by name (README, package.json) only when it is a plain file: a symlink could point outside the repo. */
const plainFile = (path) => {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size <= MAX_BYTES;
  } catch {
    return false;
  }
};
const clip = (text, n = 200) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
const safe = (line) => !KEYISH.test(line);

/** Walk the project's source files: bounded, never into SKIP_DIRS, never a secret path. */
export function walk(root, { maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
  const files = [];
  const skipped = { dirs: new Set(), large: 0, secret: 0, overCap: 0, symlinks: 0 };
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      const rel = posix(relative(root, full));
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) skipped.dirs.add(e.name);
        else stack.push(full);
        continue;
      }
      if (e.isSymbolicLink()) {
        skipped.symlinks++;
        continue;
      }
      if (!e.isFile()) continue;
      if (SECRET_PATH.test(rel)) {
        skipped.secret++;
        continue;
      }
      if (!SOURCE_EXT.test(e.name) && !/^readme(\.md)?$/i.test(e.name) && e.name !== 'package.json') continue;
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > maxBytes) {
        skipped.large++;
        continue;
      }
      if (files.length >= maxFiles) {
        skipped.overCap++;
        continue;
      }
      files.push(rel);
    }
  }
  return { files: files.sort(), skipped: { ...skipped, dirs: [...skipped.dirs].sort() } };
}

/** README: its title, first paragraph and headings, each with its line. */
export function readReadme(root) {
  const name = ['README.md', 'readme.md', 'Readme.md'].find((n) => plainFile(join(root, n)));
  if (!name) return null;
  const lines = readFileSync(join(root, name), 'utf8').split(/\r?\n/);
  let title = null;
  let paragraph = null;
  const headings = [];
  lines.forEach((line, i) => {
    const h = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    // Every printed line passes the key filter, headings included (codex, #336).
    if (h && !safe(line)) return;
    if (h) {
      if (!title && h[1] === '#') title = { text: h[2], at: `${name}:${i + 1}` };
      else if (headings.length < 12) headings.push({ text: h[2], at: `${name}:${i + 1}` });
      return;
    }
    const t = line.trim();
    if (!paragraph && title && t && !/^[<!\[|`>-]/.test(t) && safe(t)) paragraph = { text: clip(t, 300), at: `${name}:${i + 1}` };
  });
  return { title, paragraph, headings };
}

/** package.json's name, description and keywords. */
export function readPackage(root) {
  const path = join(root, 'package.json');
  if (!plainFile(path)) return null;
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    return {
      name: typeof pkg.name === 'string' && safe(pkg.name) ? pkg.name : null,
      description: typeof pkg.description === 'string' && safe(pkg.description) ? clip(pkg.description) : null,
      keywords: Array.isArray(pkg.keywords) ? pkg.keywords.filter((k) => typeof k === 'string' && safe(k)).slice(0, 12) : [],
    };
  } catch {
    return null;
  }
}

const ROOT_PAGES = [/^(?:apps\/[^/]+\/)?(?:src\/)?app\/(?:page|layout)\.[jt]sx?$/, /^(?:apps\/[^/]+\/)?(?:src\/)?pages\/index\.[jt]sx?$/, /^(?:public\/)?index\.html$/, /^src\/routes\/\+page\.svelte$/];

/** The landing copy: title, h1/h2 text and the metadata description in the root page(s). */
export function readLanding(root, files) {
  const out = [];
  for (const rel of files.filter((f) => ROOT_PAGES.some((re) => re.test(f))).slice(0, 6)) {
    const lines = readFileSync(join(root, rel), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!safe(line)) return;
      const at = `${rel}:${i + 1}`;
      for (const [kind, re] of [
        ['title', /<title>([^<]{3,})<\/title>|\btitle:\s*['"`]([^'"`]{3,})['"`]/],
        ['description', /\bdescription:\s*['"`]([^'"`]{10,})['"`]|<meta\s+name=["']description["']\s+content=["']([^"']{10,})/],
        ['heading', /<h[12][^>]*>([^<{]{3,})<\/h[12]>/],
      ]) {
        const m = re.exec(line);
        const text = m && (m[1] ?? m[2]);
        if (text && out.length < 20) out.push({ kind, text: clip(text.trim()), at });
      }
    });
  }
  return out;
}

/** The routes: Next.js app/ (page files) and pages/ entries, also under apps/*; each with the file that defines it. */
export function readRoutes(files) {
  const routes = new Map();
  for (const f of files) {
    let m = /^(?:apps\/[^/]+\/)?(?:src\/)?app\/(.*?)\/?page\.[jt]sx?$/.exec(f);
    if (m) {
      const path = `/${m[1]}`.replace(/\/\([^)]+\)/g, '').replace(/\/$/, '') || '/';
      if (!routes.has(path)) routes.set(path, f);
      continue;
    }
    m = /^(?:apps\/[^/]+\/)?(?:src\/)?pages\/(?!api\/|_)(.*?)\.[jt]sx?$/.exec(f);
    if (m) {
      const path = `/${m[1].replace(/(^|\/)index$/, '')}`.replace(/\/$/, '') || '/';
      if (!routes.has(path)) routes.set(path, f);
    }
  }
  return [...routes].sort(([a], [b]) => a.localeCompare(b)).map(([path, at]) => ({ path, at }));
}

/** Calls matching `table` across the source files: [{ vendor, name|null, at }], de-duplicated by vendor and name. */
export function scanCalls(root, files, table, limit = 60) {
  const out = [];
  const seen = new Set();
  for (const rel of files) {
    if (!SOURCE_EXT.test(rel) || /\.test\.|\.spec\.|__tests__|\/e2e\//.test(rel)) continue;
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      if (!safe(lines[i])) continue;
      const line = lines[i];
      // A comment line is documentation, not a call the product makes (verifier, #336).
      if (/^\s*(?:\/\/|\/?\*|#(?!!))/.test(line)) continue;
      const py = rel.endsWith('.py');
      for (const [vendor, re, idFirst] of table) {
        for (const m of line.matchAll(re)) {
          const g = m.groups ?? {};
          // Server clients put the user id first: the event is the second literal (verifier, #336). In Python those
          // are the only clients; in JS a two-literal capture is the server form too.
          let name = idFirst && (py || g.lit2 !== undefined) ? (g.lit2 ?? null) : (g.lit ?? null);
          // A template literal with a placeholder (`${EVENT}`) is not a name the draft can cite.
          if (name !== null && (name.includes('${') || name === '')) name = null;
          const key = `${vendor}\u0000${name ?? `${rel}:${i + 1}`}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ vendor, name, at: `${rel}:${i + 1}` });
        }
      }
    }
  }
  return out;
}

/** Everything the product read knows, from a project root. */
export function readProduct(root) {
  const { files, skipped } = walk(root);
  return {
    stack: readStack(root).stack,
    readme: readReadme(root),
    package: readPackage(root),
    landing: readLanding(root, files),
    routes: readRoutes(files),
    analytics: scanCalls(root, files, ANALYTICS),
    flags: scanCalls(root, files, FLAGS),
    scanned: files.length,
    skipped,
  };
}

export function formatProduct(p) {
  const out = ['What the product says (each fact with its file):'];
  out.push(`  Stack .......... ${p.stack.length ? p.stack.join(', ') : 'no manifest file found'}`);
  if (p.readme?.title) out.push(`  README ......... ${p.readme.title.text} (${p.readme.title.at})`);
  if (p.readme?.paragraph) out.push(`                   ${p.readme.paragraph.text} (${p.readme.paragraph.at})`);
  if (p.package?.name || p.package?.description)
    out.push(`  package.json ... ${[p.package.name, p.package.description].filter(Boolean).join(': ')} (package.json)`);
  if (p.package?.keywords?.length) out.push(`  Keywords ....... ${p.package.keywords.join(', ')} (package.json)`);
  for (const l of p.landing.slice(0, 8)) out.push(`  Landing ${l.kind.padEnd(8, '.')} ${l.text} (${l.at})`);
  out.push(`  Routes ......... ${p.routes.length ? p.routes.length : 'none found'}`);
  for (const r of p.routes.slice(0, 15)) out.push(`    ${r.path} (${r.at})`);
  if (p.routes.length > 15) out.push(`    … ${p.routes.length - 15} more (--json lists them all)`);
  out.push(`What it already measures:`);
  if (!p.analytics.length) out.push('  no analytics calls found');
  for (const a of p.analytics.slice(0, 20)) out.push(`  ${a.vendor}: ${a.name ?? '(event name not a literal)'} (${a.at})`);
  out.push(`Flags in the code:`);
  if (!p.flags.length) out.push('  none found');
  for (const f of p.flags.slice(0, 12)) out.push(`  ${f.vendor}: ${f.name ?? '(key not a literal)'} (${f.at})`);
  const s = p.skipped;
  out.push(
    `Read ${p.scanned} files; skipped ${[
      s.dirs.length ? `the folders ${s.dirs.join(', ')}` : null,
      s.secret ? `${s.secret} secret-looking files (never opened)` : null,
      s.large ? `${s.large} files over ${MAX_BYTES / 1024} KB` : null,
      s.overCap ? `${s.overCap} files past the ${MAX_FILES}-file cap` : null,
      s.symlinks ? `${s.symlinks} symlinks (never followed)` : null,
    ]
      .filter(Boolean)
      .join('; ') || 'nothing'}.`
  );
  return out.join('\n');
}

function main(argv) {
  const at = argv.indexOf('--root');
  if (at !== -1 && !argv[at + 1]) {
    console.error('read-product: --root needs a directory');
    return 1;
  }
  const root = resolve(at === -1 ? process.cwd() : argv[at + 1]);
  const product = readProduct(root);
  console.log(argv.includes('--json') ? JSON.stringify(product, null, 2) : formatProduct(product));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
