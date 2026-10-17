// prod-smoke.checks.example.mjs — TEMPLATE FILL-IN. Copy to prod-smoke.checks.mjs, then edit.
//
// The production watchdog's assertions, as a reviewed file (scripts/prod-smoke.mjs is the engine; the
// daily routine is scripts/routines/prod-smoke.prompt.md). The rule the engine's header states is the
// one to write these by: assert IDENTITY, not just a status. A 200 proves something answered; it does
// not prove the right thing answered. Give every page check a body marker only the right page carries.
//
// Check shape (see evaluateCheck in prod-smoke.mjs for every key):
//   { id, name, path, why, expect: { status,                      // required
//       location,                                                // a redirect target
//       mediaTypeIn: ['text/html'], mediaTypeIsJson: true,       // what kind of thing answered
//       bodyIncludes: [...], bodyExcludes: [...],                // identity markers
//       bodyIsJson, bodyJsonMatches: {k: v}, bodyJsonRequires: {k: 'object'}, bodyJsonPaths: {'a.b': 'string'} } }
//   A derived check: { dependsOn: '<id>', pathFrom: (depBody) => ({ path, expect }) | { unavailable } | { failed } }
//
// Never make a red smoke pass by weakening a check. When a route moves, re-point the check at the new
// contract, and assert the move too when old links depend on it.

import { JS_MEDIA_TYPES } from './prod-smoke.mjs'; // eslint-disable-line no-unused-vars -- for a script check

export const BASE = 'https://example.com'; // TEMPLATE FILL-IN: your production origin

export const CHECKS = [
  {
    id: 'home',
    name: 'home page (/)',
    path: '/',
    expect: { status: 200, mediaTypeIn: ['text/html'], bodyIncludes: ['TEMPLATE FILL-IN: a marker only your home page renders'] },
    why: 'The front door. The marker proves it is YOUR home page, not an error shell that also returns 200.',
  },
  {
    id: 'health',
    name: 'health endpoint',
    path: '/api/health',
    expect: { status: 200, mediaTypeIsJson: true, bodyIsJson: true, bodyJsonMatches: { ok: true } },
    why: 'The API answers, and answers with the shape a client depends on — not just any 200.',
  },
];
