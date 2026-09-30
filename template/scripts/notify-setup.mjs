#!/usr/bin/env node
// notify-setup.mjs — find your Telegram chat id, and send ONE test message, so notifications can be
// proven before anything scheduled depends on them (distribute-what-we-use S3.3).
//
//   node scripts/notify-setup.mjs --chat-id            list the chats your bot has seen (getUpdates)
//   node scripts/notify-setup.mjs --test               send one test message to every destination that is configured
//   node scripts/notify-setup.mjs --test --telegram    ...to Telegram only (needs the token AND a chat id)
//   node scripts/notify-setup.mjs --test --slack       ...to Slack only (needs SLACK_WEBHOOK_URL)
//
// ── Where the secrets come from ──────────────────────────────────────────────────────────────────
// TELEGRAM_BOT_TOKEN and SLACK_WEBHOOK_URL are read from the environment, then from `.env.local` at the project
// root. They are NEVER printed and NEVER written anywhere: not to the screen, not to a file, not into an error
// message (every message that could echo one is scrubbed first). The Telegram chat id is not a secret, so it is
// printed. The chat id for `--test` is `telegram.chatId` from `reporting.config.json` (with the gitignored
// `reporting.config.local.json` laid over it, see lib/reporting-config.mjs) or, failing that, TELEGRAM_CHAT_ID (environment or `.env.local`, for a project with no reporting config yet).
//
// ── What the scheduled reports actually do (deviation 5) ─────────────────────────────────────────
// The standup, weekly recap and PMO report post to TELEGRAM only, and nothing reads `reporting.destination`.
// Slack here covers this script's test message and ad-hoc sends via slack-notify.mjs — this script does not make
// the scheduled reports post to Slack, and says so rather than implying it.
//
// ── Exit codes (LEARNINGS: "could not look" is its own outcome, never the failure code) ──────────
//   0  did what was asked          1  the API answered and refused (or --chat-id found no chat)
//   2  bad usage                   3  could not look: a token / webhook / chat id is absent, or the network failed
//
// Every network path takes an injectable `fetch`; the specs inject one and never touch a real API.
// Zero deps — Node 18+.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFileValue } from './lib/jev.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { chatIdFor, loadReportingConfig, ReportingConfigError } from './lib/reporting-config.mjs';
import { send as sendSlack } from './slack-notify.mjs';

export const EXIT = { ok: 0, refused: 1, usage: 2, couldNotLook: 3 };
export const TEST_TEXT = 'Golden Frijoles test message: notifications are wired up. You can ignore this one.';
const TELEGRAM_API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

/** Pure — the flags. `{ error }` on anything unknown, so a typo never silently means "do nothing". */
export function parseArgs(argv) {
  const opts = { chatId: false, test: false, telegram: false, slack: false };
  for (const a of argv) {
    if (a === '--chat-id') opts.chatId = true;
    else if (a === '--test') opts.test = true;
    else if (a === '--telegram') opts.telegram = true;
    else if (a === '--slack') opts.slack = true;
    else return { error: `unknown argument ${a}` };
  }
  if (opts.chatId === opts.test) return { error: 'give exactly one of --chat-id or --test' };
  if ((opts.telegram || opts.slack) && !opts.test) return { error: '--telegram and --slack go with --test' };
  return { opts };
}

/** A secret from the environment, then `.env.local` at the project root (then the cwd). null when absent. */
export function readEnvValue(
  name,
  {
    env = process.env,
    root = projectRoot(),
    cwd = process.cwd(),
    read = readFileSync,
    exists = existsSync,
  } = {}
) {
  if (env[name]?.trim()) return env[name].trim();
  for (const dir of [root, cwd]) {
    const p = join(dir, '.env.local');
    if (!exists(p)) continue;
    try {
      const v = envFileValue(read(p, 'utf8'), name);
      if (v) return v;
    } catch {
      /* an unreadable env file is no value from it */
    }
  }
  return null;
}

/** Pure — remove every secret from a string that is about to be shown. */
export const scrub = (text, secrets) =>
  secrets.filter(Boolean).reduce((t, s) => t.split(s).join('[hidden]'), String(text ?? ''));

/** Pure — the distinct chats in a getUpdates result, oldest first: `{ id, type, title }`. */
export function chatsFromUpdates(updates) {
  const seen = new Map();
  for (const u of updates ?? []) {
    for (const key of [
      'message',
      'edited_message',
      'channel_post',
      'edited_channel_post',
      'my_chat_member',
      'chat_member',
    ]) {
      const chat = u?.[key]?.chat;
      if (!chat || chat.id == null || seen.has(chat.id)) continue;
      const person = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
      seen.set(chat.id, {
        id: chat.id,
        type: chat.type ?? 'unknown',
        title: chat.title || (chat.username ? `@${chat.username}` : person) || '(no title)',
      });
    }
  }
  return [...seen.values()];
}

