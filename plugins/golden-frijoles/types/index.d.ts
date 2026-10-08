// The golden-frijoles plugin's `$.state` contract.
//   buildView      — the build view's text (the resolver's lines, joined), or null when there is nothing to draw.
//                    Written by `turn.start`, read by the `AbovePrompt` band.
//   sessionFigures — the session line's figures (build-view-upgrade D6), or null before the first measurement.
//                    Written by `session.measure` and the AskUserQuestion count, read by the `PromptHint` row.
declare module 'claude-code' {
  interface PluginState {
    'golden-frijoles': {
      buildView: string | null;
      sessionFigures: {
        contextPct: number | null;
        fiveHourPct: number | null;
        sevenDayPct: number | null;
        fiveHourResetsAt: number | null;
        sevenDayResetsAt: number | null;
        questionsWaiting: number;
      } | null;
    };
  }
}
