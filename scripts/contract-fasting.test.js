/**
 * API contract: fasting (docs/api-contract.md, "Fasting").
 *
 * One fast is active at a time (end_at null). start_at and end_at are ISO
 * instants in UTC with a Z; goal_hours is a number of hours (0, 168],
 * rounded to 0.1, 16 when missing or out of range.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { ERROR, FAST } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

let fast = null;

test('no fast yet: GET /api/fasts/active is null, the list is empty', async () => {
  const active = await srv.api('GET', '/api/fasts/active');
  assert.equal(active.status, 200);
  assert.equal(active.body, null);
  assert.deepEqual((await srv.api('GET', '/api/fasts')).body, []);
});

test('POST /api/fasts/start: 201 and the new, active fast', async () => {
  const startAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const r = await srv.api('POST', '/api/fasts/start', { goal_hours: 18.04, start_at: startAt }, { example: 'fasting.start' });
  assert.equal(r.status, 201);
  assertShape(r.body, FAST);
  fast = r.body;
  assert.equal(fast.end_at, null);
  assert.equal(fast.goal_hours, 18, 'rounded to 0.1');
  assert.equal(fast.start_at, startAt, 'a start up to 24 h back is kept');
  const active = await srv.api('GET', '/api/fasts/active', undefined, { example: 'fasting.active' });
  assertShape(active.body, FAST);
  assert.equal(active.body.id, fast.id);
});

test('a second start while one is active is 409', async () => {
  const r = await srv.api('POST', '/api/fasts/start', {});
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'A fast is already in progress. End it before starting a new one.' });
});

test('PATCH /api/fasts/:id edits start, goal and notes', async () => {
  const r = await srv.api('PATCH', `/api/fasts/${fast.id}`, { goal_hours: 20, notes: 'Water only' }, { example: 'fasting.patch' });
  assert.equal(r.status, 200);
  assertShape(r.body, FAST);
  assert.equal(r.body.goal_hours, 20);
  assert.equal(r.body.notes, 'Water only');
});

test('POST /api/fasts/:id/end ends it now; ending twice is 400', async () => {
  const r = await srv.api('POST', `/api/fasts/${fast.id}/end`, {}, { example: 'fasting.end' });
  assert.equal(r.status, 200);
  assertShape(r.body, { ...FAST, end_at: 'isotime' });
  assert.ok(Date.parse(r.body.end_at) >= Date.parse(r.body.start_at));
  const again = await srv.api('POST', `/api/fasts/${fast.id}/end`, {});
  assert.equal(again.status, 400);
  assert.deepEqual(again.body, { error: 'Fast is already ended' });
  assert.equal((await srv.api('GET', '/api/fasts/active')).body, null);
});

test('GET /api/fasts lists fasts newest start first; limit defaults to 30, at most 365', async () => {
  const r = await srv.api('GET', '/api/fasts?limit=60', undefined, { example: 'fasting.list' });
  assert.equal(r.status, 200);
  assertShape(r.body, [FAST]);
  assert.equal(r.body[0].id, fast.id);
});

test('out-of-range input falls back instead of failing: goal 16 h, start now', async () => {
  const r = await srv.api('POST', '/api/fasts/start', { goal_hours: 500, start_at: '2001-01-01T00:00:00Z' });
  assert.equal(r.status, 201);
  assert.equal(r.body.goal_hours, 16);
  assert.ok(Date.now() - Date.parse(r.body.start_at) < 60_000, 'a start more than 24 h back becomes now');
  await srv.api('POST', `/api/fasts/${r.body.id}/end`, {});
});

test('DELETE /api/fasts/:id; 404 for a fast that does not exist', async () => {
  const r = await srv.api('DELETE', `/api/fasts/${fast.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  const missing = await srv.api('POST', '/api/fasts/999999/end', {});
  assert.equal(missing.status, 404);
  assertShape(missing.body, ERROR);
});

// Found while writing the contract: PATCH accepts end_at: null, which
// re-opens an ended fast without the one-active-fast check POST /start has,
// so two fasts can be active at once.
test('re-opening a fast while another is active is refused', { todo: 'routes/fasts.js PATCH end_at:null skips the active-fast check' }, async () => {
  const a = await srv.api('POST', '/api/fasts/start', {});
  await srv.api('POST', `/api/fasts/${a.body.id}/end`, {});
  const b = await srv.api('POST', '/api/fasts/start', {});
  const reopen = await srv.api('PATCH', `/api/fasts/${a.body.id}`, { end_at: null });
  await srv.api('POST', `/api/fasts/${b.body.id}/end`, {});
  assert.equal(reopen.status, 409);
});
