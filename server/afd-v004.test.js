import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAfdV004,
  candidateType7Hash,
  crc16Kermit,
  validateAfdV004,
} from './afd-v004.js';

const timezone = 'America/Sao_Paulo';
const header = {
  employer_id_type: '1',
  employer_document: '12345678000195',
  cno_caepf: null,
  legal_name: 'Loja Teste Ltda',
  inpi_registration: '51202600000000123',
  start_date: '2026-11-01',
  end_date: '2026-11-30',
  generated_at: '2026-11-27T18:32:48.000Z',
  timezone,
  developer_id_type: '2',
  developer_document: '52998224725',
};

test('CRC-16/KERMIT usa o vetor oficial 123456789 = 2189', () => {
  assert.equal(crc16Kermit('123456789'), '2189');
});

test('gera AFD 004 com tipos 2, 4, 5, 6 e 7, CRLF, trailer e marcador', () => {
  const markPayload = {
    recorded_at: '2026-11-27T15:00:30.000Z',
    employee_cpf_snapshot: '52998224725',
    recorded_on: '2026-11-27T15:00:42.000Z',
    timezone,
    collector_type: '02',
    is_offline: false,
  };
  const mark = {
    nsr: 5,
    record_type: '7',
    record_payload: markPayload,
  };
  mark.record_hash = candidateType7Hash({
    nsr: mark.nsr,
    markedAt: markPayload.recorded_at,
    cpf: markPayload.employee_cpf_snapshot,
    recordedAt: markPayload.recorded_on,
    collectorType: markPayload.collector_type,
    isOffline: markPayload.is_offline,
    previousHash: null,
    timezone,
  });
  const records = [
    { nsr: 4, record_type: '6', occurred_at: '2026-11-27T15:00:00.000Z', record_payload: { event_code: '07', recorded_at: '2026-11-27T15:00:00.000Z' } },
    { nsr: 3, record_type: '5', occurred_at: '2026-11-27T14:00:00.000Z', record_payload: { operation: 'I', recorded_at: '2026-11-27T14:00:00.000Z', cpf: '52998224725', full_name: 'Funcionário Teste', responsible_cpf: '52998224725' } },
    { nsr: 2, record_type: '4', occurred_at: '2026-11-27T13:00:00.000Z', record_payload: { before_at: '2026-11-27T12:59:00.000Z', adjusted_at: '2026-11-27T13:00:00.000Z', responsible_cpf: '52998224725' } },
    { nsr: 1, record_type: '2', occurred_at: '2026-11-27T12:00:00.000Z', record_payload: { recorded_at: '2026-11-27T12:00:00.000Z', responsible_cpf: '52998224725', employer_id_type: '1', employer_document: '12345678000195', legal_name: 'Loja Teste Ltda', service_location: 'Belo Horizonte - MG' } },
    mark,
  ];
  const output = buildAfdV004({ header, records });
  const result = validateAfdV004(output);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.records, 5);
  const lines = output.toString('latin1').split('\r\n');
  assert.equal(lines[0].slice(250, 253), '004');
  assert.equal(lines[0].slice(-4), crc16Kermit(lines[0].slice(0, -4)));
  assert.equal(lines[1].slice(0, 9), '000000001');
  assert.equal(lines.at(-2), '9999999990000000010000000000000000010000000010000000010000000019');
  assert.equal(lines.at(-1).length, 100);
  assert.ok(output.includes(Buffer.from('\r\n', 'latin1')));
});

test('bloqueia exportação sem número de registro INPI', () => {
  assert.throws(
    () => buildAfdV004({ header: { ...header, inpi_registration: '' }, records: [] }),
    /Registro INPI obrigatório/,
  );
});

test('bloqueia NSR duplicado e hash tipo 7 divergente', () => {
  const duplicate = [
    { nsr: 1, record_type: '6', record_payload: { event_code: '07', recorded_at: '2026-11-27T15:00:00.000Z' } },
    { nsr: 1, record_type: '6', record_payload: { event_code: '08', recorded_at: '2026-11-27T15:01:00.000Z' } },
  ];
  assert.throws(() => buildAfdV004({ header, records: duplicate }), /NSR duplicado/);
  assert.throws(() => buildAfdV004({
    header,
    records: [{ nsr: 1, record_type: '7', record_hash: '0'.repeat(64), record_payload: {
      recorded_at: '2026-11-27T15:00:00.000Z', employee_cpf_snapshot: '52998224725',
      recorded_on: '2026-11-27T15:00:30.000Z', timezone, collector_type: '02', is_offline: false,
    } }],
  }), /Hash do registro tipo 7 diverge/);
});

test('validador detecta CRC corrompido', () => {
  const output = buildAfdV004({ header, records: [] });
  const broken = Buffer.from(output);
  broken[20] = broken[20] === 0x31 ? 0x32 : 0x31;
  assert.equal(validateAfdV004(broken).ok, false);
});
