# Refine reference — bug-path detail, the planning panel, and archetype tags

Loaded on demand from `SKILL.md` Stage 2. Moved here verbatim (ways-of-work-lean-pass S3.2) so the stages stay legible.

> **Bug path detail.** Before proposing a fix, write the **reproduction** (exact steps + where it
> diverges from the promise) and the **root cause** (read the model/route — many "bugs" are an
> unbuilt or half-built promise, not a regression). The fix is a normal user story with an
> acceptance check and a regression spec so it can't silently come back.

> **Cross-agent planning panel — available on demand, never an obligation.** A spike's "A vs B" call can
> take a different model family's read: `node scripts/cross-panel.mjs <brief> --lens both --agent codex`.
> It is single-pass, print-only and advisory; it never gates and never writes the doc. Run it via the
> `Panel:` verb when the fork is worth it — there is **no requirement to offer it** (removed 2026-09-16:
> an advisory nicety had become a required ritual on every spike and every architecture fork).

**Optional archetype tag.** Alongside the class, an ask can also carry a *mode* tag — orthogonal, from the
role-archetypes spike decision (the origin project's `spike-role-archetypes` seed; trial
basis). Omit it for the default (Builder); only tag when it isn't.

| Archetype | What it changes |
|---|---|
| **Prototyper** | Thin, explicitly-disposable slice; minimal/optional QA; skip full DoD; low-risk; state "may never ship" up front. |
| **Builder** | *Default* — production-grade, full DoD. No tag needed. |
| **Sweeper** | Acceptance = "less code / same behavior / no regressions"; prove the old path unreachable; add a guard against it returning; shared-surface touch → announce. |
| **Grower** | Acceptance ties to a success signal/metric, not just "works"; reuse-first even stronger. |
| **Maintainer** | Security/reliability/cost/perf on a mature system; expect high-risk (Stage 6b kill-switch thinking, Opus/escalate); ties to runbook/infra skills. |

It **composes with, doesn't replace** the class above — pairs into a 2-tuple, e.g. *Chore/Sweeper*. It's a
**planning prompt, not a gate**: no new required field, no CI check, no team-mix ratios. Soft note: a
macro-section's product maturity biases which archetype to expect (pre-PMF → Prototyper/Builder; mature →
Sweeper/Maintainer) — an expectation-setter, never a rule. Archetype may *suggest* a starting model, but the
Stage 6 / Model-tiers escalation triggers (money/auth/migration/shared-infra/ambiguity) stay the hard SSOT —
referenced here, not re-encoded.
