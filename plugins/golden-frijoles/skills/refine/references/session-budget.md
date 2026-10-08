# Refine reference — the budget line at each approval gate

Loaded on demand from `SKILL.md` Stage 7.1 (session-budget D6). **The rule: one deep ask per approval gate;
keep going while the budget line says so.** It replaced "one deep ask per run", which was set for earlier
models; the product owner's decision bandwidth is the binding constraint now, and the line is how it's
measured instead of guessed.

## At every approval gate

Count what you can see, then run:

```
node "$REFINE/session-line.mjs" --asks-open <n> --questions-waiting <n> --gates-passed <n> \
  --root "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
```

- **asks open**: deep asks the product owner has put to this session that have not reached their gate yet.
- **questions waiting**: questions you asked that are still unanswered. Count them; never estimate.
- **gates passed**: approval gates this session has passed, this one included.

Print its one line as-is, e.g.
`2 asks open · 1 question waiting · 1 gate passed · context: not measured here → keep going`.
Cowork cannot see its own context fill, so the line says so rather than guess. The verdict comes from the
same `sessionVerdict()` and `THRESHOLDS` table as the Claude Code line (`session-budget.mjs`, beside the
script). Never restate the numbers from memory: the table is the only place they live.

## Acting on the verdict

| Verdict | Do |
|---|---|
| **keep going** | Start the next deep ask in this session. |
| **checkpoint** | Commit the docs, get the waiting questions answered, journal the next step, then continue. |
| **hand off** | Emit `backlog-cadence.md`'s next-session prompt for the next ⬜ item, and stop. |

Journal only the verdict you act on, never the figures:
`node scripts/session-note.mjs --kind next "<verdict> — <next step>"` (where the project has the script;
if it doesn't, say so). The figures go to the local log, `.golden-frijoles/session-budget.jsonl`, which
the script creates with its own `.gitignore`; `--no-log` skips it.

**The line advises; it never ends a session for you.** If the product owner wants to keep going past a
hand-off, that's their call: say what the line said, and go on.
