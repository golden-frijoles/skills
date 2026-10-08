# Why appetite, betting and the circuit breaker (Shape Up, adapted for agents)

`Roadmap/WAYS-OF-WORKING.md` carries the *rules*: the appetite table, the four betting rules, the
hill-routing default. This file carries the *reasoning*, because a builder session does not need to
re-read the philosophy to follow the rule — and the process doc is loaded at the start of every session.

## A ticket board without economics is a sausage machine

Work goes through it and nothing records what budget it drew from or what it displaced. The betting
layer exists to make **opportunity cost** — *what else could we be building?* — the visible, guiding
question, rather than a thing rediscovered when a wave has already been spent.

## Why sessions, not hours or tokens

Shape Up denominates appetite in calendar time (a 2-week or 6-week batch). With agents that is the wrong
denominator: the operation runs round the clock, so wall-clock time measures nothing about cost. Raw
tokens are too weak a ceiling in the other direction — an agent will eventually build anything if it is
allowed to tokenmaxx. The binding constraints here are **product-owner attention** and **session
context**, with review rounds close behind. So appetite is denominated in **sessions**, each tier
carrying an implied token band.

## Appetite is a creative constraint, not an estimate

An estimate starts from the solution and predicts the cost. An appetite starts from the cost and
constrains the solution: *how much is this problem worth?* Fixed appetite, variable scope. The appetite
is what makes an agent stop, zoom out and hammer the scope instead of hammering the problem — which is
the single behaviour that most reliably rescues a run that has stopped moving.

## The circuit breaker is the default, not the exception

When an M or L bet exhausts its appetite, the work **stops and returns to shaping**. It is never
extended in flight. Repeated hammering on one problem is evidence that the work is uphill — unknowns
still being figured out — not evidence that it needs more tokens. This is the same signal as
*escalate, don't guess*: a scope that stops moving is a raised hand.

## Underwriting, and why `underwritten_by: null` is honest

`underwritten_by: null` is the truthful state of an idea nobody has paid for yet: fine in the funnel,
impossible on the board. Scaffolded is not the same as bet — an epic may have complete docs and no
funding, which is exactly what makes the next betting table a three-line decision rather than a fresh
refine.

## An unpicked pitch is let go, not backlogged

If it matters, it resurfaces. A backlog of everything ever proposed is a graveyard that costs attention
every time it is read.
