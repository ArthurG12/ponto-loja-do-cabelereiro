import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRepServer } from '../server/rep-p-server.js';

let server;
let baseUrl;

before(async () => {
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.REP_COLLECTOR_ID = '';
  process.env.REP_COLLECTOR_TYPE = '';
  process.env.REP_ALLOWED_ORIGIN = '';
  process.env.REP_ALLOWED_ORIGINS = '';
  server = createRepServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('health endpoint responds without exposing configuration', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'rep-p-api' });
});

test('readiness endpoint fails closed when private credentials are absent', async () => {
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    service: 'rep-p-api',
    configured: false,
  });
});

test('unknown routes are not exposed', async () => {
  const response = await fetch(`${baseUrl}/api/admin/login`, { method: 'POST' });
  assert.equal(response.status, 404);
});

test('REP-P routes reject unapproved browser origins', async () => {
  const response = await fetch(`${baseUrl}/api/rep-p/register`, {
    method: 'POST',
    headers: {
      origin: 'https://unexpected.example',
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 403);
});

test('REP-P routes reject unsupported HTTP methods', async () => {
  const response = await fetch(`${baseUrl}/api/rep-p/register`, {
    method: 'GET',
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
});
