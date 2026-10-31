const LEGACY_KEY = 'ponto-facil-loja-v1';

let adminConfiguredFlag = false;
let migrated = false;

async function post(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    return { ok: false, error: 'O banco de dados não está respondendo. Rode o sistema de novo.' };
  }
  const data = await response.json().catch(() => null);
  if (!data) return { ok: false, error: 'Resposta inválida do banco.' };
  return data;
}

async function migrateLegacy() {
  if (migrated) return;
  migrated = true;
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    const response = await post('/api/import', data);
    if (response.ok) localStorage.removeItem(LEGACY_KEY);
    else migrated = false;
  } catch {
    migrated = false;
  }
}

export const sqliteApi = {
  mode: 'sqlite',
  adminConfigured() {
    return adminConfiguredFlag;
  },
  async refreshStatus() {
    const status = await post('/api/status');
    adminConfiguredFlag = Boolean(status.adminConfigured);
    return status;
  },
  async isAdminUnlocked() {
    const response = await post('/api/admin/session');
    return Boolean(response.unlocked);
  },
  async setupAdmin(password, confirm) {
    const response = await post('/api/admin/setup', { password, confirm });
    if (response.ok) adminConfiguredFlag = true;
    return response;
  },
  async adminLogin({ password }) {
    return post('/api/admin/login', { password });
  },
  async adminLogout() {
    await post('/api/admin/logout');
  },
  async listActiveEmployees() {
    await migrateLegacy();
    const response = await post('/api/employees/active');
    return { ok: Boolean(response.ok), employees: response.employees || [], error: response.error };
  },
  async listStaff() {
    return post('/api/employees/staff');
  },
  async verifyPin(employeeId, pin) {
    return post('/api/pin/verify', { employeeId, pin });
  },
  async todayPunches(employeeId, pin) {
    return post('/api/punches/today', { employeeId, pin });
  },
  async registerPunch(employeeId, pin, type, requestId) {
    return post('/api/punches/register', { employeeId, pin, type, requestId });
  },
  async punchesBetween(start, end) {
    return post('/api/punches/between', { start, end });
  },
  async justificationsBetween(start, end) {
    return post('/api/justifications/between', { start, end });
  },
  async saveEmployee(input) {
    return post('/api/employees/save', input);
  },
  async saveJustification(input) {
    return post('/api/justifications/save', input);
  },
  async deleteJustification(id) {
    return post('/api/justifications/delete', { id });
  },
  async adjustPunch(input) {
    return post('/api/punches/adjust', input);
  },
  async exportBackup() {
    const response = await post('/api/backup');
    if (!response.ok) return '';
    return JSON.stringify(response.store, null, 2);
  },
  async restoreBackup(text) {
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, error: 'Arquivo inválido.' }; }
    const response = await post('/api/restore', data);
    if (response.ok) await this.refreshStatus();
    return response;
  },
};
