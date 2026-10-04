// index.tsx — the build view, as a Claude Code function hook (build-visualization-claude-mods S4).
//
// A THIN RENDERER (D3): every fact on screen comes from `build-state.mjs --json --offline` — the copy bundled
// in `vendor/`, never the open repo's (distribute-what-we-use D5) — which is plain Node, tested, and useful
// on its own. This file decides nothing about epics, stories or status.
//
// LIVE (live-build-view S1, D1–D3): one check — `createViewer` in build-view.mjs — runs on turn.start, after every
// Bash call and on a 30 s tick, and resolves only when the key moved (every worktree's HEAD + branch, the newest
// Roadmap/ mtime). The view is kept in `$.store`, failures included. Every check is `--offline`: **no `gh` call ever
// happens on a turn's path**, so a network stall cannot slow a turn. The online refresh (the PR facts the Status row
// reads) runs on its own timer — 60 s after start, then every 5 min — and once after a `git push`/`gh pr …`, queued on
// the clock so the tool call never waits for it. Every subprocess carries a timeout.
//
// WHERE IT DRAWS (fix/build-view-band): the band above the prompt, one wrapped row per resolver line. It
// used to be `$.ui.status`, a single status row — newlines showed as U+FFFD and the view was cut off at the
// terminal's right edge. `turn.start` writes the text to `$.state`; the `AbovePrompt` render hook reads it,
// so a write redraws the band and nothing else.
//
// THE SESSION LINE (session-budget D2/D8): `session.measure` pushes the engine's own figures after each turn;
// `sessionVerdict()` — the SAME function groom's Cowork line uses, imported from the groom skill — turns them
// into keep going / checkpoint / hand off, drawn on `$.ui.status` (one row under the prompt, free since the
// band moved off it). It advises and never acts: nothing here compacts, clears or ends a session (D5). Each
// verdict CHANGE appends a row to `.golden-frijoles/session-budget.jsonl`, ignored by its own `.gitignore` (D7).
//
// THE SPEND ROW (finops S1.3, D5/D24): the resolver prints it from `.golden-frijoles/usage-summary.json`; this module
// only keeps that file fresh, by running the bundled `epic-actuals.mjs --refresh` from `session.measure`.
//
// It never throws into the turn: any failure logs (visible with `claude --debug`) and clears the view.
import type { EngineInterface, Register } from 'claude-code';
import {
  ONLINE_EVERY_MS,
  ONLINE_FIRST_MS,
  PLUGIN_DIR,
  TICK_MS,
  USAGE_TIMEOUT_MS,
  KICKOFF_TIMEOUT_MS,
  attempt,
  bandRowsFrom,
  buildListText,
  createViewer,
  epicActualsArgv,
  isEpicSlug,
  isOnlineTrigger,
  kickoffArgv,
  progressOf,
  publishedManifestPath,
  shouldRefreshUsage,
  spendOf,
  versionOf,
  versionRow,
} from './build-view.mjs';
import {
  LOG_FILE,
  LOG_GITIGNORE,
  budgetRow,
  figuresFromMeasure,
  sessionLine,
  sessionVerdict,
} from '../skills/groom/session-budget.mjs';

const STORE_KEY = 'golden-frijoles/build-view';
const VIEW = { plugin: 'golden-frijoles', key: 'buildView' } as const;

const TONE_COLORS = { busy: 'yellow', info: 'cyan', good: 'green', bad: 'red', plain: undefined } as const;
const RISK_COLORS = { LOW: 'green', MEDIUM: 'yellow', HIGH: 'red' } as const;
const LABEL_WIDTH = 12; // glyph + space + the longest label (`Progress`) + gap

// The session line's inputs. Module variables on purpose: a hot reload starts them over, which at worst
// logs one repeated verdict row and hides the line until the next measurement — never a wrong figure.
let measured: { contextPct: number | null; fiveHourPct: number | null; sevenDayPct: number | null } | null = null;
let questionsWaiting = 0; // in-flight AskUserQuestion calls; "asks open" is not observable here (D8)
let loggedVerdict: string | null = null;
// The live view (D1). Built in session.start, whose `$` its io closes over — the same way a `$.clock` timer's callback
// uses the `$` of the hook that started it. A hot reload builds a new one (session.start fires again) and the engine
// drops the old environment's timers with it.
let viewer: ReturnType<typeof createViewer> | null = null;
let warnedNoState = false; // log an engine without `$.state` once per load, not on every draw
let usageRefreshedAt: number | null = null; // finops D24 — the last usage refresh attempt, ok or not

