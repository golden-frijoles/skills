// maturity-lens.mjs — places a pod on the published Steps-of-AI-Adoption ladder.
//
// pod-report · Sprint 2, Story 2.4. Pure, sibling of `pod-metrics.mjs`: every function here takes
// already-gathered evidence and returns a value. No git, no network, no clock, no imports beyond
// node builtins (in fact: no imports at all). That is what makes "rerun from the same inputs ⇒
// byte-identical maturity section" testable, and it is inherited straight from 2.1's determinism
// spec (see sprint-2.md Story 2.4 acceptance).
//
// ── The five rules this file exists to enforce (sprint-2.md, Story 2.4 + README amendment) ──────
//
// 1. EVIDENCE IS REQUIRED FOR EVERY `met` ROW, STRUCTURALLY. `makeCriterionRow` below has no
//    `status` parameter — status is DERIVED from whether an evidence pointer was handed in. A
//    scorer literally cannot produce a `met` row without a real evidence object, because there is
//    no code path that sets status to `met` any other way. This is the acceptance criterion "the
//    renderer is structurally incapable of an unevidenced claim", implemented at the one chokepoint
//    every row passes through.
// 2. THREE STATES ONLY: `met` · `not_met` · `not_instrumented`. `makeCriterionRow` is the only
//    place a status string is written, and it only ever writes one of these three.
// 3. THE VERDICT AND THE NOT-INSTRUMENTED COUNT COME FROM ONE FUNCTION, ONE OBJECT. `scoreVerdict`
//    returns `{ step, stepLabel, metCriteria, totalCriteria, notInstrumentedCount }` as a single
//    return value — there is no way to read `step` off a call that didn't also compute
//    `notInstrumentedCount`, so a caller cannot render the score while dropping the coverage gap
//    that qualifies it.
// 4. EVERY DERIVED ROW STATES ITS PROXY NATURE. Every criterion here is inferred from git/PR shape
//    (a trailer, a check name, a timestamp overlap) — none of it is direct observation of intent or
//    quality. `proxyNote` is a required field on every row, met or not.
// 5. A DELIBERATELY LOW-MATURITY FIXTURE MUST SCORE LOW. `scoreVerdict` starts at step 0 and only
//    rises off zero if at least one criterion is actually `met` — an all-empty or all-failing input
//    cannot be nudged to "Assisted" by the absence of data. See maturity-lens.test.mjs.
//
// ── Expected input shape (the gatherer's contract; not enforced at runtime — missing fields render
//    the affected criterion `not_instrumented`, never crash) ─────────────────────────────────────
//   {
//     prs: [{
//       number, createdAt, mergedAt, closedAt,
//       reviewComments: [{ isAgentReviewer }],   // automated_code_review
//       ciCheckNames: ['lint', 'test', ...],     // code_quality_enforcement
//       ciPassedBeforeMerge: boolean,            // trusted_self_verification_loop
//       riskTier: 'LOW' | 'MEDIUM' | 'HIGH',     // risk_tier_merge_discipline
//       mergedByIsAgent: boolean,                // risk_tier_merge_discipline
//     }],
//     commits: [{ date, agentCoAuthored, isRevert }],
//     hasClaudeMd: boolean,
//     skillsProvenance: [{ plugin, ref }],
//   }
//
// ── Not derivable, and why (fixed for v1 — see sprint-2.md's "Rendered not instrumented" list) ───
// These six never touch `prs`/`commits`/`hasClaudeMd` at all: no shape of git/PR evidence answers
// them, so they are declared gaps rather than criteria that could theoretically fail to be met.
// Each is also a guardrail named on the ladder itself — the upsell IS the honest gap.
export const NOT_INSTRUMENTED = [
  {
    key: 'auto_mode_state',
    label: 'Auto-mode state',
    reason:
      'Whether auto mode is enabled is a local CLI/session setting. It is never written into a ' +
      'commit or a PR, so git history cannot answer it either way.',
    guardrail:
      'OpenTelemetry export of session state into the existing SIEM/observability stack (Step 1 guardrail).',
  },
  {
    key: 'live_agent_concurrency',
    label: 'Live agent-concurrency count',
    reason:
      'How many agents are running at once is a point-in-time process fact. Git only records ' +
      'commits after the fact and never captures how many sessions were open concurrently.',
    guardrail: 'Analytics to monitor team usage (Step 2 guardrail) — a live agent-concurrency dashboard.',
  },
  {
    key: 'token_cost_per_outcome',
    label: 'Token / cost per outcome',
    reason:
      'No token or spend ledger exists anywhere in git history. Cost-per-outcome needs a billing ' +
      'or usage-API join this dataset does not have — same gap pod-metrics.mjs names for cost-per-point.',
    guardrail: 'Manage token use with model selection + the Analytics API (Step 3 guardrail).',
  },
  {
    key: 'automatic_security_review',
    label: 'Automatic security review',
    reason:
      'A security-specific review pass is not distinguishable from an ordinary code-quality check ' +
      'in PR metadata unless it runs as its own named CI check — which this dataset does not carry.',
    guardrail: 'Claude Security Review wired in as a named CI check (Step 2–3 guardrail/product).',
  },
  {
    key: 'proactive_agent_kickoff_monitor',
    label: 'Proactive agent-kicks-off-agent monitor',
    reason:
      'Whether an agent proactively kicked off another agent, versus a human invoking it, is not ' +
      'recorded by git — the resulting commit and PR look identical either way.',
    guardrail:
      'Claude Tag monitoring a channel or data source and kicking off tasks proactively (Step 3 product) — instrument the trigger source.',
  },
  {
    key: 'agent_sandboxing',
    label: 'Agent sandboxing',
    reason:
      'Sandbox usage is a runtime execution-environment fact. It leaves no trace in git or PR ' +
      'metadata once the run completes.',
    guardrail: 'Agent sandboxing (Step 3 product) — record sandbox usage per run.',
  },
];

