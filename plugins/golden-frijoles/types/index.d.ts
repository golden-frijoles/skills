// The golden-frijoles plugin's `$.state` contract: the build view's text (the resolver's lines, joined),
// or null when there is nothing to draw. Written by `turn.start`, read by the `AbovePrompt` band.
declare module 'claude-code' {
  interface PluginState {
    'golden-frijoles': { buildView: string | null };
  }
}
