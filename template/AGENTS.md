# Agent index — <TEMPLATE FILL-IN: project name>

## What is this?

<TEMPLATE FILL-IN: one or two sentences — what this product does, for whom, and the mission behind
it.>

**Architecture**: <TEMPLATE FILL-IN: the stack in one line — e.g. "Next.js App Router + Postgres" or
"a Django API + a React SPA".>

**Repo layout** (fill in if this is a monorepo; delete if it's a single app):
```
<repo-root>/
├── apps/<app-a>/     ← <what it is>
└── apps/<app-b>/     ← <what it is>
```

**Workflow (gitflow)**: work on a **feature branch** (`feat/<epic-slug>`), commit per story, open a
**PR**, and **merge to `main`** when verified + approved. Merging to `main` is the deploy —
<TEMPLATE FILL-IN: describe your actual deploy mechanism/timing here>. Never commit feature work
straight to `main`. Roll back a bad merge with `git revert` on `main`.

## Start here (orientation for any agent)

Before planning or building, read these — they are the source of truth and change often:
- **`Roadmap/README.md`** (product source of truth, one level above this file if nested under an app)
  — the product poster: every feature by domain, current status.
- **`Roadmap/WAYS-OF-WORKING.md`** — how we plan/build/ship: the cadence, gitflow, Definition of Done
  (story **and** epic), QA/smoke-test rules, the test harness. Follow it.
- **`Roadmap/LEARNINGS.md`** — the distilled, cross-cutting wisdom from past epics' retrospectives
  (multi-agent + async-deploy coordination, tooling gotchas, what's worked). **Read it** — it's how a
  past retro reaches you instead of dying in its epic folder. You feed it at epic close (see the epic
  Definition of Done).
- **Team memory** (if your tooling keeps one) — durable facts: deploy topology, per-epic notes,
  gotchas.
- Process: **plan first** (plan mode → user stories → product-owner approves) → branch + **scaffold
  the epic/sprint docs before code** → build one story → verify → **smoke-test** → PR → merge. At
  **epic close**, update `Roadmap/README.md` (the poster), write a `RETROSPECTIVE.md`, and **promote
  its durable learnings to `Roadmap/LEARNINGS.md`**.
- **First session in a fresh spawn: run `node scripts/preflight.mjs`.** It is the one command that
  says whether this project can create a kill-switch, and it prints the two commands that fix it if
  not. A `risk: high` epic cannot be planned properly against a project with no flag provider.

---

## ⚠️ The rules that cannot be violated

### 1. Feature flags are Golden Frijoles. Never build a parallel flag store.

**This rule ships with the template and is not a fill-in.** Every `risk: high` epic here has to
answer the kill-switch question, and the answer names a flag mechanism — so the mechanism cannot be
"whatever this project happened to build". It is Golden Frijoles, for every project spawned from
`template/`.

| Concern | Where it lives |
|---|---|
| Creating a flag, in every environment | `frijoles flags create <domain>.<feature>_enabled --kill-switch --all-envs` |
| Reading a flag at runtime | the one seam — `apps/*/flags.mjs`, wrapping `createFlagProvider` |
| Turning a flag on or off | `frijoles flags rollout` / `frijoles flags kill`, or the Golden console |
| The credential | `GOLDEN_FRIJOLES_FLAG_READ_KEY` in `.env.local`, written by `frijoles init`, **server-side only** |
| Reading them at all | `npm install @golden-frijoles/sdk` in the app that reads flags — `frijoles` writes, the SDK reads |
| Is it linked at all? | `node scripts/preflight.mjs` — it fails loudly and prints the one command |

What this forbids, concretely: a checked-in map of default flag values, a `flags` table in your own
database, a `FEATURE_X_ENABLED` env var used as a flag, a second SDK. **A read's `fallback` argument
is not a store** — it is what that one call site does when it has no answer, and it is the flag's
fail-open position (`true` for a kill-switch, `false` for an enablement).

Three things that are easy to get wrong, each answered in
[`references/flags-runtime.md`](references/flags-runtime.md):

- **A Golden outage must never fail a build, a test run or a deploy.** Reads resolve synchronously
  against the caller's default. If you write `if (!flags.ready) throw`, you have inverted the one
  property that makes a flag provider safe to depend on.
- **Middleware / Edge is a decision, not a default.** The SDK runs there; its background-snapshot
  design does not. Move the seam to a Node runtime, or say in the epic that you did not.
- **Activating a flag is its own step.** `frijoles flags sync` pushes *definitions* and activates nothing.
  A kill-switch story that stops at "created" can serve compile defaults in production while the
  console reads "never turned on here".

**The plan the free tier gives you (⚠️ not enforced yet, and not the public pricing page — see below):**

| Tier | Price | Evaluations / mo | Projects | Seats | Flags · Envs · Segments |
|---|---|---|---|---|---|
| **Free** | $0 | 50,000 | 1 | 1 | **Unlimited** |
| **Start-Up** | $45/mo | 1,000,000 | Unlimited | 3 | Unlimited |
| **Scale-Up** | $300/mo | 5,000,000+ | Unlimited | 5 (+15 @ $50) | Unlimited |

**Unlimited flags and environments on the free tier is what makes rule 1 enforceable** — a project
creates every kill-switch it needs without paying. The metered axis is evaluations, and the SDK's
background-snapshot design consumes them at refresh rate, not per request.

> ⚠️ **NOT ENFORCED, DELIBERATELY. Every account gets everything, unlimited.** This table is the
> written definition, not a live limit: there is no metering, no quota display, no upgrade prompt
> and no limit error anywhere in the product today. **Do not build against these numbers** — do not
> add a quota check, a tier branch or an "approaching your limit" warning. If you hit something that
> looks like a limit, it is a bug, not a plan.
>
> ⚠️ **And these are not the prices on the public pricing page.** This is the *flag-plan model*
> decided 2026-09-16 for the mandate in rule 1; the product's public landing page prices its tiers
> differently and moves on its own schedule. The only line rule 1 actually depends on is the one
> above it: **unlimited flags and environments on the free tier.** If you need a price to quote,
> read the pricing page, never this table.

<!-- TEMPLATE FILL-IN — rules 2 and up are yours. This is the load-bearing section of this file:
     write 2-4 more non-negotiable architectural rules for THIS project — the things that must never
     be worked around, no matter how convenient a shortcut looks in the moment. Keep rule 1 above.
     Worked example shape below, replace entirely — do not ship this as-is: -->

<!--

### 2. <System of record> owns <domain>. Never build it from scratch.
If a feature touches <core domain concepts>, it goes through <the canonical module/service>. Do not
create ad-hoc tables or bespoke routes for these concerns.

| Concern | Where it lives |
|---|---|
| <concept> | <canonical location> |

### 3. <Secondary datastore> is ONLY for <non-core> data.
<Rule of thumb for what belongs where.>

### 4. <Any first-class cross-cutting concern> must stay accurate.
<What "accurate" means here and how it's checked.>

### 5. <Auth provider> is the auth layer. Never replace it.
<What this means in practice — no custom auth pages, etc.>

### 6. <Any other non-negotiable house rule, e.g. a copy/locale policy>.
<State it precisely enough that a fresh agent can self-check against it.>
-->

---

## Context routing — read only what you need

<!-- TEMPLATE FILL-IN: a table pointing from "what I'm working on" to the right context doc, so an
     agent doesn't have to read everything. Keep entries short. -->

| I'm working on… | Read these docs |
|---|---|
| a feature flag / a kill-switch story | [`references/flags-runtime.md`](references/flags-runtime.md), then `node scripts/preflight.mjs` |
| <area> | <doc path> |

---

## Quick-reference

```bash
# TEMPLATE FILL-IN: your project's real dev/build/test commands
npm run dev
npx tsc --noEmit
npm run build
```

**Key env vars**:

| Variable | What it is | Where it lives |
|---|---|---|
| `GOLDEN_FRIJOLES_URL` | the Golden Frijoles deployment | `.env.local` (written by `frijoles init`) |
| `GOLDEN_FRIJOLES_FLAG_READ_KEY` | reads this environment's flag snapshot — **server-side only** | `.env.local`, gitignored, mode 0600 |
| `GOLDEN_FRIJOLES_ENVIRONMENT` | `development` \| `preview` \| `production` | `.env.local` |

A `flag_sync` key (writing flag *definitions*) is an operator/deploy credential and belongs in **CI
secrets**, never in `.env.local`. `frijoles init` deliberately does not write one.

<!-- TEMPLATE FILL-IN: add the env vars YOUR app needs below, grouped by app if a monorepo. -->

**Key imports**:

- `apps/example-app/flags.mjs` — `flags.isEnabled(key, fallback)`. The only flag seam (rule 1).

<!-- TEMPLATE FILL-IN: the handful of `lib/` seams every feature should reuse instead of reinventing
     (a data client, an auth helper, a notification sender, a rate limiter — whatever your project's
     equivalents are). -->
