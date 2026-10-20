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
// `sessionVerdict()` — the SAME function refine's Cowork line uses, imported from the refine skill — turns them
// into keep going / checkpoint / hand off. It advises and never acts: nothing here compacts, clears or ends a session
// (D5). Each verdict CHANGE appends a row to `.golden-frijoles/session-budget.jsonl`, ignored by its own `.gitignore`
// (D7). WHERE IT DRAWS (build-view-upgrade D5/D6): each figure in its own colour, with the time to its window's reset,
// on a row under the engine's hint line (`PromptHint`, which this hook wraps — `$.ui.status` takes plain text only).
// The figures live in `$.state`; the parts are computed while drawing, and a one-minute clock redraws the countdown.
// An engine without `$.state` gets today's plain `$.ui.status` line instead — never both.
//
// THE SPEND ROW (finops S1.3, D5/D24): the resolver prints it from `.golden-frijoles/usage-summary.json`; this module
// only keeps that file fresh, by running the bundled `epic-actuals.mjs --refresh` from `session.measure`.
//
// THE SCREENSAVER (screensaver D1–D7): when the person has been away a few minutes — 3 with nothing in flight (or no
// view at all: any repo, any folder), 9 with an epic in flight — or at once on `/screensaver now`, an ascii.rest piece
// plays under the band, text in one ink at its own size. WHEN is screensaver.mjs; the piece is rendered OFF the drawing
// path by piece-render.mjs, in the person's own Node (the drawing sandbox is too slow for the heavy ones), and
// piece-player.mjs picks what fits and turns frames into lines this file draws, 10 a second, only while it plays. Where
// the band leaves no room it folds to its header while the piece plays. Any key, submit, turn or question ends it and
// brings the band back. `/screensaver` turns it on or off, sets the minutes, plays it now or stops it.
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
  barsOf,
  headerLayout,
  publishedManifestPath,
  trackOf,
  shouldRefreshUsage,
  spendOf,
  versionOf,
  versionRow,
} from './build-view.mjs';
import { CHECK_MS, bandHeight, createSaver, parseArgs, statusText } from './screensaver.mjs';
import {
  FPS,
  RENDER_TIMEOUT_MS,
  ROTATE_S,
  SLEEP_MIN,
  captionOf,
  layoutFor,
  parseClip,
  renderArgv,
  fitAt,
  linesOf,
} from './piece-player.mjs';
import {
  LOG_FILE,
  LOG_GITIGNORE,
  budgetRow,
  figuresFromMeasure,
  sessionLine,
  sessionParts,
  sessionVerdict,
} from '../skills/refine/session-budget.mjs';

const STORE_KEY = 'golden-frijoles/build-view';
const VIEW = { plugin: 'golden-frijoles', key: 'buildView' } as const;
const SESSION = { plugin: 'golden-frijoles', key: 'sessionFigures' } as const;
const COUNTDOWN_MS = 60_000; // the reset countdown's redraw (D5): its smallest unit is a minute

const TONE_COLORS = { busy: 'yellow', info: 'cyan', good: 'green', warn: 'yellow', bad: 'red', plain: undefined } as const;
const RISK_COLORS = { LOW: 'green', MEDIUM: 'yellow', HIGH: 'red' } as const;
const LABEL_WIDTH = 13; // build-view-one-story D1: 2 + glyph + space + the label padded to 9 — the resolver's column 13

// The session line's inputs. Module variables, but a hot reload does not start the figures over: `$.state` keeps them
// (the hint row keeps drawing them), so session.start reads them back into `measured` — otherwise the countdown would
// freeze and the next AskUserQuestion would erase them (#312 review). At worst a reload logs one repeated verdict row.
let measured: ReturnType<typeof figuresFromMeasure> | null = null;
let stateWorks: boolean | null = null; // false → this engine has no `$.state`: the plain status line is the session line
let questionsWaiting = 0; // in-flight AskUserQuestion calls; "asks open" is not observable here (D8)
let loggedVerdict: string | null = null;
// The live view (D1). Built in session.start, whose `$` its io closes over — the same way a `$.clock` timer's callback
// uses the `$` of the hook that started it. A hot reload builds a new one (session.start fires again) and the engine
// drops the old environment's timers with it.
let viewer: ReturnType<typeof createViewer> | null = null;
let warnedNoState = false; // log an engine without `$.state` once per load, not on every draw
let usageRefreshedAt: number | null = null; // finops D24 — the last usage refresh attempt, ok or not