/**
 * The ladder this lens scores against — VERSION-PINNED so an old report stays interpretable
 * against the ladder it was scored on, even after the source document is revised.
 *
 * Title + author + date come from the source file's own header (`references/Steps-of-AI-Adoption.md`,
 * "Boris Cherny · Jul 16, 2026"). Per the epic's licensing posture: cite + link, never republish
 * the table wholesale — this object carries the citation, not the ladder's content.
 */
export const LADDER_CITATION = {
  title: 'Steps of AI Adoption',
  author: 'Boris Cherny',
  date: '2026-07-16',
  source: 'references/Steps-of-AI-Adoption.md',
};

/** Human-readable name for each ladder step, keyed by step number (0–4). */
export const STEP_LABELS = {
  0: 'Gated',
  1: 'Assisted',
  2: 'Parallel',
  3: 'Supervised autonomy',
  4: 'AI-native',
};

/**
 * The ONE constructor every criterion row passes through. This is rule 1 and rule 2, implemented
 * as code rather than convention: there is no `status` parameter, so a scorer cannot hand this
 * function a claim of `met` — it can only hand over evidence (or not) and let the status follow.
 *
 *   - `evidence` truthy  → status is ALWAYS 'met'. Evidence wins; nothing else is consulted.
 *   - `evidence` falsy, `notInstrumentedReason` given → 'not_instrumented'.
 *   - `evidence` falsy, neither reason given → 'not_met' (a generic reason is supplied so the row
 *     is never silently blank).
 */
function makeCriterionRow({
  id,
  criterion,
  ladderStep,
  proxyNote,
  evidence = null,
  notMetReason,
  notInstrumentedReason,
}) {
  if (evidence) {
    return { id, criterion, ladderStep, status: 'met', isProxy: true, proxyNote, evidence, reason: null };
  }
  if (notInstrumentedReason) {
    return {
      id,
      criterion,
      ladderStep,
      status: 'not_instrumented',
      isProxy: true,
      proxyNote,
      evidence: null,
      reason: notInstrumentedReason,
    };
  }
  return {
    id,
    criterion,
    ladderStep,
    status: 'not_met',
    isProxy: true,
    proxyNote,
    evidence: null,
    reason: notMetReason ?? 'Criterion evaluated against the supplied evidence; not met.',
  };
}

