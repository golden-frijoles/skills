# The target at Stage 1.5 — the result record

Right after the appetite, ask **once: which number should this move, from what to what, and when do we read it?**

- **Which number.** Offer the input keys `strategy.mjs` printed on its `Target:` line, by name. A key from that list is
  a *grounded* bet. With no North Star inputs, take free text; readers show it as "not grounded". Never check the
  network at grooming.
- **From → to.** Two numbers. A target may go down (`44 → 30`). From and to cannot be the same.
- **Read when.** A day, `YYYY-MM-DD`, or leave it blank: blank means 30 days after shipping, derived by the extract and
  never written back. A written day that passes before the epic ships is read the day it ships — prefer blank unless
  the date matters. A read more than 90 days after shipping is recorded and marked late.
- **All three or none.** `target_metric`, `target_from` and `target_to` go together (the contract refuses a partial
  target, which would otherwise never come due); `read_date` only with them.
- **"No target" is an answer.** Leave the fields null; never invent a number to fill the slot.

Write the answers into the seed's frontmatter: `hypothesis` (one sentence), `target_metric`, `target_from`,
`target_to`, `read_date`. The Bet block shows them on one `Target:` line (`references/funding.md`). `scaffold-epic`
carries them into the epic README, which is born with `verdict`, `verdict_actual`, `verdict_evidence` and
`verdict_at` null. On the read date, `node scripts/epic-read.mjs --epic <slug>` fetches the number through `gf` (signed in with
`gf login`) and drafts the verdict (proven, disproven
or unclear) with its evidence, and `--write` stamps it only after the product owner approves.
