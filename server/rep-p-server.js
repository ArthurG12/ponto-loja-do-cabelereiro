import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { listActiveRepEmployees, listRepPunchesToday, registerRepPunch } from './rep-p.js';

const PORT = Number(process.env.PORT || 5176);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 16 * 1024;
const REP_ROUTES = new Set(['/api/rep-p/employees', '/api/rep-p/register', '/api/rep-p/today']);

function configured() {
  return Boolean(
    /^https:\/\//.test(process.env.SUPABASE_URL || '')
    && (process.env.SUPABASE_SERVICE_ROLE_KEY || '').length >= 20
    && (process.env.REP_COLLECTOR_ID || '').trim().length >= 3
    && ['01', '02', '03', '04', '05'].includes(process.env.REP_COLLECTOR_TYPE || '')
    && allowedOrigins().size > 0
  );
}

function allowedOrigins() {
  const raw = process.env.REP_ALLOWED_ORIGINS || process.env.REP_ALLOWED_ORIGIN || '';
  return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
}

function baseHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-site',
    ...extra,
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, baseHeaders(headers));
  res.end(JSON.stringify(body));
}

function corsFor(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Corpo da solicitação muito grande.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON inválido.');
    error.statusCode = 400;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('O corpo deve ser um objeto JSON.');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

const handlers = {
  '/api/rep-p/employees': listActiveRepEmployees,
  '/api/rep-p/register': registerRepPunch,
  '/api/rep-p/today': listRepPunchesToday,
};

export function createRepServer() {
  const server = createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      send(res, 400, { ok: false, error: 'Solicitação inválida.' });
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      send(res, 200, { ok: true, service: 'rep-p-api' });
      return;
    }
    if (req.method === 'GET' && pathname === '/readyz') {
      const ready = configured();
      send(res, ready ? 200 : 503, { ok: ready, service: 'rep-p-api', configured: ready });
      return;
    }

    if (!REP_ROUTES.has(pathname)) {
      send(res, 404, { ok: false, error: 'Caminho não encontrado.' });
      return;
    }

    const origin = req.headers.origin || '';
    const origins = allowedOrigins();
    if (origin && (!origins.has(origin) || (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')))) {
      send(res, 403, { ok: false, error: 'Origem não autorizada.' });
      return;
    }
    const corsHeaders = origin ? corsFor(origin) : {};

    if (req.method === 'OPTIONS') {
      if (!origin || !corsHeaders['access-control-allow-origin']) {
        send(res, 403, { ok: false, error: 'Origem não autorizada.' });
        return;
      }
      res.writeHead(204, baseHeaders(corsHeaders));
      res.end();
      return;
    }
    const employeeListRoute = pathname === '/api/rep-p/employees';
    const expectedMethod = employeeListRoute ? 'GET' : 'POST';
    if (req.method !== expectedMethod) {
      send(res, 405, { ok: false, error: 'Método não permitido.' }, { allow: employeeListRoute ? 'GET, OPTIONS' : 'POST, OPTIONS' });
      return;
    }
    if (!configured()) {
      send(res, 503, { ok: false, error: 'Serviço REP-P não configurado.' }, corsHeaders);
      return;
    }
    if (employeeListRoute) {
      try {
        const result = await handlers[pathname]({});
        send(res, 200, result, corsHeaders);
      } catch (error) {
        console.error('Erro interno na API REP-P:', error?.code || 'sem código');
        send(res, 500, { ok: false, error: 'Falha interna no serviço REP-P.' }, corsHeaders);
      }
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      send(res, 415, { ok: false, error: 'Envie o conteúdo em JSON.' }, corsHeaders);
      return;
    }

    try {
      const body = await readJson(req);
      const result = await handlers[pathname](body);
      send(res, 200, result, corsHeaders);
    } catch (error) {
      if (error?.statusCode) {
        send(res, error.statusCode, { ok: false, error: error.message }, corsHeaders);
        return;
      }
      console.error('Erro interno na API REP-P:', error?.code || 'sem código');
      send(res, 500, { ok: false, error: 'Falha interna no serviço REP-P.' }, corsHeaders);
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createRepServer();
  server.listen(PORT, HOST, () => {
    console.log(`API REP-P em http://${HOST}:${PORT}`);
  });
}
