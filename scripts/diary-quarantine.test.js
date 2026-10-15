/**
 * A diary day under a date that does not exist is quarantined, never stored
 * and never lost (server/lib/diary-quarantine.js):
 *   - the migration that moves the rows an earlier version stored,
 *   - the trigger that keeps the table from taking another,
 *   - the one rule in JavaScript and in SQL agreeing on every date.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { INDEX_DATE_VALID } from '../server/lib/diary-keyset.js';
import {
  ADMIT, QUARANTINE_MAX_PER_USER, admitDiaryDay, ensureDiaryDateGuard, quarantineBadDiaryRows, quarantineDay, quarantinedDate,
} from '../server/lib/diary-quarantine.js';
import { isCalendarDate } from '../server/lib/mcp/_util.js';

const req = createRequire(new URL('../server/package.json', import.meta.url));
const Database = req('better-sqlite3');
const dir = mkdtempSync(join(tmpdir(), 'nt-quarantine-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const dbUrl = new URL('../server/db.js', import.meta.url).href;
const boot = file => execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(dbUrl)})`], {
  env: { ...process.env, DB_PATH: file }, encoding: 'utf8',
});

test('the migration moves every row whose date is not a real calendar date, whole, and keeps the rest', () => {
  const file = join(dir, 'legacy.db');
  boot(file); // schema

  // What a database looks like that an earlier version wrote: the guard is not there yet.
  const raw = new Database(file);
  raw.exec('DROP TRIGGER diary_date_is_real_insert; DROP TRIGGER diary_date_is_real_update');
  raw.prepare(`INSERT INTO users (id, username, password_hash) VALUES (7, 'seven', 'x')`).run();
  const put = raw.prepare(`INSERT INTO diary (user_id, date, items, body_stats, water, notes, updated_at, deleted_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`);
  const items = [{ uuid: 'q-1', meal: 0, name: 'Quarantined oats', nutrition: { calories: 100 } }];
  put.run(7, '2026-02-30', JSON.stringify(items), '{"weight":80}', 'a note', '2026-03-01 08:00:00', null);
  put.run(7, 'garbage', '[]', '{}', null, '2026-03-01 09:00:00', null);
  put.run(null, '2026-04-31', '[]', '{}', null, '2026-03-01 10:00:00', '2026-03-02 00:00:00');
  put.run(7, '2026-03-01', JSON.stringify(items), '{}', null, '2026-03-01 11:00:00', null);
  put.run(7, '2024-02-29', '[]', '{}', null, '2026-03-01 12:00:00', null);
  raw.close();

  const out = boot(file);
  assert.match(out, /moved 3 row\(s\)/, 'the count is logged');

  const after = new Database(file);
  try {
    assert.deepEqual(after.prepare('SELECT date FROM diary ORDER BY date').all().map(r => r.date), ['2024-02-29', '2026-03-01']);
    const kept = after.prepare('SELECT user_id, date, payload, source FROM diary_quarantine ORDER BY id').all();
    assert.deepEqual(kept.map(k => [k.user_id, k.date, k.source]), [[7, '2026-02-30', 'migration'], [7, 'garbage', 'migration'], [null, '2026-04-31', 'migration']]);
    const first = JSON.parse(kept[0].payload);
    assert.deepEqual(JSON.parse(first.items), items, 'the whole row is kept, items included');
    assert.deepEqual([first.body_stats, first.notes, first.updated_at], ['{"weight":80}', 'a note', '2026-03-01 08:00:00']);
    assert.equal(JSON.parse(kept[2].payload).deleted_at, '2026-03-02 00:00:00', 'a deleted day is kept as deleted');
    assert.equal(after.prepare('SELECT created_at FROM diary_quarantine WHERE id = 1').get().created_at.length, 19);
  } finally { after.close(); }

  assert.doesNotMatch(boot(file), /moved/, 'a second boot has nothing left to move');
  const again = new Database(file);
  try { assert.equal(again.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n, 3, 'and adds nothing'); } finally { again.close(); }
});

test('the migration is all or nothing: a row is deleted only together with its copy', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE diary (id INTEGER PRIMARY KEY, user_id INTEGER, date TEXT NOT NULL);
      CREATE TABLE diary_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT NOT NULL CHECK (date <> 'bad-two'),
        payload TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO diary (date) VALUES ('bad-one'), ('bad-two'), ('2026-03-01');
    `);
    assert.throws(() => quarantineBadDiaryRows(db), /CHECK/);
    assert.deepEqual(db.prepare('SELECT date FROM diary ORDER BY id').all().map(r => r.date), ['bad-one', 'bad-two', '2026-03-01'], 'nothing was deleted');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n, 0, 'and no copy is left half-made');
  } finally { db.close(); }
});

test('the table refuses a date that does not exist, by every way of writing it', () => {
  const file = join(dir, 'guard.db');
  boot(file);
  const db = new Database(file);
  try {
    const bad = ['2026-02-30', 'garbage', '2026-13-01', '2025-04-31', '2026-1-5', '2026-10-05x', ' 2026-10-05', '2026-10-05 10:00:00', ''];
    const writes = {
      insert: date => db.prepare('INSERT INTO diary (user_id, date) VALUES (NULL, ?)').run(date),
      'insert or ignore': date => db.prepare('INSERT OR IGNORE INTO diary (user_id, date) VALUES (NULL, ?)').run(date),
      'insert or replace': date => db.prepare('INSERT OR REPLACE INTO diary (user_id, date) VALUES (NULL, ?)').run(date),
      upsert: date => db.prepare(`INSERT INTO diary (user_id, date) VALUES (NULL, ?) ON CONFLICT(date, user_id) DO UPDATE SET notes = 'x'`).run(date),
    };
    for (const date of bad) {
      for (const [how, write] of Object.entries(writes)) assert.throws(() => write(date), /real YYYY-MM-DD/, `${how} ${JSON.stringify(date)}`);
    }
    assert.throws(() => db.prepare('INSERT INTO diary (user_id, date) VALUES (NULL, ?)').run(20261005), /real YYYY-MM-DD/, 'a number is not a date');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary').get().n, 0);

    for (const date of ['2026-03-01', '2024-02-29', '2000-02-29']) writes.insert(date);
    assert.throws(() => db.prepare(`UPDATE diary SET date = '2026-02-30' WHERE date = '2026-03-01'`).run(), /real YYYY-MM-DD/, 'a day cannot be moved onto one either');
    assert.equal(db.prepare(`UPDATE diary SET notes = 'edited', date = date WHERE date = '2026-03-01'`).run().changes, 1, 'other edits are untouched');
    assert.equal(db.prepare(`UPDATE diary SET date = '2026-03-02' WHERE date = '2026-03-01'`).run().changes, 1, 'moving to a real date is fine');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine').get().n, 0, 'the trigger refuses; it does not quarantine');
  } finally { db.close(); }
});

test('admitDiaryDay lets a real date through and quarantines anything else with what was sent', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE diary_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT NOT NULL, payload TEXT NOT NULL, source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const circular = {}; circular.self = circular;
    assert.equal(admitDiaryDay(db, { userId: 1, date: '2026-10-14', payload: {}, source: 's' }), ADMIT.WRITE);
    assert.equal(admitDiaryDay(db, { userId: 1, date: '2026-02-30', payload: { items: [1, 2] }, source: 'one' }), ADMIT.QUARANTINED);
    assert.equal(admitDiaryDay(db, { userId: null, date: 42, payload: { n: 1 }, source: 'two' }), ADMIT.QUARANTINED);
    assert.equal(admitDiaryDay(db, { userId: undefined, date: null, payload: circular, source: 'three' }), ADMIT.QUARANTINED);
    const rows = db.prepare('SELECT user_id, date, payload, source FROM diary_quarantine ORDER BY id').all();
    assert.deepEqual(rows.map(r => [r.user_id, r.date, r.source]), [[1, '2026-02-30', 'one'], [null, '42', 'two'], [null, 'null', 'three']]);
    assert.deepEqual(JSON.parse(rows[0].payload), { items: [1, 2] });
    assert.match(rows[2].payload, /unserializable/, 'a payload that cannot be written as JSON is still kept, as text');
    quarantineDay(db, { userId: 2, date: 'x'.repeat(500), payload: null, source: 'long' });
    assert.equal(db.prepare('SELECT length(date) AS n FROM diary_quarantine ORDER BY id DESC LIMIT 1').get().n, 500, 'the raw date is kept whole');
    assert.equal(quarantinedDate('x'.repeat(500)).length, 40, 'what an answer names is short');
    assert.equal(quarantinedDate(42), '42');
  } finally { db.close(); }
});

test('admitDiaryDay stops quarantining at the cap, per person, and says so; a real date is never affected', () => {
  const db = new Database(':memory:');
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => { warned.push(a.join(' ')); };
  try {
    db.exec(`CREATE TABLE diary_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT NOT NULL, payload TEXT NOT NULL, source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const fill = userId => {
      const ins = db.prepare(`INSERT INTO diary_quarantine (user_id, date, payload, source) VALUES (?, 'garbage', '{}', 'fill')`);
      for (let i = 0; i < QUARANTINE_MAX_PER_USER - 1; i++) ins.run(userId);
    };
    const count = userId => db.prepare('SELECT COUNT(*) AS n FROM diary_quarantine WHERE user_id IS ?').get(userId).n;
    const bad = userId => admitDiaryDay(db, { userId, date: '2026-02-30', payload: { n: 1 }, source: 'batch' });
    fill(1);
    fill(null);

    assert.equal(bad(1), ADMIT.QUARANTINED, 'the last place is still taken');
    assert.equal(count(1), QUARANTINE_MAX_PER_USER);
    assert.equal(bad(1), ADMIT.FULL, 'the next is refused');
    assert.equal(bad(1), ADMIT.FULL);
    assert.equal(count(1), QUARANTINE_MAX_PER_USER, 'and nothing was added');
    assert.equal(warned.length, 2);
    assert.match(warned[0], new RegExp(`user 1 holds ${QUARANTINE_MAX_PER_USER}\\b`), 'the warning names the person and the count');

    assert.equal(admitDiaryDay(db, { userId: 1, date: '2026-10-14', payload: {}, source: 's' }), ADMIT.WRITE, 'a real day is written however full it is');
    assert.equal(count(2), 0);
    assert.equal(bad(2), ADMIT.QUARANTINED, 'another person has a quarantine of their own');
    assert.equal(bad(null), ADMIT.QUARANTINED, 'so does single-user mode (user_id NULL)');
    assert.equal(bad(null), ADMIT.FULL);
    assert.equal(count(null), QUARANTINE_MAX_PER_USER);
  } finally { console.warn = warn; db.close(); }
});

test('the migration ignores the cap: it never deletes a row without its copy', () => {
  const db = new Database(':memory:');
  try {
    const extra = 5;
    db.exec(`
      CREATE TABLE diary (id INTEGER PRIMARY KEY, user_id INTEGER, date TEXT NOT NULL);
      CREATE TABLE diary_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT NOT NULL, payload TEXT NOT NULL, source TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const quarantine = db.prepare(`INSERT INTO diary_quarantine (user_id, date, payload, source) VALUES (3, 'garbage', '{}', 'fill')`);
    for (let i = 0; i < QUARANTINE_MAX_PER_USER; i++) quarantine.run();
    const diary = db.prepare(`INSERT INTO diary (user_id, date) VALUES (3, ?)`);
    for (let i = 0; i < extra; i++) diary.run(`bad-${i}`);

    assert.equal(quarantineBadDiaryRows(db), extra);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM diary').get().n, 0);
    assert.deepEqual(
      db.prepare(`SELECT date FROM diary_quarantine WHERE source = 'migration' ORDER BY id`).all().map(r => r.date),
      Array.from({ length: extra }, (_, i) => `bad-${i}`),
      'every row was copied, past the cap',
    );
  } finally { db.close(); }
});

test('JavaScript and SQL agree on which dates exist', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE diary (date TEXT)');
    const sqlSays = db.prepare('SELECT date(?) IS ? AS ok').pluck();
    const indexSays = db.prepare(`SELECT COUNT(*) FROM (SELECT ? AS date) WHERE ${INDEX_DATE_VALID}`).pluck();
    const pad = (n, w) => String(n).padStart(w, '0');
    const dates = [];
    for (let t = Date.UTC(1900, 0, 1); t <= Date.UTC(2101, 0, 1); t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));
    for (const y of [0, 4, 100, 400, 1900, 2000, 2024, 2025, 2100, 9999]) {
      for (let m = 0; m <= 13; m++) for (let d = 0; d <= 32; d++) dates.push(`${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`);
    }
    dates.push('', 'garbage', '2026-1-5', '20261005', '2026/10/05', '2026-10-05x', ' 2026-10-05', '2026-10-05 10:00:00', '2026-10-05T10:00:00Z', '+2026-10-05', '２０２６-10-05');
    for (const date of dates) {
      assert.equal(sqlSays.get(date, date) === 1, isCalendarDate(date), `date() ${JSON.stringify(date)}`);
      assert.equal(indexSays.get(date) === 1, isCalendarDate(date), `the index ${JSON.stringify(date)}`);
    }
  } finally { db.close(); }
});

test('ensureDiaryDateGuard can run on every boot', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE diary (id INTEGER PRIMARY KEY, date TEXT NOT NULL, notes TEXT)');
    ensureDiaryDateGuard(db);
    ensureDiaryDateGuard(db);
    assert.throws(() => db.prepare(`INSERT INTO diary (date) VALUES ('2026-02-30')`).run(), /real YYYY-MM-DD/);
  } finally { db.close(); }
});