/**
 * Automated code review present — Step 2 product/guardrail ("Claude Code Review",
 * "manual code review... hold the same quality bar").
 *
 * PROXY: a reviewer-agent PR comment is evidence review RAN, not evidence it caught anything.
 */
export function scoreAutomatedCodeReview({ prs } = {}) {
  const base = {
    id: 'automated_code_review',
    criterion: 'Automated code review present',
    ladderStep: 2,
    proxyNote:
      'A reviewer-agent PR comment is a proxy for "automated review ran on this PR", not proof it caught anything.',
  };
  if (!Array.isArray(prs)) {
    return makeCriterionRow({ ...base, notInstrumentedReason: 'No PR data was supplied to the lens.' });
  }
  if (prs.length === 0) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason: 'PR data was supplied but the window contains zero PRs to evaluate.',
    });
  }
  const reviewed = prs.filter(
    (pr) => Array.isArray(pr.reviewComments) && pr.reviewComments.some((c) => c.isAgentReviewer)
  );
  const ratio = reviewed.length / prs.length;
  if (ratio >= 0.5) {
    return makeCriterionRow({
      ...base,
      evidence: {
        pointerType: 'pr',
        ref: reviewed[0].number,
        detail: `${reviewed.length} of ${prs.length} PRs carry an agent reviewer comment (e.g. PR #${reviewed[0].number})`,
      },
    });
  }
  return makeCriterionRow({
    ...base,
    notMetReason: `Only ${reviewed.length} of ${prs.length} PRs carry an agent reviewer comment — under the 50% presence bar.`,
  });
}

/**
 * Automatic code-quality enforcement — Step 2 guardrail ("lint, automated tests, typecheck").
 *
 * PROXY: a named CI check attached to a PR is a proxy for "quality was enforced automatically",
 * not proof the check was strict or that it actually gated the merge.
 */
export function scoreCodeQualityEnforcement({ prs } = {}) {
  const base = {
    id: 'code_quality_enforcement',
    criterion: 'Automatic code-quality enforcement (CI check names)',
    ladderStep: 2,
    proxyNote:
      'A named CI check on a PR is a proxy for "quality was enforced automatically", not proof the check was strict.',
  };
  if (!Array.isArray(prs)) {
    return makeCriterionRow({ ...base, notInstrumentedReason: 'No PR data was supplied to the lens.' });
  }
  if (prs.length === 0) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason: 'PR data was supplied but the window contains zero PRs to evaluate.',
    });
  }
  const withChecks = prs.filter((pr) => Array.isArray(pr.ciCheckNames) && pr.ciCheckNames.length > 0);
  const ratio = withChecks.length / prs.length;
  if (ratio >= 0.5) {
    const examplePr = withChecks[0];
    return makeCriterionRow({
      ...base,
      evidence: {
        pointerType: 'ci_check',
        ref: examplePr.ciCheckNames[0],
        detail: `${withChecks.length} of ${prs.length} PRs carry at least one CI check (e.g. "${examplePr.ciCheckNames[0]}" on PR #${examplePr.number})`,
      },
    });
  }
  return makeCriterionRow({
    ...base,
    notMetReason: `Only ${withChecks.length} of ${prs.length} PRs carry a CI check name.`,
  });
}

/**
 * Worktree isolation / parallel agents — Step 2 product ("worktree isolation in CLI and Desktop"),
 * evidenced as overlapping branch lifetimes (each open PR stands in for a live worktree/checkout).
 *
 * PROXY: two PR lifetimes overlapping in time is a proxy for parallel agents on separate worktrees,
 * not direct proof either PR ran in an isolated worktree.
 */