const lineNow = () => {
  const figures = { ...(measured ?? {}), questionsWaiting };
  return sessionLine(figures, sessionVerdict(figures)) ?? undefined;
};

// What reaches the transcript. A mod's `$.ui.log` is a row in the person's main window, so it is spent only on something
// they should act on, and each distinct line ONCE per load; repeats and routine bookkeeping (check timings, "usage:
// refreshed (ok)", the plugin-version line) go to the debug log alone (`claude --debug`). Before 2026-10-04 every 30 s
// tick and every Bash call logged a timing row, and the band's own news drowned in them.
const noted = new Set<string>();
function note($: EngineInterface, msg: string) {
  if (noted.has(msg)) return $.ui.log(msg, { to: 'debug' });
  noted.add(msg);
  $.ui.log(msg);
}
const debug = ($: EngineInterface, msg: string) => $.ui.log(msg, { to: 'debug' });

// The view's I/O, spelled at its own call sites. The cache is one `$.store` slot PER CHECKOUT ROOT: the store is shared
// by every session of the plugin, and one slot let two sessions in two worktrees serve each other's view (#240 review).
function ioFor($: EngineInterface) {
  return {
    run: (argv: string[], opts: { timeoutMs: number }) => $.process.run(argv, opts),
    list: (path: string) => $.fs.list(path),
    getCached: (root: string) => $.store.get(`${STORE_KEY}@${root}`),
    setCached: (root: string, entry: unknown) => $.store.set(`${STORE_KEY}@${root}`, entry),
    show: (text: string | null) => $.state.set(VIEW, text),
    log: (msg: string) => note($, msg),
    debug: (msg: string) => debug($, msg),
    now: () => Date.now(),
  };
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    viewer = createViewer(ioFor($));
    const live = viewer;
    // D5 — the Plugin row: this module's own manifest vs the marketplace clone's (no network). Once per load.
    try {
      const publishedPath = publishedManifestPath(PLUGIN_DIR);
      if (publishedPath && (await $.fs.exists(publishedPath))) {
        const installed = versionOf(await $.fs.read(`${PLUGIN_DIR}/.claude-plugin/plugin.json`));
        const published = versionOf(await $.fs.read(publishedPath));
        live.setPluginRow(versionRow(installed, published));
        debug($, `build view: plugin ${installed} installed, ${published} in the marketplace clone`);
      }
    } catch (err) {
      note($, `build view: plugin version: ${String(err)}`);
    }
    // S2.4 (D12) — the kickoff's one home.
    try {
      await $.command.register({
        name: 'build',
        description: 'Put the generated epic kickoff in the prompt (golden-frijoles)',
        argumentHint: '<epic-slug>',
      });
    } catch (err) {
      note($, `build view: /build not registered: ${String(err)}`);
    }
    // D1 — the tick; D3 — the online refresh, first after a minute, then every five.
    $.clock.every(TICK_MS, () => void live.check('tick'));
    $.clock.after(ONLINE_FIRST_MS, () => {
      void live.refreshOnline('timer');
      $.clock.every(ONLINE_EVERY_MS, () => void live.refreshOnline('timer'));
    });
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    // Awaited here (unlike the tick): the band should be right when the turn begins. Never throws (createViewer). A load
    // whose session.start never ran (its hook failed, or a chain stopped short) still gets a view — just no timers.
    if (!viewer) viewer = createViewer(ioFor($));
    await viewer.check('turn');
    return next(e);
  });

  // D1 — after every Bash call: the agent's own `git switch`/`git commit` moves the band mid-turn. The check is queued on
  // the clock, so the call's result is never held up by it; a push or a PR command also queues ONE online refresh (D3).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e);
    const live = viewer;
    if (live) {
      $.clock.after(0, () => void live.check('bash'));
      if (e.tool === 'Bash' && isOnlineTrigger(e.command)) $.clock.after(0, () => void live.refreshOnline('push'));
    }
    return result;
  });

  // /build <slug>: the BUNDLED generator's kickoff, put in the prompt box — never sent, never saved (S2.4, D12). It does
  // not touch git: the kickoff's own first line switches the branch.
  on('command.run', { command: 'build' }, async ($, e) => {
    const live = viewer ?? (viewer = createViewer(ioFor($)));
    const root = await live.locate();
    if (!root) return { text: '/build: not inside a git checkout — run it from the repo whose Roadmap/ holds the epic.' };
    const slug = String(e.args || '').trim();
    const list = async (reason: string) => {
      const listed = await $.process.run(kickoffArgv(root, null), { timeoutMs: KICKOFF_TIMEOUT_MS });
      return { text: buildListText(reason, listed.exitCode === 0 ? listed.stdout : '') };
    };
    if (!isEpicSlug(slug)) return list(slug ? `/build: "${slug}" is not an epic slug.` : '/build: which epic?');
    const run = await $.process.run(kickoffArgv(root, slug), { timeoutMs: KICKOFF_TIMEOUT_MS });
    // Exit 1 is the generator's own refusal (its die(): no such epic, no Roadmap/ — an uncaught throw exits 1 too), so the
    // list follows; a timeout or a signal is something else and says so.
    if (run.exitCode === 1) return list(`/build: no epic "${slug}" under Roadmap/.`);
    if (run.exitCode !== 0 || !run.stdout.trim())
      return { text: `/build: the kickoff generator failed (exit ${run.exitCode}). Run it by hand: node ${kickoffArgv(root, slug).slice(1).join(' ')}` };
    // Under a dialog, headless, or on a failed fill: the kickoff is the command's output instead, to copy by hand.
    const filled = await attempt(() => $.prompt.fill({ text: run.stdout.trimEnd() }));
    if (!filled?.isFilled) return { text: run.stdout };
    return { text: `Kickoff for ${slug} is in the prompt — press enter to start.` };
  });

  on('session.measure', async ($, e, next) => {
    const repoRoot = viewer?.root ?? null; // the view's own git root, so the log lands at the repo root (D7)
    try {
      measured = figuresFromMeasure(e);
      const figures = { ...measured, questionsWaiting };
      const verdict = sessionVerdict(figures);
      $.ui.status(sessionLine(figures, verdict) ?? undefined);
      // Only at a known repo root (D7): with no git root — a session outside a repo, or a hot reload before the
      // next turn.start — the line still draws but nothing is written into whatever directory the session is in.
      if (repoRoot && verdict.verdict !== loggedVerdict && sessionLine(figures, verdict)) {
        // $.fs has no append: read + write the whole (small — one row per verdict change) file. Hooks for this
        // event run one at a time, so this session never races itself; a SECOND session or the Cowork CLI
        // writing the same file in the same instant can lose one row — accepted for a local, advisory log.
        const dir = `${repoRoot}/`;
        if (!(await $.fs.exists(`${dir}${LOG_GITIGNORE.path}`))) await $.fs.write(`${dir}${LOG_GITIGNORE.path}`, LOG_GITIGNORE.text);
        const path = `${dir}${LOG_FILE}`;
        const prior = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : '';
        const row = budgetRow({ at: Date.now(), surface: 'claude-code', figures, verdict });
        await $.fs.write(path, `${prior}${prior && !prior.endsWith('\n') ? '\n' : ''}${row}\n`);
        loggedVerdict = verdict.verdict;
      }
    } catch (err) {
      note($, `session line: ${String(err)}`);
    }
    // finops S1.3 (D24) — keep the Spend row's summary fresh, off the hot path: the BUNDLED epic-actuals.mjs, at most
    // once a minute, timeout-bound. A slow or failed run logs and leaves the last row; a good one makes the next check
    // re-resolve with the new figure (a new figure moves no key).
    if (shouldRefreshUsage(usageRefreshedAt, repoRoot)) {
      usageRefreshedAt = Date.now();
      try {
        const run = await $.process.run(epicActualsArgv(repoRoot as string), { timeoutMs: USAGE_TIMEOUT_MS });
        if (run.exitCode === 0) debug($, 'usage: refreshed (ok)');
        else note($, `usage: refresh failed (exit ${run.exitCode})`);
        if (run.exitCode === 0) viewer?.invalidate();
      } catch (err) {
        note($, `usage: ${String(err)}`);
      }
    }
    return next(e);
  });

  // "Questions waiting", honestly counted: the AskUserQuestion dialogs open right now (D8).
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    // Everything inside the try, so the count always comes back down even if drawing the line fails.
    try {
      questionsWaiting += 1;
      $.ui.status(lineNow());
      return await next(e);
    } finally {
      questionsWaiting = Math.max(0, questionsWaiting - 1);
      $.ui.status(lineNow());
    }
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    // On an engine without `$.state` (2.1.278 has none) this read throws; 0.14.0 then logged "ui.render hook
    // skipped: threw TypeError: … evaluating '$.state.get'" on every draw. The band needs an engine with
    // `$.state`; without one it draws nothing and says so once (`claude --debug`).
    const read = await attempt(
      () => $.state.get(VIEW),
      (err) => {
        if (warnedNoState) return;
        warnedNoState = true;
        $.ui.log(`build view: this engine has no $.state — the band needs a newer Claude Code (${String(err)})`);
      },
    );
    if (!read) return next(e);
    const { value } = read;
    const rows = bandRowsFrom(value ?? null);
    if (!rows.length) return next(e);
    const { Box, Text } = $.ui.resolve(e);

    const bar = (value: string) => {
      const p = progressOf(value);
      if (!p) return null;
      const width = Math.min(p.total, 12);
      const filled = Math.round((p.done / p.total) * width);
      return (
        <Text>
          <Text color="green">{'▰'.repeat(filled)}</Text>
          <Text dimColor>{'▱'.repeat(width - filled)}</Text>{' '}
        </Text>
      );
    };

    // finops S2.4 — the Spend row's bar, from the resolver's own words (spendOf): green inside the quote, red when over.
    const spendBar = (value: string) => {
      const { bar, tone } = spendOf(value);
      if (!bar) return null;
      return (
        <Text>
          <Text color={TONE_COLORS[tone as keyof typeof TONE_COLORS]}>{'▰'.repeat(bar.filled)}</Text>
          <Text dimColor>{'▱'.repeat(bar.width - bar.filled)}</Text>{' '}
        </Text>
      );
    };

    return (
      <Box flexDirection="column" paddingX={1} width={e.props.bodyColumns}>
        {rows.map((row, i) => {
          if (row.kind === 'heading') {
            return (
              <Text key={`r${i}`} bold color={TONE_COLORS[row.tone]} wrap="wrap">
                {row.glyph} golden-frijoles · {row.value}
              </Text>
            );
          }
          if (row.kind === 'note') {
            return (
              <Box key={`r${i}`} flexDirection="row">
                <Box width={LABEL_WIDTH} flexShrink={0}>
                  <Text dimColor>{'  '}{row.glyph}</Text>
                </Box>
                <Box flexShrink={1}>
                  <Text dimColor italic wrap="wrap">{row.value}</Text>
                </Box>
              </Box>
            );
          }
          return (
            <Box key={`r${i}`} flexDirection="row">
              <Box width={LABEL_WIDTH} flexShrink={0}>
                <Text color="cyan">{'  '}{row.glyph} </Text>
                <Text dimColor>{row.label}</Text>
              </Box>
              <Box flexShrink={1}>
                <Text wrap="wrap">
                  {row.label === 'Progress' ? bar(row.main) : null}
                  {row.label === 'Spend' ? spendBar(row.main) : null}
                  <Text bold={row.label === 'Epic'} color={TONE_COLORS[row.tone]}>{row.main}</Text>
                  {row.meta ? <Text dimColor>{'  ·  '}{row.risk ? row.meta.replace(/ ?· ?risk \w+/, '') : row.meta}</Text> : null}
                  {row.risk ? (
                    <Text>
                      <Text dimColor>{'  ·  '}</Text>
                      <Text bold color={RISK_COLORS[row.risk as keyof typeof RISK_COLORS] ?? 'yellow'}>{`▲ risk ${row.risk}`}</Text>
                    </Text>
                  ) : null}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    );
  });
};
