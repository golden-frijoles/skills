// reporting-config.mjs — the ONE config seam for the reporting family (standup, weekly-recap, pmo-report).
//
// ── Why one file, and why it is committed ─────────────────────────────────────────────────────
// The three reporting scripts were extracted from an origin project with its repo list, Telegram
// target, smoke workflow and artifact-hosting URLs written straight into source. That is why they sat
// dark for six weeks (plugin-audit-and-extraction D1/D2): there was no place for a consuming project to
// put its own values, so porting meant either shipping someone else's targets or rewriting the logic.
//
// This module is that place. Every project-specific value the three scripts ACTUALLY read (locked
// against the source, not against what they appear to read) lives in `reporting.config.json` at the repo
// root. It is COMMITTED — none of it is a secret (the bot token stays in TELEGRAM_BOT_TOKEN), and a
// routine's cloud sandbox is a fresh checkout every run, so a gitignored per-skill config.json never
// survived to the next run anyway. The per-skill `config.json` files this replaces were exactly that trap.
//
// ── Public repos: reporting.config.local.json ─────────────────────────────────────────────────
// A chat id is not a secret, but a PUBLIC repo should still not publish it. An optional, gitignored
// `reporting.config.local.json` next to the committed file is merged over it (top-level keys replace;
// `telegram` merges one level deep) — so the committed file carries the repos and signals and the local
// file carries the chat. Routines keep using TELEGRAM_CHAT_ID, which needs neither.
//
// ── Fail loudly, never borrow ─────────────────────────────────────────────────────────────────
// A missing or malformed file THROWS a ReportingConfigError that names the file. There is no default
// repo list and no default chat: a reporting script that silently falls back to a baked-in target posts
// one project's status into another project's channel. Optional sections are optional in the explicit
// sense — absent means "this signal is off here", and the scripts say so rather than guessing.
//
// Zero deps — Node 18+.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { projectRoot } from './project-root.mjs';
import { readSection } from './config.mjs';

export const DEFAULT_ROOT = projectRoot(); // D2
export const CONFIG_FILENAME = 'reporting.config.json';
export const EXAMPLE_FILENAME = 'reporting.config.example.json';
export const LOCAL_FILENAME = 'reporting.config.local.json';

export const SURFACES = ['standup', 'weekly', 'pmo', 'merge'];
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export class ReportingConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReportingConfigError';
  }
}

/** Where the config lives. `REPORTING_CONFIG` overrides it (tests, or a project that keeps it elsewhere). */
export function configPath({ root = DEFAULT_ROOT, env = process.env } = {}) {
  return env.REPORTING_CONFIG ? resolve(root, env.REPORTING_CONFIG) : join(root, CONFIG_FILENAME);
}

function fail(path, msg) {
  throw new ReportingConfigError(`${path}: ${msg}`);
}

function repoList(path, value, key) {
  if (!Array.isArray(value)) fail(path, `"${key}" must be an array of "owner/name" strings`);
  for (const r of value) {
    if (typeof r !== 'string' || !REPO_RE.test(r))
      fail(path, `"${key}" has an invalid repo "${r}" — expected "owner/name"`);
  }
  return value;
}

/**
 * Pure — validate a parsed config object and return it normalized. Throws ReportingConfigError on any
 * shape problem, naming the key. `path` is only used in the messages.
 */
