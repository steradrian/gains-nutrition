/**
 * activity-counting.js — does a diary Activity row count toward the day?
 * The server decides (server/lib/active-calories.js effectiveActiveCalories);
 * this mirrors it for the Diary screen, one row at a time.
 *
 *   - An openGym bridge row the server marks `covered_by` (a wearable
 *     reports active calories that day) never counts, whatever the policy:
 *     the wearable already holds that workout.
 *   - Any other row counts on a day without wearable calories, and on a
 *     day with them unless the policy is 'wearable_wins'.
 */

/** True when this activity row counts toward the day's burned calories. */
export function activityCounts(row, { wearablePresent, policy }) {
  if (row?.covered_by) return false;
  return !wearablePresent || (policy || 'wearable_wins') !== 'wearable_wins';
}

/** A wellness source as people know it: 'health_connect' -> 'Health Connect'. */
export function deviceLabel(source) {
  return String(source || '').split(/[_\s-]+/).filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** { counted, uncounted } kcal for a day's rows. */
export function activityTotals(rows, ctx) {
  let counted = 0, uncounted = 0;
  for (const row of rows || []) {
    const kcal = Number(row?.kcal) || 0;
    if (activityCounts(row, ctx)) counted += kcal; else uncounted += kcal;
  }
  return { counted, uncounted };
}

/**
 * The Activity header: the kcal of the rows that count, and the rows that
 * total is made of (the bar's segments). When no row counts (a wearable
 * wins the day) the header still shows what was logged, flagged
 * `noneCounted`, as it always did, so it never reads as zero.
 */
export function activityHeader(rows, ctx) {
  const all = rows || [];
  const { counted, uncounted } = activityTotals(all, ctx);
  const noneCounted = all.length > 0 && all.every(row => !activityCounts(row, ctx));
  return noneCounted
    ? { kcal: uncounted, rows: all, noneCounted }
    : { kcal: counted, rows: all.filter(row => activityCounts(row, ctx)), noneCounted };
}
