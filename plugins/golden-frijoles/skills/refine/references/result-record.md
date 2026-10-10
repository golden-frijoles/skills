# The bet at Stage 1.5 — the result record

Right after the appetite, write the bet: **which input this moves, for whom, by how much, by when, and why we think
so.** It is a short plain story of two or three sentences, and it becomes the seed's `hypothesis`. Anyone should be able to
follow it: who has the problem, what changes, why it matters to them.

**Read the strategy first.** Before drafting, read what exists of `Roadmap/00-strategy/` in the consuming project:
`pmf-narrative.md` (the persona and the value proposition), `brand-platform.md`, and the business model notes. Use
whichever exist; the `persona:` and `job:` lines `strategy.mjs` printed still apply. If none exist, draft from the ask
alone and say so.

**Write it in this order:**
1. What is wrong today, and for whom.
2. What changes.
3. Why that matters to them (the value proposition, in their words).
4. **We'll know when** <the signal: the event the target counts>.

**Keep it at 320 characters or fewer.** No file names or paths, no backticks, no code names (snake_case or dotted
keys), and none of the internal words: wiring, seam, endpoint, frontmatter, schema, route, payload, hook. A guard
(`why-check`) enforces the length and the vocabulary, and the product owner still edits the draft. The target numbers
go in the target fields below, not necessarily in the prose.

**Before and after.** A Why that reads as parts stuck together:

> We believe that wiring each bet's flag to its epic, its adoption event and its funnel read, for founders who refine
> and ship bets with their agent, will let them see whether a feature worked, because today the flag and the funnel
> live apart.

The same Why as a story (312 characters):

> Today a founder ships a feature and cannot tell if anyone used it, because the switch that turned it on and the
> numbers that would show it live apart. Put them on one page and every bet shows who it reached, who used it and who
> came back. We'll know when a founder reads that funnel before deciding the next bet.

**Trace it from the strategy** (`strategy.mjs` printed it at Stage 0):
1. **Which input?** Offer the keys on its `inputs a seed can move` line, by name, and say which one this ask most
   plausibly moves.
2. **For whom, doing what?** Its `persona:` and `job:` lines are the agreed answer; narrow them to the slice this ask
   serves rather than inventing a new person.
3. **What is wrong today, on what evidence?** The pain or behaviour the change acts on, and how we know
   (a reading, a conversation, a dogfood finding). "We think so" is allowed, said as such.
4. **Draft the story** from the answers and show it; the product owner edits it. Write it into `hypothesis`, the
   persona into `persona`, and the target into the fields below.

- **Which number.** Offer the input keys `strategy.mjs` printed on its `Target:` line, by name. A key from that list is
  a *grounded* bet. With no North Star inputs, take free text; readers show it as "not grounded". Never check the
  network at refining.
- **From → to.** Two numbers. A target may go down (`44 → 30`). From and to cannot be the same.
- **Read when.** A day, `YYYY-MM-DD`, or leave it blank: blank means 30 days after shipping, derived by the extract and
  never written back. A written day that passes before the epic ships is read the day it ships — prefer blank unless
  the date matters. A read more than 90 days after shipping is recorded and marked late.
- **All three or none.** `target_metric`, `target_from` and `target_to` go together (the contract refuses a partial
  target, which would otherwise never come due); `read_date` only with them.
- **"No target" is an answer.** Leave the fields null; never invent a number to fill the slot. "No baseline yet" is a
  valid *from* when the read itself will establish it; say so in the story rather than guessing a number.

## The challenge — when no input fits

When the ask can't name an input with a credible mechanism, **challenge once**, as a partner, not a form. Offer two
or three reframes taken from the strategy, each one line:
- **Another input.** The same ask aimed at the input it could actually move ("this reads like `<other key>`: …").
- **A smaller cut.** A slice that tests the highest domino `strategy.mjs` printed, before building the whole thing.
- **A chore.** "This keeps something working; no hypothesis needed" — then classify it as one (Stage 2).

The product owner picks one, or **overrides**: the bet is funded as asked, and that is always allowed. Record it as
`grounded: false` with `grounded_reason` (their reason, one sentence: "launch blocker", "a bet on the brand, not an
input"). A grounded bet records `grounded: true`. Never repeat the challenge for the same seed, never block the gate on
it, and never rewrite a recorded reason. `grounded_bets_share` counts exactly this record (`scripts/bets-grounded.mjs`):
a bet is grounded when its target is a North Star input with a from and a to, whatever the field says.

**A Bug or a Chore** skips the bet: its `hypothesis` is `Why: keeps <X> working`, `grounded` stays null, and it is not
counted. The class is confirmed at Stage 2; when the ask is plainly one already (a defect, a dependency bump), skip the
bet here, and if Stage 2 classifies it otherwise, come back and write the bet.

Write the answers into the seed's frontmatter: `hypothesis` (the sentence), `persona`, `grounded` and
`grounded_reason`, `target_metric`, `target_from`, `target_to`, `read_date`. The Plan gate shows them as Target and Read date (`references/gates.md`). `scaffold-epic`
carries them into the epic README, which is born with `verdict`, `verdict_actual`, `verdict_evidence` and
`verdict_at` null. On the read date, `node scripts/epic-read.mjs --epic <slug>` fetches the number through `frijoles` (signed in with
`frijoles login`) and drafts the verdict (proven, disproven
or unclear) with its evidence, and `--write` stamps it only after the product owner approves.
