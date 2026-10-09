# Strategy at Stage 0 — the Moves · Tests line

The three strategy coaches (the `strategy` skill's chapters `pmf-narrative`, `north-star`, `risk-validation`) each leave one file in
`Roadmap/00-strategy/`, and render three one-pagers from those files into `Roadmap/00-strategy/one-pagers/` (a business
model canvas, a value proposition sheet and a persona poster; `scripts/one-pagers.mjs`). When that folder exists, Stage 0 runs the reader that ships beside the generators:

```bash
node "$REFINE/strategy.mjs"     # find $REFINE with the block under "Locate the generators" in SKILL.md
```

- **It prints the strategy:** keep it in mind for the pitch. The pitch gets one line under its title:
  `Moves: <input key> · Tests: <dimension>`, naming the input metric this seed moves (a key from the North Star's
  inputs) and the PMF dimension it tests (the highest domino when it fits). If the seed moves none of them, write
  `Moves · Tests: neither — <why>`. That answer is useful too.
- **It prints nothing:** the project has no strategy files. **Offer the North Star once for this seed**, in one line:
  "There's no North Star yet, so this bet can't say which number it moves. Run the North Star chapter of `strategy`
  now (about 20 minutes), or carry on and mark it not grounded?" Skip the offer when the person already chose "a first
  epic now" over strategy in this conversation (`setup`). On a decline, write the line as `Moves · Tests: not grounded
  — no strategy yet`, record `grounded: false` with `grounded_reason: no strategy yet`, and the Plan gate says the
  same (`gates.md` → *Not grounded*). Never ask twice for the same seed.
- **It names a file it "could not read":** say so in one line, and use whatever else it printed.
- **`$REFINE` has no `strategy.mjs`:** the installed plugin predates 0.18.0. Read the files in `Roadmap/00-strategy/`
  directly, and suggest updating the plugin.

The reader skips values the coach never filled in (`<…>` placeholders), so a draft template doesn't turn into a fake
input.
