#!/usr/bin/env node
// pmo-report.mjs — gather PMO operational metrics for the current report window.
//
// This is intentionally a root-repo script, not an app surface. It reuses the ops-routines rail:
// REST-only GitHub reads (gh-rest), the weekly-recap-style window log, log-branch persistence, and the
// Telegram formatter's length guard. Prints the report, delivers the weekly one, and persists the window
// only on non-dry --weekly runs.
//
// Project values (repos, deploy repos, chat, doc viewer, registry) come from reporting.config.json via
// scripts/lib/reporting-config.mjs; Roadmap rows come from scripts/roadmap-extract.mjs (the same SSOT
// extractor build-order.mjs reads). Ported into the dobby-foundation template by
// plugin-audit-and-extraction S1 — metric logic unchanged from the origin.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listPulls, searchMergedPrs } from './lib/gh-rest.mjs';
import { readLogFromBranch, appendLineToBranch } from './lib/log-branch.mjs';
import { telegramHtmlToConsoleText, truncateForTelegram } from './lib/telegram-format.mjs';
import { buildTelegramDeliveryMessage, sendTelegramMessage } from './lib/pmo-delivery.mjs';
import { loadReportingConfig, chatIdFor, ReportingConfigError } from './lib/reporting-config.mjs';
import {
  benchmarkTemplateValues,
  loadBenchmarkDataset,
  validateBenchmarkDataset,
} from './lib/pmo-benchmarks.mjs';
import { buildDocViewerUrl, fillPmoTemplate } from './lib/pmo-templates.mjs';
import { upgradeArtifactLinks } from './lib/report-registry.mjs';
import { parseStatusFlipsFromLog, filterFlipsToWindow } from './weekly-recap.mjs';
import { baselineSummary, formatBaselineSummary, summarizePmoMetrics } from './lib/pmo-metrics.mjs';
import { computePmoWindow, formatPmoReport, lastPmoLogEntry, pmoLogLine } from './lib/pmo-window-log.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { isMain } from './lib/is-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(); // D2
const LOG_BRANCH = 'claude/pmo-reports-log';
const LOG_BRANCH_PATH = 'pmo-reports.log';
const LOG_MESSAGE = 'chore(pmo): append operational report window';

export function parseArgs(argv) {
  const has = (flag) => argv.includes(flag);
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1] || null;
  };
  return {
    dryRun: has('--dry-run'),
    weekly: has('--weekly'),
    monthly: has('--monthly'),
    sheet: has('--sheet') || has('--monthly'),
    open: has('--open'),
    sinceISO: value('--since'),
    untilISO: value('--until'),
  };
}

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function runNode(args) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function loadRoadmapRows() {
  const result = runNode([join(__dirname, 'roadmap-extract.mjs')]); // a sibling, never the project's copy
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout || '[]');
  } catch {
    return [];
  }
}

export function loadLogContent({
  readRemoteLog = () => readLogFromBranch({ cwd: ROOT, branch: LOG_BRANCH, path: LOG_BRANCH_PATH }),
} = {}) {
  return readRemoteLog();
}

export function gatherRepoResults(
  sinceISO,
  untilISO,
  { repos, searchMerged = searchMergedPrs, listOpen = listPulls } = {}
) {
  return repos.map((repo) => {
    const prs = searchMerged({ repo, sinceDate: sinceISO.slice(0, 10), base: 'main' });
    const openPrs = listOpen({ repo, state: 'open', perPage: 100 });
    if (prs === null || openPrs === null) return { repo, available: false, prs: [], openPrs: [] };
    return {
      repo,
      available: true,
      prs: prs.filter((pr) => pr.mergedAt >= sinceISO && pr.mergedAt < untilISO),
      openPrs,
    };
  });
}

function gatherEpicStatusFlips(sinceISO, untilISO) {
  const result = git([
    'log',
    '--since',
    sinceISO,
    '--until',
    untilISO,
    '--date=iso-strict',
    '-p',
    '--reverse',
    '--',
    'Roadmap/*/*/README.md',
  ]);
  if (result.status !== 0) return [];
  return filterFlipsToWindow(parseStatusFlipsFromLog(result.stdout || ''), sinceISO, untilISO);
}

