import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const collectorId = process.env.REP_COLLECTOR_ID || '';
const configured = /^https:\/\//.test(supabaseUrl)
  && serviceRoleKey.length >= 20
  && collectorId.trim().length >= 3;

const supabase = configured
  ? createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  : null;

const allowedTypes = new Set(['entrada', 'saida_intervalo', 'retorno_intervalo', 'saida']);

export async function registerRepPunch(input) {
  if (!configured || !supabase) {
    return { ok: false, error: 'Registro REP-P indisponível: configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e REP_COLLECTOR_ID no servidor.' };
  }

  const employeeId = String(input?.employeeId || '');
  const pin = String(input?.pin || '');
  const type = String(input?.type || '');
  const requestId = String(input?.requestId || '');

  if (!employeeId || !/^\d{4,6}$/.test(pin) || !allowedTypes.has(type)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return { ok: false, error: 'Dados da marcação inválidos.' };
  }

  const { data, error } = await supabase.rpc('register_time_mark', {
    p_employee_id: employeeId,
    p_submitted_pin: pin,
    p_punch_type: type,
    p_client_request_id: requestId,
    p_collector_id: collectorId.trim(),
  });

  if (error) {
    const message = error.message || '';
    if (/senha inválida|muitas tentativas|funcionário|funcionario|marcação|marcacao|estabelecimento|próxima marcação|proxima marcacao|já foram realizadas/i.test(message)) {
      return { ok: false, error: message.replace(/^P0001:\s*/, '') };
    }
    console.error('Falha no registro REP-P:', error.code || 'sem código');
    return { ok: false, error: 'Não foi possível registrar a marcação. Tente novamente.' };
  }

  if (data?.ok === false) {
    return { ok: false, error: data.error || 'Não foi possível validar a senha.' };
  }

  const mark = data?.punch || (Array.isArray(data) ? data[0] : data);
  if (!mark?.id || !mark?.nsr || !mark?.recorded_at) {
    return { ok: false, error: 'O servidor não retornou a confirmação da marcação.' };
  }

  return {
    ok: true,
    punch: {
      id: mark.id,
      employee_id: mark.employee_id,
      punch_type: mark.punch_type,
      recorded_at: mark.recorded_at,
      source: mark.source,
      nsr: mark.nsr,
    },
  };
}
