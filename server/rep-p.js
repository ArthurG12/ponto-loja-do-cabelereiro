import { createClient } from '@supabase/supabase-js';
import { buildAfdV004, candidateType7Hash } from './afd-v004.js';

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
  try {
    const { data, error } = await supabase.rpc('record_rep_service_event', {
      p_establishment_id: establishmentId,
      p_event_code: eventCode,
    });
    if (error) {
      console.error('Falha ao registrar evento de disponibilidade REP-P:', error.code || 'sem código');
      return { ok: false, error: 'Não foi possível registrar o evento de disponibilidade.' };
    }
    return data?.ok === true ? data : { ok: false, error: 'O banco não confirmou o evento de disponibilidade.' };
  } catch {
    console.error('Falha de conexão ao registrar evento de disponibilidade REP-P.');
    return { ok: false, error: 'Não foi possível registrar o evento de disponibilidade.' };
  }
}


const AFD_V004_HASH_VERSION = 'afd-v004-fixed-concat-candidate-v1';
const authAnonKey = process.env.SUPABASE_ANON_KEY || '';

export async function authenticateRepAdmin(accessToken) {
  if (!configured || !supabase || !authAnonKey || !accessToken) {
    return { ok: false, unavailable: !configured || !supabase || !authAnonKey };
  }
  try {
    const authClient = createClient(supabaseUrl, authAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser(accessToken);
    if (authError || !user?.id) return { ok: false };
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profileError) {
      console.error('Falha ao verificar perfil administrativo REP-P:', profileError.code || 'sem código');
      return { ok: false, unavailable: true };
    }
    return profile?.role === 'admin'
      ? { ok: true, userId: user.id }
      : { ok: false };
  } catch {
    return { ok: false, unavailable: true };
  }
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function localMidnightUtc(dateText, timezone) {
  const [year, month, day] = dateText.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    const correction = target - represented;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

export async function prepareRepAfdExport({ startDate, endDate }) {
  if (!configured || !supabase) throw new Error('Serviço REP-P não configurado.');
  if (!validIsoDate(startDate) || !validIsoDate(endDate) || startDate > endDate) {
    const error = new Error('Período AFD inválido.');
    error.statusCode = 400;
    throw error;
  }
  const firstDay = new Date(`${startDate}T00:00:00.000Z`);
  const lastDay = new Date(`${endDate}T00:00:00.000Z`);
  const dayCount = Math.round((lastDay - firstDay) / 86400000) + 1;
  if (dayCount > 31) {
    const error = new Error('O período máximo de exportação é de 31 dias.');
    error.statusCode = 400;
    throw error;
  }

  const { data: establishment, error: establishmentError } = await supabase
    .from('establishments')
    .select('id,timezone,active,employer_id_type,employer_document,cno_caepf,legal_name,service_location')
    .eq('id', establishmentId)
    .maybeSingle();
  if (establishmentError || !establishment?.active) {
    throw new Error('Estabelecimento REP-P não encontrado ou inativo.');
  }

  let timezone = establishment.timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('Fuso horário do estabelecimento inválido.');
  }
  const rangeStart = localMidnightUtc(startDate, timezone);
  const nextDay = new Date(lastDay.getTime() + 86400000).toISOString().slice(0, 10);
  const rangeEnd = localMidnightUtc(nextDay, timezone);

  const allRecords = [];
  let ledgerOffset = 0;
  while (true) {
    const { data: page, error: ledgerError } = await supabase
      .from('rep_ledger')
      .select('establishment_id,nsr,record_type,source_table,source_id,occurred_at,record_payload,hash_version,record_hash')
      .eq('establishment_id', establishmentId)
      .order('nsr', { ascending: true })
      .range(ledgerOffset, ledgerOffset + 999);
    if (ledgerError) {
      console.error('Falha ao consultar livro AFD:', ledgerError.code || 'sem código');
      throw new Error('Não foi possível consultar o livro AFD.');
    }
    allRecords.push(...(page || []));
    if (allRecords.length > 100000) {
      throw new Error('Histórico excede o limite seguro de validação. Exportação bloqueada.');
    }
    if (!page || page.length < 1000) break;
    ledgerOffset += 1000;
  }

  let previousType7Hash = '';
  const type7HashesByNsr = new Map();
  for (const record of allRecords || []) {
    if (String(record.record_type) !== '7') continue;
    if (record.hash_version !== AFD_V004_HASH_VERSION) {
      throw new Error('Histórico contém hash legado ou não validado; exportação AFD bloqueada.');
    }
    const payload = record.record_payload || {};
    const expected = candidateType7Hash({
      nsr: record.nsr,
      markedAt: payload.recorded_at,
      cpf: payload.employee_cpf_snapshot,
      recordedAt: payload.recorded_on || payload.created_at,
      collectorType: payload.collector_type,
      isOffline: payload.is_offline,
      previousHash: previousType7Hash || null,
      timezone: payload.timezone || timezone,
    });
    if (record.record_hash !== expected) {
      throw new Error('Cadeia SHA-256 do histórico diverge; exportação AFD bloqueada.');
    }
    previousType7Hash = record.record_hash;
    type7HashesByNsr.set(Number(record.nsr), record.record_hash);
  }

  const selected = allRecords.filter((record) => {
    const timestamp = new Date(record.occurred_at).getTime();
    return Number.isFinite(timestamp) && timestamp >= rangeStart.getTime() && timestamp < rangeEnd.getTime();
  });
  const firstIncludedType7 = selected
    .filter((record) => String(record.record_type) === '7')
    .reduce((minimum, record) => Math.min(minimum, Number(record.nsr)), Infinity);
  let initialPreviousType7Hash = null;
  if (Number.isFinite(firstIncludedType7)) {
    const previous = [...type7HashesByNsr.keys()].filter((nsr) => nsr < firstIncludedType7).sort((a, b) => b - a)[0];
    initialPreviousType7Hash = previous == null ? null : type7HashesByNsr.get(previous);
  }

  const inpi = process.env.REP_INPI_REGISTRATION || '';
  const developerType = process.env.REP_DEVELOPER_ID_TYPE || '';
  const developerDocument = process.env.REP_DEVELOPER_DOCUMENT || '';
  const header = {
    employer_id_type: establishment.employer_id_type,
    employer_document: establishment.employer_document,
    cno_caepf: establishment.cno_caepf,
    legal_name: establishment.legal_name,
    inpi_registration: inpi,
    start_date: startDate,
    end_date: endDate,
    generated_at: new Date().toISOString(),
    timezone,
    developer_id_type: developerType,
    developer_document: developerDocument,
  };

  const output = buildAfdV004({
    header,
    records: selected,
    initialPreviousType7Hash,
  });
  return {
    buffer: output,
    recordCount: selected.length,
    startDate,
    endDate,
    timezone,
    establishmentId,
  };
}