function epicSlugFromPath(path) {
  const m = /^Roadmap\/((?:0[1-9]|10)-[^/]+)\/([^/]+)\//.exec(path);
  return m ? `${m[1]}/${m[2]}` : null;
}

function gatherDocOpsInputs(sinceISO, untilISO, epicStatusFlips) {
  const result = git([
    'log',
    '--since',
    sinceISO,
    '--until',
    untilISO,
    '--name-only',
    '--pretty=format:commit:%H',
    '--',
    'Roadmap',
  ]);
  const paths =
    result.status === 0 ? result.stdout.split('\n').filter((line) => line.startsWith('Roadmap/')) : [];
  const docChanges = paths.flatMap((path) => {
    const epicSlug = epicSlugFromPath(path);
    return epicSlug ? [{ epicSlug, path }] : [];
  });
  const learningsPromotions = [...new Set(paths.filter((path) => path === 'Roadmap/LEARNINGS.md'))].map(
    (path) => ({ path })
  );
  const shippedEpics = epicStatusFlips
    .filter((flip) => flip.status === 'shipped')
    .map((flip) => ({
      slug: epicSlugFromPath(flip.file),
      hasRetrospective: existsSync(join(ROOT, dirname(flip.file), 'RETROSPECTIVE.md')),
    }));
  return { docChanges, learningsPromotions, shippedEpics };
}

function firstCommitDateForPath(path) {
  const result = git(['log', '--diff-filter=A', '--follow', '--format=%aI', '--reverse', '--', path]);
  if (result.status !== 0) return null;
  return result.stdout.trim().split('\n').filter(Boolean)[0] || null;
}

function gatherEpicLeadInputs(epicStatusFlips) {
  return epicStatusFlips
    .filter((flip) => flip.status === 'shipped')
    .flatMap((flip) => {
      const scaffoldedAt = firstCommitDateForPath(flip.file);
      if (!scaffoldedAt) return [];
      return [{ slug: epicSlugFromPath(flip.file), scaffoldedAt, shippedAt: flip.date }];
    });
}

export function buildReport({
  window,
  repoResults,
  roadmapRows,
  epicStatusFlips,
  docOpsInputs,
  epicLeadInputs,
  deployRepos = [],
}) {
  const prs = repoResults.flatMap((result) => result.prs);
  const metrics = summarizePmoMetrics({
    ...window,
    deployRepos,
    repoResults,
    prs,
    changeItems: prs,
    epics: epicLeadInputs,
    roadmapRows,
    epicStatusFlips,
    storyShipEvents: [],
    ...docOpsInputs,
  });
  const baselineLine = window.baseline
    ? formatBaselineSummary(
        baselineSummary({ repoResults, roadmapRows, docChanges: docOpsInputs.docChanges })
      )
    : null;
  return { metrics, text: truncateForTelegram(formatPmoReport({ metrics, baselineLine }), 4096) };
}

export function loadReportBenchmarks() {
  const dataset = loadBenchmarkDataset();
  const errors = validateBenchmarkDataset(dataset);
  if (errors.length) throw new Error(`Invalid PMO benchmark dataset:\n${errors.join('\n')}`);
  return benchmarkTemplateValues(dataset);
}

// No doc viewer configured → no artifacts. The Telegram text and the console report still carry every
// number; the decks are an optional rendering and never borrow another project's hosting.
export function buildReportArtifacts(metrics, args, { docViewerUrl = null, benchmarks } = {}) {
  const artifacts = [];
  if (!docViewerUrl) return artifacts;
  benchmarks ??= loadReportBenchmarks();
  for (const [name, enabled] of [
    ['weekly', args.weekly],
    ['monthly', args.monthly],
    ['sheet', args.sheet],
  ]) {
    if (!enabled) continue;
    const markdown = fillPmoTemplate(name, metrics, { benchmarks });
    artifacts.push({
      name,
      markdown,
      url: buildDocViewerUrl(markdown, { baseUrl: docViewerUrl, present: name === 'weekly' }),
    });
  }
  return artifacts;
}

export function shouldSendWeeklyTelegram(args) {
  return args.weekly && !args.dryRun;
}

