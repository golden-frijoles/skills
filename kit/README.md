# @golden-frijoles/kit

The scripts the [Golden Frijoles skills](https://github.com/golden-frijoles/skills) run: planning, build-order,
reporting and verification rails. The skills use it for you, so you rarely call it yourself.

```
npx -y @golden-frijoles/kit@<version> --list          # what it carries
npx -y @golden-frijoles/kit@<version> build-order     # run one against the repo you're in
npx -y @golden-frijoles/kit@<version> --root ../other build-order
```

- **It works on the project you're standing in.** It walks up from your current directory to the nearest folder
  holding `Roadmap/` or `.git`. Override that with `--root <dir>`.
- **It never copies anything into your repo.** A script writes only what it exists to write, like
  `Roadmap/00-ideas/BUILD-ORDER.md`.
- **Your own copy wins.** If your project has `scripts/<name>.mjs`, the skills run that instead of the kit, so a
  deliberate fork keeps working. That's by name, so an unrelated `scripts/preflight.mjs` of your own would be run in
  its place. Rename yours, or pass the script through `frijoles-kit` directly.
- **Some files stay yours even when the kit runs:** `scripts/prose/cpo-persona.md`, `scripts/prose-lessons.md`,
  `scripts/cross-panel.prompt.md` and `scripts/doc-format.enforced.json` override the kit's defaults.
- **Zero dependencies.** A script that drives another tool, like Playwright or a reviewer CLI, uses *your*
  installation and prints the install line when it can't find one.

Versions move in lockstep with the plugin: kit `X.Y.Z` is exactly what plugin release `vX.Y.Z` pins. Every release
is published from CI with npm provenance.

Licensed under Apache-2.0. "Golden Frijoles" is a trademark; see `NOTICE`.
