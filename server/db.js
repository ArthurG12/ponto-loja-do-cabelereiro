import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dayKeyOf, instant, nextType, punchOrderError, saoPauloParts, wallToIso } from '../src/time.js';
import { hashSecret, pinShape, randomId, sameHash } from './secrets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'ponto.sqlite');
mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    schedule_code TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    pin_hash TEXT NOT NULL,
    pin_salt TEXT NOT NULL,
    pin_kdf TEXT NOT NULL DEFAULT 'sha256',
    photo_url TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
  );
  CREATE TABLE IF NOT EXISTS punches (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL,
    punch_type TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    source TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    voided_at TEXT,
    void_reason TEXT,
    UNIQUE (employee_id, client_request_id)
  );
  CREATE TABLE IF NOT EXISTS justifications (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL,
    category TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS corrections (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    punch_id TEXT,
    employee_id TEXT,
    reason TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    kdf TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
`);

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const FAKE_EMPLOYEES = [
  { id: 'fake-1', full_name: 'Colaboradora 1', schedule_code: 'A', pin_salt: 'OucEfCSTo2TcYrQxjgVYfA==', pin_hash: 'cap0pw8x1CJMSPOeBu1//YcR5KNWKaaMtS0etnpYXSc=' },
  { id: 'fake-2', full_name: 'Colaboradora 2', schedule_code: 'A', pin_salt: 'WvKEOClQ0sD+jEoKuNjysQ==', pin_hash: 'aGUqFBbAPft0EDnuw1orsIN9RvJh1/nPau2r+ZLm6kY=' },
  { id: 'fake-3', full_name: 'Colaboradora 3', schedule_code: 'B', pin_salt: 'gCNpHsHXYw+iGbofdK30Qw==', pin_hash: '5tAoVnn//ECONkGaeZ3wOgHLmXCykXYg7zYRAi3dQOQ=' },
  { id: 'fake-4', full_name: 'Colaboradora 4', schedule_code: 'B', pin_salt: 'Ex2pJYie33prWfMGUqfkUA==', pin_hash: 'DvL4LZkK0ZogobWbSlYNEuhT19gJvbE/gPAnF1kRXXo=' },
  { id: 'fake-5', full_name: 'Colaboradora 5', schedule_code: 'A', pin_salt: 'AemrbCSt8QT5mXf4jGhNMQ==', pin_hash: 'HRU/9wQOzOXHp3v2+7z69sY56Bt+b0tHP0223Z0h7AQ=' },
];

function lastWeekKeys() {
  const today = saoPauloParts().dayKey;
  const [year, month, day] = today.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const sinceMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = new Date(Date.UTC(year, month - 1, day - sinceMonday - 7));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + index));
    return date.toISOString().slice(0, 10);
  });
}

function insertPunch(punch) {
  db.prepare(`INSERT OR IGNORE INTO punches
    (id, employee_id, punch_type, recorded_at, source, client_request_id, voided_at, void_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    punch.id,
    punch.employee_id,
    punch.punch_type,
    punch.recorded_at,
    punch.source || 'tablet',
    punch.client_request_id,
    punch.voided_at || null,
    punch.void_reason || null,
  );
}

function seedPunch(employeeId, day, type, hhmm) {
  insertPunch({
    id: randomId(),
    employee_id: employeeId,
    punch_type: type,
    recorded_at: wallToIso(day, hhmm),
    source: 'tablet',
    client_request_id: `seed-last-week:${employeeId}:${day}:${type}`,
  });
}

function seedDay(employeeId, day, slots) {
  ['entrada', 'saida_intervalo', 'retorno_intervalo', 'saida'].forEach((type, index) => {
    if (slots[index]) seedPunch(employeeId, day, type, slots[index]);
  });
}

function ensureSeed() {
  const insertEmployee = db.prepare(`INSERT OR IGNORE INTO employees
    (id, full_name, schedule_code, active, pin_hash, pin_salt, pin_kdf)
    VALUES (?, ?, ?, 1, ?, ?, 'sha256')`);
  for (const demo of FAKE_EMPLOYEES) {
    insertEmployee.run(demo.id, demo.full_name, demo.schedule_code, demo.pin_hash, demo.pin_salt);
  }
  const [mon, tue, wed, thu, fri, sat, sun] = lastWeekKeys();
  const fullA = ['08:00', '12:00', '13:00', '17:00'];
  const fullB = ['09:00', '13:00', '14:00', '18:00'];
  const saturdayA = ['08:00', null, null, '12:00'];
  const saturdayB = ['09:00', null, null, '13:00'];
  seedDay('fake-1', mon, fullA);
  seedDay('fake-1', tue, fullA);
  seedDay('fake-1', wed, fullA);
  seedDay('fake-1', thu, fullA);
  seedDay('fake-1', fri, fullA);
  seedDay('fake-1', sat, saturdayA);
  seedDay('fake-2', mon, ['08:22', '12:05', '13:08', '17:00']);
  seedDay('fake-2', tue, ['08:35', '12:00', '13:00', '17:10']);
  seedDay('fake-2', wed, ['08:00', '12:00', '13:00', '17:45']);
  seedDay('fake-2', thu, ['08:18', '12:10', '13:20', '17:00']);
  seedDay('fake-2', fri, ['08:00', '12:00', '13:00', '18:10']);
  seedDay('fake-2', sat, ['08:12', null, null, '12:40']);
  seedDay('fake-3', mon, fullB);
  seedDay('fake-3', wed, ['09:07', null, null, null]);
  seedDay('fake-3', thu, fullB);
  seedDay('fake-3', fri, ['09:00', '13:00', null, null]);
  seedDay('fake-3', sat, saturdayB);
  seedDay('fake-4', mon, ['09:00', '13:00', '14:00', '17:15']);
  seedDay('fake-4', tue, fullB);
  seedDay('fake-4', thu, ['09:40', '13:05', '14:10', '18:20']);
  seedDay('fake-4', fri, fullB);
  seedDay('fake-4', sat, ['09:00', null, null, '13:50']);
  seedDay('fake-5', mon, fullA);
  seedDay('fake-5', tue, ['08:10', '12:00', '13:00', '16:40']);
  seedDay('fake-5', wed, ['08:00', null, null, '17:00']);
  seedDay('fake-5', thu, ['08:00', '12:00', '13:00', '17:30']);
  seedDay('fake-5', sat, saturdayA);
  seedDay('fake-5', sun, ['10:00', null, null, '14:00']);
  const excuseId = `seed-last-week:excuse:fake-4:${wed}`;
  db.prepare(`INSERT OR IGNORE INTO justifications
    (id, employee_id, category, starts_at, ends_at, notes, created_at)
    VALUES (?, 'fake-4', 'atestado', ?, ?, 'Atestado de teste', ?)`).run(
    excuseId,
    `${wed}T00:00:00-03:00`,
    `${wed}T23:59:00-03:00`,
    new Date().toISOString(),
  );
}

ensureSeed();

function publicEmployee(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    schedule_code: row.schedule_code,
    active: Boolean(row.active),
    photo_url: row.photo_url || null,
  };
}

