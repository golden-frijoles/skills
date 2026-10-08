<!-- Chapter of the `strategy` skill (plugin-1-0 S3.1). Formerly the `cold-read` skill; its body is unchanged apart from
     the names of its sibling chapters. The kit block and the scripts it runs are in ../SKILL.md. -->
# cold-read: an independent read first, compared at the end

A cold read is worth something only if two things hold: **it was written without the maker's strategy**, and **nobody
changed it afterwards**. The first is the exclusion list in the brief; the second is the seal. Keep both, or the
compare measures nothing.

## Part 1: before coaching (the read)

1. **Run it on another model family:**
   `node scripts/cold-read.mjs run`
   It hands the brief to Codex, writes `Roadmap/00-strategy/cold-read/<date>-cold-read.md` and seals it. Give the maker
   the sha256 it prints and ask them to keep it: the compare checks it, because a seal file beside the read could be
   replaced, and the hash they hold cannot.
2. **Exit 3 means no other family is reachable.** Say so in one line ("No other model family here, so this read is
   same-family; agreement will count for less."). Then run it yourself with a separate agent (a subagent or a fresh
   session), never in this conversation:
   - give it exactly the output of `node scripts/cold-read.mjs brief --out Roadmap/00-strategy/cold-read/<today>-cold-read.md`,
     nothing else from this conversation. That brief tells it to write the read there (with the frontmatter that
     records `family: claude (same family)`) and to reply only `written`;
   - if it replies with anything more than that, don't read it: say the read may have reached you and the compare
     will note it;
   - then seal it: `node scripts/cold-read.mjs seal Roadmap/00-strategy/cold-read/<today>-cold-read.md`, and give the
     maker the hash to keep, as in step 1. **A read missing its reading log, its contamination or its riskiest
     assumption is refused** (exit 1, naming what is missing): ask the same agent to finish it, then seal again.
3. **Do not open the read.** You are about to coach this maker, and a read you have seen is no longer independent.
   Check only that the file exists and the seal was printed. If the maker opens it, that is their choice; note it in
   the compare.
4. **Offer the coaches next:** "The cold read is sealed. Want to start the strategy coaches? The first is
   `pmf-narrative`." Offer; don't start unasked.

## Part 2: after coaching (the compare)

Run this once the last coach has finished, before the Strategy gate (refine's `references/gates.md`).

1. Ask the maker for the hash they kept, then
   `node scripts/cold-read.mjs compare <the sealed read> --expect <their hash, or its first 12 characters>`.
   It verifies the seal, checks it is the one they were shown, and writes `<the read's name>-compare.md` beside it. If they
   didn't keep it, run without `--expect`: the compare is then marked **UNVERIFIED**, and it stays so until they confirm
   the full hash it prints against their notes. Say so in one line; never call an unverified compare verified.
   **If it refuses, stop**: tell the maker the hashes it names and that the read or its seal changed after sealing,
   so this compare cannot run on it. Never reseal it.
2. **Now read the cold read**, then the coached files, and fill each section of the compare:
   - **Converged** and **Diverged**: one row per topic; in Diverged, say which side is stronger and why.
   - **Only the cold read saw** and **Only the coached run saw**: numbered, one finding each.
   - The facilitator-authored sections the script listed are coach vs cold read, not maker vs cold read: weigh them so.
   - **Decisions for the maker**: numbered. A change to a strategy file the maker has already approved is a decision,
     never a silent edit.
   - **Did it earn its place**: what it changed, what it cost.
3. Show the maker the Decisions, then follow *When a coach finishes* in refine's `references/gates.md`.

## Rules

- Nothing in the cold read is invented: "couldn't find" is an answer, and every figure has a source.
- The read's *Reading log* (with *Contamination*) and *Riskiest assumption and the cheapest test* are mandatory; the
  seal refuses a read without them.
- The read and its seal are the maker's strategy material: never commit them on their behalf.
