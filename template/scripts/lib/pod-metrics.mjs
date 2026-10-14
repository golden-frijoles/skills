// pod-metrics.mjs — the Pod Report's delivery metrics, computed from real git/PR data.
//
// pod-report · Sprint 2, Story 2.1. Pure: every function here takes already-gathered data and
// returns a value. No git, no network, no clock. That is what makes the sprint's headline
// acceptance criterion — "rerun from the same inputs ⇒ byte-identical artifact" — testable at all.
//
// ── The amendment this file implements (Daniel, 2026-07-25) ───────────────────────────────────
// The epic originally promised "human-baseline era vs agent-augmented era of the SAME repo". That
// comparison is not computable: medusa-bonsai is agent-native from its first commit (75% of June's
// commits carry a Claude co-author trailer, 86% of July's, 691 of 846 overall). There is no
// human-majority era to baseline against.
//
// So the baseline is PUBLISHED BENCHMARKS — our numbers computed, theirs cited — and anything the
// data cannot support renders as **not instrumented**, never as a zero. That distinction is the
// whole ethic of this epic: a fabricated 0% change-failure-rate would be the most flattering
// number on the page and the least true.
//
// NOT INSTRUMENTED, and why — each one is also a guardrail a pods engagement installs:
//   · velocity (points/sprint)     — story points do not exist anywhere in the dataset
//   · cost per shipped point       — no points, and no token/cost ledger
//   · change failure rate          — 0 true `git revert` commits in 846; no rollback mechanism
//   · failed-deployment recovery   — no incident record to measure against
//   · story-level throughput       — no per-story ship event (mb's own rail hardcodes it empty)

/** The metrics we deliberately do not compute, with the reason shown to the reader. */
export const NOT_INSTRUMENTED = [
  {
    key: 'velocity',
    label: 'Velocity (points per sprint)',
    reason: 'Story points are not tracked in this dataset — there is nothing to sum.',
    guardrail: 'Adopt a sizing convention, or accept throughput as the honest substitute.',
  },
  {
    key: 'cost_per_point',
    label: 'Cost per shipped point',
    reason: 'Needs both story points and a token/spend ledger. Neither exists.',
    guardrail: 'Instrument agent spend per epic; pair it with a sizing convention.',
  },
  {
    key: 'change_failure_rate',
    label: 'Change failure rate',
    reason:
      'Zero true revert commits across the whole history. Fixes are folded forward, so there is no ' +
      'rollback signal to count — a computed rate here would read 0% and mean "not measured", not "no failures".',
    guardrail: 'Record deploy outcomes and link incidents to the change that caused them.',
  },
  {
    key: 'recovery_time',
    label: 'Failed-deployment recovery time',
    reason: 'Requires paired incident start/resolve timestamps. No incident record exists.',
    guardrail: 'An incident log with timestamps, linked to deploys.',
  },
  {
    key: 'story_throughput',
    label: 'Throughput (stories per period)',
    reason:
      'No per-story ship event carries a timestamp. Epic-level throughput below is computed; ' +
      'story-level is not derivable without inventing a date.',
    guardrail: 'Emit a ship event per story, or track story status transitions with dates.',
  },
];

/** Percentile over an unsorted numeric array. Nearest-rank — no interpolation, so it is exact. */
export function percentile(values, p) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * True median — the AVERAGE of the two middle values on an even count, not the lower one.
 *
 * `percentile(values, 50)` would be the obvious implementation and it is the wrong one here.
 * Nearest-rank picks the LOWER middle, so a two-epic dataset of 2 and 4 days reports 2 days — the
 * faster, more flattering number, selected by an implementation detail rather than by the data. On
 * a sales artifact every such coin-flip has to land on the conservative side, and the standard
 * definition of a median happens to be that side. Percentiles above stay nearest-rank, which is
 * their standard definition.
 */
