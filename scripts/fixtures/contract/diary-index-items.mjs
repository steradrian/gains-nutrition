// Diary items whose kcal GET /api/diary/index must agree on with the app's
// own sums (Nutrition.calculate, and the web client's nutritionOf/totalsOf).
// Expected values are written out, not computed, so a client test can copy
// this file and pin the same numbers.
//
// The day total rounds the sum of the unrounded item values (561), not the
// sum of the rounded ones (559): three 0.4 kcal items must not vanish.
export const PARITY_ITEMS = [
  // quantity scales the logged nutrition
  { uuid: 'par-oats', meal: 0, name: 'Oats', quantity: 1.5, nutrition: { calories: 152 }, expectKcal: 228 },
  // a flat legacy item with the old calories_kcal alias
  { uuid: 'par-toast', meal: 1, name: 'Toast', calories_kcal: 80.4, expectKcal: 80 },
  // a split recipe: the children's sum, the parent's own nutrition is ignored
  {
    uuid: 'par-stew', meal: 2, name: 'Stew', is_recipe: true, id: 40, nutrition: { calories: 999 },
    _splitItems: [
      { uuid: 'par-stew-beef', name: 'Beef', quantity: 2, nutrition: { calories: 100.4 } },
      { uuid: 'par-stew-stock', name: 'Stock', nutrition: { calories: '50.3' } },
    ],
    expectKcal: 251,
  },
  { uuid: 'par-a', meal: 3, name: 'Almond', nutrition: { calories: 0.4 }, expectKcal: 0 },
  { uuid: 'par-b', meal: 3, name: 'Bean', nutrition: { calories: 0.4 }, expectKcal: 0 },
  { uuid: 'par-c', meal: 3, name: 'Caper', nutrition: { calories: 0.4 }, expectKcal: 0 },
  // nothing to count
  { uuid: 'par-water', meal: 3, name: 'Plain water', expectKcal: 0 },
];
export const PARITY_DAY_KCAL = 561;
