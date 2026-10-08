# Refine reference — the Stage 3 question bank

Loaded on demand from `SKILL.md` Stage 3. Moved here verbatim (ways-of-work-lean-pass S3.2).

> **Research current reality when it matters.** If the ask leans on anything that changes or is recent —
> a protocol/standard, a payment-provider capability, a framework/library behaviour, a
> hosting-platform or auth-provider limit, or a competitor's pattern — **web-search to confirm
> the present-day facts** rather than relying on training memory. Cite what you found in the scope doc. Don't
> plan on a stale assumption.

Core bank (adapt):
- **Role & job:** which of the project's roles is this for? What job are they hiring it to do?
- **Outcome & signal:** what's true after this ships that isn't now? How will *the product owner* test it?
- **Scope boundary:** what's explicitly *in* v1 and *out*? (Write the "out" list — it prevents creep.)
- **Granularity heuristic:** at which level does the thing attach (per-account vs per-entity vs
  per-item)? Always ask it for anything configurable — the wrong level is an expensive re-shape.
- **Data model:** does the project's system of record already model this? If not, is it truly
  outside that system, or are we missing a primitive? (The project's AGENTS.md data-ownership
  rules decide.)
- **Agent surface:** how does an AI agent do this through the project's agent interface (MCP or
  equivalent), per its AGENTS rules?
- **Language & channels:** new copy follows the project's language policy (see its AGENTS.md)?
  Behaves on all the project's channels/surfaces?
- **Overlap:** does the poster already claim this? Reuse or extend, don't rebuild.
