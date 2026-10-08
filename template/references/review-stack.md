# Why the review stack is shaped this way

`Roadmap/WAYS-OF-WORKING.md` carries the rules. This file carries the reasoning, so a builder session
does not pay for it on every load.

## Two properties, each covered exactly once

- **Family independence** — a different model family, with different blind spots. Delivered by the
  external `cross-review.mjs` pass.
- **Context independence** — an agent that did not hold the diff in its head while writing it.
  Delivered by the fresh `verifier` subagent, which also has the repo, the sibling repos and
  `origin/main` available to it.

These are *different axes*, not substitutes. The stack used to run **two** external passes plus a fresh
reviewer on high-risk PRs: two generalists differentiated only by vendor, and the second bought
corroboration of the same kind rather than a second property. The 2026 literature agrees — differentiation
beats reviewer headcount — and a specialised security reader finds more than security bolted onto a
general prompt.

## The failure that makes the guard load-bearing

With two external passes, a CLI that exited 0 printing nothing was contradicted by the other one. With
one, nothing contradicts it: an empty reply reads exactly like "looks clean". This has happened here —
agy 1.0.10 silently changed its `--print` contract and shipped empty reviews for weeks, and vibe has
twice posted a raw tool call (`read_file{…}`) instead of a review.

So `assertReviewOutput` requires the reply to carry real review structure, and a structureless reply
fails the run and the PR's `cross-review/<lens>` status. Two design rules came out of measuring it
against ~1000 real reviewer replies:

1. **A guard that rejects correct output is worse than one that misses a rare fault** — it trains people
   to bypass it. The accepted shapes are deliberately wide (headings, bold or bulleted severity markers,
   a bare `Clean.`), and a rejected reply is **printed in full** before the run dies, so a false reject
   can never destroy a review that cost a real run.
2. **Absent is not clean.** `pending` is posted before the CLI is even checked, because a version-pin
   refusal or a dead token exits before the guard — and a missing status is indistinguishable from
   "never ran".

## Why the version is recorded rather than pinned

A hard version pin on the only external family takes the whole layer offline on every routine CLI
update — the "one busy model took a whole family offline" failure this operation already recorded. The
version lands in the comment instead, flagged when it differs from the last verified one, because the
output guard covers the actual risk (a changed print contract). agy is the exception: its print contract
has broken twice, so it keeps a hard pin and a doctor that bumps it only on a green live probe.

## Why a capped family just falls through

The deleted protocol stopped the run and asked the product owner for a quota refund, waiting up to 30
minutes, on the theory that external quota is refundable and subagent tokens are not. With one pass and
four families, the next family is one line away — the pause cost more attention than it saved. What
survives is the loud part: if the layer ends up short or dark, the PR body says so.
