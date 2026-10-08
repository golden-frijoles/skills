# Refine reference — the kill-switch decision (Stage 6b)

Loaded on demand from `SKILL.md` Stage 6b. **This file is the ONE home of the kill-switch polarity rule** — the seed template, the epic DoD and any project flag tooling reference it rather than restating it (ways-of-work-lean-pass S3.4). Moved here verbatim (S3.2); the **mechanism** was rewritten to the Golden Frijoles contract (golden-flags-by-default S1.1), and the **polarity doctrine below is unchanged** — it was already correct and already matches the SDK's semantics.

> **Operating default:** most projects here build with **no new flag unless the product owner asks for one** — see the consuming project's WAYS-OF-WORKING. When one IS asked for, this is how it is decided.

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
     frijoles flags create <domain>.<feature>_enabled --kill-switch --all-envs
     ```
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
