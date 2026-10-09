# Connecting to Golden Frijoles at setup, and the ending

Everything before this step stays on the founder's machine. This step is where the project, its North Star and its
roadmap reach Golden Frijoles, so it is asked, once, and each command says what it did. Run the CLI as the package
setup's Stage 2.1 names (`npx -y @golden-frijoles/cli@<version> …`, never a bare `frijoles`: some shells alias it).

## 1. Ask once

> Connect to Golden Frijoles? It opens your browser once to sign in; nothing is sent until you confirm there. Then your
> project, North Star and roadmap are in the console, and you can see your first event arrive.
>
> **1 Yes** · **2 Later**

"Later": say that `frijoles login`, then `frijoles init --ingest`, connect it whenever they want, and go to the ending.

## 2. The commands, in order (stop at the first failure and name its fix)

1. **Sign in:** `… login` (skip when Stage 2.1 printed "Signed in as"). It opens the browser and waits.
2. **The project and its keys:** `… init --ingest`. It creates the project if the account has none, makes sure
   `.env.local` is ignored by git (it refuses otherwise), and writes the keys: `GOLDEN_FRIJOLES_*` for reading flags,
   `GROWTH_ENGINE_API_KEY` and `GROWTH_ENGINE_URL` for sending events. It prints names, never values: never print,
   copy or commit a key yourself.
3. **The North Star:** `… north-star set Roadmap/00-strategy/north-star.md --yes`, the file the Strategy gate agreed.
   Without `--yes` it only shows what it would send.
4. **The roadmap:** `node scripts/roadmap-push.mjs --env-file .env.local` (the run rule applies: the kit's
   `roadmap-push --env-file .env.local` when the project has no copy). It reads only the push's own variables from the
   file, so nothing in it runs.
5. **The first event:** `… status`. "Waiting for the first event" is expected until the app runs with the key; say
   where to look: `https://goldenfrijoles.com/app` (Today shows the same message, and when it arrives).

## 3. The ending (always, connected or not)

Three lines, then stop:

> **North Star:** <the metric, one line> (agreed; go deeper any time with `strategy`).
> **First idea:** <its title>, in the backlog (`refine` takes it from there). **Measuring code:** <the PR's link> to
> review, or "not added", or "nothing to measure yet".
> **Console:** https://goldenfrijoles.com/app, or "not connected: `frijoles login`, then `frijoles init --ingest`".
