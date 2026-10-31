export const PUNCH_LABELS = {
  entrada: 'Entrada',
  saida_intervalo: 'Saída para almoço',
  retorno_intervalo: 'Retorno do almoço',
  saida: 'Saída final',
};

export const EXCUSE_LABELS = {
  atestado: 'Atestado',
  folga: 'Folga',
  outro: 'Abono',
};

export const SCHEDULE_INFO = {
  A: {
    label: 'Jornada A',
    detail: 'Segunda a sexta, 08:00–12:00 e 13:00–17:00. Sábado, 08:00–12:00.',
  },
  B: {
    label: 'Jornada B',
    detail: 'Segunda a sexta, 09:00–13:00 e 14:00–18:00. Sábado, 09:00–13:00.',
  },
};

const WEEKDAY_BLOCKS = {
  A: [
    [],
    [['08:00', '12:00'], ['13:00', '17:00']],
    [['08:00', '12:00'], ['13:00', '17:00']],
    [['08:00', '12:00'], ['13:00', '17:00']],
    [['08:00', '12:00'], ['13:00', '17:00']],
    [['08:00', '12:00'], ['13:00', '17:00']],
    [['08:00', '12:00']],
  ],
  B: [
    [],
    [['09:00', '13:00'], ['14:00', '18:00']],
    [['09:00', '13:00'], ['14:00', '18:00']],
    [['09:00', '13:00'], ['14:00', '18:00']],
    [['09:00', '13:00'], ['14:00', '18:00']],
    [['09:00', '13:00'], ['14:00', '18:00']],
    [['09:00', '13:00']],
  ],
};

export function saoPauloParts(date = new Date()) {
  const bag = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const minute = Number(bag.minute);
  return {
    year: bag.year,
    month: bag.month,
    day: bag.day,
    hour,
    minute,
    dayKey: `${bag.year}-${bag.month}-${bag.day}`,
    minutes: hour * 60 + minute,
  };
}

export function currentMonth(date = new Date()) {
  return saoPauloParts(date).dayKey.slice(0, 7);
}

export function todayKey(date = new Date()) {
  return saoPauloParts(date).dayKey;
}

export function monthDays(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const days = [];
  for (let day = 1; day <= count; day += 1) {
    days.push(`${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return days;
}

export function weekdayIndex(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function weekdayName(dayKey) {
  return ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][weekdayIndex(dayKey)];
}

export function fmtDayKey(dayKey) {
  const [, month, day] = dayKey.split('-');
  return `${day}/${month}`;
}

export function fmtDate(date) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(date);
}

export function fmtTime(date) {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}

export function fmtHours(mins) {
  if (mins == null || Number.isNaN(mins)) return '—';
  const sign = mins < 0 ? '−' : '';
  const abs = Math.abs(Math.round(mins));
  return `${sign}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}min`;
}

function fmtSpan(mins) {
  if (mins < 60) return `${mins} min`;
  return fmtHours(mins);
}

export function fmtClock(mins) {
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function monthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const nextYear = monthNumber === 12 ? year + 1 : year;
  return {
    start: `${month}-01T00:00:00-03:00`,
    end: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00-03:00`,
  };
}

export function dayRange(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const endKey = next.toISOString().slice(0, 10);
  return { start: `${dayKey}T00:00:00-03:00`, end: `${endKey}T00:00:00-03:00` };
}

export function wallToIso(dayKey, hhmm) {
  if (!/^(\d{2}):(\d{2})$/.test(hhmm || '')) return null;
  return `${dayKey}T${hhmm}:00-03:00`;
}

export function dayKeyOf(iso) {
  return saoPauloParts(new Date(iso)).dayKey;
}

export function instant(iso) {
  return new Date(iso).getTime();
}

export function minutesOf(iso) {
  return saoPauloParts(new Date(iso)).minutes;
}

function blocksFor(schedule, dayKey) {
  const table = WEEKDAY_BLOCKS[schedule === 'B' ? 'B' : 'A'];
  return table[weekdayIndex(dayKey)] || [];
}

