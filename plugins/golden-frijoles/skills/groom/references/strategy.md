# Strategy at Stage 0 — the Moves · Tests line

The three strategy coaches (`pmf-narrative`, `north-star`, `risk-validation`) each leave one file in
`Roadmap/00-strategy/`. When that folder exists, Stage 0 runs the reader that ships beside the generators:

```bash
node "$GROOM/strategy.mjs"     # find $GROOM with the block under "Locate the generators" in SKILL.md
```

- **It prints the strategy:** keep it in mind for the pitch. The pitch gets one line under its title:
  `Moves: <input key> · Tests: <dimension>`, naming the input metric this seed moves (a key from the North Star's
  inputs) and the PMF dimension it tests (the highest domino when it fits). If the seed moves none of them, write
  `Moves · Tests: neither — <why>`. That answer is useful too.
- **It prints nothing:** the project has no strategy files. Write the line as `Moves · Tests: not grounded — no
  strategy yet`, and the Plan gate says the same (`gates.md` → *Not grounded*). That is a fact, not a nag: never ask
  for a strategy because of it.
- **It names a file it "could not read":** say so in one line, and use whatever else it printed.
- **`$GROOM` has no `strategy.mjs`:** the installed plugin predates 0.18.0. Read the files in `Roadmap/00-strategy/`
  directly, and suggest updating the plugin.

The reader skips values the coach never filled in (`<…>` placeholders), so a draft template doesn't turn into a fake
input.
