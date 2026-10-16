/**
 * The same create sent several times at once makes one row.
 *
 * POST /api/foods and POST /api/meals look for the row a retry would find
 * (the client_key, the source stamp, the barcode) and then download the
 * image before the INSERT. Requests that arrive while it downloads all find
 * nothing, and used to insert one row each: the unique index on the source
 * stamp refused the second food with a 500, and a key or a barcode made
 * duplicates. The route looks again once the image is in, with nothing
 * awaited before the INSERT; the first create stands and the others answer
 * with its row (200), as a retry a moment later would.
 *
 * The image is served by a local server that takes its time, so the requests
 * really overlap. Single-user mode, where the unique index does not apply
 * (NULL owners are all different to it), is in owner-scope-single-user.test.js.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { bootInProcess } from './fixtures/in-process-server.mjs';

// The image fetch is aimed at the loopback server below, which the SSRF guard refuses unless the owner allows it.
process.env.ALLOW_PRIVATE_IMAGE_URLS = '1';

const env = await bootInProcess({
  prefix: 'nt-create-race',
  routes: { '/api/foods': 'foods.js', '/api/meals': 'meals.js' },
});
const db = env?.db;
const skip = t => { if (!env) { t.skip('better-sqlite3 is not built for this Node'); return true; } return false; };
const { newUser, call } = env ?? {};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]);
const images = createServer((req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); }, 200));
images.listen(0, '127.0.0.1');
await once(images, 'listening');
test.after(() => images.close());
const imgUrl = `http://127.0.0.1:${images.address().port}/photo.png`;

const AT_ONCE = 4;
const sendAtOnce = (user, route, body) => Promise.all(Array.from({ length: AT_ONCE }, () => call(user, 'POST', route, body)));
// One 201 (the create that won) and the rest 200 with its row.
function assertOneWon(replies, label) {
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 200, 200, 201], `${label}: ${JSON.stringify(replies.map(r => [r.status, r.body?.error]))}`);
  assert.equal(new Set(replies.map(r => r.body.id)).size, 1, `${label}: one row`);
}
const count = (table, user) => db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`).get(user.id).n;

test('POST /api/foods with one source stamp, sent at once: one food, no UNIQUE 500', async t => {
  if (skip(t)) return;
  const u = newUser();
  const replies = await sendAtOnce(u, '/api/foods', { name: 'Pantry oats', nutrition: { calories: 380 }, img_url: imgUrl, source_app: 'cooktrace', source_external_id: 'pantry:7' });
  assertOneWon(replies, 'stamp');
  assert.equal(count('foods', u), 1);
  assert.match(db.prepare('SELECT img_url FROM foods WHERE user_id = ?').get(u.id).img_url, /^\/uploads\//, 'the image was downloaded');
});

test('POST /api/foods with one client_key, sent at once: one food', async t => {
  if (skip(t)) return;
  const u = newUser();
  assertOneWon(await sendAtOnce(u, '/api/foods', { name: 'Keyed oats', nutrition: { calories: 380 }, img_url: imgUrl, client_key: 'android:1' }), 'key');
  assert.equal(count('foods', u), 1);
});

test('POST /api/foods with one barcode, sent at once: one food', async t => {
  if (skip(t)) return;
  const u = newUser();
  assertOneWon(await sendAtOnce(u, '/api/foods', { name: 'Scanned oats', nutrition: { calories: 380 }, img_url: imgUrl, barcode: '7612345678900' }), 'barcode');
  assert.equal(count('foods', u), 1);
});

test('POST /api/meals with one client_key, sent at once: one meal', async t => {
  if (skip(t)) return;
  const u = newUser();
  assertOneWon(await sendAtOnce(u, '/api/meals', { name: 'Keyed bowl', items: [], nutrition: {}, img_url: imgUrl, client_key: 'android:2' }), 'key');
  assert.equal(count('meals', u), 1);
});

test('POST /api/meals with one source stamp, sent at once: one meal', async t => {
  if (skip(t)) return;
  const u = newUser();
  assertOneWon(await sendAtOnce(u, '/api/meals', { name: 'Pulled recipe', items: [], nutrition: {}, img_url: imgUrl, source_app: 'cooktrace', source_external_id: 'recipe:9' }), 'stamp');
  assert.equal(count('meals', u), 1);
});

test('two accounts creating the same stamp at once each get their own food', async t => {
  if (skip(t)) return;
  const a = newUser(), b = newUser();
  const body = { name: 'Shared stamp', nutrition: { calories: 1 }, img_url: imgUrl, source_app: 'cooktrace', source_external_id: 'pantry:8' };
  const [ra, rb] = await Promise.all([call(a, 'POST', '/api/foods', body), call(b, 'POST', '/api/foods', body)]);
  assert.deepEqual([ra.status, rb.status], [201, 201]);
  assert.notEqual(ra.body.id, rb.body.id);
});
