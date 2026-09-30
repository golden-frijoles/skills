// notify-setup.test.mjs — the chat-id finder and the test message (distribute-what-we-use S3.3).
// Every network path is an injected fetch: nothing here can reach Telegram or Slack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatsFromUpdates,
  emptyChatExplanation,
  EXIT,
  parseArgs,
  readEnvValue,
  run,
  scrub,
  TEST_TEXT,
} from './notify-setup.mjs';
import { ReportingConfigError } from './lib/reporting-config.mjs';

const TOKEN = '123456:SECRET-TOKEN-abc';
const HOOK = 'https://hooks.slack.test/services/T000/B000/SECRETHOOK';

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const text = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => JSON.parse(body),
});

/** A CLI harness: `routes` maps a Bot API method (or 'slack') to a response or a function returning one. */
function harness({
  values = { TELEGRAM_BOT_TOKEN: TOKEN },
  routes = {},
  config = { telegram: { chatId: '-100777' } },
  env = {},
} = {}) {
  const h = { out: '', err: '', calls: [] };
  h.io = {
    env,
    readValue: (name) => values[name] ?? null,
    load: () => {
      if (config instanceof Error) throw config;
      return config;
    },
    stdout: (t) => (h.out += t),
    stderr: (t) => (h.err += t),
    fetchImpl: async (url, init) => {
      const method = url.startsWith('https://api.telegram.org/') ? url.split('/').pop() : 'slack';
      h.calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : null });
      const r = routes[method];
      if (r === undefined) throw new Error(`unexpected call ${method}`);
      return typeof r === 'function' ? r() : r;
    },
  };
  return h;
}

test('parseArgs: exactly one of --chat-id / --test; unknown flags and stray target flags are refused', () => {
  assert.deepEqual(parseArgs(['--chat-id']).opts.chatId, true);
  assert.equal(parseArgs(['--test', '--slack']).opts.slack, true);
  for (const bad of [[], ['--chat-id', '--test'], ['--slack'], ['--nope']])
    assert.ok(parseArgs(bad).error, bad.join(' '));
});

test('chatsFromUpdates: distinct chats from every update shape, with a title for each kind', () => {
  const chats = chatsFromUpdates([
    { message: { chat: { id: 11, type: 'private', first_name: 'Ada', last_name: 'L' } } },
    { message: { chat: { id: 11, type: 'private', first_name: 'Ada' } } },
    { channel_post: { chat: { id: -100, type: 'channel', title: 'Ops' } } },
    { my_chat_member: { chat: { id: -200, type: 'supergroup', title: 'Team' } } },
    { edited_message: { chat: { id: 12, type: 'private', username: 'bob' } } },
    { poll: {} },
  ]);
  assert.deepEqual(chats, [
    { id: 11, type: 'private', title: 'Ada L' },
    { id: -100, type: 'channel', title: 'Ops' },
    { id: -200, type: 'supergroup', title: 'Team' },
    { id: 12, type: 'private', title: '@bob' },
  ]);
});

test('--chat-id: prints each chat id with its type and title, exit 0', async () => {
  const h = harness({
    routes: {
      getUpdates: json({
        ok: true,
        result: [{ message: { chat: { id: -100555, type: 'group', title: 'Ship room' } } }],
      }),
    },
  });
  assert.equal(await run(['--chat-id'], h.io), EXIT.ok);
  assert.match(h.out, /-100555\s+group\s+Ship room/);
  assert.deepEqual(
    h.calls.map((c) => c.method),
    ['getUpdates']
  );
});

test('--chat-id, empty and a webhook is set: says the webhook is the cause and names deleteWebhook (never the token)', async () => {
  const h = harness({
    routes: {
      getUpdates: json({ ok: true, result: [] }),
      getWebhookInfo: json({ ok: true, result: { url: 'https://example.test/hook' } }),
    },
  });
  assert.equal(await run(['--chat-id'], h.io), EXIT.refused);
  assert.match(h.out, /a webhook is set/);
  assert.match(h.out, /deleteWebhook/);
  assert.match(h.out, /privacy/i);
  assert.equal(h.out.includes(TOKEN), false);
});

test('--chat-id: Telegram answers 409 to getUpdates while a webhook is active, and that is reported as the webhook', async () => {
  const h = harness({
    routes: {
      getUpdates: json(
        {
          ok: false,
          error_code: 409,
          description: "Conflict: can't use getUpdates method while webhook is active",
        },
        409
      ),
      getWebhookInfo: json({ ok: true, result: { url: 'https://example.test/hook' } }),
    },
  });
  assert.equal(await run(['--chat-id'], h.io), EXIT.refused);
  assert.match(h.out, /a webhook is set/);
});

