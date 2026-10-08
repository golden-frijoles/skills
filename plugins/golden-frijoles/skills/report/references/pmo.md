<!-- Chapter of the `report` skill (plugin-1-0 S3). Formerly the `pmo-report` skill; its body is unchanged apart from
     the names of its sibling chapters. The kit block and the scripts it runs are in ../SKILL.md. -->
# pmo-report - weekly PMO delivery

> This skill never merges, approves, blocks, or edits app code. Its normal writes are one chat
> message plus one append to the `claude/pmo-reports-log` branch after a successful non-dry run.

## Project config — `reporting.config.json` (TEMPLATE FILL-IN)

`standup-post`, `weekly-recap` and `pmo-report` read **one** file: `reporting.config.json` at the
consuming project's repo root, validated by `scripts/lib/reporting-config.mjs`. It is committed. Nothing
in it is a secret, and a routine's cloud sandbox is a fresh checkout every run, so a gitignored per-skill
config never survived to the next run anyway. Copy `reporting.config.example.json` to start. In a **public** repo, keep the chat id out of git: put it in a gitignored
`reporting.config.local.json`, which is merged over the committed file.

| Key | What it is | Absent means |
|---|---|---|
| `repos` | every repo the reports aggregate over. **Required.** Shared by all three reports, so define it once | the script refuses to run and names the file |
| `deployRepos` | `[{label, repo}]` — the repos where a merge to `main` IS a deploy | no deploys line |
| `telegram.chatId` / `telegram.chatIds.<standup\|weekly\|pmo>` | where each report posts. A surface id wins over the project id, which wins over `TELEGRAM_CHAT_ID` | the send refuses; `--dry-run` still works |
| `smoke` | `{repo, workflow}` — the browser-smoke workflow the standup reports on | no smoke signal |
| `stalePreviewAgeDays` | the age the standup's stale-preview count uses | no stale-preview signal |
| `vercelProject` | the Vercel project whose previews that count reads. **Required when `stalePreviewAgeDays` is set** — the prune script has no default project, by design | the config is refused if the age is set without it |
| `liveFlags` | `{command, cwd}` — prints the flag keys that are ON, one per line | the prose brief treats flag state as *unknown*, never "none" |
| `artifacts.docViewerUrl` | the project's URL-hash markdown viewer, for deck/packet links | no deck links (the Telegram text stands alone) |
| `artifacts.registry` | `{resolverBaseUrl, bucket}` — short-link registry for those decks | links stay URL-hash links |
| `prose.extraBannedToolNames` | this project's own stack names, which the prose guard must reject | only the universal list is enforced |

**This skill refuses to guess.** If the file is missing or a key is malformed, the script exits with a
message naming the file and the key. Report that message, then stop.

## When to run me
The product owner asks for the PMO weekly report, the on-demand monthly packet, or the weekly
**pmo-report** routine (`scripts/routines/pmo-report.prompt.md`) invokes me as its one step.

## What already exists (reuse, don't rebuild)
- **`scripts/pmo-report.mjs`** - the mechanical part. Weekly delivery: `node scripts/pmo-report.mjs
  --weekly`. Safe local smoke: `node scripts/pmo-report.mjs --dry-run --weekly`. Monthly packet:
  `node scripts/pmo-report.mjs --monthly` (automatically emits both the packet doc and metrics sheet).
- **`scripts/lib/gh-rest.mjs`** - REST-only GitHub reads, routine-sandbox-safe.
- **`scripts/lib/log-branch.mjs`** - dedicated `claude/pmo-reports-log` persistence, no main-branch
  push needed.
- **`scripts/lib/telegram-format.mjs`** and **`scripts/lib/pmo-delivery.mjs`** - message length guard,
  headline formatter, and sendMessage wrapper. Chat routing is `scripts/lib/reporting-config.mjs`.
- **`scripts/pmo/templates/`** - the `deck` templates; the script fills values only.

## Stage 1 — ensure config
**Unattended (a routine — no human present):** the environment's `TELEGRAM_CHAT_ID` counts as a
configured chat. **Never** `AskUserQuestion` and **never** write a chat id into a committed file. If
`reporting.config.json` or the chat is missing, stop and use the routine's failure ping. The steps below
are for an interactive run only.

1. If `reporting.config.json` is missing, copy `reporting.config.example.json` and fill it in with the
   product owner, using `AskUserQuestion` for values you cannot derive. The repo list is usually
   derivable from `git remote -v` across the project's checkouts. Commit the file.
2. If the chat is not configured, ask the product owner for the chat id. It is normally the same
   bot/chat the other reports and deploy notifiers use. Write it to `telegram.chatId`, or to
   `telegram.chatIds.<surface>` for a separate channel.

**Never** ask for or write the bot token here. That's a secret and belongs in the `TELEGRAM_BOT_TOKEN`
env var, set outside this flow (the product owner's shell, or the routine's environment config).

## Stage 2 - run it
For the weekly routine path, run:

```bash
node scripts/pmo-report.mjs --weekly
```

For safe smoke without Telegram or log writes, run:

```bash
node scripts/pmo-report.mjs --dry-run --weekly
```

For the monthly packet path, run:

```bash
node scripts/pmo-report.mjs --monthly
```

Report back the headline metrics and the generated `deck` links.

## Stage 3 - on failure
Surface stderr verbatim. Do not retry blindly; a missing chat env var, a missing chat id, GitHub auth, or
a story-deck URL/message-size issue is a config or implementation problem. Two failed attempts on the
same cause escalate to the product owner.

## Gotchas
- **A green routine run is not success by itself.** Success is the message landing with the story-deck
  link. If the script cannot attempt the post, use the routine's failure-ping path.
- **`--monthly` includes `--sheet` by design.** The acceptance is packet doc plus metrics sheet, so the
  product owner should not need a second flag.
- **The log write happens after delivery.** If the send fails, the window is not advanced, so the next
  run can retry the same reporting window.
- **The `deck` URL may be hash-only state** (it is in the origin implementation). If so, don't
  add short-link persistence or a database to work around it.