/**
 * Pure — why `--chat-id` found nothing, given getWebhookInfo's answer. `webhook` is the result object, or null when
 * getWebhookInfo itself could not be read (then both causes are named, since they cannot be told apart).
 */
export function emptyChatExplanation(webhook) {
  const privacy =
    'A bot in a GROUP only sees commands and @mentions while group privacy is on: ask @BotFather (/mybots → your bot → ' +
    'Bot Settings → Group Privacy → Turn off), or send the bot a /command in the group.';
  const webhookCause = (url) =>
    `A webhook is set on this bot (on ${url}), and while one is, getUpdates returns nothing. Remove it with ` +
    `${TELEGRAM_API}/bot<YOUR-TOKEN>/deleteWebhook (open that URL with your real token), message the bot again, ` +
    'then re-run. Only remove it if nothing else of yours relies on that webhook.';
  const nobody =
    'Nobody has messaged the bot yet: open a chat with it in Telegram, press Start (or send any message), then re-run.';
  // Host only: a webhook URL often carries a secret path segment (#190 review).
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return 'a URL';
    }
  };
  if (webhook && webhook.url)
    return `No chats found. Cause: a webhook is set.\n  ${webhookCause(host(webhook.url))}\n  ${privacy}`;
  if (webhook) return `No chats found. No webhook is set, so: ${nobody}\n  ${privacy}`;
  return `No chats found, and getWebhookInfo could not be read, so the cause is one of two.\n  1. ${webhookCause('unknown')}\n  2. ${nobody}\n  ${privacy}`;
}

/** POST a Bot API method. Returns { ok, status, body } and never throws. `secrets` are scrubbed from any failure text. */
export async function telegramCall(method, token, payload, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* a non-JSON error body: the status still says what happened */
    }
    return { ok: res.ok && body?.ok === true, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      network: true,
      body: { description: scrub(err?.message ?? err, [token]) },
    };
  }
}

const apiError = (r) =>
  `${r.body?.description ?? `HTTP ${r.status}`}${r.body?.error_code ? ` (error_code ${r.body.error_code})` : ''}`;

/** `--chat-id`. */
async function chatIdCommand({ token, fetchImpl, stdout, stderr }) {
  if (!token) {
    stderr(
      'could not look: TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather (/newbot), then put TELEGRAM_BOT_TOKEN=… in .env.local.\n'
    );
    return EXIT.couldNotLook;
  }
  const updates = await telegramCall('getUpdates', token, { timeout: 0 }, fetchImpl);
  if (updates.network) {
    stderr(`could not look: ${updates.body.description}\n`);
    return EXIT.couldNotLook;
  }
  // Telegram answers 409 to getUpdates while a webhook is active: that is the cause, not an unrelated refusal.
  const webhookActive = updates.status === 409;
  if (!updates.ok && !webhookActive) {
    stderr(`Telegram rejected getUpdates: ${apiError(updates)}\n`);
    return EXIT.refused;
  }
  const chats = webhookActive ? [] : chatsFromUpdates(updates.body?.result);
  if (chats.length) {
    stdout(`Found ${chats.length} chat(s) your bot has seen:\n`);
    for (const c of chats) stdout(`  ${String(c.id).padEnd(16)} ${c.type.padEnd(11)} ${c.title}\n`);
    stdout(
      'Put the id in reporting.config.local.json (a public repo) or reporting.config.json as {"telegram":{"chatId":"<id>"}}.\n'
    );
    return EXIT.ok;
  }
  const info = await telegramCall('getWebhookInfo', token, {}, fetchImpl);
  stdout(`${emptyChatExplanation(info.ok ? (info.body?.result ?? {}) : null)}\n`);
  return EXIT.refused;
}

/** The Telegram chat id `--test` would use, and where it came from — or a reason there is none. */
export function resolveChatId({ env, load = loadReportingConfig }) {
  try {
    const id = chatIdFor(load(), null, env);
    return id
      ? { id: String(id), from: 'reporting config / TELEGRAM_CHAT_ID' }
      : { reason: 'no telegram.chatId in the reporting config and no TELEGRAM_CHAT_ID' };
  } catch (err) {
    if (!(err instanceof ReportingConfigError)) throw err;
    return env.TELEGRAM_CHAT_ID
      ? { id: String(env.TELEGRAM_CHAT_ID), from: 'TELEGRAM_CHAT_ID' }
      : { reason: err.message.split('\n')[0] };
  }
}