// The screensaver's state machine (screensaver D1). Module-level like `viewer`; a hot reload starts it fresh, which at
// worst delays the next start by one quiet window. The two setting fields survive reloads in `$.store`.
const SAVER_KEY = 'golden-frijoles/screensaver';
const SAVER_HINT = 'goldenfrijoles.com'; // the caption's tail when there is no band at all: where the rest of it lives
// Time is the engine's: quiet time is counted in the saver's own `$.clock` ticks, never the wall clock — so a test's
// clock drives it, and a machine asleep for an hour is not an hour away.
let saverMs = 0;
const saver = createSaver({ now: () => saverMs });
let turnRunning = false; // a model turn is in flight: the saver never starts under one (AbovePrompt `isWorking` too)

// The piece (screensaver S1.5). Clips are kept by piece (the last few); one render runs at a time, and a piece that
// failed is not asked again this load. `layout` is the band's last drawing — the room the pieces are fitted to.
const FRAME_MS = Math.round(1000 / FPS);
type Clip = NonNullable<ReturnType<typeof parseClip>>;
const clips = new Map<string, Clip>();
const failed = new Set<string>();
let rendering: string | null = null;
let playIndex = 0; // pieces this run has rotated through
let frameNo = 0;
let playMs = 0; // time on this piece
let playedMs = 0; // time this run has played, for SLEEP_MIN
let layout: { maxRows: number; columns: number; bandRows: number } | null = null;

/** The piece this run is on and how it fits, or null when the terminal has no room for any. */
function wantedPiece() {
  const at = layout ? layoutFor(layout) : null;
  if (!at) return null;
  const fit = fitAt(at.fits, saver.state.seed, playIndex);
  return { fit, compact: at.compact, key: fit.id };
}

let frames: { cancel: () => void } | null = null; // the frame clock: running only while a piece plays

/**
 * A new run starts on its first frame, on the piece its seed picks, and starts the frame clock: 10 frames a second, the
 * next piece after ROTATE_S (rendered while the last one still plays). The clock stops itself the moment nothing plays
 * — an idle session never wakes 8 times a second for nothing.
 */
function beginPiece($: EngineInterface) {
  playIndex = 0;
  frameNo = 0;
  playMs = 0;
  playedMs = 0;
  startFrames($);
}

// The frame clock itself. Also started by the band's own drawing when a piece should play and the clock is not running
// (it stops whenever there is nothing to draw: no band drawn yet, or no room for any piece).
function startFrames($: EngineInterface) {
  frames?.cancel();
  frames = $.clock.every(FRAME_MS, () => {
    if (!saver.state.active) {
      frames?.cancel();
      frames = null;
      return;
    }
    frameNo += 1;
    playMs += FRAME_MS;
    playedMs += FRAME_MS;
    // Nothing to draw here (no band drawn yet, or no room): the clock stops until the band's next drawing restarts it.
    const want = wantedPiece();
    if (!want) {
      frames?.cancel();
      frames = null;
      return;
    }
    // Asleep after SLEEP_MIN, or nothing to play (the piece could not render): the run ends and the band comes back.
    if (playedMs >= SLEEP_MIN * 60_000 || failed.has(want.key)) {
      saver.stop();
      frames?.cancel();
      frames = null;
      $.ui.invalidate('ui.render');
      return;
    }
    if (playMs >= ROTATE_S * 1000 && !rendering) {
      playMs = 0;
      playIndex += 1;
      frameNo = 0;
    }
    void ensureClip($);
    $.ui.invalidate('ui.render');
  });
}

