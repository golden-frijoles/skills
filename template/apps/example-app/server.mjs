#!/usr/bin/env node
// server.mjs — the smallest real app the e2e harness can run against. TEMPLATE FILL-IN: delete this once
// your real app exists and point playwright.config.ts's webServer at your app's own dev command.
//
// It exists so the harness is RUNNABLE on day one instead of being a shape with no specs: `npm run
// test:e2e` starts this, runs the api gate against it, and goes green — which proves the wiring (base URL,
// projects, webServer) before any product code is written. Zero deps.
//
//   node server.mjs            # http://localhost:3000   (PORT overrides)
//
// It also demonstrates the flag seam: `flags.isEnabled(key, fallback)` from ./flags.mjs, resolved
// on the SERVER and rendered as a value. With no `.env.local` and no SDK installed the call returns
// its call-site default and the app boots exactly as before — which is the point, and what
// e2e/flags.spec.ts asserts.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { flags } from './flags.mjs';

// `.env.local` is what `frijoles init` writes, and a framework app loads it for you. This one has no
// framework, so it loads it here — from the app directory first, then the repo root, because either
// is a reasonable place to have run `frijoles init`. Guarded on both sides: `process.loadEnvFile` needs
// Node >= 20.12, and a missing file is the ORDINARY case on a fresh clone. Nothing about a flag
// provider may stop this server starting.
for (const candidate of ['./.env.local', '../../.env.local']) {
  try {
    process.loadEnvFile?.(fileURLToPath(new URL(candidate, import.meta.url)));
    break;
  } catch {
    /* not there, or not supported — every flag then resolves to its call-site default */
  }
}

const PORT = Number(process.env.PORT || 3000);

// The demo kill-switch. `false` is this call site's fail-open position: the app is correct with the
// flag absent, unset, or with Golden Frijoles unreachable.
const DEMO_FLAG = 'demo.hello_enabled';
const demoEnabled = () => flags.isEnabled(DEMO_FLAG, false);

const home = () => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Example app</title></head>
  <body>
    <main>
      <h1>Example app</h1>
      <p data-testid="status">The harness is wired.</p>
      <p data-testid="demo-flag">${DEMO_FLAG}: ${demoEnabled() ? 'on' : 'off'}</p>
    </main>
  </body>
</html>`;

export const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/flags') {
    // Resolved VALUES, never the key. `flags.status()` carries no credential material.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ [DEMO_FLAG]: demoEnabled(), provider: flags.status() }));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(home());
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Awaited, then the server starts — but a failure here is a LOG LINE, never a refusal to boot.
// `initialize()` resolves rather than rejects for every outage shape (see flags.mjs), so there is
// nothing to catch; the app is correct either way and reads fall back until a snapshot arrives.
await flags.initialize();

server.listen(PORT, () => console.log(`example-app listening on http://localhost:${PORT}`));
