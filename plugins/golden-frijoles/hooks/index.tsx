// index.tsx — the build view, as a Claude Code function hook (build-visualization-claude-mods S4).
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
// It never throws into the turn: any failure logs (visible with `claude --debug`) and clears the view.
import type { Register } from 'claude-code';
import { attempt, bandRowsFrom, buildStateArgv, progressOf, repoFactsFrom, shouldRefresh, statusTextFrom } from './build-view.mjs';
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
const GIT_TIMEOUT_MS = 2_000;
const RESOLVE_TIMEOUT_MS = 5_000;

const TONE_COLORS = { busy: 'yellow', info: 'cyan', good: 'green', bad: 'red', plain: undefined } as const;
const RISK_COLORS = { LOW: 'green', MEDIUM: 'yellow', HIGH: 'red' } as const;
const LABEL_WIDTH = 12; // glyph + space + the longest label (`Progress`) + gap

// The session line's inputs. Module variables on purpose: a hot reload starts them over, which at worst
// logs one repeated verdict row and hides the line until the next measurement — never a wrong figure.
let measured: { contextPct: number | null; fiveHourPct: number | null; sevenDayPct: number | null } | null = null;
let questionsWaiting = 0; // in-flight AskUserQuestion calls; "asks open" is not observable here (D8)
let loggedVerdict: string | null = null;
let repoRoot: string | null = null; // from turn.start's rev-parse, so the log lands at the repo root
let warnedNoState = false; // log an engine without `$.state` once per load, not on every draw

const lineNow = () => {
  const figures = { ...(measured ?? {}), questionsWaiting };
  return sessionLine(figures, sessionVerdict(figures)) ?? undefined;
};

export const register: Register = (on) => {
  on('turn.start', async ($, e, next) => {
    try {
      const head = await $.process.run(['git', 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD', '--show-toplevel'], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const facts = repoFactsFrom(head.stdout, head.exitCode);
      repoRoot = facts.root;
      const cached = await $.store.get(STORE_KEY);
      if (!shouldRefresh(cached, facts.key)) {
        $.ui.log(`build view: cached (${facts.key})`);
        // Always write the view — including an empty one for a cached failure — so a stale view from the
        // previous branch can never stay on screen (the fresh reviewer's finding on #32).
        await $.state.set(VIEW, cached.text || null);
        return next(e);
      }
      // The BUNDLED resolver, never one the open repo supplies (distribute-what-we-use D5).
      const run = await $.process.run(buildStateArgv(facts.root), {
        timeoutMs: RESOLVE_TIMEOUT_MS,
      });
      const text = statusTextFrom(run.stdout, run.exitCode);
      $.ui.log(`build view: resolved (${facts.key}) (${run.exitCode === 0 ? 'ok' : `exit ${run.exitCode}`})`);
      await $.store.set(STORE_KEY, { key: facts.key, at: Date.now(), text });
      await $.state.set(VIEW, text || null);
    } catch (err) {
      $.ui.log(`build view: ${String(err)}`);
      // Guarded: on an engine without `$.state` (see `attempt` in build-view.mjs) the failure above IS that, and
      // an unguarded clear would make the engine skip this hook with an error line.
      await attempt(() => $.state.set(VIEW, null));
    }
    return next(e);
  });

  on('session.measure', async ($, e, next) => {
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
      $.ui.log(`session line: ${String(err)}`);
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
