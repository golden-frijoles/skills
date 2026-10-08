# Funding at the gate — what `fund.mjs` and `scaffold-epic.mjs` write (Stage 7)

The approval gate is the betting table (WAYS-OF-WORKING → *Betting & appetite*). One answer approves the pitch and
funds it, so nothing leaves refining scaffolded but unfunded, and nobody has a follow-up step.

## What the product owner sees

The **Plan gate** in `gates.md`: plain words, with the bet in it ("We bet that …", Moves, Target, Read date, Size,
Flag) and "What this pushes back". This file is what its answers write. You propose the position and what the epic
pushes back from the month's `Roadmap/bets/wave-YYYY-MM.md` and *Ready to build* in `BUILD-ORDER.md`; the product
owner edits either. **Approve the plan** runs `fund.mjs` then `scaffold-epic.mjs`; **Park it** runs neither.

## `fund.mjs` — the bet

```
node "$REFINE/fund.mjs" --slug <slug> --displaced "<what stays parked>" --next      # fund: front of the queue
node "$REFINE/fund.mjs" --slug <slug> --displaced "<what stays parked>" --after <slug>
node "$REFINE/fund.mjs" --slug <queued-slug> --displaced "<the next wave displaces…>"  # re-bet, position kept
node "$REFINE/fund.mjs" --slug <queued-slug> --after <slug>                           # reorder only
```

The mode follows from whether the bet is funded and placed, both read README-first then seed, as the board reads
them: **fund** (not both — the funding is written now; a placement is required unless it already holds a queue
position), **re-bet** (funded and placed, no placement flag) or **reorder** (funded and placed, with a placement: no
cycle row, `underwritten_by` untouched). An old `ready` seed with a leftover number is funded afresh when placed.

- Appends one row (Bet · Appetite · Displaced) to the month's cycle file, creating it on first use. A second run for
  the same slug in the same cycle adds nothing.
- Sets the seed's `underwritten_by:` (the bare cycle name) and `appetite:`, and moves a `ready` seed to `queued`. A
  `raw` seed is refused: it has no pitch yet.
- `--next` / `--after` renumber **the queue only**: live, funded work (epics scaffolded or in progress, seeds
  queued). Numbering starts at the queue's lowest number and skips every number a shipped or archived item holds, so
  history never moves. A `ready` seed's leftover number is not a queue position, so it cannot be "re-bet" in place.
- The epic kickoff of an L bet tells the builder to ask the one-line re-bet when it stops at a wave boundary.
- `--dry-run` prints the plan and writes nothing. `--cycle <name>` and `--date` override the month.

## `scaffold-epic.mjs` — the scaffold, after the bet

- Refuses a seed with no `underwritten_by:` and prints the `fund.mjs` command. With no seed file at all it scaffolds
  as it always did, from its flags.
- `--slug <seed>` alone reads title, area, type and risk from the seed, the macro from the one `Roadmap/<area>-*`
  directory, and makes ONE sprint whose stories are the items under the seed's `## Acceptance…` heading (bullets or
  a numbered list; a section with neither warns) — the fixed-scope
  path (dogfood F33). Sharpen each story's role and outcome after.
- Copies the seed's `build_order`, quote and intent score into the README, and sets the seed's `epic:` and
  `status: scaffolded`.
- Prints one path-scoped commit: the epic files, the seed, the cycle file and `BUILD-ORDER.md` (regenerate it first
  with `node scripts/build-order.mjs`). The board fails on a live bet with no `underwritten_by:` naming a cycle file.
