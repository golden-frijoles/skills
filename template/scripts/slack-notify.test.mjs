// Slack parity for the mechanical CI/CD rail. These cases mirror telegram-notify.test.mjs while
// pinning the one platform difference that matters: Incoming Webhooks answer in plain text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification, send } from './slack-notify.mjs';
import { SLACK_LIMIT } from './lib/slack-text.mjs';

const base = {
  repo: 'golden-beans',
  sha: 'abc1234def5678',
  icon: '📦',
  subject: 'feat(pod-report): the surface renders',
  meta: 'by @danybgoode',
  status: '',
  url: 'https://github.com/danybgoode/golden-beans/commit/abc1234',
  linkLabel: 'view diff',
};

test('an ordinary push builds a complete Incoming Webhook payload', () => {
  const p = buildNotification(base);
  assert.equal(p.unfurl_links, false);
  assert.equal(p.unfurl_media, false);
  assert.match(p.text, /golden-beans · 📦 · `abc1234`/);
  assert.match(p.text, /feat\(pod-report\): the surface renders/);
  assert.match(p.text, /by @danybgoode/);
  assert.match(p.text, /<https:\/\/github\.com\/[^|]+\|view diff>/);
});

test('the sha is shortened and a multi-line commit body is omitted', () => {
  const p = buildNotification({ ...base, subject: 'feat: subject\n\nbody that does not belong here' });
  assert.match(p.text, /`abc1234`/);
  assert.equal(p.text.includes('abc1234def5678'), false);
  assert.equal(p.text.includes('body that does not belong here'), false);
});

test('mrkdwn metacharacters are escaped in every request-derived field', () => {
  const p = buildNotification({
    ...base,
    repo: 'golden<&>',
    subject: 'fix: handle <script> & >',
    meta: 'by <dan&team>',
    url: 'https://example.com/x?a=1&b=2',
    linkLabel: 'open <deploy>',
  });
  assert.match(p.text, /golden&lt;&amp;&gt;/);
  assert.match(p.text, /&lt;script&gt; &amp; &gt;/);
  assert.match(p.text, /by &lt;dan&amp;team&gt;/);
  assert.match(p.text, /x\?a=1&amp;b=2\|open &lt;deploy&gt;/);
  assert.equal(p.text.includes('<script>'), false);
});

test('runaway and entity-heavy subjects converge under Slack’s conservative cap', () => {
  for (const subject of ['x'.repeat(20_000), ...['>', '<', '&'].map((ch) => ch.repeat(20_000))]) {
    const p = buildNotification({ ...base, subject });
    assert.ok(p.text.length <= SLACK_LIMIT, `text is ${p.text.length} chars`);
    assert.match(p.text, /`abc1234`/);
    assert.match(p.text, /<https:\/\/github\.com\/[^|]+\|view diff>/);
  }
});

test('an absent meta/status is omitted and a deploy status is preserved', () => {
  const push = buildNotification({ ...base, meta: '', status: '' });
  assert.equal(push.text.split('\n').length, 3);

  const deploy = buildNotification({
    ...base,
    icon: '🚀',
    meta: '',
    status: '✅ READY',
    linkLabel: 'open deployment',
  });
  assert.match(deploy.text, /🚀/);
  assert.match(deploy.text, /✅ READY/);
  assert.match(deploy.text, /open deployment/);
});

test('send accepts Slack’s literal plain-text ok response', async () => {
  const seen = {};
  const result = await send('https://hooks.slack.test/x', { text: 'hello' }, async (url, init) => {
    seen.url = url;
    seen.init = init;
    return { ok: true, status: 200, text: async () => 'ok' };
  });
  assert.deepEqual(result, { ok: true, status: 200, body: 'ok' });
  assert.equal(seen.url, 'https://hooks.slack.test/x');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { text: 'hello' });
});

test('send reports Slack’s plain-text error token and non-2xx status', async () => {
  const result = await send('https://hooks.slack.test/x', { text: 'bad' }, async () => ({
    ok: false,
    status: 400,
    text: async () => 'invalid_payload',
  }));
  assert.deepEqual(result, { ok: false, status: 400, body: 'invalid_payload' });
});

test('a 2xx body other than ok and a network exception both fail closed', async () => {
  const strange = await send('x', { text: 'x' }, async () => ({
    ok: true,
    status: 200,
    text: async () => 'unexpected',
  }));
  assert.equal(strange.ok, false);

  const network = await send('x', { text: 'x' }, async () => {
    throw new Error('ETIMEDOUT');
  });
  assert.equal(network.ok, false);
  assert.equal(network.status, 0);
  assert.match(network.body, /ETIMEDOUT/);
});
