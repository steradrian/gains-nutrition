// The contract tests' server: the real server/index.js on a scratch
// database, in a child process (as scripts/android-sync.test.js runs it),
// with net.mjs preloaded so it never reaches the network.
//
// startServer() signs up the first account (the admin) and signs it in; api()
// sends that account's token as a Bearer header, which is what the Android
// app does and needs no CSRF token. Set CONTRACT_EXAMPLES_DIR to also write
// every request and response a test labels with `example` to
// <dir>/<file>.json, the source of the examples in docs/api-contract.md.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NET = new URL('./net.mjs', import.meta.url).href;
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'ALL_PROXY', 'all_proxy'];
export const PASSWORD = 'Contract-Test-Pass-77!';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/**
 * Boot the server. `file` is the test's import.meta.url (names its example
 * file); `upstream` the fake upstream's origin, when the test needs one.
 */
export async function startServer({ file, upstream = null, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nt-contract-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const childEnv = { ...process.env };
  for (const k of PROXY_VARS) delete childEnv[k];
  Object.assign(childEnv, {
    PORT: String(port), DB_PATH: join(dir, 'server.db'), UPLOADS_PATH: join(dir, 'uploads'),
    JWT_SECRET: 'contract-test-secret-0123456789abcdef', INSECURE_COOKIES: '1', NODE_ENV: 'test', LOG_LEVEL: 'error',
    CONTRACT_FAKE_UPSTREAM: upstream || '', ...env,
  });
  let log = '';
  const child = spawn(process.execPath, ['--import', NET, 'index.js'], { cwd: join(ROOT, 'server'), env: childEnv });
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    if (child.exitCode != null) break;
    try { up = (await fetch(base + '/api/auth/status')).ok; } catch { await sleep(250); }
  }
  if (!up) { child.kill(); throw new Error(`server did not start:\n${log}`); }

  const examples = [];
  const srv = {
    base, dir, token: null, log: () => log,
    /** { status, body, headers }; body is parsed JSON, or the text when it is not JSON. */
    async api(method, path, body, { token = srv.token, headers = {}, example } = {}) {
      const h = { ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      if (token) h.authorization = `Bearer ${token}`;
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let parsed = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (example) examples.push({ example, request: { method, path, ...(body !== undefined ? { body } : {}) }, response: { status: res.status, body: parsed } });
      return { status: res.status, body: parsed, headers: res.headers };
    },
    async stop() {
      if (process.env.CONTRACT_EXAMPLES_DIR && file && examples.length) {
        mkdirSync(process.env.CONTRACT_EXAMPLES_DIR, { recursive: true });
        writeFileSync(join(process.env.CONTRACT_EXAMPLES_DIR, basename(fileURLToPath(file)).replace(/\.test\.js$/, '.json')), JSON.stringify(examples, null, 2));
      }
      child.kill();
      await new Promise(r => (child.exitCode != null ? r() : child.once('exit', r)));
      rmSync(dir, { recursive: true, force: true });
    },
  };

  // The first account on a fresh install registers without a session and
  // is the admin; sign-in hands back the token.
  const reg = await srv.api('POST', '/api/auth/register', { username: 'contract', password: PASSWORD });
  if (reg.status !== 200) throw new Error(`register: ${reg.status} ${JSON.stringify(reg.body)}\n${log}`);
  const login = await srv.api('POST', '/api/auth/login', { username: 'contract', password: PASSWORD });
  if (login.status !== 200 || !login.body?.token) throw new Error(`login: ${login.status} ${JSON.stringify(login.body)}`);
  srv.token = login.body.token;
  srv.user = login.body.user;
  return srv;
}