test('--chat-id, empty and NO webhook: says nobody has messaged the bot, and names group privacy', async () => {
  const h = harness({
    routes: {
      getUpdates: json({ ok: true, result: [] }),
      getWebhookInfo: json({ ok: true, result: { url: '' } }),
    },
  });
  assert.equal(await run(['--chat-id'], h.io), EXIT.refused);
  assert.match(h.out, /No webhook is set/);
  assert.match(h.out, /Nobody has messaged the bot yet/);
  assert.match(h.out, /Group Privacy/);
  assert.equal(
    h.out.includes('deleteWebhook'),
    false,
    'the webhook fix is not offered when there is no webhook'
  );
});

test('emptyChatExplanation: when getWebhookInfo could not be read, both causes are named', () => {
  const t = emptyChatExplanation(null);
  assert.match(t, /deleteWebhook/);
  assert.match(t, /Nobody has messaged/);
});

test('--chat-id: no token is could-not-look (its own exit code), not a failure; an API rejection is the failure code', async () => {
  const none = harness({ values: {} });
  assert.equal(await run(['--chat-id'], none.io), EXIT.couldNotLook);
  assert.match(none.err, /could not look: TELEGRAM_BOT_TOKEN/);
  assert.deepEqual(none.calls, []);
  const bad = harness({
    routes: { getUpdates: json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401) },
  });
  assert.equal(await run(['--chat-id'], bad.io), EXIT.refused);
  assert.match(bad.err, /Unauthorized \(error_code 401\)/);
});

test('--test --telegram: sends one message to the configured chat and prints exactly what went where', async () => {
  const h = harness({ routes: { sendMessage: json({ ok: true, result: {} }) } });
  assert.equal(await run(['--test', '--telegram'], h.io), EXIT.ok);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.chat_id, '-100777');
  assert.equal(h.calls[0].body.text, TEST_TEXT);
  assert.match(h.out, /Telegram: sent to chat -100777/);
  assert.match(h.out, /post to Telegram only today/);
});

test('--test: the chat id falls back to TELEGRAM_CHAT_ID when there is no reporting config', async () => {
  const h = harness({
    config: new ReportingConfigError('reporting.config.json not found'),
    env: { TELEGRAM_CHAT_ID: '42' },
    routes: { sendMessage: json({ ok: true }) },
  });
  assert.equal(await run(['--test', '--telegram'], h.io), EXIT.ok);
  assert.equal(h.calls[0].body.chat_id, '42');
});

test('--test: with no reporting config, TELEGRAM_CHAT_ID from .env.local is used', async () => {
  const h = harness({
    values: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '99' },
    config: new ReportingConfigError('reporting.config.json not found'),
    routes: { sendMessage: json({ ok: true }) },
  });
  assert.equal(await run(['--test', '--telegram'], h.io), EXIT.ok);
  assert.equal(h.calls[0].body.chat_id, '99');
});

test('--test --telegram with no chat id anywhere: could-not-look, and it says how to get one', async () => {
  const h = harness({ config: { telegram: { chatId: null } } });
  assert.equal(await run(['--test', '--telegram'], h.io), EXIT.couldNotLook);
  assert.match(h.err, /no Telegram chat id/);
  assert.match(h.err, /--chat-id/);
  assert.deepEqual(h.calls, []);
});

test('--test: an API rejection exits non-zero with the API text; the token never appears anywhere', async () => {
  const h = harness({
    routes: {
      sendMessage: json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400),
    },
  });
  assert.equal(await run(['--test', '--telegram'], h.io), EXIT.refused);
  assert.match(h.err, /Bad Request: chat not found \(error_code 400\)/);
  assert.equal((h.out + h.err).includes(TOKEN), false);
});

