# The bet at Stage 1.5 — the result record

Right after the appetite, write the bet: **which input this moves, for whom, by how much, by when, and why we think
so.** It is one sentence (North Star Playbook's bet shape, in product prose), and it becomes the seed's `hypothesis`:

> **We believe that** <the change> **for** <persona, doing their job> **will** <move input X from a to b by the read
> date>, **because** <the insight: their pain or behaviour, with the evidence>. **We'll know when** <the signal: the
> event the target counts>.

**Trace it from the strategy** (`strategy.mjs` printed it at Stage 0):
1. **Which input?** Offer the keys on its `inputs a seed can move` line, by name, and say which one this ask most
   plausibly moves.
2. **For whom, doing what?** Its `persona:` and `job:` lines are the agreed answer; narrow them to the slice this ask
   serves rather than inventing a new person.
3. **By what mechanism, on what evidence?** The *because*: the pain or behaviour the change acts on, and how we know
   (a reading, a conversation, a dogfood finding). "We think so" is allowed, said as such.
4. **Draft the sentence** from the answers and show it; the product owner edits it. Write it into `hypothesis`, the
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
  valid *from* when the read itself will establish it; say so in the *because* rather than guessing a number.

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
