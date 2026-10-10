# Refine reference — the flag decisions (Stage 6b): Measure, then Safety

Loaded on demand from `SKILL.md` Stage 6b. **This file is the ONE home of the kill-switch polarity rule** — the seed template, the epic DoD and any project flag tooling reference it rather than restating it (ways-of-work-lean-pass S3.4). Moved here verbatim (S3.2); the **mechanism** was rewritten to the Golden Frijoles contract (golden-flags-by-default S1.1), and the **polarity doctrine below is unchanged** — it was already correct and already matches the SDK's semantics.

> **Operating default** (one-bet-wired, decided by the product owner 2026-10-08): **suggest a Measure flag for every Feature epic**, and a
> Safety flag by risk. Nothing else gets a flag unless the product owner asks for one.

### Measure — "Do you want to know if this worked?" (one-bet-wired D5, D6)

Ask it first, for **every Feature epic**, and suggest yes: a flag is how a bet gets read. "Measure" is an
**enablement** flag the founder rolls out (you → 10% → 50% → everyone), so the funnel compares the people who got it
with nothing guessed. On yes, write the bet's measurement into the seed's frontmatter beside `flag_key:`:

- `target_segment: everyone`: who the bet is for (TARS's Targeted: a strategy choice, the share of the user base with
  the problem; named segments such as "power users" come with `tars-segments`).
- `adopted_event:`: the event that means the feature was really used (not a view of it). Ask; never guess a name.
- `retained_event:` (leave null for "the adoption event again") and `retention_days:` (default 7): what repeating looks
  like, and within how long.
- `satisfied_event:` (optional): a rating or survey event; null means satisfaction is "not measured", never zero.

