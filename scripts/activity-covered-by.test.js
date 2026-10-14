/**
 * The Diary's Activity section respects covered_by (src/lib/activity-
 * counting.js, src/routes/Diary.svelte).
 *
 * The server never counts an openGym bridge row on a day a wearable reports
 * active calories, whatever the policy, and marks it covered_by. The diary
 * used to decide "counted" for all rows at once from the policy alone, so
 * under manual_wins or additive it showed covered bridge rows as counted.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { activityCounts, activityTotals, deviceLabel } from '../src/lib/activity-counting.js';

const bridge = (kcal, covered_by = 'garmin') => ({ name: 'Push day', kcal, source: 'opengym', covered_by });
const manual = kcal => ({ name: 'Walk', kcal, source: 'manual_form', covered_by: null });

test('a covered bridge row never counts, whatever the policy', () => {
  for (const policy of ['wearable_wins', 'manual_wins', 'additive', undefined]) {
    assert.equal(activityCounts(bridge(190), { wearablePresent: true, policy }), false, String(policy));
  }
});

test('other rows follow the policy, as before', () => {
  assert.equal(activityCounts(manual(100), { wearablePresent: false, policy: 'wearable_wins' }), true, 'no wearable: counts');
  assert.equal(activityCounts(manual(100), { wearablePresent: true, policy: 'wearable_wins' }), false);
  assert.equal(activityCounts(manual(100), { wearablePresent: true, policy: 'manual_wins' }), true);
  assert.equal(activityCounts(manual(100), { wearablePresent: true, policy: 'additive' }), true);
  assert.equal(activityCounts(manual(100), { wearablePresent: true }), false, 'the default policy is wearable_wins');
  assert.equal(activityCounts(bridge(190, null), { wearablePresent: false, policy: 'wearable_wins' }), true, 'an uncovered bridge row counts');
});

test('totals split counted from shown-only', () => {
  const day = [bridge(190), manual(100)];
  assert.deepEqual(activityTotals(day, { wearablePresent: true, policy: 'manual_wins' }), { counted: 100, uncounted: 190 });
  assert.deepEqual(activityTotals(day, { wearablePresent: true, policy: 'wearable_wins' }), { counted: 0, uncounted: 290 });
});

test('device labels read as people know them', () => {
  assert.equal(deviceLabel('health_connect'), 'Health Connect');
  assert.equal(deviceLabel('garmin'), 'Garmin');
  assert.equal(deviceLabel(null), '');
});

test('Diary.svelte decides per row with activityCounts and shows what covers a bridge row', () => {
  const src = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
  assert.match(src, /import \{ activityCounts, deviceLabel \} from '\.\.\/lib\/activity-counting\.js'/);
  assert.doesNotMatch(src, /manualCounted/, 'no single policy-wide decision');
  assert.match(src, /acts\.every\(a => !activityCounts\(a, countCtx\)\)/);
  assert.match(src, /\{#if a\.covered_by\}[^]*?diary\.activity\.covered_by'/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.match(en.diary.activity.covered_by, /\{device\}/);
});
