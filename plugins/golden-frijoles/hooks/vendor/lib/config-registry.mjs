// config-registry.mjs — every setting Golden Frijoles can ask for, in one table (golden-frijoles-plugin S4.3, D11).
//
// This is the audit §4.3 table as data. Setup reads it for its questions, a script reads it before asking
// just-in-time (lib/config.mjs `needSetting`), and `gf doctor` reads it to say which modules are configured. A new
// setting is a new row here, never a question hard-coded in a skill.
//
//   key       dotted, `<section>.<name>`: the path in golden-frijoles.config.json
//   module    the product module doctor groups it under (Plan · Build · Ship · Measure · Spend · Operate)
//   askWhen   'setup' | 'first-groom' | 'first-pr' | 'first-smoke' | 'first-report' | 'first-prune'
//             | 'first-high-risk-groom' | 'never-yet' (declared so the schema is ready; nothing reads it this wave)
//   default   what a skipped question means. `null` = "unanswered", which a rail must treat as its safest choice
//   question  the plain words an agent asks, once
//   choices   optional allowed values; `store: 'env'` means the answer lives in .env.local (gf init), never here
//
// Zero deps, no imports: config.mjs imports THIS, so it must not import back.

export const REGISTRY = Object.freeze([
  // ── Setup (golden-frijoles-plugin S5.1: Q1, Q2, Q4 are asked; Q3, Q5 wait for their modules, X18) ──
  {
    key: 'project.mode',
    module: 'Plan',
    askWhen: 'setup',
    required: true,
    default: 'existing',
    choices: ['existing', 'new', 'planning-only'],
    question: 'What are we working on: an existing repo (adds Roadmap/, keeps everything else), a new project, or planning only (no repo changes)?',
  },
  {
    key: 'project.startPoint',
    module: 'Plan',
    askWhen: 'setup',
    default: 'idea',
    choices: ['idea', 'plan', 'building'],
    question: 'Where are you starting: an idea, you know what to build, or you are already building?',
  },
  {
    key: 'project.account',
    module: 'Ship',
    askWhen: 'setup',
    default: 'later',
    choices: ['later', 'now'],
    store: 'env',
    question: 'Connect a Golden Frijoles account now (gf login + gf init), or later?',
  },
  {
    key: 'board.sink',
    module: 'Plan',
    askWhen: 'never-yet',
    default: 'terminal',
    choices: ['terminal', 'golden-frijoles', 'notion'],
    question: 'Where should the board live?',
  },
  {
    key: 'verify.depth',
    module: 'Build',
    askWhen: 'never-yet',
    default: 'light',
    choices: ['off', 'light', 'standard', 'deep'],
    question: 'How much proof do you want on risky stories?',
  },
  // ── Just in time ──
  {
    key: 'roadmap.areas',
    module: 'Plan',
    askWhen: 'first-groom',
    default: ['09 Platform & Infra'],
    question: 'Which areas (macro-sections) does this roadmap have? 09 Platform & Infra is reserved.',
  },
  {
    key: 'ways.fillIns',
    module: 'Plan',
    askWhen: 'first-groom',
    default: 'Roadmap/fill-ins.yml',
    question: 'Where are this project\'s WAYS-OF-WORKING fill-ins?',
  },
  {
    key: 'review.families',
    module: 'Build',
    askWhen: 'first-pr',
    default: ['claude'],
    question: 'Which reviewer CLIs do you have (codex, agy, vibe, claude)?',
  },
  {
    key: 'review.reviewScope',
    module: 'Build',
    askWhen: 'first-pr',
    default: 'security-paths-only',
    choices: ['every-pr', 'security-paths-only'],
    question: 'Review every PR, or only PRs that touch security paths?',
  },
  {
    key: 'review.securityPaths',
    module: 'Build',
    askWhen: 'first-pr',
    default: null,
    question: 'Which paths are security-sensitive (globs)? Skipping keeps the template\'s list.',
  },
  {
    key: 'jev.egress',
    module: 'Build',
    askWhen: 'first-pr',
    default: null,
    choices: [true, false],
    question: 'Send PR review text and report drafts to TypeSafe (Jev) to judge their quality? Nothing is sent until you say yes.',
  },
  {
    // NOT `smoke.envs`: that is live-smoke's own {name: url} map, and a list saved there broke it (review of #49).
    key: 'smoke.defaultEnv',
    module: 'Build',
    askWhen: 'first-smoke',
    default: 'local',
    question: 'Which environment should live-smoke check when you don\'t name one (local, preview, production)?',
  },
  {
    key: 'reporting.destination',
    module: 'Operate',
    askWhen: 'first-report',
    default: null,
    question: 'Where should standups and recaps go: Telegram (the scheduled reports post there), or print to the terminal? Slack works for test and ad-hoc messages only, not the scheduled reports. Secrets stay in .env.local.',
  },
  {
    key: 'routines',
    module: 'Operate',
    // never-yet: declares the section so readSection accepts it, while `gf doctor` (which skips never-yet
    // rows) never reports Operate unconfigured for it — its values are per-routine fill-ins that
    // routine-bootstrap.mjs names itself when one is missing (#191 review).
    askWhen: 'never-yet',
    default: null,
    question: 'Which project values should routine prompts fill before you schedule them?',
  },
  {
    key: 'deploy.vercelProject',
    module: 'Operate',
    askWhen: 'first-prune',
    default: null,
    question: 'Which Vercel project should stale previews be counted for?',
  },
  {
    key: 'ship.killSwitchPolicy',
    module: 'Ship',
    askWhen: 'first-high-risk-groom',
    default: 'every-risk-high-story-names-its-flag',
    question: 'Should every risk:high story name its kill-switch flag?',
  },
  {
    // intent-match D4/D16: an optional second-family read of the pitch at the architecture lock. OFF unless a person
    // turns it on — never asked (`never-yet`), because a reader that runs by default is the stall D4 rules out.
    key: 'intent.reader',
    module: 'Plan',
    askWhen: 'never-yet',
    default: 'off',
    choices: ['off', 'on'],
    question: 'At the architecture lock, ask one other model family (codex, agy or vibe) to read the pitch and score whether it would build the same thing? Off by default; any failure is skipped.',
  },
  {
    // semantic-lint D4: the rules the lint rail's selectors run (id, globs, allowlist, patterns, question). never-yet,
    // like `routines`: it declares the section so `config get/set` accept it, and `gf doctor` (which skips never-yet
    // rows and prints one line per MODULE) never reports Build unconfigured because a project has no lint rules.
    key: 'lint.rules',
    module: 'Build',
    askWhen: 'never-yet',
    default: null,
    question: 'Which rules should semantic-lint check on every push (selectors plus one question each for Jev)?',
  },
  {
    key: 'spend.telemetry',
    module: 'Spend',
    askWhen: 'never-yet',
    default: 'off',
    choices: ['off', 'on'],
    question: 'Export cost telemetry?',
  },
]);

export const MODULES = Object.freeze(['Plan', 'Build', 'Ship', 'Measure', 'Spend', 'Operate']);
