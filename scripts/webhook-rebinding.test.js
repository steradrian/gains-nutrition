/**
 * Webhook delivery connects to the address the SSRF guard checked
 * (server/lib/webhooks.js, through ssrf-guard.js fetchChecked).
 *
 * Checking the address and then fetching separately resolves the name
 * twice, and a hostile DNS server can answer the check with a public
 * address and the fetch with an internal one (DNS rebinding). Here the
 * name is one only the guard's lookup knows (pinned.invalid, faked to
 * 127.0.0.1): the delivery reaches the local receiver only when the
 * connection uses the checked answer instead of resolving the name again,
 * and the name is looked up exactly once per attempt.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'nt-webhook-rebind-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.UPLOADS_PATH = join(dir, 'uploads');
process.env.WEBHOOKS_ENABLED = '1';
process.env.ALLOW_PRIVATE_WEBHOOK_URLS = '1'; // the receiver is on 127.0.0.1
const db = (await import('../server/db.js')).default;
const { createWebhook, sendTestWebhook } = await import('../server/lib/webhooks.js');

const received = [];
const receiver = http.createServer((req, res) => {
  received.push({ host: req.headers.host, event: req.headers['x-nutritrace-event'] });
  res.writeHead(204); res.end();
});
await new Promise(r => receiver.listen(0, '127.0.0.1', r));
const port = receiver.address().port;

test.after(() => { receiver.close(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

test('a webhook delivery connects to the checked address and never resolves the name a second time', async () => {
  const userId = Number(db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('hooker', 'x', 'admin')`).run().lastInsertRowid);
  const lookups = [];
  const real = dns.lookup;
  dns.lookup = async (host, opts) => {
    if (host !== 'pinned.invalid') return real(host, opts);
    lookups.push(host);
    const answer = { address: '127.0.0.1', family: 4 };
    return opts?.all ? [answer] : answer;
  };
  try {
    const { row } = await createWebhook({ userId, url: `http://pinned.invalid:${port}/hook`, events: ['meal.logged'] });
    const atCreate = lookups.length;
    const result = await sendTestWebhook({ userId, id: row.id });
    assert.equal(result.last_delivery_status, 'success', `delivery failed: ${result.last_delivery_error}`);
    assert.equal(received.length, 1);
    assert.equal(received[0].host, `pinned.invalid:${port}`, 'the request still names the host');
    assert.equal(received[0].event, 'test');
    assert.equal(lookups.length - atCreate, 1, 'one lookup for the one attempt: the check\'s');
  } finally {
    dns.lookup = real;
  }
});

test('a delivery to a refused address is recorded as failed without connecting', async () => {
  const userId = Number(db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('meta', 'x', 'admin')`).run().lastInsertRowid);
  const { row } = await createWebhook({ userId, url: `http://127.0.0.1:${port}/hook`, events: ['meal.logged'] });
  // The address changes after the webhook was saved, as DNS can.
  db.prepare('UPDATE webhooks SET url = ? WHERE id = ?').run('http://169.254.169.254/hook', row.id);
  const before = received.length;
  const result = await sendTestWebhook({ userId, id: row.id });
  assert.equal(result.last_delivery_status, 'failed');
  assert.match(result.last_delivery_error, /cloud-metadata/);
  assert.equal(received.length, before);
});
