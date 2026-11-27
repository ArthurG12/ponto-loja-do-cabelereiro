import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const collectorId = process.env.REP_COLLECTOR_ID || '';
const collectorType = process.env.REP_COLLECTOR_TYPE || '';
const establishmentId = process.env.REP_ESTABLISHMENT_ID || '';
const establishmentIdIsValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(establishmentId);
const configured = /^https:\/\//.test(supabaseUrl)
  && serviceRoleKey.length >= 20
  && collectorId.trim().length >= 3
  && ['01', '02', '03', '04', '05'].includes(collectorType)
  && establishmentIdIsValid;

const supabase = configured
  ? createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  : null;

const allowedTypes = new Set(['entrada', 'saida_intervalo', 'retorno_intervalo', 'saida']);

export async function registerRepPunch(input) {
  if (!configured || !supabase) {
    return { ok: false, error: 'Registro REP-P indisponível: configure SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REP_COLLECTOR_ID, REP_COLLECTOR_TYPE e REP_ESTABLISHMENT_ID no servidor.' };
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
    p_collector_type: collectorType,
  });

  if (error) {
    const message = error.message || '';
    if (/senha inválida|muitas tentativas|funcionário|funcionario|marcação|marcacao|estabelecimento|CPF|cpf|próxima marcação|proxima marcacao|já foram realizadas/i.test(message)) {
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


export async function listRepPunchesToday(input) {
  if (!configured || !supabase) {
    return { ok: false, error: 'Consulta REP-P indisponível: configure o backend.' };
  }

  const employeeId = String(input?.employeeId || '');
  const pin = String(input?.pin || '');
  const day = String(input?.day || '');

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(employeeId)
    || !/^\d{4,6}$/.test(pin)
    || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, error: 'Dados para consulta inválidos.', punches: [] };
  }

  const { data, error } = await supabase.rpc('list_employee_time_marks', {
    p_employee_id: employeeId,
    p_submitted_pin: pin,
    p_day: day,
  });

  if (error) {
    console.error('Falha na consulta REP-P:', error.code || 'sem código');
    return { ok: false, error: 'Não foi possível carregar as marcações de hoje.', punches: [] };
  }

  if (data?.ok === false) {
    return { ok: false, error: data.error || 'Senha inválida.', punches: [] };
  }

  // Preserva a leitura de marcações históricas legadas, mas somente pelo
  // backend confiável. O navegador não recebe mais acesso direto a esta RPC.
  const { data: legacyData, error: legacyError } = await supabase.rpc('list_employee_punches', {
    employee_uuid: employeeId,
    submitted_pin: pin,
    p_day: day,
  });
  if (legacyError) {
    console.error('Falha na consulta do histórico legado:', legacyError.code || 'sem código');
    return { ok: false, error: 'Não foi possível carregar o histórico de hoje.', punches: [] };
  }

  const legacyPunches = (legacyData || []).map((punch) => ({
    id: punch.id,
    employee_id: punch.employee_id,
    punch_type: punch.punch_type,
    recorded_at: punch.recorded_at,
    source: punch.source,
  }));
  const repPunches = (data?.punches || []).map((mark) => ({
    id: mark.id,
    employee_id: mark.employee_id,
    punch_type: mark.punch_type,
    recorded_at: mark.recorded_at,
    source: mark.source,
    nsr: mark.nsr,
  }));

  return {
    ok: true,
    punches: [...legacyPunches, ...repPunches]
      .sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)),
  };
}

export async function listActiveRepEmployees() {
  if (!configured || !supabase) {
    return { ok: false, error: 'Consulta da equipe indisponível: configure o backend.', employees: [] };
  }

  const { data, error } = await supabase
    .from('employees')
    .select('id,full_name,photo_url,schedule_code')
    .eq('active', true)
    .order('full_name');

  if (error) {
    console.error('Falha ao carregar equipe REP-P:', error.code || 'sem código');
    return { ok: false, error: 'Não foi possível carregar a equipe.', employees: [] };
  }

  return { ok: true, employees: data || [] };
}

export async function recordRepServiceEvent(eventCode) {
  if (!configured || !supabase) {
    return { ok: false, error: 'Registro de disponibilidade REP-P indisponível: configure o backend e REP_ESTABLISHMENT_ID.' };
  }
  if (!['07', '08'].includes(eventCode)) {
    return { ok: false, error: 'Código de transição de serviço inválido.' };
  }
  const { data, error } = await supabase.rpc('record_rep_service_event', {
    p_establishment_id: establishmentId,
    p_event_code: eventCode,
  });
  if (error) {
    console.error('Falha ao registrar evento de disponibilidade REP-P:', error.code || 'sem código');
    return { ok: false, error: 'Não foi possível registrar o evento de disponibilidade.' };
  }
  return data?.ok === true ? data : { ok: false, error: 'O banco não confirmou o evento de disponibilidade.' };
}