export function shouldPersistWindow(args) {
  if (args.dryRun) return false;
  return args.weekly;
}

function openUrl(url) {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('open', [url], { encoding: 'utf8' });
  return result.status === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let config;
  try {
    config = loadReportingConfig({ root: ROOT });
  } catch (e) {
    if (e instanceof ReportingConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const deployRepos = config.deployRepos.map((d) => d.repo);
  const logContent = loadLogContent();
  const lastLog = lastPmoLogEntry(logContent);
  const window = computePmoWindow(lastLog, new Date(), args);

  const roadmapRows = loadRoadmapRows();
  const repoResults = gatherRepoResults(window.sinceISO, window.untilISO, { repos: config.repos });
  const epicStatusFlips = gatherEpicStatusFlips(window.sinceISO, window.untilISO);
  const docOpsInputs = gatherDocOpsInputs(window.sinceISO, window.untilISO, epicStatusFlips);
  const epicLeadInputs = gatherEpicLeadInputs(epicStatusFlips);
  const { metrics, text } = buildReport({
    window,
    repoResults,
    roadmapRows,
    epicStatusFlips,
    docOpsInputs,
    epicLeadInputs,
    deployRepos,
  });

  console.log(text);
  const artifacts = buildReportArtifacts(metrics, args, { docViewerUrl: config.artifacts.docViewerUrl });
  if ((args.weekly || args.monthly || args.sheet) && !config.artifacts.docViewerUrl) {
    console.log('\nNo artifacts.docViewerUrl in reporting.config.json — deck/packet/sheet links skipped.');
  }
  // reporthub-as-notion S1.3: try to upgrade each artifact's URL-hash link to a short gs://-backed
  // /r/<slug> link (scripts/lib/report-registry.mjs). Mutates `artifacts` in place; on any upload
  // failure (no credentials, unreachable bucket, ...) the artifact keeps the URL-hash link it already
  // had — printed below and, for --weekly, the one that reaches Telegram either way. `--dry-run` never
  // writes to the registry (dryRun: args.dryRun) — it logs the would-be slug/link and keeps the
  // URL-hash fallback, same as it already skips Telegram and the window log.
  await upgradeArtifactLinks(artifacts, {
    date: window.untilISO ? new Date(window.untilISO) : new Date(),
    dryRun: args.dryRun,
    baseUrl: config.artifacts.registry?.resolverBaseUrl,
    bucket: process.env.REPORT_REGISTRY_BUCKET || config.artifacts.registry?.bucket,
  });
  for (const artifact of artifacts) {
    console.log(`\nDeck ${artifact.name}: ${artifact.url}`);
    if (args.open) {
      const opened = openUrl(artifact.url);
      console.log(
        opened
          ? `Opened ${artifact.name} in the browser.`
          : `Could not auto-open ${artifact.name}; use the URL above.`
      );
    }
  }

  if (args.weekly) {
    const message = buildTelegramDeliveryMessage({ metrics, artifacts });
    if (shouldSendWeeklyTelegram(args)) {
      const chatId = chatIdFor(config, 'pmo');
      await sendTelegramMessage({ chatId, text: message });
      console.log('\nTelegram weekly PMO report sent.');
    } else {
      console.log('\nDry run: Telegram weekly PMO report not sent.');
      console.log(telegramHtmlToConsoleText(message));
    }
  }

  if (!shouldPersistWindow(args)) {
    const reason =
      args.monthly || args.sheet
        ? 'On-demand artifact run: window log not updated.'
        : 'Window log not updated; run --weekly to deliver and advance the PMO window.';
    console.log(args.dryRun ? '\nDry run: window log not updated.' : `\n${reason}`);
    return;
  }

  const ok = appendLineToBranch({
    cwd: ROOT,
    branch: LOG_BRANCH,
    path: LOG_BRANCH_PATH,
    line: pmoLogLine({ window, metrics, baselineEstablished: !!window.baseline }),
    message: LOG_MESSAGE,
  });
  if (!ok) {
    console.error(`Failed to persist ${LOG_BRANCH_PATH} on ${LOG_BRANCH}.`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