export function median(values) {
  const sorted = [...(values ?? [])].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * PR review latency — opened → merged, in hours.
 *
 * ── Renamed from "cycle time", and the rename is the honest part ──────────────────────────────
 * Measured against the real dataset before shipping: the median came out at 0.16 hours — under ten
 * minutes — and a fifth of PRs merge within sixty seconds of opening. That is not a delivery speed.
 * In this pod's workflow the branch is built first and the PR is opened as the final step, so this
 * interval measures the REVIEW-AND-MERGE formality, not how long the work took.
 *
 * Reported as "review latency" and explicitly marked NOT comparable to DORA's change lead time
 * (commit → production), because presenting a nine-minute number beside DORA's "under one day
 * is elite" would be the single most flattering and least meaningful line in the whole report.
 * `comparableToDora: false` is a structural field, not a footnote, so a renderer cannot drop it.
 *
 * Unmerged PRs are excluded rather than counted as open-forever, which would turn this into a
 * measure of the backlog.
 */
export function cycleTimeHours(prs) {
  const durations = (prs ?? [])
    .filter((pr) => pr.createdAt && pr.mergedAt)
    .map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0);

  const base = {
    comparableToDora: false,
    interpretation:
      'Time from a pull request being opened to being merged. In this pod the branch is built first ' +
      'and the PR is opened as the final step, so this measures review-and-merge latency — NOT how ' +
      'long the work took, and NOT comparable to DORA change lead time (commit to production).',
  };
  if (durations.length === 0) return { ...base, count: 0, medianHours: null, p90Hours: null };
  return {
    ...base,
    count: durations.length,
    medianHours: round(median(durations), 2),
    p90Hours: round(percentile(durations, 90), 2),
  };
}

/**
 * Epic lead time — first commit touching the epic's docs → the commit that flipped it to shipped.
 *
 * Days, not hours: an epic spans days and reporting it to two decimal places would imply a
 * precision the underlying "when did this really start" question does not have.
 */
