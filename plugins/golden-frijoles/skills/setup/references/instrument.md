# Adding the measuring code at setup

After the Strategy gate's Approve, the North Star has inputs, and the gate showed which of them still "need an event".
This step adds those events to the product as a **pull request the founder reviews**: the agent does the legwork,
nothing is merged for them, and nothing reaches Golden Frijoles until they connect (`references/connect.md`).

## 1. Ask once

> Add the measuring code now? It comes as a pull request you review: the Golden Frijoles SDK, one tracked event for
> each input that needs one, and error capture. Nothing is merged for you.
>
> **1 Yes** · **2 Later**

"Later" ends this step: say that the measurement plan is in `Roadmap/00-strategy/north-star.md` and the Connect page
has the snippet. On route 2 (a new idea, nothing built yet) skip this step: there is no product to measure.

## 2. Before touching anything

- **A clean start.** `git status --porcelain` must be empty (or only the files setup itself wrote under `Roadmap/` and
  the config, which you commit first, separately). Never mix the founder's uncommitted work into this branch: if the
  tree is dirty, say so and stop.
- **A branch.** `git switch -c golden-frijoles/measure` (add `-2`, `-3` if it exists). Never commit on the default
  branch.
- **The stack.** From `read-product.mjs`'s output and the manifests: the package manager (`package-lock.json` → npm,
  `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun) and where server code runs (Next.js route handlers
  and server actions, an Express/Fastify/Hono server, serverless functions). The SDK is a Node/TypeScript package: for a
  stack it does not fit (Python, Ruby, Go), say so, add nothing, and point to the HTTP API (`POST /api/v1/track`) in
  the PR description instead.

## 3. The changes

1. **Install the SDK** with the project's own package manager: `npm install @golden-frijoles/sdk` (or `pnpm add`, `yarn
   add`, `bun add`).
2. **One client module**, server side, where the project keeps its helpers (`lib/`, `src/lib/`, `server/`). A server
   handles many people at once, so it makes **one client per request, for that request's user**: never call
   `identify()` on a client shared across requests, which would attribute one person's events to another.

   ```ts
   // lib/golden-frijoles.ts: Golden Frijoles clients. Server-only: the ingest key must never reach a browser.
   import { createGrowthEngineClient } from '@golden-frijoles/sdk'

   // Both written by `frijoles init --ingest`. A missing key makes every call return an error result (the SDK never
   // throws); a missing URL means the hosted engine, goldenfrijoles.com.
   const apiKey = process.env.GROWTH_ENGINE_API_KEY ?? ''
   const url = process.env.GROWTH_ENGINE_URL
   const options = url ? { apiKey, baseUrl: url } : { apiKey }

   /** A client for one request's user. Cheap: it holds no connection. */
   export const growthFor = (userId: string) => createGrowthEngineClient({ ...options, userId })

   /** The server itself, for errors that belong to no one person. */
   export const growthServer = createGrowthEngineClient({ ...options, userId: 'system:server' })
   ```

   In a Next.js app add `import 'server-only'` first when the project already uses it. Never write a key into code:
   the key lives in `.env.local` (written by `frijoles init --ingest`) and in the host's environment settings.
3. **One `track` per input that needs an event**, at the code point that proves it happened, **on the server**: the
   API route, server action or handler that completes the action (an order saved, an invite sent), not the button that
   asks for it. The event name is the one the North Star's input table names; the user id is the product's own:

   ```ts
   await growthFor(user.id).track('order_placed', { featureId: 'checkout' })
   ```

   `track` never throws; do not wrap it in a try/catch that changes the product's behaviour. When there is no clear
   server code point (the action happens only in the browser), add a `TODO(golden-frijoles)` comment where it belongs,
   with the reason, and list it in the PR: never guess, and never put the ingest key in browser code.
4. **Error capture**, from the place errors are handled while the process is still alive. `captureError` sends over
   the network, so it must run where the send can finish (verifier, #338):
   - **Next.js:** `instrumentation.ts`. Next awaits this hook for route handlers and server actions; errors while a page
     renders are reported without waiting, so on a serverless host a few of those may be lost (verifier, #338):

     ```ts
     export async function onRequestError(error: unknown) {
       if (process.env.NEXT_RUNTIME !== 'nodejs') return
       const { growthServer } = await import('./lib/golden-frijoles')
       await growthServer.captureError(error)
     }
     ```
   - **Express:** an error middleware after the routes, which passes the error on unchanged:
     `app.use((err, req, res, next) => { void growthServer.captureError(err); next(err) })`.
   - **Fastify:** `app.addHook('onError', async (request, reply, error) => { await growthServer.captureError(error) })`.
   - **Hono:** inside the existing `app.onError`, add `await growthServer.captureError(err)` before its response. With
     none, add one that keeps Hono's own default (an `HTTPException` such as an auth 401 answers as itself and is not an
     error; anything else is logged and answers 500), adding only the report:

     ```ts
     import { HTTPException } from 'hono/http-exception'

     app.onError(async (err, c) => {
       if (err instanceof HTTPException) return err.getResponse()
       await growthServer.captureError(err)
       console.error(err)
       return c.text('Internal Server Error', 500)
     })
     ```
   - **A crash cannot be reported.** When the process dies (an uncaught exception, or an unhandled rejection under
     Node's default), it exits before a network send can leave. Do not add `process.on` listeners for it: a
     `'uncaughtException'` or `'unhandledRejection'` listener replaces Node's crash and changes how the app fails, and
     `'uncaughtExceptionMonitor'` runs too late to send anything. Say in the PR that crashes are not reported.
   - **Anything else:** skip it and say so in the PR, rather than force it.
5. **Flags:** only when `read-product.mjs` found flag reads. Do not migrate a flag provider here; note it in the PR as
   a later step.
6. **The ignore rule:** `.env.local` must be in `.gitignore` (`frijoles init` refuses otherwise). Never add an env file
   to the commit.

## 4. Check, then open the pull request

- The project's own checks pass: its type check, lint and tests (whatever `package.json` scripts it has). A failure
  you caused is fixed; a failure that was already there is named in the PR, not hidden.
- `git diff --stat` shows only the files above. Commit with a plain message (`Measure the North Star with Golden
  Frijoles`).
- **When `gh auth status` succeeds:** push the branch and `gh pr create` with a body that lists every file and why, the
  events and the code point each one sits at, any `TODO(golden-frijoles)`, and how to try it locally
  (`frijoles init --ingest`, then run the app and `frijoles status`). Show the PR's link.
- **Otherwise:** push the branch if the remote accepts it and print the link to open a pull request; if it cannot be
  pushed, leave the branch and say so. Never merge it, and never push to the default branch.
