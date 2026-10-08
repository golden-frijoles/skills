import { test, expect } from '@playwright/test'

// The `api` project — the deterministic gate. This spec is the app-level half of D1: whatever the
// flag provider is doing, the app BOOTS, SERVES, and answers with a resolved value.
//
// ⚠️ **It asserts the SHAPE, never the VALUE, and that distinction is the whole point** (found in
// review). The first version hard-asserted `demo.hello_enabled === false`, which is the answer only
// while the flag provider is NOT working: this template's own walkthrough has the project run
// `frijoles flags create demo.hello_enabled --kill-switch --all-envs`, and `--kill-switch` means born
// serving `true`. So a project that followed the instructions turned its own shipped gate red, and
// the gate was green precisely while flags were broken — an assertion pointing exactly backwards.
//
// TEMPLATE FILL-IN: keep this spec when you replace the rest of the example app. Point it at your
// own first flag; the properties below are the ones worth keeping.
test('the flags endpoint answers with a resolved boolean, whatever the provider is doing', async ({ request }) => {
  const res = await request.get('/api/flags')
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  // A boolean either way: served by Golden Frijoles, or the call-site default. Never null,
  // never undefined, never a thrown 500 — that is D1 at the app's edge.
  expect(typeof body['demo.hello_enabled']).toBe('boolean')
  expect(body.provider?.provider).toBe('golden-frijoles')
  // The status seam never carries credential material, so it is safe on a health endpoint.
  expect(JSON.stringify(body)).not.toContain('gf_flagread')
})

test('the app serves normally whether or not the flag provider is ready', async ({ request }) => {
  const health = await request.get('/api/health')
  expect(health.ok()).toBeTruthy()
  expect(await health.json()).toEqual({ ok: true })
})
