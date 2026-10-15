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
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { activityCounts, activityHeader, activityTotals, deviceLabel } from '../src/lib/activity-counting.js';

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

test('the header total leaves covered rows out, and its bar is made of the rows it counts', () => {
  const day = [bridge(190), manual(100)];
  const manualWins = { wearablePresent: true, policy: 'manual_wins' };
  const header = activityHeader(day, manualWins);
  assert.equal(header.kcal, 100, 'the covered 190 is not in the total');
  assert.deepEqual(header.rows.map(r => r.kcal), [100]);
  assert.equal(header.noneCounted, false);
  assert.equal(activityHeader([bridge(190), bridge(60)], manualWins).kcal, 250, 'nothing counts: what was logged, flagged');
  assert.equal(activityHeader([bridge(190), bridge(60)], manualWins).noneCounted, true);
  assert.equal(activityHeader(day, { wearablePresent: false, policy: 'wearable_wins' }).kcal, 100, 'a covered row stays out on a day without wearable calories too');
  assert.deepEqual(activityHeader([], manualWins), { kcal: 0, rows: [], noneCounted: false });
  assert.deepEqual(activityHeader(null, manualWins), { kcal: 0, rows: [], noneCounted: false });
});

test('Diary.svelte takes its total from activityHeader and shows what covers a bridge row', () => {
  const src = readFileSync(new URL('../src/routes/Diary.svelte', import.meta.url), 'utf8');
  assert.match(src, /import \{ activityHeader, deviceLabel \} from '\.\.\/lib\/activity-counting\.js'/);
  assert.doesNotMatch(src, /manualCounted/, 'no single policy-wide decision');
  assert.match(src, /\{@const header = activityHeader\(acts, countCtx\)\}/);
  assert.match(src, /\{@const totalActKcal = header\.kcal\}/);
  assert.doesNotMatch(src, /acts\.reduce\(/, 'the total is not a sum of every row');
  assert.match(src, /\{#each header\.rows as a/);
  assert.match(src, /\{#if a\.covered_by\}[^]*?diary\.activity\.covered_by'/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.match(en.diary.activity.covered_by, /\{device\}/);
});

test('every locale file has the covered_by strings, with the {device} placeholder', () => {
  const dir = new URL('../src/i18n/', import.meta.url);
  const locales = readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.ok(locales.length >= 10, locales.join(', '));
  for (const file of locales) {
    const activity = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).diary?.activity;
    assert.match(activity?.covered_by ?? '', /\{device\}/, `${file} covered_by`);
    assert.ok(activity?.covered_by_hint, `${file} covered_by_hint`);
  }
});