function parseHHMM(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function expectedMinutes(schedule, dayKey) {
  return blocksFor(schedule, dayKey).reduce((sum, [start, end]) => sum + (parseHHMM(end) - parseHHMM(start)), 0);
}

export function shiftStart(schedule, dayKey) {
  const blocks = blocksFor(schedule, dayKey);
  if (!blocks.length) return null;
  return parseHHMM(blocks[0][0]);
}

export function shiftEnd(schedule, dayKey) {
  const blocks = blocksFor(schedule, dayKey);
  if (!blocks.length) return null;
  return parseHHMM(blocks[blocks.length - 1][1]);
}

export function sequenceFor(schedule, dayKey) {
  if (blocksFor(schedule, dayKey).length >= 2) {
    return ['entrada', 'saida_intervalo', 'retorno_intervalo', 'saida'];
  }
  return ['entrada', 'saida'];
}

export function activePunches(punches) {
  return (punches || []).filter((punch) => !punch.voided_at);
}

export function nextType(schedule, dayKey, punches) {
  const sequence = sequenceFor(schedule, dayKey);
  const active = activePunches(punches);
  if (!active.length) return sequence[0];
  const last = [...active].sort((a, b) => instant(a.recorded_at) - instant(b.recorded_at)).at(-1);
  const index = sequence.indexOf(last.punch_type);
  if (index === -1 || index === sequence.length - 1) return null;
  return sequence[index + 1];
}

export function workedMinutes(punches) {
  const by = {};
  for (const punch of activePunches(punches)) by[punch.punch_type] = punch;
  if (by.entrada && by.saida_intervalo) {
    const morning = Math.max(0, minutesOf(by.saida_intervalo.recorded_at) - minutesOf(by.entrada.recorded_at));
    const afternoon = by.retorno_intervalo && by.saida
      ? Math.max(0, minutesOf(by.saida.recorded_at) - minutesOf(by.retorno_intervalo.recorded_at))
      : 0;
    return morning + afternoon;
  }
  if (by.entrada && by.saida) {
    return Math.max(0, minutesOf(by.saida.recorded_at) - minutesOf(by.entrada.recorded_at));
  }
  return 0;
}

export function coversDay(justification, dayKey) {
  return dayKey >= dayKeyOf(justification.starts_at) && dayKey <= dayKeyOf(justification.ends_at);
}

export function computeDay(schedule, dayKey, dayPunches, excuse, today) {
  const punches = activePunches(dayPunches);
  if (!punches.length && !excuse && expectedMinutes(schedule, dayKey) === 0) return null;
  const by = {};
  for (const punch of punches) by[punch.punch_type] = punch;
  const sequence = sequenceFor(schedule, dayKey);
  const complete = sequence.every((type) => by[type]);
  const worked = workedMinutes(punches);
  const start = shiftStart(schedule, dayKey);
  const late = by.entrada && start != null ? Math.max(0, minutesOf(by.entrada.recorded_at) - start) : 0;
  const expected = excuse ? 0 : expectedMinutes(schedule, dayKey);
  let balance = null;
  let incomplete = false;
  let missing = false;
  let open = false;
  if (!punches.length && !excuse && dayKey >= today) return null;
  if (excuse && !punches.length) balance = 0;
  else if (complete) balance = worked - expected;
  else if (dayKey === today) open = true;
  else if (!punches.length) missing = true;
  else incomplete = true;
  return {
    dayKey,
    expected,
    worked,
    late,
    complete,
    incomplete,
    missing,
    open,
    excused: Boolean(excuse),
    excuseLabel: excuse ? (EXCUSE_LABELS[excuse.category] || excuse.category) : '',
    balance,
    by,
    sequence,
  };
}

export function apurate(employee, punches, justifications, month, today) {
  const rows = [];
  for (const dayKey of monthDays(month)) {
    const mine = punches.filter((punch) => punch.employee_id === employee.id && !punch.voided_at && dayKeyOf(punch.recorded_at) === dayKey);
    const excuse = justifications.find((item) => item.employee_id === employee.id && coversDay(item, dayKey));
    const row = computeDay(employee.schedule_code, dayKey, mine, excuse, today);
    if (row) rows.push(row);
  }
  const totals = {
    expected: 0, worked: 0, balance: 0, overtime: 0, deficit: 0, lateDays: 0, lateMinutes: 0, incomplete: 0, missing: 0,
  };
  for (const row of rows) {
    if (row.late > 0) {
      totals.lateDays += 1;
      totals.lateMinutes += row.late;
    }
    if (row.incomplete) totals.incomplete += 1;
    if (row.missing) totals.missing += 1;
    if (row.balance == null) continue;
    totals.expected += row.expected;
    totals.worked += row.worked;
    totals.balance += row.balance;
    totals.overtime += Math.max(0, row.balance);
    totals.deficit += Math.min(0, row.balance);
  }
  return { rows, totals };
}

export function describePresence(employee, punches, now = new Date()) {
  const parts = saoPauloParts(now);
  const dayPunches = (punches || []).filter((punch) => punch.employee_id === employee.id && !punch.voided_at && dayKeyOf(punch.recorded_at) === parts.dayKey);
  const next = nextType(employee.schedule_code, parts.dayKey, dayPunches);
  const start = shiftStart(employee.schedule_code, parts.dayKey);
  const end = shiftEnd(employee.schedule_code, parts.dayKey);
  const by = {};
  for (const punch of dayPunches) by[punch.punch_type] = punch;

  if (!dayPunches.length) {
    if (start == null) return { key: 'off', label: 'Folga', detail: 'Sem jornada neste dia' };
    if (parts.minutes > start) {
      return { key: 'late', label: 'Atraso', detail: `${fmtSpan(parts.minutes - start)} além das ${fmtClock(start)}` };
    }
    return { key: 'waiting', label: 'Não chegou', detail: `Previsto às ${fmtClock(start)}` };
  }

  if (!next) {
    const leave = by.saida ? minutesOf(by.saida.recorded_at) : null;
    const extra = end != null && leave != null ? leave - end : 0;
    if (extra > 0) return { key: 'extra', label: 'Já saiu', detail: `Ficou ${fmtSpan(extra)} além da jornada` };
    const late = by.entrada && start != null ? minutesOf(by.entrada.recorded_at) - start : 0;
    if (late > 0) return { key: 'done', label: 'Já saiu', detail: `Chegou ${fmtSpan(late)} depois das ${fmtClock(start)}` };
    return { key: 'done', label: 'Já saiu', detail: `Trabalhado ${fmtHours(workedMinutes(dayPunches))}` };
  }

  if (next === 'retorno_intervalo') {
    return { key: 'lunch', label: 'No almoço', detail: by.saida_intervalo ? `Saiu às ${fmtTime(new Date(by.saida_intervalo.recorded_at))}` : '' };
  }
  const late = by.entrada && start != null ? minutesOf(by.entrada.recorded_at) - start : 0;
  if (late > 0) return { key: 'working', label: 'Em expediente', detail: `Chegou ${fmtSpan(late)} depois das ${fmtClock(start)}` };
  return { key: 'working', label: 'Em expediente', detail: by.entrada ? `Entrada às ${fmtTime(new Date(by.entrada.recorded_at))}` : '' };
}

export function punchOrderError(schedule, dayKey, punches) {
  const sequence = sequenceFor(schedule, dayKey);
  const active = activePunches(punches);
  const seen = new Set();
  for (const punch of active) {
    if (!sequence.includes(punch.punch_type)) return 'Esse tipo de marcação não faz parte da jornada deste dia.';
    if (seen.has(punch.punch_type)) return 'Já existe essa marcação neste dia.';
    if (dayKeyOf(punch.recorded_at) !== dayKey) return 'O horário precisa cair no dia escolhido.';
    seen.add(punch.punch_type);
  }
  const ordered = [...active].sort((a, b) => instant(a.recorded_at) - instant(b.recorded_at));
  let lastIndex = -1;
  for (const punch of ordered) {
    const index = sequence.indexOf(punch.punch_type);
    if (index < lastIndex) return 'Os horários precisam seguir a ordem da jornada.';
    lastIndex = index;
  }
  return '';
}
