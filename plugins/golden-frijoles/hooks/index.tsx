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
// It never throws into the turn: any failure logs (visible with `claude --debug`) and clears the view.
import type { Register } from 'claude-code';
import { bandRowsFrom, buildStateArgv, progressOf, repoFactsFrom, shouldRefresh, statusTextFrom } from './build-view.mjs';

const STORE_KEY = 'golden-frijoles/build-view';
const VIEW = { plugin: 'golden-frijoles', key: 'buildView' } as const;
const GIT_TIMEOUT_MS = 2_000;
const RESOLVE_TIMEOUT_MS = 5_000;

const TONE_COLORS = { busy: 'yellow', info: 'cyan', good: 'green', bad: 'red', plain: undefined } as const;
const RISK_COLORS = { LOW: 'green', MEDIUM: 'yellow', HIGH: 'red' } as const;
const LABEL_WIDTH = 12; // glyph + space + the longest label (`Progress`) + gap

export const register: Register = (on) => {
  on('turn.start', async ($, e, next) => {
    try {
      const head = await $.process.run(['git', 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD', '--show-toplevel'], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const facts = repoFactsFrom(head.stdout, head.exitCode);
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
      await $.state.set(VIEW, null).catch(() => {});
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const { value } = await $.state.get(VIEW);
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
