# Refine reference — the sprint-end smoke walkthrough format

Loaded on demand from `SKILL.md`. Moved here verbatim (ways-of-work-lean-pass S3.2).

### Stage 8b — The sprint-end smoke walkthrough (fool-proof, real URLs)
Every sprint closes with a **step-by-step manual walkthrough the product owner can follow blind**, written into
`sprint-N.md`. Once deployed, it uses **real production URLs** (preview URLs while pre-merge). Format —
numbered, one action + one expected result per step, no jargon:

```
## Sprint <N> — Smoke walkthrough (do these in order)
Env: production · https://<prod-domain>   (or the preview URL while testing pre-merge)

1. Go to https://<prod-domain>/<path-to-the-new-thing>
   → You see the new "<thing>" section.
2. Click "<button>".
   → A <result> appears within ~2s.
3. Open https://<the-other-surface>.<prod-domain> in a private window.
   → The <feature> renders as promised on that surface too.
4. (money path, if any) Drive the real flow with the provider's test credentials.
   → The confirmation the user would see arrives; the owning screen shows <field>.

If any step fails, note the step number + what you saw — that's the bug report.
```

Rules: real clickable URLs (not "the settings page"); the exact button/label; the observable result; and
call out which steps are the **money/auth path** (those are the ones an automated browser smoke can't fully
cover, so they're owed to the product owner by name).

---