export function scoreWorktreeIsolation({ prs } = {}) {
  const base = {
    id: 'worktree_isolation',
    criterion: 'Worktree isolation / parallel agents (overlapping branch lifetimes)',
    ladderStep: 2,
    proxyNote:
      'Two PR lifetimes overlapping in time is a proxy for parallel agents on separate worktrees, not direct proof of worktree usage.',
  };
  if (!Array.isArray(prs)) {
    return makeCriterionRow({ ...base, notInstrumentedReason: 'No PR data was supplied to the lens.' });
  }
  const spans = prs
    .filter((pr) => pr.createdAt && (pr.mergedAt || pr.closedAt))
    .map((pr) => ({
      number: pr.number,
      start: Date.parse(pr.createdAt),
      end: Date.parse(pr.mergedAt ?? pr.closedAt),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);

  if (spans.length < 2) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason:
        'Fewer than two PRs carry both open and close timestamps — nothing to check for overlap.',
    });
  }

  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[j].start < spans[i].end) {
        return makeCriterionRow({
          ...base,
          evidence: {
            pointerType: 'pr',
            ref: `${spans[i].number}+${spans[j].number}`,
            detail: `PR #${spans[i].number} and PR #${spans[j].number} had overlapping open periods`,
          },
        });
      }
    }
  }
  return makeCriterionRow({
    ...base,
    notMetReason: 'No two PRs in the window had overlapping open periods.',
  });
}

/**
 * "Claude writes most of the code" — the exact phrase quoted in the ladder's Step 2 description.
 *
 * PROXY, explicitly: a `Co-Authored-By: Claude` trailer ratio is a proxy for "the agent wrote most
 * of the code", not proof — a human can add the trailer trivially, or an agent can add it to a
 * commit it did not substantially author. Rule 4's example case, by name.
 */
export function scoreClaudeWritesMostCode({ commits } = {}) {
  const base = {
    id: 'claude_writes_most_code',
    criterion: '"Claude writes most of the code" (Co-Authored-By trailer ratio)',
    ladderStep: 2,
    proxyNote:
      'A Co-Authored-By: Claude trailer ratio is a proxy for "the agent wrote most of the code", not proof.',
  };
  if (!Array.isArray(commits)) {
    return makeCriterionRow({ ...base, notInstrumentedReason: 'No commit data was supplied to the lens.' });
  }
  if (commits.length === 0) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason: 'Commit data was supplied but the window contains zero commits.',
    });
  }
  const agentCoAuthored = commits.filter((c) => c.agentCoAuthored).length;
  const ratio = agentCoAuthored / commits.length;
  const pct = Math.round(ratio * 1000) / 10;
  // `>=` not `>`, matching the other presence criteria. At exactly 50% the criteria should agree
  // with one another rather than one silently taking the stricter reading (cross-review, PR #32).
  if (ratio >= 0.5) {
    return makeCriterionRow({
      ...base,
      evidence: {
        pointerType: 'stat',
        ref: `${agentCoAuthored}/${commits.length}`,
        detail: `${pct}% of commits (${agentCoAuthored} of ${commits.length}) carry a Claude co-author trailer`,
      },
    });
  }
  return makeCriterionRow({
    ...base,
    notMetReason: `Only ${agentCoAuthored} of ${commits.length} commits (${pct}%) carry a Claude co-author trailer.`,
  });
}

/**
 * Risk-tier merge discipline — Step 2 guardrail ("manual code review, code merge, and security
 * review — hold the same quality bar for human and agent-generated code").
 *
 * PROXY: a HIGH-tier PR merged under a human identity is a proxy for discipline being followed,
 * not proof the risk assessment itself was correct.
 */