function byName(a, b) {
  return a.full_name.localeCompare(b.full_name, 'pt-BR');
}

function employeeRow(id) {
  return db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
}

function punchRow(row) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    punch_type: row.punch_type,
    recorded_at: row.recorded_at,
    source: row.source,
    client_request_id: row.client_request_id,
    voided_at: row.voided_at,
    void_reason: row.void_reason,
  };
}

async function checkPin(employee, pin) {
  if (employee.locked_until && new Date(employee.locked_until).getTime() > Date.now()) {
    return 'Muitas tentativas. Aguarde 15 minutos e tente de novo.';
  }
  const hashed = await hashSecret(pin, employee.pin_salt, employee.pin_kdf || 'sha256');
  if (!sameHash(hashed.hash, employee.pin_hash)) {
    const count = (employee.locked_until ? 0 : employee.failed_attempts || 0) + 1;
    if (count >= MAX_ATTEMPTS) {
      db.prepare('UPDATE employees SET failed_attempts = 0, locked_until = ? WHERE id = ?').run(new Date(Date.now() + LOCK_MS).toISOString(), employee.id);
    } else {
      db.prepare('UPDATE employees SET failed_attempts = ?, locked_until = NULL WHERE id = ?').run(count, employee.id);
    }
    return 'Senha inválida.';
  }
  db.prepare('UPDATE employees SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(employee.id);
  return '';
}

function todayPunchesOf(employeeId) {
  const day = saoPauloParts().dayKey;
  return db.prepare('SELECT * FROM punches WHERE employee_id = ? AND voided_at IS NULL').all(employeeId)
    .map(punchRow)
    .filter((punch) => dayKeyOf(punch.recorded_at) === day);
}

function openSession() {
  const token = randomId();
  db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').run(token, new Date().toISOString());
  return token;
}

export const store = {
  file,
  adminConfigured() {
    return Boolean(db.prepare('SELECT id FROM admin WHERE id = 1').get());
  },
  adminSession(token) {
    if (!token || !this.adminConfigured()) return false;
    return Boolean(db.prepare('SELECT token FROM sessions WHERE token = ?').get(token));
  },
  async setupAdmin(password, confirm) {
    if ((password || '').length < 6) return { ok: false, error: 'Use pelo menos 6 caracteres.' };
    if (password !== confirm) return { ok: false, error: 'As senhas não conferem.' };
    if (this.adminConfigured()) return { ok: false, error: 'A senha do administrador já foi criada.' };
    const hashed = await hashSecret(password);
    db.prepare('INSERT INTO admin (id, hash, salt, kdf) VALUES (1, ?, ?, ?)').run(hashed.hash, hashed.salt, hashed.kdf);
    return { ok: true, token: openSession() };
  },
  async adminLogin(password) {
    const admin = db.prepare('SELECT * FROM admin WHERE id = 1').get();
    if (!admin) return { ok: false, error: 'Crie a senha do administrador primeiro.' };
    const hashed = await hashSecret(password, admin.salt, admin.kdf || 'pbkdf2');
    if (!sameHash(hashed.hash, admin.hash)) return { ok: false, error: 'Senha do administrador incorreta.' };
    return { ok: true, token: openSession() };
  },
  adminLogout(token) {
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },
  listActiveEmployees() {
    const employees = db.prepare('SELECT * FROM employees WHERE active = 1').all().map(publicEmployee).sort(byName);
    return { ok: true, employees };
  },
  listStaff() {
    return { ok: true, employees: db.prepare('SELECT * FROM employees').all().map(publicEmployee).sort(byName) };
  },
  async verifyPin(employeeId, pin) {
    if (!pinShape(pin)) return { ok: false, error: 'A senha tem de 4 a 6 números.' };
    const employee = employeeRow(employeeId);
    if (!employee?.active || !employee.pin_hash) return { ok: false, error: 'Senha inválida.' };
    const error = await checkPin(employee, pin);
    return error ? { ok: false, error } : { ok: true };
  },
  async todayPunches(employeeId, pin) {
    const verified = await this.verifyPin(employeeId, pin);
    if (!verified.ok) return verified;
    return { ok: true, punches: todayPunchesOf(employeeId) };
  },
  async registerPunch(employeeId, pin, type, requestId) {
    const employee = employeeRow(employeeId);
    if (!employee?.active) return { ok: false, error: 'Colaboradora não encontrada.' };
    const error = await checkPin(employee, pin);
    if (error) return { ok: false, error };
    const existing = db.prepare('SELECT * FROM punches WHERE employee_id = ? AND client_request_id = ?').get(employeeId, requestId);
    if (existing) return { ok: true, punch: punchRow(existing) };
    const today = todayPunchesOf(employeeId);
    const expected = nextType(employee.schedule_code, saoPauloParts().dayKey, today);
    if (!expected) return { ok: false, error: 'As marcações de hoje já foram realizadas.' };
    if (type !== expected) return { ok: false, error: 'A próxima marcação esperada mudou. Volte e tente de novo.' };
    const punch = {
      id: randomId(),
      employee_id: employeeId,
      punch_type: type,
      recorded_at: new Date().toISOString(),
      source: 'tablet',
      client_request_id: requestId || randomId(),
      voided_at: null,
    };
    insertPunch(punch);
    return { ok: true, punch };
  },
  punchesBetween(start, end) {
    const from = instant(start);
    const to = instant(end);
    const punches = db.prepare('SELECT * FROM punches').all().map(punchRow)
      .filter((punch) => instant(punch.recorded_at) >= from && instant(punch.recorded_at) < to);
    return { ok: true, punches };
  },
  justificationsBetween(start, end) {
    const from = instant(start);
    const to = instant(end);
    const justifications = db.prepare('SELECT * FROM justifications').all()
      .filter((item) => instant(item.starts_at) < to && instant(item.ends_at) >= from);
    return { ok: true, justifications };
  },
  async saveEmployee(input) {
    const name = (input.full_name || '').trim();
    if (name.length < 3) return { ok: false, error: 'Informe o nome da colaboradora.' };
    if (input.schedule_code !== 'A' && input.schedule_code !== 'B') return { ok: false, error: 'Escolha a jornada A ou B.' };
    if (!input.id && !pinShape(input.pin)) return { ok: false, error: 'Defina uma senha numérica de 4 a 6 dígitos.' };
    if (input.pin && !pinShape(input.pin)) return { ok: false, error: 'A senha precisa ter de 4 a 6 números.' };
    if (!input.id) {
      const hashed = await hashSecret(input.pin);
      db.prepare(`INSERT INTO employees
        (id, full_name, schedule_code, active, pin_hash, pin_salt, pin_kdf)
        VALUES (?, ?, ?, 1, ?, ?, ?)`).run(randomId(), name, input.schedule_code, hashed.hash, hashed.salt, hashed.kdf);
    } else {
      const employee = employeeRow(input.id);
      if (!employee) return { ok: false, error: 'Colaboradora não encontrada.' };
      db.prepare('UPDATE employees SET full_name = ?, schedule_code = ?, active = ? WHERE id = ?').run(name, input.schedule_code, input.active ? 1 : 0, input.id);
      if (input.pin) {
        const hashed = await hashSecret(input.pin);
        db.prepare('UPDATE employees SET pin_hash = ?, pin_salt = ?, pin_kdf = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
          .run(hashed.hash, hashed.salt, hashed.kdf, input.id);
      }
    }
    return { ok: true };
  },
  saveJustification(input) {
    if (!input.employee_id) return { ok: false, error: 'Escolha a colaboradora.' };
    if (!input.starts_on || !input.ends_on || input.ends_on < input.starts_on) return { ok: false, error: 'Informe o período do abono.' };
    db.prepare(`INSERT INTO justifications (id, employee_id, category, starts_at, ends_at, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      randomId(),
      input.employee_id,
      input.category,
      `${input.starts_on}T00:00:00-03:00`,
      `${input.ends_on}T23:59:00-03:00`,
      input.notes?.trim() || '',
      new Date().toISOString(),
    );
    return { ok: true };
  },
  deleteJustification(id) {
    db.prepare('DELETE FROM justifications WHERE id = ?').run(id);
    return { ok: true };
  },
  adjustPunch(input) {
    const reason = input.reason?.trim() || '';
    if (reason.length < 3) return { ok: false, error: 'Informe o motivo do ajuste.' };
    if (input.action === 'void') {
      const punch = db.prepare('SELECT * FROM punches WHERE id = ? AND voided_at IS NULL').get(input.punch_id);
      if (!punch) return { ok: false, error: 'Marcação não encontrada.' };
      const voidedAt = new Date().toISOString();
      db.prepare('UPDATE punches SET voided_at = ?, void_reason = ? WHERE id = ?').run(voidedAt, reason, punch.id);
      db.prepare('INSERT INTO corrections (id, action, punch_id, employee_id, reason, at) VALUES (?, ?, ?, ?, ?, ?)').run(randomId(), 'void', punch.id, punch.employee_id, reason, voidedAt);
      return { ok: true };
    }
    const recordedAt = wallToIso(input.day, input.time);
    if (!recordedAt) return { ok: false, error: 'Informe um horário válido.' };
    const employee = employeeRow(input.employee_id);
    if (!employee) return { ok: false, error: 'Colaboradora não encontrada.' };
    const dayPunches = db.prepare('SELECT * FROM punches WHERE employee_id = ? AND voided_at IS NULL').all(employee.id)
      .map(punchRow)
      .filter((punch) => dayKeyOf(punch.recorded_at) === input.day);
    if (input.action === 'retime') {
      const punch = dayPunches.find((item) => item.id === input.punch_id);
      if (!punch) return { ok: false, error: 'Marcação não encontrada.' };
      const preview = dayPunches.map((item) => (item.id === punch.id ? { ...item, recorded_at: recordedAt } : item));
      const orderError = punchOrderError(employee.schedule_code, input.day, preview);
      if (orderError) return { ok: false, error: orderError };
      db.prepare('UPDATE punches SET recorded_at = ? WHERE id = ?').run(recordedAt, punch.id);
      db.prepare('INSERT INTO corrections (id, action, punch_id, employee_id, reason, at) VALUES (?, ?, ?, ?, ?, ?)').run(randomId(), 'retime', punch.id, employee.id, reason, new Date().toISOString());
      return { ok: true };
    }
    const preview = [...dayPunches, { punch_type: input.punch_type, recorded_at: recordedAt }];
    const orderError = punchOrderError(employee.schedule_code, input.day, preview);
    if (orderError) return { ok: false, error: orderError };
    const id = randomId();
    insertPunch({
      id,
      employee_id: employee.id,
      punch_type: input.punch_type,
      recorded_at: recordedAt,
      source: 'ajuste',
      client_request_id: randomId(),
    });
    db.prepare('INSERT INTO corrections (id, action, punch_id, employee_id, reason, at) VALUES (?, ?, ?, ?, ?, ?)').run(randomId(), 'insert', id, employee.id, reason, new Date().toISOString());
    return { ok: true };
  },
  exportBackup() {
    return {
      employees: db.prepare('SELECT id, full_name, schedule_code, active, pin_hash, pin_salt, pin_kdf, photo_url FROM employees').all(),
      punches: db.prepare('SELECT * FROM punches').all(),
      justifications: db.prepare('SELECT * FROM justifications').all(),
      corrections: db.prepare('SELECT * FROM corrections').all(),
      admin: db.prepare('SELECT hash, salt, kdf FROM admin WHERE id = 1').get() || null,
    };
  },
  restoreBackup(data) {
    if (!Array.isArray(data.employees) || !Array.isArray(data.punches)) {
      return { ok: false, error: 'Esse arquivo não é um backup do Ponto Fácil.' };
    }
    const currentAdmin = db.prepare('SELECT hash, salt, kdf FROM admin WHERE id = 1').get();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM corrections; DELETE FROM justifications; DELETE FROM punches; DELETE FROM employees; DELETE FROM sessions; DELETE FROM admin;');
      for (const employee of data.employees) {
        db.prepare(`INSERT INTO employees (id, full_name, schedule_code, active, pin_hash, pin_salt, pin_kdf, photo_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          employee.id,
          employee.full_name,
          employee.schedule_code,
          employee.active ? 1 : 0,
          employee.pin_hash,
          employee.pin_salt,
          employee.pin_kdf || 'sha256',
          employee.photo_url || null,
        );
      }
      for (const punch of data.punches) insertPunch(punch);
      for (const item of data.justifications || []) {
        db.prepare(`INSERT INTO justifications (id, employee_id, category, starts_at, ends_at, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(item.id, item.employee_id, item.category, item.starts_at, item.ends_at, item.notes || '', item.created_at || new Date().toISOString());
      }
      for (const item of data.corrections || []) {
        db.prepare('INSERT INTO corrections (id, action, punch_id, employee_id, reason, at) VALUES (?, ?, ?, ?, ?, ?)').run(item.id, item.action, item.punch_id || null, item.employee_id || null, item.reason || '', item.at);
      }
      const admin = data.admin || currentAdmin;
      if (admin?.hash && admin?.salt) {
        db.prepare('INSERT INTO admin (id, hash, salt, kdf) VALUES (1, ?, ?, ?)').run(admin.hash, admin.salt, admin.kdf || 'sha256');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'Não foi possível restaurar o backup.' };
    }
    return { ok: true };
  },
  importLegacy(data) {
    if (!data || !Array.isArray(data.employees) || !Array.isArray(data.punches)) return { ok: true, skipped: true };
    const insertEmployee = db.prepare(`INSERT OR IGNORE INTO employees
      (id, full_name, schedule_code, active, pin_hash, pin_salt, pin_kdf, photo_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const employee of data.employees) {
      if (!employee?.id || !employee.pin_hash || !employee.pin_salt) continue;
      insertEmployee.run(employee.id, employee.full_name, employee.schedule_code || 'A', employee.active === false ? 0 : 1, employee.pin_hash, employee.pin_salt, employee.pin_kdf || 'pbkdf2', employee.photo_url || null);
    }
    for (const punch of data.punches) {
      if (!punch?.employee_id || !punch.punch_type || !punch.recorded_at) continue;
      insertPunch({ ...punch, id: punch.id || randomId(), client_request_id: punch.client_request_id || punch.id || randomId() });
    }
    const insertJustification = db.prepare(`INSERT OR IGNORE INTO justifications
      (id, employee_id, category, starts_at, ends_at, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const item of data.justifications || []) {
      if (!item?.id) continue;
      insertJustification.run(item.id, item.employee_id, item.category, item.starts_at, item.ends_at, item.notes || '', item.created_at || new Date().toISOString());
    }
    if (!this.adminConfigured() && data.admin?.hash && data.admin?.salt) {
      db.prepare('INSERT INTO admin (id, hash, salt, kdf) VALUES (1, ?, ?, ?)').run(data.admin.hash, data.admin.salt, data.admin.kdf || 'pbkdf2');
    }
    return { ok: true };
  },
};