// Render the wanted clip if it is not here yet: a process, off the drawing path, at most one at a time. Never throws.
async function ensureClip($: EngineInterface) {
  const want = wantedPiece();
  if (!want || clips.has(want.key) || failed.has(want.key) || rendering) return want;
  rendering = want.key;
  try {
    const run = await $.process.run(renderArgv(want.key), { timeoutMs: RENDER_TIMEOUT_MS });
    const clip = run.exitCode === 0 ? parseClip(run.stdout) : null;
    if (clip) {
      clips.set(want.key, clip);
      while (clips.size > 3) clips.delete(clips.keys().next().value as string);
    } else {
      failed.add(want.key);
      note($, `screensaver: could not render ${want.fit.name} (exit ${run.exitCode}) — is \`node\` on your PATH?`);
    }
  } catch (err) {
    failed.add(want.key);
    note($, `screensaver: could not render ${want.fit.name}: ${String(err)}`);
  } finally {
    rendering = null;
  }
  $.ui.invalidate('ui.render');
  return want;
}

// D6 — the figures go to `$.state`, where the hint row reads them; on an engine without it, the plain status line.
// Resolves true when the state write landed. Never throws.
async function showSession($: EngineInterface) {
  const figures = { ...(measured ?? {}), questionsWaiting };
  // Anything to show — a question waiting counts before the first measurement, as it did on the plain line (#312 review).
  const any = sessionParts(figures).length > 0;
  const stored = await attempt(
    async () => {
      await $.state.set(SESSION, any ? (figures as never) : null);
      return true;
    },
    () => {},
    false,
  );
  stateWorks = stored;
  // Never both: the row under the hint replaces the plain line (a hot reload from an older copy may have left one).
  $.ui.status(stored ? undefined : (sessionLine(figures, sessionVerdict(figures)) ?? undefined));
  return stored;
}

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

// The person did something: the screensaver ends, and the band redraws only if it was up.
const wake = ($: EngineInterface) => {
  if (saver.touch()) $.ui.invalidate('ui.render');
};

