// index.ts — the build view, as a Claude Code function hook (build-visualization-claude-mods S4).
//
// A THIN RENDERER (D3): every fact on screen comes from `build-state.mjs --json --offline` — the copy bundled
// in `vendor/`, never the open repo's (distribute-what-we-use D5) — which is plain Node, tested, and useful
// on its own. This file decides nothing about epics, stories or status.
//
// The latency budget (D4): one `git rev-parse` per turn, and a full resolve only when the branch or HEAD
// moved or the cached view aged out — the view is kept in `$.store`, failures included, so a project
// without the resolver re-tries occasionally rather than every turn. `--offline` is passed on purpose:
// **no `gh` call ever happens inside the hook**, so a network stall cannot slow a turn. Both subprocesses
// carry a timeout for the same reason: turn start waits on this hook.
//
// It never throws into the turn: any failure logs (visible with `claude --debug`) and clears the view.
import { buildStateArgv, repoFactsFrom, shouldRefresh, statusTextFrom } from './build-view.mjs';

const STORE_KEY = 'golden-frijoles/build-view';
const GIT_TIMEOUT_MS = 2_000;
const RESOLVE_TIMEOUT_MS = 5_000;

export function register(on) {
  on('turn.start', async ($, e, next) => {
    try {
      const head = await $.process.run(['git', 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD', '--show-toplevel'], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const facts = repoFactsFrom(head.stdout, head.exitCode);
      const cached = await $.store.get(STORE_KEY);
      if (!shouldRefresh(cached, facts.key)) {
        $.ui.log(`build view: cached (${facts.key})`);
        // Always write the row — including an empty one for a cached failure — so a stale view from the
        // previous branch can never stay on screen (the fresh reviewer's finding on #32).
        $.ui.status(cached.text || '');
        return next(e);
      }
      // The BUNDLED resolver, never one the open repo supplies (distribute-what-we-use D5).
      const run = await $.process.run(buildStateArgv(facts.root), {
        timeoutMs: RESOLVE_TIMEOUT_MS,
      });
      const text = statusTextFrom(run.stdout, run.exitCode);
      $.ui.log(`build view: resolved (${facts.key}) (${run.exitCode === 0 ? 'ok' : `exit ${run.exitCode}`})`);
      await $.store.set(STORE_KEY, { key: facts.key, at: Date.now(), text });
      $.ui.status(text || '');
    } catch (err) {
      $.ui.log(`build view: ${String(err)}`);
      $.ui.status('');
    }
    return next(e);
  });
}