**Report each evaluation, or the funnel stays empty.** The flag is read through the SDK's flag provider, which does not
report on its own: the code that reads it calls `trackFlagEvaluation` (the SDK README's *Flag evaluation telemetry*),
with `subject: { type: 'user', id }` set to **the same id the app tracks its events with** (`growthFor(user.id)`). The
funnel counts the person in `subject`, so a server client's own user (`system:server`) never stands in for the people
it evaluates for. Write this into the story that puts the feature behind the flag.

**When the founder is not signed in** (`npx -y @golden-frijoles/cli@<version> whoami --json` does not exit 0), this is
the one place an account is suggested, because here it pays off. First read the kit's `config get measure.signIn`: a
value means it was already asked in this project, so do not ask again. Otherwise say, once:

> Measuring needs a Golden Frijoles account: it serves the flag and counts who used it. **Sign in now** (opens your
> browser once) · **Later** (the bet is saved here either way).

"Sign in now" runs `frijoles login`. Either answer is saved with the kit's `config set measure.signIn now|later`, so it
is never asked again in this project. "Later" keeps the bet, and the Plan gate's Flag line says "measured once you sign
in" (`gates.md`). Once signed in, the agent runs `frijoles bet sync
Roadmap/<area>/<slug>/README.md` at the Build gate: it creates the Measure flag (off until rolled out) and leaves an
existing one alone; the funnel arrives with the roadmap push.

A Bug or Chore skips Measure (nothing to read), and so does an epic with no runtime seam a flag could gate.

**Yes to both Measure and Safety is one flag:** the Measure flag. An enablement flag rolled out is also switched off by
rolling it back, so it is the Safety switch too; write one `flag_key`, polarity enablement.

### Safety — "Do you need to be able to switch it off fast?"

Asked second, by risk. Everything below is the Safety decision, unchanged.

### Stage 6b — Kill-switch decision for `risk: high` (recommend, don't auto-inject)
A high-risk epic should ship behind a kill-switch — but that's **decided here at refining**, sliced as
real work, **not** discovered as a checkbox at epic close. For any `risk: high` epic, answer one
question and **write the answer in the scope seed** (the answer is mandatory; the flag itself is not):

> *Is there a runtime seam a kill-switch can gate?*

- **Yes →** *recommend* a kill-switch **story** (the product owner evaluates it at the scope-doc gate — never
  auto-injected). Name **five** things:
  1. **Flag** — `<domain>.<feature>_enabled`, written as `flag_key:` in the seed's frontmatter (the scaffold copies it
     into the epic README; the Hub's epic page shows its state and links to it), created in **Golden Frijoles**, which is the flag
     provider for every project spawned from this template (`AGENTS.md`'s cannot-be-violated rules:
     *never build a parallel flag store*). The taxonomy lives in the provider, not in docs and not in
     a checked-in default map.
     ```
     frijoles flags create <domain>.<feature>_enabled --kill-switch --all-envs \
       --description "<the seed's hypothesis, up to about 400 characters> (epic <slug>)"
     ```
     The description is the bet's Why, so the console says why the flag exists (grounded-bets D9). Clip a long
     hypothesis at a word boundary with `…` (the provider takes 500 characters); leave out `--description` only when
     the seed has no hypothesis.
  2. **Polarity** (pick the fail-open default to match intent):
     - **Kill-switch** (ship live, instantly killable) → default **`true`**, **create it ENABLED in
       every env** (switch *armed*; disabling is the deliberate kill) → `--kill-switch`.
     - **Enablement / dark-launch** (merge dark, activate deliberately — esp. money infra that must be
       **seeded first**) → default **`false`**, **create it DISABLED in every env**, flip on when ready
       → `--enablement`. *"Created disabled" means serving `false`, not absent from the snapshot.*
     - A flag is **invisible until created in the flag provider** — the story must say "create it in every env."
     - `--kill-switch --enablement` together is a usage error. Pick the intent, once.
  3. **Seam** — the single source of truth to gate (one resolver function, wrapping the SDK's
     `createFlagProvider`) so UI + agent surface + the money path are covered by one call. The
     provider resolves **synchronously** against a **caller-supplied default**, so the seam's signature
     carries that default and the flag can never make the seam `async`.
  4. **Activation — its own step, not a consequence of the definition.** Definitions are
     catalog-as-code; activations are not. `frijoles flags sync` pushes definitions from source control and
     **does not activate anything**; `frijoles flags create --all-envs` creates *and* activates. The story
     must carry the check, per environment:
     ```
     frijoles flags get <domain>.<feature>_enabled
     ```
     It prints one row per environment. **PRODUCTION must not read `—`.** In the CLI's vocabulary
     `—` is *never activated here*, `off (nothing served)` is *activated then deactivated* — both
     mean the consumer is serving its call-site default — and anything else is the value a context
     with no attributes actually gets. (`frijoles flags ls` is the all-flags view; it takes no `--env`.)
     *The cautionary tale is real: a project synced 42 flag definitions, never created the
     activations, and 39 of them read "Never turned on here" while the runtime quietly served
     compile-time defaults through the fallback chain. Every dashboard said the flags existed.*
  5. **Runtime placement.** The provider is **server-side**: its `flagReadKey` is a credential and must
     never reach a browser bundle. For a **middleware / Edge seam**, read
     [`references/flags-runtime.md`](https://github.com/golden-frijoles/skills/blob/main/template/references/flags-runtime.md)
     — it ships into every spawned project at `references/flags-runtime.md` — before planning it — the SDK runs there, but its
     background-snapshot design does not, and the answer changes the shape of the story.
- **No →** write the **one-line carve-out reason** (e.g. *DB migration — can't sit behind a runtime flag;
  reversible expand/contract instead*; *gate is the auth provider*; *no new runtime seam*).

The epic Definition of Done then only **verifies** the planned slice shipped, the flag exists **and is
activated in production** — it does **not** introduce the policy as a new build-time gate. This composes
with the merge rule unchanged: the kill-switch story rides the same `HIGH ⇒ the product owner merges`.
See the ADR `Roadmap/00-ideas/seeds/kill-switch-at-grooming.md`.

**If the project has no flag provider linked yet**, `node scripts/preflight.mjs` says so and prints the
one command that fixes it. A kill-switch story planned against a project that cannot create a flag is a
story that cannot be merged.