test('--test: a network failure that echoes the token in its message is could-not-look, and the token is scrubbed', async () => {
  const h = harness({
    routes: {
      sendMessage: () => {
        throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`);
      },
    },
  });
  assert.equal(await run(['--test', '--telegram'], h.io), EXIT.couldNotLook);
  assert.match(h.err, /could not look: Telegram unreachable/);
  assert.equal((h.out + h.err).includes(TOKEN), false);
});

test('--test --slack: posts the text to the webhook; absent webhook is could-not-look; a rejection carries Slack’s error token', async () => {
  const ok = harness({ values: { SLACK_WEBHOOK_URL: HOOK }, routes: { slack: text('ok') } });
  assert.equal(await run(['--test', '--slack'], ok.io), EXIT.ok);
  assert.equal(ok.calls[0].url, HOOK);
  assert.equal(ok.calls[0].body.text, TEST_TEXT);
  assert.equal(ok.out.includes(HOOK), false, 'the webhook URL is a secret and is never printed');
  assert.match(ok.out, /Slack: sent to the incoming webhook/);

  const none = harness({ values: {} });
  assert.equal(await run(['--test', '--slack'], none.io), EXIT.couldNotLook);
  assert.match(none.err, /SLACK_WEBHOOK_URL is not set/);

  const bad = harness({ values: { SLACK_WEBHOOK_URL: HOOK }, routes: { slack: text('no_service', 404) } });
  assert.equal(await run(['--test', '--slack'], bad.io), EXIT.refused);
  assert.match(bad.err, /status=404 body=no_service/);
});

test('--test with no flag: sends to every destination that is configured, and only those', async () => {
  const both = harness({
    values: { TELEGRAM_BOT_TOKEN: TOKEN, SLACK_WEBHOOK_URL: HOOK },
    routes: { sendMessage: json({ ok: true }), slack: text('ok') },
  });
  assert.equal(await run(['--test'], both.io), EXIT.ok);
  assert.deepEqual(both.calls.map((c) => c.method).sort(), ['sendMessage', 'slack']);
  // Genuinely Slack-only: no token AND no chat id (a chat id without a token is half-configured Telegram).
  const slackOnly = harness({
    values: { SLACK_WEBHOOK_URL: HOOK },
    config: new ReportingConfigError('no reporting.config.json'),
    routes: { slack: text('ok') },
  });
  assert.equal(await run(['--test'], slackOnly.io), EXIT.ok);
  assert.deepEqual(
    slackOnly.calls.map((c) => c.method),
    ['slack']
  );
  const nothing = harness({ values: {}, config: new ReportingConfigError('no reporting.config.json') });
  assert.equal(await run(['--test'], nothing.io), EXIT.couldNotLook);
  assert.match(nothing.err, /nothing is configured/);
});

test('readEnvValue: the environment wins, then .env.local; an absent or unreadable file is null', () => {
  const files = { '/p/.env.local': 'A=1\nexport B="two"\n' };
  const opts = { root: '/p', cwd: '/p', exists: (p) => p in files, read: (p) => files[p] };
  assert.equal(readEnvValue('A', { ...opts, env: { A: 'env' } }), 'env');
  assert.equal(readEnvValue('A', { ...opts, env: {} }), '1');
  assert.equal(readEnvValue('B', { ...opts, env: {} }), 'two');
  assert.equal(readEnvValue('C', { ...opts, env: {} }), null);
  assert.equal(
    readEnvValue('A', {
      root: '/p',
      cwd: '/p',
      env: {},
      exists: () => true,
      read: () => {
        throw new Error('EACCES');
      },
    }),
    null
  );
});

test('scrub removes every occurrence of every secret and tolerates missing ones', () => {
  assert.equal(scrub('a SECRET b SECRET', ['SECRET', null]), 'a [hidden] b [hidden]');
});

test('exit codes are a contract: 0 ok, 1 refused, 2 usage, 3 could-not-look (never the failure code)', () => {
  assert.deepEqual(EXIT, { ok: 0, refused: 1, usage: 2, couldNotLook: 3 });
});

// ── #190 review: one exit precedence whatever the send order; a webhook's secret path is never printed ──
test('--test: a refusal outranks unreachable, in either order', async () => {
  const unreachable = () => {
    throw new Error('connect ECONNREFUSED');
  };
  const values = { TELEGRAM_BOT_TOKEN: TOKEN, SLACK_WEBHOOK_URL: HOOK };
  const a = harness({
    values,
    routes: { sendMessage: json({ ok: false, description: 'chat not found' }, 400), slack: unreachable },
  });
  assert.equal(await run(['--test'], a.io), EXIT.refused, 'telegram refused, slack unreachable');
  const b = harness({ values, routes: { sendMessage: unreachable, slack: text('invalid_payload', 400) } });
  assert.equal(await run(['--test'], b.io), EXIT.refused, 'telegram unreachable, slack refused');
});

test('--chat-id: a set webhook is named by host only — its path can carry a secret', async () => {
  const h = harness({
    routes: {
      getUpdates: json({ ok: true, result: [] }),
      getWebhookInfo: json({ ok: true, result: { url: 'https://hooks.example.test/tg/SECRET-PATH-123' } }),
    },
  });
  await run(['--chat-id'], h.io);
  const all = h.out + h.err;
  assert.match(all, /hooks\.example\.test/);
  assert.doesNotMatch(all, /SECRET-PATH-123/);
});

test('--test: a token with no chat id is named as missing, even when Slack alone would succeed (agy on #190)', async () => {
  const h = harness({
    values: { TELEGRAM_BOT_TOKEN: TOKEN, SLACK_WEBHOOK_URL: HOOK },
    config: new ReportingConfigError('no reporting.config.json'),
    routes: { slack: text('ok') },
  });
  assert.equal(await run(['--test'], h.io), EXIT.couldNotLook);
  assert.match(h.err, /no Telegram chat id/);
  assert.equal(h.calls.length, 0, 'nothing is sent while half the setup is missing');
});
