# Intent match and visuals — refine Stages 1, 3.5 and 4.6

Read at Stage 3.5 and Stage 4.6. The seed format is in `templates/scope-seed.md`.

## Stage 1 — what to keep for the score

- **The ask, as given:** the product owner's words, verbatim, as they arrived. Never tidy or summarise them. The score
  compares the pitch against these words, so a paraphrase would score the pitch against itself.
- **Claims:** the separate things the ask asks for, one numbered line each, in the product owner's terms. You split
  them; the product owner may edit them. The scorer only reads them.
- **Teach-back:** the product owner's answer to the Stage 1 mirror (*"You want X so that Y. Right?"*): `yes`,
  `partly` or `no`. Leave the placeholder if it was never asked. An unanswered teach-back is left out of the score,
  not counted as zero.

## Stage 3.5 — Intent match (advisory)

```
node scripts/intent-match.mjs Roadmap/00-ideas/seeds/<slug>.md --write
```

The scorer prints how many questions it will ask Jev, then five lines:

| Line | Question behind it | Statistic |
|---|---|---|
| coverage in | For each claim: does the pitch deliver it? | mean P(yes) |
| coverage out | For each acceptance criterion: does it trace to a claim or a recorded decision? | mean P(yes) |
| clarity | For each criterion: could two builders test it the same way? | mean score ÷ 3 |
| teach-back | The product owner's answer to the mirror | yes 1 · partly 0.5 · no 0 |
| agreement | Pending until the optional reader at the lock (`intent-reader.mjs`) | P(same build) |

It then prints a **total, marked uncalibrated**, with the signals it used, and a **band**. The bands are placeholders
until twenty answered epics can fit them: **80+** build · **60–79** resolve the follow-ups first · **below 60** sketch
or spike first.

Each **gap** is routed to one artifact. A gap is either an uncovered claim or an unclear criterion. Make the artifact
(Stage 4.6 draws most of them), or say why not, then re-run the scorer. A criterion listed as **untraced** is scope
nobody asked for: trace it to the ask or cut it.

`--write` records `intent_match:` in the seed's frontmatter, adds an `## Intent match` section, and keeps the
components in a comment for the reader at the lock.

**It never gates.** It can add a step. It never blocks the scaffold and never replaces the product owner's approval.
With no `TYPESAFE_API_KEY`, or with `jev.egress` not `true`, it prints "could not look" and no number. Say that
plainly, then carry on.

## Stage 4.6 — Visuals, drawn from the shape of the ask

Every **shaped bet** (appetite M or L) gets a **system context** in the seed's `## Visuals`: the actors, the systems
and the data flow between them, in Mermaid. After that, draw only what the ask's shape triggers:

| The ask has… | Draw | Format |
|---|---|---|
| a screen or a page someone uses | wireframe: low fidelity, the words that matter | a `surface` block per state: its id and route, then the blocks in order, by kind, with their words (below) |
| a journey of several steps | flow | Mermaid `flowchart` |
| a new table, record or payload | data sample: three real-looking rows | a table in the seed |
| a lifecycle or statuses | state machine | Mermaid `stateDiagram` |
| calls across services, async work or retries | sequence | Mermaid `sequenceDiagram` |
| a new repo, package or deploy boundary | container diagram | Mermaid `flowchart` with subgraphs |

**Fixed-scope work** (appetite S) draws only when a row fires.

Name a screen's states from these ten: **idle · hover · focus · pressed · loading · success · error · empty ·
disabled · unbuilt**. `disabled` means you can't do this right now, and it comes back. `unbuilt` means it is not
built yet. The two must look different: collapsing them is the defect the taxonomy exists to prevent.

The table uses the same words Stage 3.5 routes a gap to. The route vocabulary adds three that aren't drawings:
*copy deck* (the exact words), *spike* (an experiment) and *think chain* (a trade-off reasoned in writing; when the
question is whether the work is worth doing, the PMF narrative and risk-validation chapters of `strategy` answer it). So a routed gap usually maps to one row here.

Mermaid renders on GitHub and diffs as text.

### The `surface` block

One fenced block per state. `state:` is a lower-case hyphenated id; for any state but the default, end it in the
state's name from the ten (`orders-empty`). `route:` is the path. Then one line per block, in order:
`- <kind> ["the words"] [action "…"] [count N] [columns "a | b | …"]`.

```surface
state: orders-empty
route: /orders
- head "Orders" action "Share your shop"
- empty "No orders yet. Your first sale shows up here."
```

The kinds are twelve: `head` (carries `action`) · `answer` · `summary` (`count`) · `tiles` (`count`) · `toolbar` ·
`list` (`columns`) · `empty` · `card` · `steps` (`count`) · `field` · `tabs` · `note`. Record only what survives a
change of data: a primary action's words, a count of tiles or stats, a list's column words. Never a value, a row
count or a pixel. There is no `when:`: an empty or error screen is its own block with its own id.

**Render every surface block and publish the page for review:**

```
node scripts/sketch-render.mjs Roadmap/00-ideas/seeds/<slug>.md --out <scratch>/<slug>-sketch.html
```

It draws a grey wireframe, one section per state, and fails with the line number and the known kinds on a line it
cannot read. Publish that HTML (an Artifact, or wherever the product owner reviews) and link it in the seed: the
product owner approves the picture, not the text. The plugin ships no contract gate: a project that has one can map
the twelve kinds onto its own and check a built page against an approved block.
