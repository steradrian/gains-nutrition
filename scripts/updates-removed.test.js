/**
 * The GitHub update check is gone: no route, no client module, no setting.
 * Deploys are hub-driven, so nothing in the app asks GitHub about releases.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { startServer } from './fixtures/contract/server.mjs';

const root = new URL('../', import.meta.url);
const exists = (p) => existsSync(new URL(p, root));
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('the update-check modules are deleted', () => {
  for (const p of [
    'server/routes/updates.js', 'server/lib/update-check.js',
    'src/lib/updates.js', 'src/lib/apk-asset.js',
    'src/components/settings/SettingsUpdates.svelte',
    'src/routes/settings/Updates.svelte', 'src/routes/settings/Support.svelte',
  ]) assert.equal(exists(p), false, `${p} should be gone`);
});

test('the server does not mount or import the update check', () => {
  const index = read('server/index.js');
  assert.doesNotMatch(index, /routes\/updates\.js|update-check\.js|\/api\/updates/);
});

test('the old updates routes answer nothing from the update check', async () => {
  const srv = await startServer({ file: import.meta.url });
  try {
    for (const path of ['/api/updates/server-status', '/api/updates/config']) {
      const r = await srv.api('GET', path);
      const isUpdateJson = r.body !== null && typeof r.body === 'object'
        && ('current' in r.body || 'disabled' in r.body || 'enabled' in r.body);
      assert.equal(isUpdateJson, false, `${path} must not return an update-check payload`);
      // With a built client the SPA fallback answers 200 with HTML; without
      // one the fallback fails. Either way it is not a JSON route.
      if (r.status === 200) assert.equal(typeof r.body, 'string', `${path} must not be a JSON route`);
    }
  } finally {
    await srv.stop();
  }
});
