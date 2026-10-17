// eslint.config.mjs — the rails' lint, held where they are written (template-scripts-consumer-gates D1).
//
// The projects that copy template/scripts run `eslint --max-warnings=0` on what they copy, so an unused
// binding written here failed THEIR gate after a release (plugin waves 1 and 2: 13 orphaned bindings, then
// an unused import). This file is the one rule source for that check, run in two places:
//   - here, in this repo's own CI (`eslint . --max-warnings=0`, the "rails lint" step), and
//   - in the golden-frijoles monorepo's `npm run lint`, which spreads RAILS with `basePath: 'skills'`.
// Patterns are relative to this directory in both.
//
// Core ESLint only: no plugin imports, so it runs from a bare global install with no node_modules. It asks
// one question, the one consumers' gates have failed on. Adopting a consumer's full config is out of scope.

export const RAILS = [
  {
    // Lint the scripts a project copies or the plugin runs, and nothing else: every other script file in this
    // repo is ignored, then the rails are un-ignored. `vendor/` holds generated copies of template/scripts,
    // which are linted at their source.
    ignores: [
      '**/*.{mjs,js,cjs}',
      '!template/scripts/**/*.mjs',
      '!template/optional/**/*.mjs',
      '!plugins/golden-frijoles/hooks/*.mjs',
      '!plugins/golden-frijoles/skills/**/*.mjs',
      '**/vendor/**',
    ],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // The same options as the monorepo's own scripts/ block: `_` marks a binding kept on purpose.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];

export default RAILS;
