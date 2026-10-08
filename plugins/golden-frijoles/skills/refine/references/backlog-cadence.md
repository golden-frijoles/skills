# Refine reference — Stage 9: backlog cadence and the next-session handoff

Loaded on demand from `SKILL.md` Stage 9. Moved here verbatim (ways-of-work-lean-pass S3.2).

## Stage 9 — Close the loop: backlog cadence + next-session handoff

**The backlog keeps growing.** The product owner routinely drops a *batch* of prioritized asks at once.

> **Cadence updated (2026-08-08) — what batches, and what doesn't.** This stage used to read "we do
> **not** refine a batch in one session," which contradicted the consuming project's own
> WAYS-OF-WORKING (updated 2026-07-14): *with a strong planning model, the default is a **single-session
> refine** — one deep Definition-of-Ready refine for the front-of-queue epic plus a portfolio pass that
> seeds/resequences the rest of the funnel.* The skill was the stale half. Reconciled here.
>
> **Updated (2026-09-30, session-budget): one deep ask per approval gate; keep going while the budget line says so.** The old
> "one deep ask per run" was set for earlier models; the binding constraint now is the product owner's
> decision bandwidth. Each deep ask still stops at its own approval gate; what batches besides is the
> funnel bookkeeping — sequencing, appetite, lane, and a light scope pass on items that aren't at the
> front yet.
>
> **The compaction call is measured, not guessed.** Each gate ends with the budget line (`SKILL.md`
> Stage 7.1: `session-line.mjs`): keep going, checkpoint, or hand off. The durable state (seeds, epic
> docs, the bets file) makes re-entry cheap by design, which is what makes handing off early free.

The cadence:

1. **Agree a consolidated build order first** (a separate evaluation pass — consolidate overlaps, sequence
   by dependency/leverage). Funded work is placed by `fund.mjs` (`--next` / `--after <slug>`, the queue only);
   a seed not yet funded may carry an integer `build_order` as intent. That frontmatter is the SSOT the board
   sorts by; `BUILD-ORDER.md` is **generated** from it (`node scripts/build-order.mjs`); never hand-edit it.
2. **One deep ask per approval gate, plus a portfolio pass over the rest.** Deep-refine the front-of-queue
   item to full Definition of Ready and its gate; take the next one in the same session while the budget
   line says keep going. For items not near the front, set sequence, appetite, lane and enough scope to be
   bettable — then stop. A seed that is deep-refined months before it is built is a seed that will be
   refined again anyway.
3. **Let a seed's own words reclassify it.** A raw seed that says "a spike is the honest first move"
   or "worth a discovery pass before it is bet" is telling you it is not a build epic. Scaffolding it
   as one is inventing scope the seed itself flagged as unvalidated — reclassify to `type: spike` and
   shape an investigation brief instead.
4. **Scaffolded ≠ bet.** An epic may be scaffolded with `underwritten_by: null` — docs ready, bet not
   yet placed — so the next betting table is a three-line decision rather than a fresh refinement. The
   board shows it under *scaffolded, not started*, which is the truthful bucket. Only `status: queued`
   hard-requires an `appetite:`.
5. **When the budget line says hand off (or the queue is done), do BOTH:**
   - Emit the **Claude Code build/investigation handoff** for each item refined to scaffold (Stage 8).
   - **Regenerate the board** (`node scripts/build-order.mjs`) so the refined items move bucket from the
     frontmatter change — never hand-tick it — and emit a **next-session Cowork handoff prompt** for the
     **next ⬜ item** in the order. The handoff prompt references the docs that
     already exist (`BUILD-ORDER.md` as a generated read-only view, the relevant `seeds/` seed, the orientation
     files) so the next session re-enters with zero re-derivation. Template:

   ```
   We're working the agreed build order in Roadmap/00-ideas/BUILD-ORDER.md.
   The last refined item was <#X · name> — <status>.

   Refine the next ⬜ item: <#Y · name>.
   Read first, in order: Roadmap/00-ideas/BUILD-ORDER.md, then Stage 0 orientation
   (README.md, WAYS-OF-WORKING.md, LEARNINGS.md), then the scope seed
   Roadmap/00-ideas/seeds/<seed>.md and any primitives it names.
   Then run /refine on <#Y> — one ask, the normal stages — and stop at the scope-doc gate for my sign-off.
   ```

If no `BUILD-ORDER.md` exists yet (a one-off ask, not a batch), skip this stage — just close normally.

---