export function epicLeadTimeDays(epics) {
  const withBothDates = (epics ?? []).filter((e) => e.startedAt && e.shippedAt);

  // ── Exclude RETROACTIVELY DOCUMENTED epics, or the median is a documentation artifact ───────
  // Measured against the real dataset: many epic READMEs were committed with `status: shipped`
  // ALREADY SET — the create-commit and the ship-flip are the same commit, to the second. Those
  // epics were written up after the fact, so their "lead time" is zero by construction and says
  // nothing about delivery. Including them dragged the median to 0 days, which would have been the
  // most impressive and least true figure in the report.
  //
  // A one-hour floor separates "documented after the work" from "genuinely fast": no epic is
  // planned, built and shipped inside an hour, so anything below it is bookkeeping.
  const RETRO_THRESHOLD_MS = 60 * 60 * 1000;
  const spansMs = withBothDates
    .map((e) => Date.parse(e.shippedAt) - Date.parse(e.startedAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const measurable = spansMs.filter((ms) => ms >= RETRO_THRESHOLD_MS);
  const retroactivelyDocumented = spansMs.length - measurable.length;

  const base = {
    retroactivelyDocumented,
    interpretation:
      retroactivelyDocumented > 0
        ? `${retroactivelyDocumented} epic(s) were documented after the work — their README was committed with the shipped status already set, so no elapsed time is measurable for them and they are excluded rather than counted as zero.`
        : 'Elapsed days from the epic doc first appearing to its status flipping to shipped.',
  };

  const spans = measurable.map((ms) => ms / 86_400_000);
  if (spans.length === 0) return { ...base, count: 0, medianDays: null, p90Days: null };
  return {
    ...base,
    count: spans.length,
    medianDays: round(median(spans), 1),
    p90Days: round(percentile(spans, 90), 1),
  };
}

/**
 * outcome-report-any-product D1 — the one reading of an epic README's `status:` value: unquoted, lower-case, trimmed.
 * The kit's `parseFrontmatter` already drops an inline `# comment`; this also accepts `"shipped"` / `'shipped'`, which the
 * old text search (`git log -S 'status: shipped'`) could not see.
 */
export function normalizeStatus(value) {
  if (typeof value !== 'string') return null;
  const v = value
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim()
    .toLowerCase();
  return v === '' ? null : v;
}

/**
 * outcome-report-any-product D1 + D2 — an epic's status history from its README's revisions, OLDEST first:
 * `[{ commit, at, subject, status }]` (status already normalised; `null` when the revision has none).
 *
 *   shippedAt     — the FIRST revision whose status is `shipped` (the product owner, 2026-10-14: lead time runs to the
 *                   first ship). A README whose first revision is already shipped keeps that date, and
 *                   epicLeadTimeDays files it as "documented after the work", exactly as before.
 *   statusHistory — the status CHANGES only, `{ at, from, to, commit, subject }`; an edit that leaves the parsed value
 *                   alone (a reworded comment) is not a change.
 *   reopenedAt / reshippedAt — the first time it LEFT `shipped` after shipping, and the next time it shipped again.
 *
 * Pure: no git, no clock. The I/O half (scripts/pod-report.mjs → readEpics) hands it the revisions.
 */
export function epicHistory(revisions) {
  const statusHistory = [];
  let previous = null;
  for (const revision of revisions ?? []) {
    const status = revision.status ?? null;
    if (status !== previous) {
      statusHistory.push({
        at: revision.at,
        from: previous,
        to: status,
        commit: revision.commit,
        subject: revision.subject ?? '',
      });
      previous = status;
    }
  }
  // By position in the history, never by comparing date strings: two commits' ISO dates can carry different offsets.
  const shipIndex = statusHistory.findIndex((change) => change.to === 'shipped');
  const firstShip = shipIndex === -1 ? null : statusHistory[shipIndex];
  const reopenIndex =
    shipIndex === -1
      ? -1
      : statusHistory.findIndex((change, i) => i > shipIndex && change.from === 'shipped');
  const reopen = reopenIndex === -1 ? null : statusHistory[reopenIndex];
  const reshipIndex =
    reopenIndex === -1
      ? -1
      : statusHistory.findIndex((change, i) => i > reopenIndex && change.to === 'shipped');
  const reship = reshipIndex === -1 ? null : statusHistory[reshipIndex];
  return {
    shippedAt: firstShip ? firstShip.at : null,
    statusHistory,
    reopenedAt: reopen ? reopen.at : null,
    reopenedBy: reopen ? reopen.subject : null,
    reshippedAt: reship ? reship.at : null,
  };
}

/**
 * outcome-report-any-product D2 — rework, as its OWN number: of the epics that shipped, how many left `shipped`
 * afterwards, and the median days until they shipped again. Never folded into lead time. No reason is inferred;
 * each re-opened epic carries the subject of the commit that re-opened it.
 */
export function reworkSummary(epics) {
  const shipped = (epics ?? []).filter((epic) => epic.shippedAt);
  const reopened = shipped.filter((epic) => epic.reopenedAt);
  const reshipDays = reopened
    .filter((epic) => epic.reshippedAt)
    .map((epic) => (Date.parse(epic.reshippedAt) - Date.parse(epic.reopenedAt)) / 86_400_000)
    .filter((days) => Number.isFinite(days) && days >= 0);
  return {
    reopened: reopened.length,
    of: shipped.length,
    medianDaysToReship: reshipDays.length ? round(median(reshipDays), 1) : null,
    epics: reopened
      .map((epic) => ({
        slug: epic.slug,
        reopenedAt: epic.reopenedAt,
        reshippedAt: epic.reshippedAt ?? null,
        subject: epic.reopenedBy ?? '',
      }))
      .sort((a, b) => (a.reopenedAt < b.reopenedAt ? -1 : a.reopenedAt > b.reopenedAt ? 1 : 0)),
  };
}

/**
 * Deploy frequency — a LABELLED PROXY, and the label is not optional.
 *
 * There is no deploy log in the dataset, so this counts merged PRs per week and says so. medusa-
 * bonsai's own pmo-report calls its equivalent field `changeFailProxy` in its source; we inherit
 * the caveat rather than quietly dropping it. A reader who sees "deploys per week" without the
 * proxy note has been misled, which is why `isProxy` is a required part of the shape rather than a
 * comment.
 */
export function deployFrequency(prs, windowDays) {
  const merged = (prs ?? []).filter((pr) => pr.mergedAt).length;
  const weeks = windowDays > 0 ? windowDays / 7 : 0;
  return {
    isProxy: true,
    proxyNote:
      'Merged pull requests per week. No deploy log exists in this dataset, so this is a proxy for deploy frequency, not a measurement of it.',
    mergedPrs: merged,
    perWeek: weeks > 0 ? round(merged / weeks, 1) : null,
  };
}

/** Epic throughput — the one throughput figure that IS derivable (status flips carry commit dates). */
export function epicThroughput(epics, windowDays) {
  const shipped = (epics ?? []).filter((e) => e.shippedAt).length;
  const weeks = windowDays > 0 ? windowDays / 7 : 0;
  return { shipped, perWeek: weeks > 0 ? round(shipped / weeks, 2) : null };
}

/**
 * Agent-authorship share, by month.
 *
 * Reported as a COMPOSITION fact, never as a productivity claim. It says who co-authored the
 * commits, which is exactly what the trailer records — it does not say the agents wrote most of the
 * value, and the report must not imply that. This is also the evidence that killed the original
 * human-vs-agent framing, so it earns its place on the page by explaining why that comparison is
 * absent.
 */
export function authorshipByMonth(commits) {
  const months = new Map();
  for (const c of commits ?? []) {
    const month = (c.date ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (!months.has(month)) months.set(month, { month, total: 0, agentCoAuthored: 0 });
    const row = months.get(month);
    row.total++;
    if (c.agentCoAuthored) row.agentCoAuthored++;
  }
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((r) => ({ ...r, agentShare: r.total > 0 ? round(r.agentCoAuthored / r.total, 3) : null }));
}

/**
 * Assemble the full delivery section.
 *
 * DETERMINISM: this function must be a pure map from `input` to output. It takes no clock — the
 * caller supplies `generatedAt` — because a `new Date()` in here would make every run differ and
 * quietly break the sprint's byte-identical acceptance criterion.
 */
export function computeDelivery(input) {
  const { prs = [], epics = [], commits = [], windowDays = 0, generatedAt } = input;
  return {
    windowDays,
    generatedAt,
    cycleTime: cycleTimeHours(prs),
    epicLeadTime: epicLeadTimeDays(epics),
    deployFrequency: deployFrequency(prs, windowDays),
    epicThroughput: epicThroughput(epics, windowDays),
    rework: reworkSummary(epics),
    authorship: authorshipByMonth(commits),
    notInstrumented: NOT_INSTRUMENTED,
  };
}

/**
 * Round to `places`, DETERMINISTICALLY.
 *
 * Read the claim carefully, because an earlier version of this comment overstated it and the test
 * written from that claim failed: `toFixed` does NOT give textbook half-up rounding. `1.005` is not
 * exactly 1.005 in binary — it is 1.00499999… — so `round(1.005, 2)` returns 1, not 1.01. No
 * decimal-rounding approach in floating point fixes that; only decimal arithmetic would.
 *
 * What this DOES guarantee is the property the artifact actually needs: the same input always
 * produces the same output, on any machine, on any run. Determinism is the acceptance criterion
 * here — "byte-identical artifact from the same inputs" — not half-up correctness at the third
 * decimal of a metric reported to two.
 */
export function round(n, places) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Number(Number(n).toFixed(places));
}
