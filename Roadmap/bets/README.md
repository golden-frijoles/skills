# bets/ — the underwriting record

One file per cycle: `wave-YYYY-MM.md`, opened by `groom`'s `fund.mjs` at the month's first funded bet. Each
file records the bets placed, their appetite, and — the whole point — **what each displaced**. This is the
opportunity-cost ledger a ticket board can't show: one row per bet, not a ceremony.

**The approval gate is the betting table** (WAYS-OF-WORKING → *Betting & appetite*): approving a pitch in `groom`
funds it in the same answer, so the row is written in the same commit as the scaffold. "Approve, don't fund" writes
nothing here and leaves the seed `ready`. An L bet adds a row each time it is re-bet at a wave boundary.

A seed's `underwritten_by:` holds the bare name of a file here (`wave-2026-10`) — that pointer is what makes "who
authorized spending on this instead of something else?" answerable for every bet, and `build-order.mjs` fails a
live bet whose pointer is missing or names no file.

Shape per cycle file (`fund.mjs` writes the header and appends the rows):

| Bet | Appetite | Displaced (the opportunity cost) |
|---|---|---|
| what we bet on | S / M / L | what stayed parked because of it |
