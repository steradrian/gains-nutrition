/**
 * API contract: water (docs/api-contract.md, "Water").
 *
 * No endpoint or table of its own: a day's water is the `water` array of
 * its diary row, written with PUT /api/diary/:date. Each entry is
 * { uuid, amount, time }: amount in ml (the client converts oz, L and gal
 * before saving), time a display string the client formatted ("8:05 AM"),
 * with no date. Deleting goes through deleted_uuids.water and leaves a
 * tombstone of kind "water". The goal is the waterGoalMl setting.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './fixtures/contract/server.mjs';
import { assertShape } from './fixtures/contract/shape.mjs';
import { WATER_ENTRY } from './fixtures/contract/schemas.mjs';

const srv = await startServer({ file: import.meta.url });
test.after(() => srv.stop());

const day = (water, deleted = []) => srv.api('PUT', '/api/diary/2026-10-14', {
  items: [], body_stats: {}, water, notes: '', deleted_uuids: { items: [], water: deleted },
});
const glass = (uuid, amount, time) => ({ uuid, amount, time });

test('water entries round-trip: amount in ml, time as the client wrote it', async () => {
  const r = await day([glass('w-1', 250, '8:05 AM'), glass('w-2', 500, '20:15')]);
  assert.equal(r.status, 200);
  assertShape(r.body.water, [WATER_ENTRY]);
  assert.deepEqual(r.body.water, [glass('w-1', 250, '8:05 AM'), glass('w-2', 500, '20:15')]);
  const again = await srv.api('GET', '/api/diary/2026-10-14', undefined, { example: 'water.get' });
  assert.deepEqual(again.body.water, r.body.water);
});

test('entries merge by uuid like items: omitted is kept, deleted_uuids.water removes and leaves a tombstone', async () => {
  const kept = await day([glass('w-3', 330, '12:00')]);
  assert.deepEqual(kept.body.water.map(w => w.uuid).sort(), ['w-1', 'w-2', 'w-3']);
  const removed = await day([], ['w-2']);
  assert.deepEqual(removed.body.water.map(w => w.uuid).sort(), ['w-1', 'w-3']);
  assert.ok(removed.body.tombstones.some(t => t.kind === 'water' && t.uuid === 'w-2'));
});

test('an edit is the same uuid with a later updatedAt', async () => {
  const edited = await day([{ ...glass('w-1', 300, '8:05 AM'), updatedAt: '2099-01-01T00:00:00.000Z' }]);
  assert.equal(edited.body.water.find(w => w.uuid === 'w-1').amount, 300);
});

test('the water goal is a setting, waterGoalMl, in ml', async () => {
  assert.deepEqual((await srv.api('PUT', '/api/settings', { key: 'waterGoalMl', value: 2500 })).body, { ok: true });
  assert.equal((await srv.api('GET', '/api/settings')).body.waterGoalMl, 2500);
});
