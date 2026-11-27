import { createHash } from 'node:crypto';

const SIGNATURE_MARKER = 'ASSINATURA_DIGITAL_EM_ARQUIVO_P7S';
const RECORD_TYPES = new Set(['2', '4', '5', '6', '7']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function textField(value, width, label, { required = false } = {}) {
  const valueText = value == null ? '' : String(value);
  assert(!required || valueText.trim().length > 0, `${label} obrigatório no AFD.`);
  assert(!/[\r\n]/.test(valueText), `${label} não pode conter quebra de linha.`);
  assert([...valueText].every((char) => char.codePointAt(0) <= 255), `${label} contém caractere fora de ISO-8859-1.`);
  assert(Buffer.byteLength(valueText, 'latin1') <= width, `${label} excede ${width} posições.`);
  return valueText.padEnd(width, ' ');
}

function numericField(value, width, label, { required = false, pad = '0' } = {}) {
  const valueText = value == null ? '' : String(value);
  assert(!required || valueText.length > 0, `${label} obrigatório no AFD.`);
  assert(/^\d*$/.test(valueText), `${label} deve conter apenas dígitos.`);
  assert(valueText.length <= width, `${label} excede ${width} posições.`);
  if (!valueText && !required) return ' '.repeat(width);
  return pad === ' ' ? valueText.padEnd(width, ' ') : valueText.padStart(width, '0');
}

).test(digits), `${label} deve conter exatamente ${expected} dígitos.`);
  return digits.padStart(14, '0');
}

function employerIdentifier(value, type, label) {
  const digits = String(value ?? '');
  const expected = type === '1' ? 14 : 11;
  assert(digits.length === expected && /^\\d+$/.test(digits), `${label} deve conter exatamente ${expected} dígitos.`);
  return digits.padStart(14, '0');
}

function nsrField(value) {
  const nsr = Number(value);
  assert(Number.isSafeInteger(nsr) && nsr >= 1 && nsr <= 999999999, 'NSR inválido no AFD.');
  return String(nsr).padStart(9, '0');
}

