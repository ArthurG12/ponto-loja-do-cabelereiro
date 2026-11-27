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
  process.env.REP_ESTABLISHMENT_ID = '';
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
    availabilityRecorded: false,
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

test('employee directory endpoint fails closed without backend credentials', async () => {
  const response = await fetch(`${baseUrl}/api/rep-p/employees`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Serviço REP-P não configurado ou evento de disponibilidade ainda não registrado.',
  });
});

test('employee directory endpoint accepts GET only', async () => {
  const response = await fetch(`${baseUrl}/api/rep-p/employees`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, OPTIONS');
});

test('REP-P routes reject unsupported HTTP methods', async () => {
  const response = await fetch(`${baseUrl}/api/rep-p/register`, {
    method: 'GET',
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
});


async function withTestServer(options, run) {
  const instance = createRepServer(options);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
}

test('AFD export requires a bearer token before invoking authorization or ledger access', async () => {
  let authorizationCalls = 0;
  let preparationCalls = 0;
  await withTestServer({
    readiness: () => true,
    authenticateAdmin: async () => { authorizationCalls += 1; return { ok: false }; },
    prepareAfd: async () => { preparationCalls += 1; return { buffer: Buffer.from('x') }; },
  }, async (url) => {
    const response = await fetch(`${url}/api/rep-p/afd?start=2026-11-01&end=2026-11-30`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'Autenticação necessária.');
  });
  assert.equal(authorizationCalls, 0);
  assert.equal(preparationCalls, 0);
});

test('AFD export rejects authenticated users who are not administrators', async () => {
  let preparationCalls = 0;
  await withTestServer({
    readiness: () => true,
    authenticateAdmin: async (token) => ({ ok: false, token }),
    prepareAfd: async () => { preparationCalls += 1; return { buffer: Buffer.from('x') }; },
  }, async (url) => {
    const response = await fetch(`${url}/api/rep-p/afd?start=2026-11-01&end=2026-11-30`, {
      headers: { authorization: 'Bearer valid-user-token' },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'Credenciais inválidas ou acesso não autorizado.');
  });
  assert.equal(preparationCalls, 0);
});

test('AFD admin route validates the ledger but never releases an unsigned file', async () => {
  let received;
  await withTestServer({
    readiness: () => true,
    authenticateAdmin: async (token) => token === 'admin-token' ? { ok: true, userId: 'admin-id' } : { ok: false },
    prepareAfd: async (input) => {
      received = input;
      return { buffer: Buffer.from('prepared-but-unsigned') };
    },
  }, async (url) => {
    const response = await fetch(`${url}/api/rep-p/afd?start=2026-11-01&end=2026-11-30`, {
      headers: { authorization: 'Bearer admin-token' },
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /assinatura CAdES detached ICP-Brasil/);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  });
  assert.deepEqual(received, {
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    actorId: 'admin-id',
  });
});
