import { createServer } from 'node:http';
import { store } from './db.js';
import { registerRepPunch } from './rep-p.js';

const PORT = Number(process.env.PORT || 5176);

function send(res, status, body, cookie) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(new Error('Arquivo grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function tokenFrom(req) {
  const header = req.headers.cookie || '';
  const pair = header.split(';').map((part) => part.trim()).find((part) => part.startsWith('ponto_admin='));
  return pair ? decodeURIComponent(pair.slice('ponto_admin='.length)) : '';
}

function sessionCookie(token) {
  return `ponto_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`;
}

function clearCookie() {
  return 'ponto_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

const routes = {
  '/api/status': () => ({ ok: true, adminConfigured: store.adminConfigured() }),
  '/api/admin/session': (_body, token) => ({ ok: true, unlocked: store.adminSession(token) }),
  '/api/admin/setup': async (body) => {
    const result = await store.setupAdmin(body.password, body.confirm);
    return result.ok ? { ...result, cookie: sessionCookie(result.token) } : result;
  },
  '/api/admin/login': async (body) => {
    const result = await store.adminLogin(body.password);
    return result.ok ? { ...result, cookie: sessionCookie(result.token) } : result;
  },
  '/api/admin/logout': (_body, token) => {
    store.adminLogout(token);
    return { ok: true, cookie: clearCookie() };
  },
  '/api/employees/active': () => store.listActiveEmployees(),
  '/api/employees/staff': (_body, token) => (store.adminSession(token) ? store.listStaff() : { ok: false, error: 'Entre como administrador.' }),
  '/api/pin/verify': (body) => store.verifyPin(body.employeeId, body.pin),
  '/api/punches/today': (body) => store.todayPunches(body.employeeId, body.pin),
  '/api/punches/register': (body) => store.registerPunch(body.employeeId, body.pin, body.type, body.requestId),
  '/api/rep-p/register': (body) => registerRepPunch(body),
  '/api/punches/between': (body, token) => (store.adminSession(token) ? store.punchesBetween(body.start, body.end) : { ok: false, error: 'Entre como administrador.', punches: [] }),
  '/api/justifications/between': (body, token) => (store.adminSession(token) ? store.justificationsBetween(body.start, body.end) : { ok: false, error: 'Entre como administrador.', justifications: [] }),
  '/api/employees/save': (body, token) => (store.adminSession(token) ? store.saveEmployee(body) : { ok: false, error: 'Entre como administrador.' }),
  '/api/justifications/save': (body, token) => (store.adminSession(token) ? store.saveJustification(body) : { ok: false, error: 'Entre como administrador.' }),
  '/api/justifications/delete': (body, token) => (store.adminSession(token) ? store.deleteJustification(body.id) : { ok: false, error: 'Entre como administrador.' }),
  '/api/punches/adjust': (body, token) => (store.adminSession(token) ? store.adjustPunch(body) : { ok: false, error: 'Entre como administrador.' }),
  '/api/backup': (_body, token) => (store.adminSession(token) ? { ok: true, store: store.exportBackup() } : { ok: false, error: 'Entre como administrador.' }),
  '/api/restore': (body, token) => (store.adminSession(token) ? store.restoreBackup(body) : { ok: false, error: 'Entre como administrador.' }),
  '/api/import': (body) => store.importLegacy(body),
};

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || !routes[req.url]) {
    send(res, 404, { ok: false, error: 'Caminho não encontrado.' });
    return;
  }
  try {
    const body = await readBody(req);
    const result = await routes[req.url](body, tokenFrom(req));
    const cookie = result.cookie;
    if (cookie) delete result.cookie;
    if (result.token) delete result.token;
    send(res, 200, result, cookie);
  } catch (error) {
    send(res, 400, { ok: false, error: error?.message || 'Não foi possível gravar no banco.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Banco SQLite em ${store.file}`);
  console.log(`API em http://127.0.0.1:${PORT}`);
});