/** `--test`. */
async function testCommand({ opts, token, webhook, env, chatIdEnv, fetchImpl, load, stdout, stderr }) {
  // TELEGRAM_CHAT_ID may live in .env.local too: a project with no reporting.config.json yet has nowhere else for it.
  const chat = resolveChatId({ env: { ...env, TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || chatIdEnv }, load });
  // Half-configured Telegram (a token without a chat id, or the reverse) is still WANTED, so the missing half
  // is named — never silently skipped while Slack succeeds (the scheduled reports post to Telegram only).
  const wantTelegram = opts.telegram || (!opts.slack && (Boolean(token) || Boolean(chat.id)));
  const wantSlack = opts.slack || (!opts.telegram && Boolean(webhook));
  const missing = [];
  if (wantTelegram && !token) missing.push('TELEGRAM_BOT_TOKEN is not set (put it in .env.local)');
  if (wantTelegram && !chat.id)
    missing.push(`no Telegram chat id: ${chat.reason} (run --chat-id, then set telegram.chatId)`);
  if (wantSlack && !webhook) missing.push('SLACK_WEBHOOK_URL is not set (put it in .env.local)');
  if (!wantTelegram && !wantSlack)
    missing.push('nothing is configured: set TELEGRAM_BOT_TOKEN + a chat id, and/or SLACK_WEBHOOK_URL');
  if (missing.length) {
    for (const m of missing) stderr(`could not look: ${m}\n`);
    return EXIT.couldNotLook;
  }

  // One precedence whatever the send order: a refusal (a real configuration answer) outranks could-not-look
  // (weather), which outranks ok (#190 review).
  const RANK = { [EXIT.ok]: 0, [EXIT.couldNotLook]: 1, [EXIT.refused]: 2 };
  const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
  let code = EXIT.ok;
  if (wantTelegram) {
    const r = await telegramCall(
      'sendMessage',
      token,
      { chat_id: chat.id, text: TEST_TEXT, disable_web_page_preview: true },
      fetchImpl
    );
    if (r.ok) stdout(`Telegram: sent to chat ${chat.id} (from ${chat.from}): "${TEST_TEXT}"\n`);
    else if (r.network) {
      stderr(`could not look: Telegram unreachable: ${r.body.description}\n`);
      code = worse(code, EXIT.couldNotLook);
    } else {
      stderr(`Telegram rejected the message to chat ${chat.id}: ${apiError(r)}\n`);
      code = worse(code, EXIT.refused);
    }
  }
  if (wantSlack) {
    const r = await sendSlack(webhook, { text: TEST_TEXT }, fetchImpl);
    if (r.ok) stdout(`Slack: sent to the incoming webhook in SLACK_WEBHOOK_URL: "${TEST_TEXT}"\n`);
    else if (r.status === 0) {
      stderr(`could not look: Slack unreachable: ${scrub(r.body, [webhook])}\n`);
      code = worse(code, EXIT.couldNotLook);
    } else {
      stderr(`Slack rejected the message: status=${r.status} body=${scrub(r.body, [webhook])}\n`);
      code = worse(code, EXIT.refused);
    }
  }
  if (code === EXIT.ok)
    stdout('Scheduled reports post to Telegram only today; Slack covers this test and ad-hoc sends.\n');
  return code;
}

/** The CLI with every side effect injected; returns the exit code. */
export async function run(argv, io = {}) {
  const {
    env = process.env,
    fetchImpl = fetch,
    readValue = (name) => readEnvValue(name, { env }),
    load = loadReportingConfig,
    stdout = (t) => process.stdout.write(t),
    stderr = (t) => process.stderr.write(t),
  } = io;
  const parsed = parseArgs(argv);
  if (parsed.error) {
    stderr(
      `notify-setup: ${parsed.error}\nusage: notify-setup.mjs --chat-id | --test [--telegram] [--slack]\n`
    );
    return EXIT.usage;
  }
  const token = readValue('TELEGRAM_BOT_TOKEN');
  const webhook = readValue('SLACK_WEBHOOK_URL');
  // Everything shown goes through the scrubbing writers, so a secret echoed by any layer cannot reach the screen.
  const secrets = [token, webhook];
  const out = (t) => stdout(scrub(t, secrets));
  const err = (t) => stderr(scrub(t, secrets));
  if (parsed.opts.chatId) return chatIdCommand({ token, fetchImpl, stdout: out, stderr: err });
  return testCommand({
    opts: parsed.opts,
    token,
    webhook,
    env,
    chatIdEnv: readValue('TELEGRAM_CHAT_ID'),
    fetchImpl,
    load,
    stdout: out,
    stderr: err,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`notify-setup: ${e.message}\n`);
      process.exit(1);
    });