function dh(value, timezone) {
  assert(value, 'Data/hora obrigatória no AFD.');
  assert(timezone && typeof timezone === 'string', 'Fuso horário obrigatório no AFD.');
  const date = new Date(value);
  assert(Number.isFinite(date.getTime()), 'Data/hora inválida no AFD.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  const minuteTimestamp = Math.floor(date.getTime() / 60000) * 60000;
  const localAsUtc = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')), Number(part('hour')), Number(part('minute')));
  const offsetMinutes = Math.round((localAsUtc - minuteTimestamp) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}${String(absolute % 60).padStart(2, '0')}`;
}

export function crc16Kermit(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'latin1');
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0x8408) : (crc >>> 1);
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function withCrc(prefix) {
  return prefix + crc16Kermit(prefix);
}

function serializeHeader(header) {
  const employerType = String(header.employer_id_type || '');
  assert(['1', '2'].includes(employerType), 'Tipo de identificador do empregador inválido.');
  const employerDocument = employerIdentifier(header.employer_document, employerType, 'CNPJ/CPF do empregador');
  const developerType = String(header.developer_id_type || '');
  assert(['1', '2'].includes(developerType), 'Tipo de identificador do desenvolvedor inválido.');
  const developerDocument = employerIdentifier(header.developer_document, developerType, 'CPF/CNPJ do desenvolvedor');
  const inpi = numericField(header.inpi_registration, 17, 'Registro INPI', { required: true });
  assert(inpi !== '00000000000000000', 'Registro INPI ainda não foi informado.');
  const startDate = String(header.start_date || '');
  const endDate = String(header.end_date || '');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate), 'Período do AFD inválido.');
  assert(startDate <= endDate, 'Data inicial posterior à data final do AFD.');
  const prefix = '000000000' + '1' + employerType + employerDocument
    + numericField(header.cno_caepf, 14, 'CNO/CAEPF')
    + textField(header.legal_name, 150, 'Razão social/nome', { required: true })
    + inpi + startDate + endDate + dh(header.generated_at, header.timezone)
    + '004' + developerType + developerDocument
    + textField('', 30, 'Modelo REP-C');
  assert(prefix.length === 299, `Cabeçalho AFD com tamanho inesperado: ${prefix.length}.`);
  return withCrc(prefix);
}

function serializeRecord(record, timezone) {
  const payload = record.record_payload || {};
  const nsr = nsrField(record.nsr);
  const type = String(record.record_type);
  assert(RECORD_TYPES.has(type), `Tipo AFD não suportado: ${type}.`);

  if (type === '2') {
    const responsible = numericField(payload.responsible_cpf, 14, 'CPF do responsável', { required: true });
    const employerType = String(payload.employer_id_type || '');
    assert(['1', '2'].includes(employerType), 'Tipo de empregador ausente no registro AFD tipo 2.');
    const prefix = nsr + '2' + dh(payload.recorded_at, timezone) + responsible + employerType
      + employerIdentifier(payload.employer_document, employerType, 'Documento do empregador')
      + numericField(payload.cno_caepf, 14, 'CNO/CAEPF')
      + textField(payload.legal_name, 150, 'Razão social/nome', { required: true })
      + textField(payload.service_location, 100, 'Local de prestação', { required: true });
    assert(prefix.length === 327, 'Registro AFD tipo 2 com tamanho inesperado.');
    return withCrc(prefix);
  }

  if (type === '4') {
    const prefix = nsr + '4' + dh(payload.before_at, timezone) + dh(payload.adjusted_at, timezone)
      + numericField(payload.responsible_cpf, 11, 'CPF do responsável', { required: true });
    assert(prefix.length === 69, 'Registro AFD tipo 4 com tamanho inesperado.');
    return withCrc(prefix);
  }

  if (type === '5') {
    const operation = String(payload.operation || '');
    assert(['I', 'A', 'E'].includes(operation), 'Operação inválida no registro AFD tipo 5.');
    const prefix = nsr + '5' + dh(payload.recorded_at || record.occurred_at, timezone)
      + operation + numericField(payload.cpf, 12, 'CPF do empregado', { required: true })
      + textField(payload.full_name, 52, 'Nome do empregado', { required: true })
      + textField(payload.other_identification || '', 4, 'Demais dados de identificação')
      + numericField(payload.responsible_cpf, 11, 'CPF do responsável', { required: true });
    assert(prefix.length === 114, 'Registro AFD tipo 5 com tamanho inesperado.');
    return withCrc(prefix);
  }

  if (type === '6') {
    assert(['02', '07', '08'].includes(String(payload.event_code)), 'Evento inválido no registro AFD tipo 6.');
    return nsr + '6' + dh(payload.recorded_at || record.occurred_at, timezone) + String(payload.event_code);
  }

  const markedAt = payload.recorded_at;
  const registeredAt = payload.recorded_on || payload.created_at;
  const cpf = String(payload.employee_cpf_snapshot || '');
  const collector = String(payload.collector_type || '');
  const offline = payload.is_offline === true ? '1' : payload.is_offline === false ? '0' : '';
  const hash = String(record.record_hash || '');
  assert(/^\d{11}$/.test(cpf), 'Snapshot de CPF inválido no registro AFD tipo 7.');
  assert(['01', '02', '03', '04', '05'].includes(collector), 'Tipo de coletor inválido no registro AFD tipo 7.');
  assert(offline !== '', 'Indicador online/offline ausente no registro AFD tipo 7.');
  assert(/^[0-9a-f]{64}$/.test(hash), 'Hash SHA-256 ausente ou inválido no registro AFD tipo 7.');
  const prefix = nsr + '7' + dh(markedAt, payload.timezone || timezone)
    + numericField(cpf, 12, 'CPF do empregado', { required: true, pad: ' ' })
    + dh(registeredAt, payload.timezone || timezone) + collector + offline + hash;
  assert(prefix.length === 137, 'Registro AFD tipo 7 com tamanho inesperado.');
  return prefix;
}

export function buildAfdV004({ header, records, includeSignatureMarker = true }) {
  assert(header && Array.isArray(records), 'Cabeçalho e registros do AFD são obrigatórios.');
  const ordered = [...records].sort((a, b) => Number(a.nsr) - Number(b.nsr));
  const seen = new Set();
  let previousNsr = 0;
  const headerLine = serializeHeader(header);
  assert(headerLine.slice(-4) === crc16Kermit(headerLine.slice(0, -4)), 'CRC-16/KERMIT inválido no cabeçalho AFD.');
  const lines = [headerLine];
  const counts = { '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0 };

  for (const record of ordered) {
    const nsr = Number(record.nsr);
    assert(!seen.has(nsr), 'NSR duplicado no AFD.');
    assert(nsr > previousNsr, 'NSR fora de ordem no AFD.');
    seen.add(nsr);
    previousNsr = nsr;
    const type = String(record.record_type);
    const line = serializeRecord(record, header.timezone);
    if (type === '7') {
      const previousType7 = [...ordered.slice(0, ordered.indexOf(record))].reverse().find((item) => String(item.record_type) === '7');
      const payload = record.record_payload || {};
      const expectedHash = candidateType7Hash({
        nsr: record.nsr, markedAt: payload.recorded_at,
        cpf: payload.employee_cpf_snapshot,
        recordedAt: payload.recorded_on || payload.created_at,
        collectorType: payload.collector_type, isOffline: payload.is_offline,
        previousHash: previousType7?.record_hash || null,
        timezone: payload.timezone || header.timezone,
      });
      assert(record.record_hash === expectedHash, 'Hash do registro tipo 7 diverge da cadeia SHA-256 candidata; exportação bloqueada.');
    }
    lines.push(line);
    counts[type] += 1;
  }

  const trailer = '999999999'
    + String(counts['2']).padStart(9, '0')
    + String(counts['3']).padStart(9, '0')
    + String(counts['4']).padStart(9, '0')
    + String(counts['5']).padStart(9, '0')
    + String(counts['6']).padStart(9, '0')
    + String(counts['7']).padStart(9, '0') + '9';
  assert(trailer.length === 64, 'Trailer AFD com tamanho inesperado.');
  lines.push(trailer);
  if (includeSignatureMarker) lines.push(SIGNATURE_MARKER.padEnd(100, ' '));

  const output = Buffer.from(lines.join('\r\n') + '\r\n', 'latin1');
  const validation = validateAfdV004(output);
  assert(validation.ok, `AFD gerado não passou na validação: ${validation.errors.join('; ')}`);
  return output;
}

export function validateAfdV004(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const errors = [];
  if (buffer.includes(0x0a) && buffer.toString('latin1').replace(/\r\n/g, '').includes('\n')) {
    errors.push('Quebra de linha diferente de CRLF.');
  }
  const content = buffer.toString('latin1');
  if (!content.endsWith('\r\n')) errors.push('Arquivo deve terminar em CRLF.');
  const lines = content.split('\r\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => line.length === 0)) errors.push('Arquivo contém linha em branco.');
  if (lines.length < 3) errors.push('AFD deve conter cabeçalho, trailer e marcador de assinatura.');
  if (lines[0]?.length !== 303 || lines[0]?.[9] !== '1') errors.push('Cabeçalho AFD inválido.');
  if (lines[0]?.length === 303 && lines[0].slice(-4) !== crc16Kermit(lines[0].slice(0, -4))) errors.push('CRC-16/KERMIT inválido no cabeçalho AFD.');
  if (lines.at(-1)?.length !== 100 || !lines.at(-1)?.startsWith(SIGNATURE_MARKER)) errors.push('Marcador de assinatura AFD inválido.');
  const trailer = lines.at(-2) || '';
  if (trailer.length !== 64 || trailer.slice(0, 9) !== '999999999' || trailer.at(-1) !== '9') errors.push('Trailer AFD inválido.');
  const recordLines = lines.slice(1, -2);
  let previous = 0;
  let previousType7Hash = '';
  const counts = { '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0 };
  for (const line of recordLines) {
    const nsr = Number(line.slice(0, 9));
    const type = line[9];
    if (!/^\d{9}$/.test(line.slice(0, 9)) || !Number.isInteger(nsr) || nsr <= previous) errors.push('NSR inválido, duplicado ou fora de ordem.');
    previous = nsr;
    if (!RECORD_TYPES.has(type)) errors.push(`Tipo de registro inválido: ${type}.`);
    if (type in counts) counts[type] += 1;
    const expectedLength = { '2': 331, '4': 73, '5': 118, '6': 36, '7': 137 }[type];
    if (line.length !== expectedLength) errors.push(`Tamanho incorreto para registro tipo ${type}.`);
    if (['2', '4', '5'].includes(type) && line.slice(-4) !== crc16Kermit(line.slice(0, -4))) errors.push(`CRC-16/KERMIT inválido no registro tipo ${type}.`);
    if (type === '7') {
      const actualHash = line.slice(73, 137);
      const expectedHash = createHash('sha256').update(Buffer.from(line.slice(0, 73) + previousType7Hash, 'latin1')).digest('hex');
      if (!/^[0-9a-f]{64}$/.test(actualHash) || actualHash !== expectedHash) errors.push('Hash SHA-256 inválido ou cadeia quebrada no registro tipo 7.');
      previousType7Hash = actualHash;
    }
  }
  const actualCounts = ['2', '3', '4', '5', '6', '7'].map((type) => String(counts[type]).padStart(9, '0')).join('');
  if (trailer.slice(9, 63) !== actualCounts) errors.push('Contadores do trailer não correspondem aos registros.');
  if (lines.some((line) => /[^\x00-\xFF]/.test(line))) errors.push('Arquivo contém caractere fora de ISO-8859-1.');
  return { ok: errors.length === 0, errors, records: recordLines.length };
}

export function candidateType7Hash({ nsr, markedAt, cpf, recordedAt, collectorType, isOffline, previousHash, timezone }) {
  const input = nsrField(nsr) + '7' + dh(markedAt, timezone)
    + numericField(cpf, 12, 'CPF', { required: true, pad: ' ' })
    + dh(recordedAt, timezone) + collectorType + (isOffline ? '1' : '0')
    + (previousHash || '');
  return createHash('sha256').update(Buffer.from(input, 'latin1')).digest('hex');
}
