# Drafting the strategy at setup

Setup drafts the three strategy files so the founder corrects a draft instead of facing a blank page. The rules below
are what makes a draft worth correcting: the founder speaks first, every line says where it came from, and there are
two North Stars to choose between, not one to accept. The coaches (the `strategy` skill) are the way to go deeper
afterwards; they open on this draft, never on a blank template.

## 1. The question first

Before writing or showing any strategy, ask, in these words:

> In one sentence: what is this for, and who is it for?

Skip it only on route 2, whose question ("A new idea. In a sentence or two: what is it, and who is it for?") is the
same one, answered moments ago. A README, a repo description or the answer to "What are we working on?" is not an
answer to it. Quote the answer in the draft as the founder's words: `(your words)`. Asking first matters: a draft
shown before the founder has said what the product is for anchors their answer to whatever the agent guessed. (The
facts `read-repo` prints at setup's first steps are counts, not a strategy, so they may come first.)

## 2. The reads

On route 1 (this repo), run both reads and keep their output; it is the only evidence a line may cite:

```bash
node "$REFINE/read-repo.mjs" --look      # the stack, the history, the open work
node "$REFINE/read-product.mjs" --json   # the README, the landing copy, the routes, analytics calls, flags
```

On route 2 (a new idea) there is nothing to read: the sentence is the evidence.

## 3. The draft

Write the three files by their coaches' templates (`pmf-narrative`, `north-star`, `risk-validation`, in the `strategy`
skill's `templates/`), each with `status: draft`, after `node scripts/strategy-private.mjs ensure` (the run rule applies)
so a public repo keeps them private.

- **Every claim line ends with its source:** a path the reads printed, with its line (`(README.md:3)`,
  `(app/page.tsx:12)`), `(read-repo)`, `(your words)`, or `(assumed)`. Never cite a path the reads did not print, and
  never present an assumption as a fact. The Strategy gate counts the `(assumed)` lines.
- **Persona and job:** who the product is for and the job they hire it for, in the Target audience and Problem
  sections. Prefer the founder's sentence and the README over the agent's reading of the code.
- **The narrative:** one line per PMF dimension the evidence can support; a dimension it cannot support is left as the
  template's placeholder, not invented.
- **Two North Stars.** `north-star.md` gets a `## Candidates` section, after `## The game`, holding **A** and **B**:

  ```markdown
  ## Candidates

  _Two drafts to choose between at the Strategy gate. The sections below fill in from the one you pick._

  ### A · <Pithy name>
  **The game:** <attention | transaction | productivity> (source)
  **Metric:** <the precise definition> (source)
  **Inputs:** `<key>` <name> — <how it is measured> (source) · … (three or four)
  **What it would make you build:** <one line>

  ### B · <Pithy name>
  …
  ```

  A and B must differ in the game or the unit (what is counted), not just in wording; the *What it would make you
  build* lines are how the founder tells them apart. Leave the file's own North Star sections and its `## Sync payload`
  as the template's placeholders until one is chosen, so `strategy.mjs` reports no inputs from a draft.
- **An input already measured** names the event `read-product` found (`posthog: order_placed (lib/track.ts:1)`); the
  Strategy gate's measurement plan lists which inputs still need one.
- **The riskiest assumption:** the risk-validation file's highest domino, from the evidence where it can, `(assumed)`
  where it cannot.

Then show the **Strategy gate** (refine's `references/gates.md`).
