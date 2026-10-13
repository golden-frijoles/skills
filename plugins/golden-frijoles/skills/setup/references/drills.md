# Drills — rehearse a failure before a customer finds it

A **drill** (a scenario) injects one bounded, synthetic fault into your own app — a capped delay or a synthetic error
— for a synthetic cohort only, and records what happened. The agent runs the whole thing with `frijoles` and the SDK;
the founder can watch and stop it on the scenarios page (`/app/scenarios/<project>`).

Every write below needs the project's **owner** and the deployment's drill switches on. If a command answers
`disabled`, the switch is off for that deployment: say so, do not retry.

## 1. Make the app a target (once per app)

```sh
frijoles scenarios targets add site.probe --origin https://your.app   # prints a gf_target_… token ONCE
```

Put the token in the app's **server** env as `GOLDEN_FRIJOLES_TARGET_TOKEN` (never in chat, a commit or the browser),
and serve the ownership check with the SDK (`@golden-frijoles/sdk` ≥ 1.1):

```ts
// app/api/internal/resilience/ownership/route.ts (Next.js; any Fetch-API runtime works the same)
import { createScenarioOwnershipHandler } from '@golden-frijoles/sdk'
const answer = createScenarioOwnershipHandler({ token: process.env.GOLDEN_FRIJOLES_TARGET_TOKEN! })
export async function POST(request: Request) {
  return (await answer(request)) ?? new Response(null, { status: 404 })
}
```

Open that as a pull request, deploy it, then: `frijoles scenarios targets verify site.probe`. A failed verify says
why (unreachable, not answered, wrong token) and changes nothing. A lost token cannot be shown again: revoke the target
and add it under a new key.

## 2. Give the fault a seam

The fault is applied only where the app asks for it. Add one server route the drill reaches and nothing else does —
signed with a secret only the drill holds, and only for `synthetic:` subjects — that resolves the scenario with
`createScenarioProvider`, reserves a lease, applies the closed fault (`delay` or `synthetic_error`), settles, and
records it with `trackScenarioExecution` (the SDK README's "Bounded scenario provider" section is the recipe). Never
apply a fault on a path a real user takes, and never treat scenario data as code, URLs or headers.

## 3. Run the drill

```sh
frijoles flags create site.drill_fault --type json \
  --variants '[{"key":"control","value":{"kind":"none"}},{"key":"fault","value":{"kind":"delay","delayMs":1500}}]' \
  --default control --env production
frijoles flags rollout site.drill_fault --percent 50 --variant fault --env production
frijoles scenarios define site-delay --target site.probe --flag site.drill_fault@<version with the rollout>
frijoles scenarios launch site-delay
frijoles scenarios runs --watch          # send the synthetic probes now
frijoles scenarios stop <run-id>         # the emergency control: always available
```

`frijoles scenarios ls` shows targets, definitions (with the fault flag versions they can use) and runs. Report the
run's counts and stop reason to the founder, and point them at the impact comparison on the scenarios page: it is a
correlation on a synthetic cohort, never a causal claim about customers.

## Never

- Launch an `external` cohort or a security drill in production from here: both need the founder's own approval.
- Leave a run running when you hand off: stop it, or say plainly that it is still running and until when.
