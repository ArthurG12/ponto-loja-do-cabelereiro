import assert from 'node:assert/strict';
import {
  apurate, computeDay, expectedMinutes, nextType, sequenceFor, workedMinutes,
} from '../src/time.js';

const at = (day, time) => `${day}T${time}:00-03:00`;
const punch = (type, day, time) => ({ punch_type: type, recorded_at: at(day, time) });

const wed = '2026-10-21';
const sat = '2026-10-24';
const sun = '2026-10-25';

assert.equal(sequenceFor('A', wed).length, 4);
assert.equal(sequenceFor('A', sat).join(','), 'entrada,saida');
assert.equal(expectedMinutes('A', wed), 480);
assert.equal(expectedMinutes('A', sat), 240);
assert.equal(expectedMinutes('B', wed), 480);
assert.equal(expectedMinutes('A', sun), 0);

const regular = [
  punch('entrada', wed, '08:00'),
  punch('saida_intervalo', wed, '12:00'),
  punch('retorno_intervalo', wed, '13:00'),
  punch('saida', wed, '17:00'),
];
assert.equal(workedMinutes(regular), 480);
assert.equal(computeDay('A', wed, regular, null, '2026-10-28').balance, 0);
assert.equal(computeDay('A', wed, regular, null, '2026-10-28').late, 0);

const late = [
  punch('entrada', wed, '08:20'),
  punch('saida_intervalo', wed, '12:00'),
  punch('retorno_intervalo', wed, '13:00'),
  punch('saida', wed, '17:00'),
];
const lateDay = computeDay('A', wed, late, null, '2026-10-28');
assert.equal(lateDay.late, 20);
assert.equal(lateDay.worked, 460);
assert.equal(lateDay.balance, -20);

const extra = [
  punch('entrada', wed, '08:00'),
  punch('saida_intervalo', wed, '12:00'),
  punch('retorno_intervalo', wed, '13:00'),
  punch('saida', wed, '17:40'),
];
assert.equal(computeDay('A', wed, extra, null, '2026-10-28').balance, 40);

const saturday = [punch('entrada', sat, '08:00'), punch('saida', sat, '12:30')];
assert.equal(computeDay('A', sat, saturday, null, '2026-10-28').balance, 30);
assert.equal(nextType('A', sat, [punch('entrada', sat, '08:00')]), 'saida');
assert.equal(nextType('A', wed, [punch('entrada', wed, '08:00')]), 'saida_intervalo');
assert.equal(nextType('A', wed, regular), null);

const sunday = [punch('entrada', sun, '10:00'), punch('saida', sun, '14:00')];
assert.equal(computeDay('A', sun, sunday, null, '2026-10-28').balance, 240);

const open = computeDay('A', wed, [punch('entrada', wed, '08:00')], null, wed);
assert.equal(open.open, true);
assert.equal(open.balance, null);

const missing = computeDay('A', wed, [punch('entrada', wed, '08:00')], null, '2026-10-28');
assert.equal(missing.incomplete, true);

const excused = computeDay('A', wed, [], { category: 'atestado', starts_at: at(wed, '00:00'), ends_at: at(wed, '23:59') }, '2026-10-28');
assert.equal(excused.balance, 0);
assert.equal(excused.expected, 0);

const employee = { id: '1', schedule_code: 'A' };
const month = apurate(employee, regular.map((item) => ({ ...item, employee_id: '1' })), [], '2026-10', '2026-10-28');
assert.equal(month.totals.balance, 0);
assert.equal(month.totals.overtime, 0);
assert.equal(month.totals.incomplete, 0);
assert.ok(month.totals.missing > 0);

console.log('time ok');