export function validateReportingConfig(raw, path = CONFIG_FILENAME) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(path, 'must be a JSON object');

  const repos = repoList(path, raw.repos, 'repos');
  if (!repos.length) fail(path, '"repos" is empty — list every repo the reports aggregate over');

  const deployRepos = (raw.deployRepos ?? []).map((d, i) => {
    if (!d || typeof d !== 'object' || typeof d.label !== 'string' || !d.label.trim()) {
      fail(path, `"deployRepos[${i}]" needs a "label" (e.g. "Frontend") and a "repo"`);
    }
    repoList(path, [d.repo], `deployRepos[${i}].repo`);
    return { label: d.label, repo: d.repo };
  });

  const telegram = raw.telegram ?? {};
  if (!telegram || typeof telegram !== 'object' || Array.isArray(telegram))
    fail(path, '"telegram" must be an object');
  for (const k of ['chatId']) {
    if (telegram[k] != null && typeof telegram[k] !== 'string' && typeof telegram[k] !== 'number')
      fail(path, `"telegram.${k}" must be a string or number`);
  }
  const chatIds = telegram.chatIds ?? {};
  for (const k of Object.keys(chatIds)) {
    if (!SURFACES.includes(k))
      fail(path, `"telegram.chatIds.${k}" is not a surface — use one of ${SURFACES.join(', ')}`);
    if (typeof chatIds[k] !== 'string' && typeof chatIds[k] !== 'number')
      fail(path, `"telegram.chatIds.${k}" must be a string or number`);
  }

  let smoke = null;
  if (raw.smoke != null) {
    if (typeof raw.smoke !== 'object' || Array.isArray(raw.smoke))
      fail(path, '"smoke" must be an object {repo, workflow}');
    repoList(path, [raw.smoke.repo], 'smoke.repo');
    if (typeof raw.smoke.workflow !== 'string' || !raw.smoke.workflow)
      fail(path, '"smoke.workflow" must name a workflow file');
    smoke = { repo: raw.smoke.repo, workflow: raw.smoke.workflow };
  }

  let liveFlags = null;
  if (raw.liveFlags != null) {
    const cmd = raw.liveFlags.command;
    if (!Array.isArray(cmd) || !cmd.length || cmd.some((c) => typeof c !== 'string')) {
      fail(
        path,
        '"liveFlags.command" must be a non-empty argv array (e.g. ["node", "scripts/flags.mjs", "--list-on"])'
      );
    }
    liveFlags = { command: cmd, cwd: raw.liveFlags.cwd || '.' };
  }

  // Where each repo is checked out locally (session-resume.mjs's git read), relative to the repo root.
  const checkouts = raw.checkouts ?? {};
  if (typeof checkouts !== 'object' || Array.isArray(checkouts))
    fail(path, '"checkouts" must map "owner/name" to a local directory');
  for (const [repo, dir] of Object.entries(checkouts)) {
    if (!repos.includes(repo)) fail(path, `"checkouts.${repo}" is not one of "repos"`);
    if (
      typeof dir !== 'string' ||
      !dir ||
      dir.startsWith('/') ||
      dir.includes('\\') ||
      dir.split('/').includes('..')
    ) {
      fail(path, `"checkouts.${repo}" must be a relative directory inside the repo root`);
    }
  }

  // What owed-ledger.mjs counts: who manual checks are owed to, and where the specs and the epic docs live.
  const owed = raw.owed ?? {};
  if (typeof owed !== 'object' || Array.isArray(owed))
    fail(path, '"owed" must be an object {owners, specDirs, docDirs}');
  for (const k of ['owners', 'specDirs', 'docDirs']) {
    if (
      owed[k] != null &&
      (!Array.isArray(owed[k]) || owed[k].some((v) => typeof v !== 'string' || !v.trim()))
    ) {
      fail(path, `"owed.${k}" must be an array of non-empty strings`);
    }
  }
  for (const k of ['specDirs', 'docDirs']) {
    for (const d of owed[k] ?? []) {
      if (d.startsWith('/') || d.includes('\\') || d.split('/').includes('..'))
        fail(path, `"owed.${k}" entry "${d}" must be relative, inside the repo`);
    }
  }

  const stalePreviewAgeDays = raw.stalePreviewAgeDays ?? null;
  if (stalePreviewAgeDays !== null && !(Number.isInteger(stalePreviewAgeDays) && stalePreviewAgeDays > 0)) {
    fail(
      path,
      '"stalePreviewAgeDays" must be a positive integer, or absent to skip the stale-preview signal'
    );
  }
  // The prune script has no default project (a defaulted name prunes someone else's project), so the
  // signal needs one named here. Age without a project is a config error, not a silently-dark signal.
  const vercelProject = raw.vercelProject ?? null;
  if (vercelProject !== null && (typeof vercelProject !== 'string' || !/^[\w.-]+$/.test(vercelProject)))
    fail(path, '"vercelProject" must be a Vercel project name');
  if (stalePreviewAgeDays !== null && vercelProject === null)
    fail(path, '"stalePreviewAgeDays" needs "vercelProject" — the Vercel project whose previews it counts');

  const artifacts = raw.artifacts ?? {};
  const docViewerUrl = artifacts.docViewerUrl ?? null;
  if (docViewerUrl !== null && !/^https?:\/\//.test(docViewerUrl))
    fail(path, '"artifacts.docViewerUrl" must be an http(s) URL');
  const registry = artifacts.registry ?? null;
  if (registry !== null) {
    if (!/^https?:\/\//.test(registry.resolverBaseUrl || ''))
      fail(path, '"artifacts.registry.resolverBaseUrl" must be an http(s) URL');
    if (typeof registry.bucket !== 'string' || !registry.bucket)
      fail(path, '"artifacts.registry.bucket" must name a bucket');
  }

  const prose = raw.prose ?? {};
  const extraBannedToolNames = prose.extraBannedToolNames ?? [];
  if (!Array.isArray(extraBannedToolNames) || extraBannedToolNames.some((t) => typeof t !== 'string')) {
    fail(path, '"prose.extraBannedToolNames" must be an array of regex fragments');
  }
  // Compile each fragment NOW: a bad one would otherwise throw inside the prose guard at --post time.
  for (const t of extraBannedToolNames) {
    try {
      new RegExp(`\\b${t}\\b`, 'i');
    } catch (e) {
      fail(path, `"prose.extraBannedToolNames" has an invalid regex fragment "${t}" (${e.message})`);
    }
  }

  return {
    repos,
    deployRepos,
    checkouts,
    owed: { owners: owed.owners ?? null, specDirs: owed.specDirs ?? null, docDirs: owed.docDirs ?? null },
    telegram: { chatId: telegram.chatId ?? null, chatIds },
    smoke,
    liveFlags,
    stalePreviewAgeDays,
    vercelProject,
    artifacts: { docViewerUrl, registry },
    prose: { extraBannedToolNames },
  };
}

/**
 * Read + validate the project's reporting config. Throws ReportingConfigError — naming the file and how
 * to create it — when it is absent. Never returns a default.
 */
export function loadReportingConfig({
  root = DEFAULT_ROOT,
  env = process.env,
  read = readFileSync,
  exists = existsSync,
} = {}) {
  const path = configPath({ root, env });
  // The `reporting` section of golden-frijoles.config.json over the legacy file (D9); REPORTING_CONFIG still moves
  // the legacy file, the local override still layers on top, and validation stays here.
  const section = readSection('reporting', {
    root,
    legacyRead: read,
    legacyExists: exists,
    legacyPath: path,
    onLegacyError: (p, e) => fail(p, `is not valid JSON (${e.message})`),
  });
  if (!section.present) {
    throw new ReportingConfigError(
      `${path} not found — the reporting scripts refuse to guess which repos to read or where to post.\n` +
        `  Copy ${EXAMPLE_FILENAME} to ${CONFIG_FILENAME} at the repo root, fill it in, and commit it.`
    );
  }
  const parse = (p) => {
    try {
      return JSON.parse(read(p, 'utf8'));
    } catch (e) {
      return fail(p, `is not valid JSON (${e.message})`);
    }
  };
  let raw = section.raw;
  const localPath = join(dirname(path), LOCAL_FILENAME);
  if (exists(localPath)) raw = mergeLocal(raw, parse(localPath));
  return validateReportingConfig(raw, path);
}

/** Pure — overlay the gitignored local file: top-level keys replace, `telegram` merges one level deep. */
export function mergeLocal(base, local) {
  if (!local || typeof local !== 'object' || Array.isArray(local)) return base;
  const out = { ...base, ...local };
  if (base?.telegram || local.telegram) {
    out.telegram = {
      ...(base?.telegram || {}),
      ...(local.telegram || {}),
      chatIds: { ...(base?.telegram?.chatIds || {}), ...(local.telegram?.chatIds || {}) },
    };
  }
  return out;
}

/**
 * The chat to post a surface to: the surface's own id, then the project-wide one, then TELEGRAM_CHAT_ID.
 * Returns null when none is set — the caller must refuse to send rather than pick one.
 */
export function chatIdFor(config, surface, env = process.env) {
  return config?.telegram?.chatIds?.[surface] || config?.telegram?.chatId || env.TELEGRAM_CHAT_ID || null;
}

/** "owner/name" → "name", the label the reports print. */
export function shortRepo(repo) {
  return repo.split('/')[1] || repo;
}