export function scoreRiskTierMergeDiscipline({ prs } = {}) {
  const base = {
    id: 'risk_tier_merge_discipline',
    criterion: 'Risk-tier merge discipline (PR-declared tier vs. merging identity)',
    ladderStep: 2,
    proxyNote:
      'A HIGH-risk PR merged under a human identity is a proxy for merge discipline, not proof the risk tier itself was assessed correctly.',
  };
  if (!Array.isArray(prs)) {
    return makeCriterionRow({ ...base, notInstrumentedReason: 'No PR data was supplied to the lens.' });
  }
  const highTier = prs.filter(
    (pr) => typeof pr.riskTier === 'string' && pr.riskTier.toUpperCase() === 'HIGH' && pr.mergedAt
  );
  if (highTier.length === 0) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason:
        'No PR in the window declares a HIGH risk tier, so there is no high-stakes case to check discipline against.',
    });
  }
  // ── Merge identity must be KNOWN before any claim is made about it ──────────────────────────
  // Cross-review round 5, Blocking, and the worst failure this lens can produce: an earlier version
  // filtered on `mergedByIsAgent === true`, so a PR whose merge identity was never captured
  // (undefined) counted as "not a violation" and the row returned `met` with the evidence string
  // "N of N HIGH-risk PRs were merged under a human identity" — a claim about data that does not
  // exist.
  //
  // Every other row in this lens is careful that unmeasured is not met. This one asserted the
  // opposite in the one place it does most damage, because the evidence READS as specific and
  // checkable. Only PRs whose identity is actually a boolean can support a verdict either way.
  const identified = highTier.filter((pr) => typeof pr.mergedByIsAgent === 'boolean');
  if (identified.length === 0) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason: `${highTier.length} HIGH-risk PR(s) found, but none records who merged it — merge identity was not captured, so discipline cannot be judged either way.`,
    });
  }

  const violations = identified.filter((pr) => pr.mergedByIsAgent === true);
  if (violations.length === 0) {
    return makeCriterionRow({
      ...base,
      evidence: {
        pointerType: 'pr',
        ref: identified[0].number,
        // Counts the IDENTIFIED subset, not the whole high-tier set, so the number in the evidence
        // is the number actually checked. Saying "N of N" while N excluded unidentified PRs would
        // be true-looking and misleading.
        detail:
          `${identified.length} of ${identified.length} HIGH-risk PRs with a recorded merger were merged under a human identity` +
          (identified.length < highTier.length
            ? ` (${highTier.length - identified.length} further HIGH-risk PR(s) record no merger and are excluded)`
            : ''),
      },
    });
  }
  return makeCriterionRow({
    ...base,
    notMetReason: `${violations.length} of ${identified.length} HIGH-risk PRs with a recorded merger were merged under an agent identity.`,
  });
}

/**
 * Trusted self-verification loop — Step 2 description ("Claude checks its own work... before you
 * see it") and Step 3's bottleneck ("trust in the loop"), evidenced as green-gate-before-merge rate
 * paired with revert rate (never CFR itself — see pod-metrics.mjs for why that number is refused).
 *
 * PROXY: a high green-before-merge rate and a low revert rate are proxies for "the team trusts the
 * gate enough to rely on it", not proof the gate is sufficient.
 */
export function scoreTrustedSelfVerificationLoop({ prs, commits } = {}) {
  const base = {
    id: 'trusted_self_verification_loop',
    criterion: 'Trusted self-verification loop (green-gate-before-merge rate, revert rate)',
    ladderStep: 2,
    proxyNote:
      'A high green-before-merge rate and a low revert rate are proxies for "the team trusts the gate", not proof the gate itself is sufficient.',
  };
  if (!Array.isArray(prs) || !Array.isArray(commits)) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason: 'PR and/or commit data was not supplied to the lens.',
    });
  }
  const gateablePrs = prs.filter((pr) => pr.mergedAt && typeof pr.ciPassedBeforeMerge === 'boolean');
  if (gateablePrs.length === 0) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason: 'No merged PR in the window records a pre-merge CI status.',
    });
  }
  const greenCount = gateablePrs.filter((pr) => pr.ciPassedBeforeMerge).length;
  const gateRate = greenCount / gateablePrs.length;
  const revertCount = commits.filter((c) => c.isRevert).length;
  const revertRate = commits.length > 0 ? revertCount / commits.length : 0;
  if (gateRate >= 0.9 && revertRate <= 0.05) {
    return makeCriterionRow({
      ...base,
      evidence: {
        pointerType: 'stat',
        ref: `${greenCount}/${gateablePrs.length}`,
        detail: `${greenCount} of ${gateablePrs.length} merged PRs were green before merge; ${revertCount} of ${commits.length} commits are reverts`,
      },
    });
  }
  return makeCriterionRow({
    ...base,
    notMetReason: `Green-before-merge rate ${(gateRate * 100).toFixed(1)}% and/or revert rate ${(revertRate * 100).toFixed(1)}% fall outside the trusted-loop bar (>=90% green, <=5% reverts).`,
  });
}

