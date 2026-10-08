# Flags at runtime — where the provider may live, and where it may not

Loaded on demand from the kill-switch decision (`refine` Stage 6b) and from `apps/*/flags.mjs`. It
answers three questions a flag story keeps rediscovering the hard way: **can the provider run in
middleware, where does each credential live, and what happens when Golden Frijoles is down.**

Everything below was **verified against the published package**, not inferred from the docs. The
version checked is `@golden-frijoles/sdk@0.5.0`; re-run the probe in *Reproducing this* when the SDK
majors.

---

## 1. Fail soft. This is the property everything else is built on

`createFlagProvider` keeps a **background snapshot** and resolves **synchronously against a
caller-supplied default**. Reads never await, never throw, and never depend on the network being up
at the moment of the read:

```js
const enabled = flags.resolveBooleanEvaluation('checkout.demo_enabled', false).value
//                                                                       ^^^^^
//                              the answer when Golden is unreachable, slow, or has never been asked
```

| What is wrong | What a read returns |
|---|---|
| Golden is down, or the laptop is offline | your default, `reason: 'ERROR'`, `errorCode: 'PROVIDER_NOT_READY'` |
| The snapshot is older than `maxStaleMs` | your default |
| The flag does not exist yet | your default, `reason: 'DEFAULT'`, `errorCode: 'FLAG_NOT_FOUND'` |
| The flag exists and is activated | the served value, `reason: 'STATIC'` or `'TARGETING_MATCH'` |

So: **a Golden outage must never fail a build, a test run or a deploy.** `scripts/preflight.mjs`
encodes the same rule — absent configuration fails loudly, an unreachable deployment is a warning —
and `apps/example-app/flags.test.mjs` proves it with a transport that always throws. If you ever
find yourself writing `if (!flags.ready) throw`, you have inverted the one property that makes a
flag provider safe to depend on.

**The default you pass IS the kill-switch's fail-open position.** Pick it to match the polarity:
`true` for a kill-switch (ship live, killable), `false` for an enablement (merge dark).

---

## 2. Edge and middleware — the verified answer

**The API surface is Edge-safe. The lifecycle is not.** Both halves matter, and only ever hearing
the first half is how a middleware seam gets planned that cannot work.

### It runs there

Verified by executing the published `dist/` inside a context whose globals are Edge-only — no
`process`, no `Buffer`, no `require`, no `__dirname` — and driving a full
initialize → resolve → shutdown cycle:

- **No Node builtins at all.** Not `node:fs`, `node:crypto`, `node:path` — nothing. The only
  `require()` calls in the bundle are relative ones between its own modules, which every bundler
  resolves.
- **Web-standard globals only:** `globalThis.fetch`, `AbortController`, `setTimeout`, `setInterval`.
  `unref()` is called behind a `typeof` guard, so its absence off Node is a no-op rather than a
  `TypeError`.
- It ships **CommonJS** (`main: dist/index.js`). Next.js and other bundlers transpile that for the
  Edge runtime without complaint; nothing about it is Node-only.

### It should not live there anyway

An Edge middleware invocation is a **short-lived isolate**. A provider built around a background
refresh assumes a long-lived process, and in middleware:

- **The timer buys you nothing.** `setInterval` may not survive the response, and the next request
  can land in a fresh isolate. The snapshot is re-fetched from cold rather than kept warm.
- **`await provider.initialize()` per request is a blocking network round trip in front of every
  request on your site.** That is the one thing middleware must not do.
- **Without it, every read returns your default.** Which is safe, and also means the flag is not
  actually doing anything.

### So, for a middleware-gated feature, pick one — and say which in the story

1. **Move the seam.** Gate in a Node-runtime route handler, a server component or a server action,
   where one long-lived provider serves many requests. This is the default answer and it is almost
   always the right one.
2. **Accept default-only resolution in middleware** and make the deliberate choice explicit: the
   provider is created with `refreshIntervalMs: 0`, nothing is awaited on the request path, and the
   flag's value in middleware is its compile-time default until the seam moves.
3. **Carve out.** State in the epic that the middleware behaviour is not flag-gated, and why.

Option 1 unless the epic says otherwise. A story that says only "gate it with the flag in
middleware" has not made this decision — it has skipped it.

---

## 3. Credentials — three keys, and they do not travel together

| Key | What it authorizes | Where it lives |
|---|---|---|
| `flag_read` | reading one environment's snapshot | `GOLDEN_FRIJOLES_FLAG_READ_KEY` in `.env.local`, written by `frijoles init`, **server-side only** |
| `flag_sync` | writing flag *definitions* (catalog-as-code) | **CI secrets.** Never in `.env.local` |
| `ingest` | sending telemetry events | wherever your telemetry is configured |

- **`frijoles init` writes only `flag_read`,** on purpose: a verb whose job is "let this app read its
  flags" must not put wider credentials on disk as a side effect. Mint the others deliberately with
  `frijoles keys create --type flag_sync|ingest`.
- **`flagReadKey` must never reach a browser bundle.** It is a revocable credential: anything that
  holds it can read every flag in that environment. Keep the provider in server-only code, never
  prefix the variable with your framework's public prefix (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`), and
  send *resolved values* to the client, never the key. Where a client genuinely needs a flag, resolve
  it on the server and pass the boolean down.
- **`.env.local` is gitignored in this template,** and `frijoles init` refuses to run if git does not
  actually ignore it — it asks `git check-ignore` rather than trusting a line it just appended.
- A `flag_read` key is **scoped to one environment**. A production config holding a development key
  resolves development's flags and says nothing about it, which is the worst shape a flag bug has —
  `scripts/preflight.mjs` fails on exactly that mismatch.

---

## 4. Reproducing this

The Edge claim in §2 is a claim about someone else's package, so it comes with its check. Against a
published tarball, with no project involved:

```bash
npm pack @golden-frijoles/sdk           # then tar xzf the tarball
grep -rn "require(\"node:" package/dist/ ; grep -rnoE "\bprocess\.|Buffer|__dirname" package/dist/*.js
```

Both greps returning nothing is the §2 claim. To go further and *run* it under Edge-only globals,
load `package/dist/index.js` inside a `node:vm` context containing only `fetch`, `AbortController`,
the timers and the standard built-ins, and drive `initialize()` → `resolveBooleanEvaluation()`. It
resolves a served value, and an unknown key returns the caller's default.

**If a future SDK adds a Node builtin, §2's first half stops being true and the answer changes.** A
paragraph that claims Edge-compatibility without a way to re-check it is a paragraph that will be
wrong one release from now.
