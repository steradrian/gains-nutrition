/**
 * An Express app with some of the server's routes mounted, in this process,
 * on a scratch database: the tests that need a handler and a database but
 * not the whole server (the boot in contract/server.mjs is for those).
 *
 * `bootInProcess` returns null where better-sqlite3 is not built for this
 * Node (it needs Node 20): the caller skips its cases. Anything else that
 * fails is a real failure and throws. The environment is set before the
 * server's modules load, so a test file boots once, first.
 *
 * A test file that never calls `newUser` is in single-user mode
 * (userMgmtActive is false while the users table is empty): requests carry
 * no token and every route reads and writes the rows with no user. One that
 * does is in multi-user mode from then on, so a file is one or the other.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const req = createRequire(new URL('../../server/package.json', import.meta.url));

/** `routes` maps a mount path to a file in server/routes: { '/api/foods': 'foods.js' }. */
export async function bootInProcess({ prefix, routes }) {
  try { req('better-sqlite3'); } catch { return null; }
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.UPLOADS_PATH = join(dir, 'uploads');
  process.env.JWT_SECRET = `${prefix}-test-secret-0123456789abcdef`;
  const db = (await import('../../server/db.js')).default;
  const auth = await import('../../server/middleware/auth.js');

  const express = req('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(req('cookie-parser')());
  app.use(auth.authenticate);
  for (const [mount, file] of Object.entries(routes)) {
    app.use(mount, (await import(new URL(`../../server/routes/${file}`, import.meta.url))).default);
  }
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  test.after(() => { server.close(); try { db.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

  let seq = 0;
  return {
    db,
    auth,
    base,
    newUser() {
      const id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(`${prefix}-${++seq}-${Math.random()}`, 'x', 'user').lastInsertRowid);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      return { ...user, token: auth.signToken(user) };
    },
    /** { status, body } for `method path` as `user` (null: no token, as in single-user mode). */
    async call(user, method, path, body) {
      const headers = {};
      if (user) headers.authorization = `Bearer ${user.token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null;
      try { json = await res.json(); } catch { /* no body */ }
      return { status: res.status, body: json };
    },
  };
}