/**
 * Standards encoded in CLAUDE.md / Skills — Step 3 guardrail, named explicitly:
 * "`CLAUDE.md` and Skills to encode standards".
 *
 * PROXY: the presence of a CLAUDE.md file (and ways-of-work Skill provenance) is a proxy for
 * "standards are encoded", not proof they are followed.
 */
export function scoreStandardsEncoded({ hasClaudeMd, standardsFile, skillsProvenance } = {}) {
  // `standardsFile` names the file that actually exists; `hasClaudeMd` is the older boolean form,
  // still accepted so an existing caller keeps working. The evidence cites whichever was supplied,
  // because a pointer that names the wrong filename does not resolve — and "every `met` row's
  // evidence resolves" is this lens's central promise, not a nicety.
  const foundFile = standardsFile ?? (hasClaudeMd ? 'CLAUDE.md' : undefined);
  const base = {
    id: 'standards_encoded',
    criterion: 'Standards encoded in CLAUDE.md / Skills',
    ladderStep: 3,
    proxyNote:
      'The presence of CLAUDE.md (and ways-of-work Skill provenance) is a proxy for "standards are encoded", not proof they are followed.',
  };
  if (typeof hasClaudeMd !== 'boolean') {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason: 'Whether CLAUDE.md exists was not supplied to the lens.',
    });
  }
  if (!foundFile) {
    return makeCriterionRow({
      ...base,
      notMetReason: 'Neither CLAUDE.md nor AGENTS.md was found in the pushed extract.',
    });
  }
  const provenance = Array.isArray(skillsProvenance)
    ? skillsProvenance.find((s) => s.plugin === 'ways-of-work')
    : null;
  return makeCriterionRow({
    ...base,
    evidence: {
      pointerType: 'file',
      ref: foundFile ?? 'CLAUDE.md',
      detail: provenance
        ? `${foundFile} present; ways-of-work Skill provenance recorded (${provenance.ref ?? provenance.plugin})`
        : `${foundFile} present in the pushed extract`,
    },
  });
}

/**
 * Feedback remediation loop — Step 4's "scaled automation of domain-specific use cases".
 *
 * PROXY: an agent-resolved task with a resolvable commit or URL pointer is a proxy for "the
 * remediation loop closed", not proof that the remediation itself was correct.
 */
export function scoreFeedbackRemediationLoop({ taskLifecycle, feedbackLoopMinimum = 3 } = {}) {
  const base = {
    id: 'feedback_remediation_loop',
    criterion: 'Agent-resolved feedback remediation loop',
    ladderStep: 4,
    proxyNote:
      'An agent-resolved task with a commit or URL pointer is a proxy for "the remediation loop closed", not proof the fix was correct.',
  };
  if (!taskLifecycle || typeof taskLifecycle !== 'object' || Array.isArray(taskLifecycle)) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason: 'No task-lifecycle data was supplied to the lens.',
    });
  }

  const { agentResolvedTotal, agentResolvedWithEvidence, sampleEvidencePointer } = taskLifecycle;
  if (!Number.isFinite(agentResolvedTotal) || !Number.isFinite(agentResolvedWithEvidence)) {
    return makeCriterionRow({
      ...base,
      notInstrumentedReason:
        'Task-lifecycle data did not contain numeric agent-resolved and evidenced-resolution counts.',
    });
  }

  if (agentResolvedWithEvidence < feedbackLoopMinimum) {
    const missingEvidence = agentResolvedTotal - agentResolvedWithEvidence;
    const evidenceGap =
      missingEvidence > 0
        ? ` Agents resolved ${agentResolvedTotal} task(s), but ${missingEvidence} lack resolvable pointers; an unevidenced resolution is not counted.`
        : '';
    return makeCriterionRow({
      ...base,
      notMetReason:
        `Only ${agentResolvedWithEvidence} agent-resolved task(s) have resolvable evidence, below the ${feedbackLoopMinimum} required for scaled automation.` +
        evidenceGap,
    });
  }

  return makeCriterionRow({
    ...base,
    evidence: {
      pointerType: 'task_lifecycle',
      ref: sampleEvidencePointer ?? `${agentResolvedWithEvidence} evidenced agent-resolved tasks`,
      detail: `${agentResolvedWithEvidence} agent-resolved task(s) have resolvable evidence out of ${agentResolvedTotal} total; threshold: ${feedbackLoopMinimum}.`,
    },
  });
}

