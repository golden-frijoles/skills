#!/usr/bin/env node
// slack-notify.mjs — the CI/CD Slack ping, structured the same way as scripts/telegram-notify.mjs.
//
// Used by .github/workflows/notify-telegram.yml's push-notification and deploy-notification jobs,
// alongside (not instead of) the existing Telegram calls:
//   node scripts/slack-notify.mjs --icon 📦 --sha "$GITHUB_SHA" --subject "$COMMIT_MSG" \
//        --meta "by @$AUTHOR" --url "$DIFF_URL" --link-label "view diff"
//
// ── Why Incoming Webhook and not a bot token + chat.postMessage ────────────────────────────────
// Same reasoning this repo already applied to Telegram (no VERCEL_API_TOKEN when a push-based
// signal existed instead — see notify-telegram.yml's header): one fewer credential to mint, store
// and rotate. An Incoming Webhook URL is itself the channel-scoped credential — there is no
// separate bot token, channel ID, or OAuth scope to manage for this feature. If a future need
// requires posting to a channel chosen at runtime (rather than the one fixed at webhook-creation
// time), that is the point to move to `chat.postMessage` with a bot token — not before.
//
// ── Response handling is NOT the same shape as Telegram's — this is the one real gotcha ───────
// Telegram's sendMessage returns JSON ({ok: bool, ...}) regardless of outcome. Slack's Incoming
// Webhook endpoint does NOT: on success it returns the literal string "ok" (200, `text/plain`); on
// failure it returns a short plain-text error token (e.g. "invalid_payload", "channel_not_found",
// "no_service") with a non-200 status. Parsing the body as JSON here would throw on every single
// call, success or failure. So `send()` reads the body as text and treats HTTP status as the
// primary success signal — see Slack's own webhook error-handling docs if this ever needs
// re-verifying against a live change.
//
// ── Escaping is mrkdwn, not HTML, but the substitution table is identical ──────────────────────
// See scripts/lib/slack-text.mjs's header for why escapeMrkdwn and Telegram's escapeHtml do the
// same three replacements. Links use Slack's `<url|label>` syntax rather than `<a href>`; inline
// code uses single backticks rather than `<code>`.
//
// House style carried over unchanged: secrets only from GitHub Secrets, a 10s request timeout, and
// a repo with the secret unset gets a clean skip (not a failure) — see main() below.

import { escapeMrkdwn, escapeToFit, SLACK_LIMIT } from './lib/slack-text.mjs';
import { die, need } from './lib/cross-agent-cli.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Assemble the Incoming Webhook payload.
 *
 * The subject is the only field given a length budget, same rule as Telegram's buildNotification:
 * the sha, status, icon and link are structural, and truncating them to make room for a runaway
 * commit message would discard exactly the parts a reader needs.
 *
 * Pure, and exported, so a test exercises the real assembler rather than a paraphrase of it.
 */
export function buildNotification({ repo, sha, icon, subject, meta, status, url, linkLabel }) {
  const shortSha = String(sha ?? '').slice(0, 7);

  // Chrome first, measured rather than estimated — same reasoning as Telegram's version: a
  // hardcoded guess here is how a "safe" cap stops being safe once a line is added below.
  const head = `${escapeMrkdwn(repo)} · ${icon} · \`${escapeMrkdwn(shortSha)}\``;
  const tail = `<${escapeMrkdwn(url)}|${escapeMrkdwn(linkLabel)}>`;
  const metaLine = meta ? escapeMrkdwn(meta) : null;
  // `status` is our own literal ("✅ READY"), never external input — not escaped, same as Telegram's
  // version, so the emoji and casing survive.
  const statusLine = status || null;

  const chrome = [head, metaLine, statusLine, tail].filter(Boolean).join('\n').length + 1;

  // First line only: a commit body belongs behind the link, not in a notification.
  const firstLine = String(subject ?? '').split('\n')[0];
  const safeSubject = escapeToFit(firstLine, Math.max(1, SLACK_LIMIT - chrome - 16));

  const lines = [head, safeSubject];
  if (metaLine) lines.push(metaLine);
  if (statusLine) lines.push(statusLine);
  lines.push(tail);

  return {
    text: lines.join('\n'),
    // Belt-and-suspenders alongside Telegram's disable_web_page_preview: without this a commit or
    // deployment link can unfurl into a big preview card that buries the next message.
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * POST it. Returns { ok, status, body } — never throws.
 *
 * Slack's webhook response is PLAIN TEXT ("ok" on success, a short error token on failure), not
 * JSON like Telegram's — see this file's header. An accepted webhook is the conjunction Slack
 * documents: a 2xx response and the literal plain-text body `ok`.
 */
export async function send(webhookUrl, payload, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text().catch(() => '');
    return { ok: res.ok && body.trim() === 'ok', status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: `request failed: ${err?.message ?? err}` };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (!k.startsWith('--')) die(`unexpected argument ${k}`);
    opt[k.slice(2)] = need(args[++i], k);
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    // Same clean-skip stance as telegram-notify.mjs: a repo without the secret configured is a
    // configuration state, not a failure.
    process.stderr.write(
      'SLACK_WEBHOOK_URL not set — skipping cleanly.\n' +
        '  Set it as a GitHub Secret on this repo to turn Slack notifications on.\n'
    );
    return;
  }

  const payload = buildNotification({
    repo: opt.repo ?? 'golden-beans',
    sha: opt.sha ?? '',
    icon: opt.icon ?? '📦',
    subject: opt.subject ?? '',
    meta: opt.meta ?? '',
    status: opt.status ?? '',
    url: opt.url ?? '',
    linkLabel: opt['link-label'] ?? 'view',
  });

  if (payload.text.length > SLACK_LIMIT) {
    // Should be unreachable — escapeToFit bounds the only unbounded field. Checked anyway, same
    // stance as telegram-notify.mjs.
    die(`assembled text is ${payload.text.length} chars, over the ${SLACK_LIMIT}-char budget`);
  }

  const result = await send(webhookUrl, payload);
  if (result.ok) {
    process.stderr.write(`✓ ping delivered (${payload.text.length} chars)\n`);
    return;
  }

  // Loud, same policy as Telegram: an observer workflow with a rejected message and no visible
  // failure is a rail with no monitoring at all.
  process.stderr.write(
    `::error title=Slack ping NOT delivered::status=${result.status} body=${result.body}\n`
  );
  process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