// The view's I/O, spelled at its own call sites. The cache is one `$.store` slot PER CHECKOUT ROOT: the store is shared
// by every session of the plugin, and one slot let two sessions in two worktrees serve each other's view (#240 review).
function ioFor($: EngineInterface) {
  return {
    run: (argv: string[], opts: { timeoutMs: number }) => $.process.run(argv, opts),
    list: (path: string) => $.fs.list(path),
    getCached: (root: string) => $.store.get(`${STORE_KEY}@${root}`),
    setCached: (root: string, entry: unknown) => $.store.set(`${STORE_KEY}@${root}`, entry),
    // screensaver D1 — the view text is the ONLY place "in flight" is read from. The state write redraws the band.
    show: (text: string | null) => {
      saver.onView(text);
      return $.state.set(VIEW, text);
    },
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
    // screensaver D5 — the command, the saved setting, and the quiet clock.
    try {
      await $.command.register({
        name: 'screensaver',
        description: 'Play an ascii.rest animation when no epic is in flight (golden-frijoles)',
        argumentHint: '[on|off|now|stop|<minutes>]',
      });
    } catch (err) {
      note($, `screensaver: /screensaver not registered: ${String(err)}`);
    }
    const savedSaver = (await attempt(() => $.store.get(SAVER_KEY))) as { enabled?: boolean; minutes?: number } | null;
    if (savedSaver) saver.configure(savedSaver);
    $.clock.every(CHECK_MS, () => {
      saverMs += CHECK_MS;
      if (saver.tick({ busy: turnRunning || questionsWaiting > 0 })) {
        beginPiece($);
        void ensureClip($);
        $.ui.invalidate('ui.render');
      }
    });
    // D1 — the tick; D3 — the online refresh, first after a minute, then every five.
    $.clock.every(TICK_MS, () => void live.check('tick'));
    // build-view-upgrade D5 — the reset countdown moves with the clock, not only when a figure does.
    // The figures a hot reload left in `$.state` come back (the session line's own, never invented).
    const kept = await attempt(() => $.state.get(SESSION));
    if (!measured && kept?.value) {
      const { questionsWaiting: _q, ...figures } = kept.value;
      measured = figures;
    }
    $.clock.every(COUNTDOWN_MS, () => {
      if (!measured) return;
      // The plain line is text, not a drawing: on an engine without `$.state` it is rewritten instead (#312 review).
      if (stateWorks === false) void showSession($);
      else $.ui.invalidate('ui.render');
    });
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
    // A subagent's turn is not the person's: only the main conversation's turns move the screensaver.
    if (!e.agentId) {
      turnRunning = true;
      wake($);
    }
    await viewer.check('turn');
    return next(e);
  });

  // screensaver D2 — the other ways the person is there: the turn ended (they will read it), they typed, they sent.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e);
    turnRunning = false;
    wake($);
    return next(e);
  });
  on('prompt.edit', async ($, e, next) => {
    wake($);
    return next(e);
  });
  on('prompt.submit', async ($, e, next) => {
    wake($);
    return next(e);
  });

  // /screensaver [on|off|now|stop|<minutes>] (screensaver D5) — the setting is two fields in `$.store`.
  on('command.run', { command: 'screensaver' }, async ($, e) => {
    const a = parseArgs(e.args);
    if (a.error) return { text: a.error };
    // screensaver D7 — `now` plays at once, an epic in flight or not: the person asked. The answer says what really
    // happened: playing (and how to get back), or why not — never "playing" over a band that drew nothing.
    if (a.action === 'now') {
      const started = saver.start();
      if (!started.ok) return { text: 'screensaver: it is off — `/screensaver on` first.' };
      beginPiece($);
      const want = await ensureClip($);
      if (!want) {
        saver.stop();
        $.ui.invalidate('ui.render');
        return { text: 'screensaver: this terminal is too small for any piece — make it taller or wider and try again.' };
      }
      if (failed.has(want.key)) {
        saver.stop();
        $.ui.invalidate('ui.render');
        return { text: `screensaver: could not render ${want.fit.name} — is \`node\` on your PATH?` };
      }
      $.ui.invalidate('ui.render');
      const back = layout?.bandRows ? 'any key brings the build view back' : 'any key wakes it';
      return { text: `screensaver: playing ${want.fit.name} — ${back}. \`/screensaver off\` turns it off.` };
    }
    if (a.action === 'stop') {
      if (saver.stop()) $.ui.invalidate('ui.render');
    } else if (a.action === 'on' || a.action === 'off') {
      if (saver.configure({ enabled: a.action === 'on' })) $.ui.invalidate('ui.render');
    } else if (a.minutes) {
      saver.configure({ minutes: a.minutes });
    }
    if (a.action !== 'status' && a.action !== 'stop') {
      const { enabled, minutes } = saver.state;
      await attempt(() => $.store.set(SAVER_KEY, { enabled, minutes }));
    }
    return { text: statusText(saver.state) };
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
      await showSession($);
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
      wake($);
      await showSession($);
      return await next(e);
    } finally {
      questionsWaiting = Math.max(0, questionsWaiting - 1);
      wake($); // answering is the person being there: the quiet window starts over
      await showSession($);
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
    const allRows = bandRowsFrom(value ?? null);
    const columns = e.props.bodyColumns;
    // The room the pieces are fitted to: what the band leaves, read on every drawing (screensaver S1.5).
    layout = { maxRows: e.props.maxRows, columns, bandRows: bandHeight(allRows, columns) };
    // screensaver D6 — no band (a folder with no git, or a view that failed) still gets the screensaver.
    const saving = saver.visible({ isWorking: e.props.isWorking, hasSurvey: e.props.hasSurvey });
    if (!allRows.length && !saving) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    // screensaver D3/D7 — the piece at its own size, centred, never scaled; the band folds to its header while it plays
    // only when the terminal has no room for both.
    const want = saving ? wantedPiece() : null;
    if (want && !frames) startFrames($);
    const clip = want ? clips.get(want.key) : undefined;
    const hint = allRows.length ? null : SAVER_HINT;
    const saverRegion = !want ? null : clip ? (
      <Box key="screensaver" flexDirection="column">
        <Box flexDirection="column" paddingLeft={Math.max(0, Math.floor((columns - clip.cols) / 2))}>
          {linesOf(clip, frameNo, want.fit).map((line, y) => (
            <Text key={`s${y}`} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
        <Text dimColor wrap="truncate">{captionOf(clip.name, { band: allRows.length > 0, hint })}</Text>
      </Box>
    ) : (
      <Text key="screensaver" dimColor wrap="truncate">
        {captionOf(`${want.fit.name} (starting…)`, { band: allRows.length > 0, hint })}
      </Text>
    );
    const rows = clip && want?.compact ? allRows.filter((r) => r.kind === 'header') : allRows;
    if (!rows.length) return saverRegion ?? next(e);

    // build-view-upgrade D2/D3 — the resolver's own glyphs and words, coloured; nothing computed here.
    const bars = (value: string) => {
      const b = barsOf(value);
      if (!b) return <Text dimColor>{value}</Text>;
      return (
        <Text>
          {b.lead ? <Text>{b.lead}</Text> : null}
          {b.runs.map((r, j) =>
            r.kind === 'done' ? (
              <Text key={`b${j}`} color="green">{r.text}</Text>
            ) : (
              <Text key={`b${j}`} dimColor>{r.text}</Text>
            ),
          )}
          {'  '}
          <Text>{b.rest}</Text>
        </Text>
      );
    };
    const track = (value: string, tone: keyof typeof TONE_COLORS) => {
      const t = trackOf(value);
      if (!t) return <Text>{value}</Text>;
      return (
        <Text>
          <Text dimColor>{t.before}</Text>
          <Text bold color={TONE_COLORS[tone]}>{t.mark}</Text>
          <Text dimColor>{t.after}</Text>
        </Text>
      );
    };
    // finops S2.4 / build-view-one-story D8 — the Spend bar the resolver wrote: green inside the quote, full and red when
    // over, the rest dim; the `N% over` words red too.
    const spend = (value: string) => {
      const { bar, tone, rest, over } = spendOf(value);
      if (!bar) return <Text>{value}</Text>;
      const [before, after] = over ? rest.split(over) : [rest, ''];
      return (
        <Text>
          <Text color={TONE_COLORS[tone as keyof typeof TONE_COLORS]}>{'▰'.repeat(bar.filled)}</Text>
          <Text dimColor>{'▱'.repeat(bar.width - bar.filled)}</Text>
          {'  '}
          <Text>{before}</Text>
          {over ? <Text color="red">{over}</Text> : null}
          {over ? <Text>{after}</Text> : null}
        </Text>
      );
    };
    // → Next: the command bold, its reason dim (`/build <slug>   (top of the ready list)`).
    const nextCommand = (value: string) => {
      const [command, ...why] = value.split(/ {3,}/);
      return (
        <Text>
          <Text bold>{command}</Text>
          {why.length ? <Text dimColor>{`   ${why.join(' ')}`}</Text> : null}
        </Text>
      );
    };
    const indent = (key: string, child: unknown) => (
      <Box key={key} flexDirection="row">
        <Box width={LABEL_WIDTH} flexShrink={0} />
        <Box flexShrink={1}>{child as never}</Box>
      </Box>
    );

    const band = (
      <Box flexDirection="column" paddingX={1} width={columns}>
        {rows.flatMap((row, i) => {
          if (row.kind === 'header') {
            // build-view-one-story D2/D3 — what, and how far: the title clipped to fit, never the bar.
            const lay = headerLayout(row, columns);
            const left = (
              <Text wrap="truncate">
                <Text dimColor>{row.repo}</Text>{' '}
                <Text bold color={TONE_COLORS[row.tone as keyof typeof TONE_COLORS]}>{row.symbol}</Text>{' '}
                <Text>{row.lead}</Text>
                {lay.title ? <Text>{': '}<Text bold>{lay.title}</Text></Text> : null}
                {row.size ? <Text dimColor>{` · ${row.size}`}</Text> : null}
                {row.risk ? (
                  <Text>
                    <Text dimColor>{' · '}</Text>
                    <Text bold color={RISK_COLORS[row.risk as keyof typeof RISK_COLORS] ?? 'yellow'}>{`▲ risk ${row.risk}`}</Text>
                  </Text>
                ) : null}
              </Text>
            );
            const right = row.right ? bars(row.right) : null;
            if (!right) return [<Box key={`r${i}`}>{left}</Box>];
            if (lay.rightRow)
              return [
                <Box key={`r${i}`}>{left}</Box>,
                <Box key={`r${i}b`} paddingLeft={2}>{right}</Box>,
              ];
            return [
              <Box key={`r${i}`} flexDirection="row" justifyContent="space-between">
                <Box flexShrink={1}>{left}</Box>
                <Box flexShrink={0} marginLeft={2}>{right}</Box>
              </Box>,
            ];
          }
          // mod-layout-v2 — the rule between what the work is for and where it stands, at the band's own width.
          if (row.kind === 'rule')
            return [<Box key={`r${i}`} paddingLeft={2}><Text dimColor wrap="truncate">{'─'.repeat(Math.max(10, columns - 4))}</Text></Box>];
          if (row.kind === 'track')
            return [<Box key={`r${i}`} paddingLeft={2}><Text wrap="truncate">{track(row.value, row.tone)}</Text></Box>];
          if (row.kind === 'link' || row.kind === 'flag')
            return [
              <Box key={`r${i}`} flexDirection="row" paddingLeft={2}>
                <Text color={row.kind === 'flag' ? 'red' : 'cyan'} bold={row.kind === 'flag'}>{`${row.glyph} `}</Text>
                <Box flexShrink={1}><Text wrap="wrap">{row.value}</Text></Box>
              </Box>,
            ];
          if (row.kind === 'story') return [indent(`r${i}`, <Text dimColor italic wrap="wrap">{row.value}</Text>)];
          if (row.kind === 'note') return [indent(`r${i}`, <Text dimColor wrap="wrap">{row.value}</Text>)];
          return [
            <Box key={`r${i}`} flexDirection="row">
              <Box width={LABEL_WIDTH} flexShrink={0}>
                <Text color="cyan">{'  '}{row.glyph} </Text>
                <Text dimColor>{row.label}</Text>
              </Box>
              <Box flexShrink={1}>
                <Text wrap="wrap">
                  {row.label === 'Spend'
                    ? spend(row.value)
                    : row.label === 'Next'
                      ? nextCommand(row.value)
                      : row.label === 'Status'
                        ? track(row.value, row.tone)
                        : row.label === 'Stories' || row.label === 'Sprint'
                          ? bars(row.value)
                          : <Text>{row.value}</Text>}
                </Text>
              </Box>
            </Box>,
          ];
        })}
      </Box>
    );

    // screensaver D3 — under the band (or its header): a terminal too small for any piece gets the band alone.
    if (!saverRegion) return band;
    return (
      <Box flexDirection="column">
        {band}
        {saverRegion}
      </Box>
    );
  });

  // build-view-upgrade D5/D6 — the session line, coloured, on its own row under the engine's hint line. The engine's
  // drawing is kept as it is (`next(e)`); with no figures, or no `$.state`, the hint is left alone.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const base = await next(e);
    const read = await attempt(() => $.state.get(SESSION));
    const figures = read?.value ?? null;
    if (!figures) return base;
    const now = (await attempt(() => $.clock.now())) ?? Date.now();
    const parts = sessionParts(figures, sessionVerdict(figures), now);
    if (!parts.length) return base;
    const { Box, Text } = $.ui.resolve(e);
    const figuresOnly = parts.filter((p) => !p.verdict);
    const verdict = parts.find((p) => p.verdict);
    return (
      <Box flexDirection="column">
        {base}
        <Text wrap="truncate">
          {figuresOnly.map((p, i) => {
            const color = p.tone ? TONE_COLORS[p.tone as keyof typeof TONE_COLORS] : undefined;
            return (
              <Text key={`s${i}`}>
                {i ? <Text dimColor>{' · '}</Text> : null}
                {/* build-view-one-story D9 — the 5-hour meter: its filled cells and words in the figure's tone, the rest dim. */}
                {p.meter ? (
                  <Text color={color}>
                    {p.meter.head}
                    {p.meter.filled}
                    <Text dimColor>{p.meter.empty}</Text>
                    {p.meter.tail}
                  </Text>
                ) : (
                  <Text color={color} dimColor={!p.tone}>
                    {p.text}
                  </Text>
                )}
              </Text>
            );
          })}
          {verdict ? <Text dimColor>{` → ${verdict.text}`}</Text> : null}
        </Text>
      </Box>
    );
  });
};