/** Every scoreable criterion, in the fixed order they render. */
const SCORERS = [
  scoreAutomatedCodeReview,
  scoreCodeQualityEnforcement,
  scoreWorktreeIsolation,
  scoreClaudeWritesMostCode,
  scoreRiskTierMergeDiscipline,
  scoreTrustedSelfVerificationLoop,
  scoreStandardsEncoded,
  scoreFeedbackRemediationLoop,
];

/**
 * The verdict — rule 3, implemented. `step`/`stepLabel` and `notInstrumentedCount` are read off
 * ONE return object from ONE function: there is no call that produces a score without also
 * producing the coverage figure that qualifies it.
 *
 * Algorithm (deliberately simple and conservative, so it is auditable):
 *   - Zero `met` criteria ⇒ step 0 ("Gated"), full stop. This is rule 5: a fixture with nothing met
 *     cannot be nudged upward by the mere absence of failing data.
 *   - At least one `met` criterion ⇒ floor of step 1 ("Assisted") — this lens has no criteria
 *     assigned to step 1 itself, so step 1 is not separately gated, only entered.
 *   - For each higher step (2, 3, 4) that has at least one criterion assigned to it: the verdict
 *     only advances to that step if EVERY criterion assigned to it is `met`. The loop stops at the
 *     first step where that fails — a step is not "mostly" reached.
 *   - A step with zero assigned criteria is skipped without advancing or blocking: this lens has
 *     no evidence for that step yet.
 */
export function scoreVerdict(rows, fixedNotInstrumentedCount = NOT_INSTRUMENTED.length) {
  const metCriteria = rows.filter((r) => r.status === 'met').length;
  const scoredNotInstrumented = rows.filter((r) => r.status === 'not_instrumented').length;
  const notInstrumentedCount = scoredNotInstrumented + fixedNotInstrumentedCount;

  let step = 0;
  if (metCriteria > 0) {
    step = 1;
    for (const candidate of [2, 3, 4]) {
      const relevant = rows.filter((r) => r.ladderStep === candidate);
      if (relevant.length === 0) continue;
      const allMet = relevant.every((r) => r.status === 'met');
      if (allMet) {
        step = candidate;
      } else {
        break;
      }
    }
  }

  return {
    step,
    stepLabel: STEP_LABELS[step],
    metCriteria,
    totalCriteria: rows.length,
    notInstrumentedCount,
  };
}

/**
 * Assemble the full maturity section for the Pod Report artifact.
 *
 * DETERMINISM: pure map from `input` to output, no clock, no I/O — same contract as
 * `computeDelivery` in pod-metrics.mjs. Every field the render layer needs is here: the
 * version-pinned ladder citation, the scored rows (each carrying its own evidence-or-reason and
 * proxy note), the fixed v1 not-instrumented list (each an upsell line with its guardrail), and the
 * verdict bundled with the coverage count it can never be rendered apart from.
 */
export function computeMaturityLens(input = {}) {
  const rows = SCORERS.map((scorer) => scorer(input));
  return {
    ladder: LADDER_CITATION,
    rows,
    notInstrumented: NOT_INSTRUMENTED,
    verdict: scoreVerdict(rows, NOT_INSTRUMENTED.length),
  };
}
