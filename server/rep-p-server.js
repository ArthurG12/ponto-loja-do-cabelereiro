import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { authenticateRepAdmin, listActiveRepEmployees, listRepPunchesToday, prepareRepAfdExport, recordRepServiceEvent, registerRepPunch } from './rep-p.js';

const PORT = Number(process.env.PORT || 5176);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 16 * 1024;
const REP_ROUTES = new Set(['/api/rep-p/employees', '/api/rep-p/register', '/api/rep-p/today', '/api/rep-p/afd']);
let serviceAvailableRecorded = false;

function configured() {
  return Boolean(
    /^https:\/\//.test(process.env.SUPABASE_URL || '')
    && (process.env.SUPABASE_SERVICE_ROLE_KEY || '').length >= 20
    && (process.env.REP_COLLECTOR_ID || '').trim().length >= 3
    && ['01', '02', '03', '04', '05'].includes(process.env.REP_COLLECTOR_TYPE || '')
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(process.env.REP_ESTABLISHMENT_ID || '')
    && allowedOrigins().size > 0
  );
}

function ready() {
  return configured() && serviceAvailableRecorded;
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
    'access-control-allow-headers': 'authorization, content-type',
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

export function createRepServer({ readiness = ready, authenticateAdmin = authenticateRepAdmin, prepareAfd = prepareRepAfdExport } = {}) {
  const server = createServer(async (req, res) => {
    let pathname;
    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', 'http://localhost');
      pathname = requestUrl.pathname;
    } catch {
      send(res, 400, { ok: false, error: 'Solicitação inválida.' });
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      send(res, 200, { ok: true, service: 'rep-p-api' });
      return;
    }
    if (req.method === 'GET' && pathname === '/readyz') {
      const isReady = ready();
      send(res, isReady ? 200 : 503, { ok: isReady, service: 'rep-p-api', configured: configured(), availabilityRecorded: serviceAvailableRecorded });
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
    const afdRoute = pathname === '/api/rep-p/afd';
    const expectedMethod = employeeListRoute || afdRoute ? 'GET' : 'POST';
    if (req.method !== expectedMethod) {
      send(res, 405, { ok: false, error: 'Método não permitido.' }, { allow: employeeListRoute || afdRoute ? 'GET, OPTIONS' : 'POST, OPTIONS' });
      return;
    }
    if (!readiness()) {
      send(res, 503, { ok: false, error: 'Serviço REP-P não configurado ou evento de disponibilidade ainda não registrado.' }, corsHeaders);
      return;
    }
    if (afdRoute) {
      const authorization = String(req.headers.authorization || '');
      const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i);
      if (!bearer) {
        send(res, 401, { ok: false, error: 'Autenticação necessária.' }, corsHeaders);
        return;
      }
      try {
        const auth = await authenticateAdmin(bearer[1]);
        if (auth?.unavailable) {
          send(res, 503, { ok: false, error: 'Autenticação administrativa indisponível.' }, corsHeaders);
          return;
        }
        if (auth?.ok !== true) {
          send(res, 401, { ok: false, error: 'Credenciais inválidas ou acesso não autorizado.' }, corsHeaders);
          return;
        }
        const prepared = await prepareAfd({
          startDate: requestUrl.searchParams.get('start'),
          endDate: requestUrl.searchParams.get('end'),
          actorId: auth.userId,
        });
        if (!prepared?.buffer || !Buffer.isBuffer(prepared.buffer)) {
          send(res, 503, { ok: false, error: 'Exportação AFD indisponível.' }, corsHeaders);
          return;
        }
        // A geração do arquivo é deliberadamente bloqueada até existir assinatura CAdES detached ICP-Brasil real.
        send(res, 503, { ok: false, error: 'AFD validado, mas a assinatura CAdES detached ICP-Brasil ainda não está configurada. Nenhum arquivo foi disponibilizado.' }, corsHeaders);
      } catch (error) {
        if (error?.statusCode) {
          send(res, error.statusCode, { ok: false, error: error.message }, corsHeaders);
          return;
        }
        console.error('Falha na preparação protegida do AFD:', error?.code || 'sem código');
        send(res, 503, { ok: false, error: 'AFD não pôde ser preparado com segurança. Verifique os dados normativos e a cadeia do livro.' }, corsHeaders);
      }
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
  server.listen(PORT, HOST, async () => {
    const event = await recordRepServiceEvent('07');
    serviceAvailableRecorded = event.ok === true;
    if (!serviceAvailableRecorded) {
      console.error('API REP-P iniciou, mas não registrou o evento AFD tipo 6 de disponibilidade.');
    } else {
      console.log(`API REP-P disponível em http://${HOST}:${PORT}`);
    }
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    serviceAvailableRecorded = false;
    server.close();
    const event = await recordRepServiceEvent('08');
    if (!event.ok) {
      console.error(`Encerramento ${signal} sem confirmação do evento AFD tipo 6 de indisponibilidade.`);
    }
    server.closeAllConnections();
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}
