import { createClient } from '@supabase/supabase-js';
import { saoPauloParts, wallToIso } from './time.js';
import { sqliteApi } from './sqlite-api.js';

export function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function configured(url, key) {
  if (!url || !key) return false;
  const placeholders = ['SEU-PROJETO', 'COLE_SUA_CHAVE', 'SUA_CHAVE'];
  if (placeholders.some((item) => url.includes(item) || key.includes(item))) return false;
  return url.startsWith('https://') && key.length >= 20;
}

export const remote = configured(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
const repApiUrl = (import.meta.env.VITE_REP_API_URL || '').replace(/\/+$/, '');
export const supabase = remote ? createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY) : null;

function messageFrom(error, fallback) {
  const raw = error?.message || '';
  if (!raw || /fetch|network|Failed to fetch|JWT|schema cache/i.test(raw)) return fallback;
  return raw.replace(/^P0001:\s*/, '');
}

async function remoteStaff() {
  const { data, error } = await supabase.from('employees').select('id,full_name,schedule_code,active,photo_url').order('full_name');
  if (error) return { ok: false, error: messageFrom(error, 'Não foi possível carregar a equipe.'), employees: [] };
  return { ok: true, employees: data || [] };
}

const remoteApi = {
  mode: 'remote',
  adminConfigured() { return true; },
  async refreshStatus() { return { ok: true, adminConfigured: true }; },
  async isAdminUnlocked() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return false;
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', data.session.user.id).maybeSingle();
    return profile?.role === 'admin';
  },
  async setupAdmin() {
    return { ok: false, error: 'Crie o administrador no Supabase, como explica o README.' };
  },
  async adminLogin({ email, password }) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error: 'Não foi possível entrar. Confira e-mail e senha.' };
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
    if (profile?.role !== 'admin') {
      await supabase.auth.signOut();
      return { ok: false, error: 'Esta conta não possui permissão de administrador.' };
    }
    return { ok: true };
  },
  async adminLogout() {
    await supabase.auth.signOut();
  },
  async listActiveEmployees() {
    const { data, error } = await supabase.rpc('list_active_employees');
    if (error) return { ok: false, error: 'Não foi possível carregar as colaboradoras. Confira o banco de dados.', employees: [] };
    return { ok: true, employees: data || [] };
  },
  listStaff: remoteStaff,
  async verifyPin(employeeId, pin) {
    const { error } = await supabase.rpc('verify_employee_pin', { employee_uuid: employeeId, submitted_pin: pin });
    if (error) return { ok: false, error: messageFrom(error, 'Senha inválida ou acesso indisponível.') };
    return { ok: true };
  },
  async todayPunches(employeeId, pin) {
    const { data, error } = await supabase.rpc('list_employee_punches', {
      employee_uuid: employeeId,
      submitted_pin: pin,
      p_day: saoPauloParts().dayKey,
    });
    if (error) return { ok: false, error: messageFrom(error, 'Não foi possível carregar as marcações de hoje.') };

    if (!repApiUrl) return { ok: true, punches: data || [] };

    try {
      const response = await fetch(`${repApiUrl}/api/rep-p/today`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ employeeId, pin, day: saoPauloParts().dayKey }),
      });
      const result = await response.json();
      if (!response.ok || !result?.ok) {
        return { ok: false, error: result?.error || 'Não foi possível carregar as marcações REP-P.' };
      }
      return { ok: true, punches: [...(data || []), ...(result.punches || [])]
        .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)) };
    } catch {
      return { ok: false, error: 'Servidor REP-P indisponível. Não foi possível consultar as marcações.' };
    }
  },
  async registerPunch(employeeId, pin, type, requestId) {
    if (repApiUrl) {
      try {
        const response = await fetch(`${repApiUrl}/api/rep-p/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ employeeId, pin, type, requestId }),
        });
        const result = await response.json();
        if (!response.ok || !result?.ok) {
          return { ok: false, error: result?.error || 'Não foi possível registrar a marcação.' };
        }
        return result;
      } catch {
        return { ok: false, error: 'Servidor de registro indisponível. A marcação não foi registrada.' };
      }
    }

    const { data, error } = await supabase.rpc('register_punch', {
      employee_uuid: employeeId,
      submitted_pin: pin,
      requested_type: type,
      client_request_id: requestId,
    });
    if (error) return { ok: false, error: messageFrom(error, 'Não foi possível registrar.') };
    return { ok: true, punch: data };
  },
  async punchesBetween(start, end) {
    const { data, error } = await supabase.from('punches').select('id,employee_id,punch_type,recorded_at,source,voided_at,void_reason').gte('recorded_at', start).lt('recorded_at', end).order('recorded_at');
    if (error) return { ok: false, error: messageFrom(error, 'Não foi possível carregar os registros.'), punches: [] };

    if (!repApiUrl) return { ok: true, punches: data || [] };

    const { data: repMarks, error: repError } = await supabase
      .from('time_marks')
      .select('id,employee_id,punch_type,recorded_at,source,nsr')
      .gte('recorded_at', start)
      .lt('recorded_at', end)
      .order('recorded_at');
    if (repError) {
      return { ok: false, error: messageFrom(repError, 'Não foi possível carregar as marcações REP-P.'), punches: [] };
    }

    const combined = [
      ...(data || []),
      ...(repMarks || []).map((mark) => ({ ...mark, voided_at: null, void_reason: null })),
    ].sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
    return { ok: true, punches: combined };
  },
  async justificationsBetween(start, end) {
    const { data, error } = await supabase.from('justifications').select('id,employee_id,category,starts_at,ends_at,notes').lte('starts_at', end).gte('ends_at', start);
    if (error) return { ok: false, error: messageFrom(error, 'Não foi possível carregar os abonos.'), justifications: [] };
    return { ok: true, justifications: data || [] };
  },
  async saveEmployee(input) {
    const { error } = await supabase.rpc('admin_save_employee', {
      p_id: input.id || null,
      p_name: input.full_name.trim(),
      p_schedule: input.schedule_code,
      p_pin: input.pin || null,
      p_active: input.active !== false,
    });
    if (error) return { ok: false, error: messageFrom(error, 'Não foi possível salvar a colaboradora.') };
    return { ok: true };
  },
  async saveJustification(input) {
    if (!input.employee_id || !input.starts_on || !input.ends_on || input.ends_on < input.starts_on) {
      return { ok: false, error: 'Informe a colaboradora e o período do abono.' };
    }
    const { data: session } = await supabase.auth.getSession();
    const { error } = await supabase.from('justifications').insert({
      employee_id: input.employee_id,
      category: input.category,
      starts_at: `${input.starts_on}T00:00:00-03:00`,
      ends_at: `${input.ends_on}T23:59:00-03:00`,
      notes: input.notes?.trim() || '',
      created_by: session.session?.user?.id || null,
    });
    if (error) return { ok: false, error: messageFrom(error, 'Não foi possível salvar o abono.') };
    return { ok: true };
  },
  async deleteJustification(id) {
    const { error } = await supabase.from('justifications').delete().eq('id', id);
    if (error) return { ok: false, error: messageFrom(error, 'Não foi possível remover o abono.') };
    return { ok: true };
  },
  async adjustPunch(input) {
    const recordedAt = input.action === 'void' ? null : wallToIso(input.day, input.time);
    const { error } = await supabase.rpc('admin_adjust_punch', {
      p_action: input.action,
      p_punch_id: input.punch_id || null,
      p_employee_id: input.employee_id || null,
      p_type: input.punch_type || null,
      p_recorded_at: recordedAt,
      p_reason: input.reason?.trim() || '',
    });
    if (error) return { ok: false, error: messageFrom(error, 'Não foi possível ajustar a marcação.') };
    return { ok: true };
  },
  async exportBackup() { return ''; },
  restoreBackup() { return { ok: false, error: 'No modo online o backup fica no Supabase.' }; },
};

export const api = remote ? remoteApi : sqliteApi;
