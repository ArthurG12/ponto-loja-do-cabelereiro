import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, LogOut, Upload, UserPlus } from 'lucide-react';
import { api } from './api.js';
import {
  EXCUSE_LABELS, PUNCH_LABELS, SCHEDULE_INFO, apurate, currentMonth, dayKeyOf, dayRange,
  describePresence, fmtDate, fmtDayKey, fmtHours, fmtTime, monthRange,
  saoPauloParts, sequenceFor, todayKey, weekdayName,
} from './time.js';

const TABS = [
  ['hoje', 'Hoje'],
  ['equipe', 'Equipe'],
  ['mes', 'Apuração'],
  ['ajustes', 'Ajustes'],
];

const PRESENCE_ORDER = { late: 0, waiting: 1, working: 2, lunch: 3, extra: 4, done: 5, off: 6 };
const SHORT = { entrada: 'Entrada', saida_intervalo: 'Almoço', retorno_intervalo: 'Retorno', saida: 'Saída' };

function hhmmOf(iso) {
  const parts = saoPauloParts(new Date(iso));
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(';')).join('\r\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function punchTime(row, type) {
  return row.by[type] ? fmtTime(new Date(row.by[type].recorded_at)) : '—';
}

export default function Admin({ onClose, onNotice }) {
  const [tab, setTab] = useState('hoje');
  const [month, setMonth] = useState(currentMonth());
  const [staff, setStaff] = useState([]);
  const [punches, setPunches] = useState([]);
  const [justifications, setJustifications] = useState([]);
  const [todayPunches, setTodayPunches] = useState([]);
  const [booting, setBooting] = useState(true);
  const [now, setNow] = useState(new Date());
  const [filterPerson, setFilterPerson] = useState('all');
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);

  async function reload(nextMonth = month) {
    const range = monthRange(nextMonth);
    const todayMonth = currentMonth();
    const [staffRes, punchRes, justRes, todayRes] = await Promise.all([
      api.listStaff(),
      api.punchesBetween(range.start, range.end),
      api.justificationsBetween(range.start, range.end),
      nextMonth === todayMonth ? Promise.resolve(null) : api.punchesBetween(monthRange(todayMonth).start, monthRange(todayMonth).end),
    ]);
    if (!staffRes.ok || !punchRes.ok || !justRes.ok || (todayRes && !todayRes.ok)) {
      onNotice(staffRes.error || punchRes.error || justRes.error || todayRes?.error || 'Não foi possível carregar o painel.');
    }
    setStaff(staffRes.employees || []);
    setPunches(punchRes.punches || []);
    setJustifications(justRes.justifications || []);
    setTodayPunches(todayRes ? todayRes.punches || [] : punchRes.punches || []);
    setBooting(false);
  }

  useEffect(() => { reload(month); }, [month]);

  async function leave() {
    await api.adminLogout();
    onClose();
  }

  const activeStaff = staff.filter((person) => person.active);
  const day = todayKey(now);
  const board = activeStaff.map((person) => ({ person, presence: describePresence(person, todayPunches, now) }))
    .sort((a, b) => PRESENCE_ORDER[a.presence.key] - PRESENCE_ORDER[b.presence.key] || a.person.full_name.localeCompare(b.person.full_name, 'pt-BR'));

  const reports = useMemo(() => {
    const list = filterPerson === 'all' ? staff.filter((person) => person.active || punches.some((punch) => punch.employee_id === person.id)) : staff.filter((person) => person.id === filterPerson);
    return list.map((person) => ({ person, ...apurate(person, punches, justifications, month, day) }));
  }, [staff, punches, justifications, month, filterPerson, day]);

  const teamTotals = reports.reduce((sum, report) => {
    sum.overtime += report.totals.overtime;
    sum.lateDays += report.totals.lateDays;
    sum.incomplete += report.totals.incomplete;
    sum.missing += report.totals.missing;
    sum.balance += report.totals.balance;
    return sum;
  }, { overtime: 0, lateDays: 0, incomplete: 0, missing: 0, balance: 0 });

  function exportPunches() {
    const rows = [['Colaboradora', 'Data', 'Horário', 'Marcação', 'Origem']];
    punches.filter((punch) => !punch.voided_at && (filterPerson === 'all' || punch.employee_id === filterPerson))
      .forEach((punch) => rows.push([
        staff.find((person) => person.id === punch.employee_id)?.full_name || 'Colaboradora',
        fmtDate(new Date(punch.recorded_at)),
        fmtTime(new Date(punch.recorded_at)),
        PUNCH_LABELS[punch.punch_type] || punch.punch_type,
        punch.source === 'ajuste' ? 'Ajuste' : 'Tablet',
      ]));
    downloadCsv(`ponto-batidas-${month}.csv`, rows);
  }

  function exportApuration() {
    const rows = [['Colaboradora', 'Data', 'Entrada', 'Saída almoço', 'Retorno', 'Saída', 'Previsto', 'Trabalhado', 'Saldo', 'Atraso', 'Observação']];
    reports.forEach((report) => {
      report.rows.forEach((row) => {
        const note = row.excuseLabel || (row.missing ? 'Sem registro' : row.incomplete ? 'Incompleto' : row.open ? 'Em aberto' : '');
        rows.push([
          report.person.full_name,
          fmtDayKey(row.dayKey),
          punchTime(row, 'entrada'),
          punchTime(row, 'saida_intervalo'),
          punchTime(row, 'retorno_intervalo'),
          punchTime(row, 'saida'),
          fmtHours(row.expected),
          fmtHours(row.worked),
          fmtHours(row.balance),
          row.late ? `${row.late} min` : '',
          note,
        ]);
      });
      rows.push([report.person.full_name, 'Total do mês', '', '', '', '', fmtHours(report.totals.expected), fmtHours(report.totals.worked), fmtHours(report.totals.balance), `${report.totals.lateDays} dia(s)`, report.totals.incomplete ? `${report.totals.incomplete} incompleto(s)` : '']);
    });
    downloadCsv(`ponto-apuracao-${month}.csv`, rows);
  }

  return <main className="main">
    <div className="section-head">
      <div><span className="eyebrow gold">ÁREA RESTRITA</span><h2>Painel administrativo</h2><p className="muted">Quem chegou, quem ficou além do horário e o saldo do mês.</p></div>
      <button className="secondary" onClick={leave}><LogOut size={16} /> Sair</button>
    </div>
    <div className="tabs">{TABS.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    {booting ? <div className="empty">Carregando registros…</div> : <>
      {tab === 'hoje' && <TodayBoard board={board} punches={todayPunches} day={day} />}
      {tab === 'equipe' && <TeamPanel staff={staff} onSaved={reload} />}
      {tab === 'mes' && <MonthPanel month={month} setMonth={setMonth} staff={staff} filterPerson={filterPerson} setFilterPerson={setFilterPerson} reports={reports} totals={teamTotals} openId={openId} setOpenId={setOpenId} onExportPunches={exportPunches} onExportApuration={exportApuration} />}
      {tab === 'ajustes' && <AdjustPanel staff={staff} justifications={justifications} onSaved={reload} />}
    </>}
  </main>;
}

function TodayBoard({ board, punches, day }) {
  if (!board.length) return <div className="empty">Cadastre a equipe na aba Equipe para acompanhar o dia.</div>;
  return <div className="today-grid">{board.map(({ person, presence }) => {
    const sequence = sequenceFor(person.schedule_code, day);
    const mine = punches.filter((punch) => punch.employee_id === person.id && !punch.voided_at && dayKeyOf(punch.recorded_at) === day);
    return <article className={`today-card is-${presence.key}`} key={person.id}>
      <div className="today-top"><strong>{person.full_name}</strong><span className={`badge badge-${presence.key}`}>{presence.label}</span></div>
      <p>{presence.detail}</p>
      <div className="punch-times">{sequence.map((type) => {
        const punch = mine.find((item) => item.punch_type === type);
        return <span key={type}><small>{SHORT[type]}</small>{punch ? fmtTime(new Date(punch.recorded_at)) : '—'}</span>;
      })}</div>
      <small className="person-schedule">{SCHEDULE_INFO[person.schedule_code]?.label || 'Jornada'}</small>
    </article>;
  })}</div>;
}

function TeamPanel({ staff, onSaved }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function edit(person) {
    setError('');
    setForm({ id: person.id, full_name: person.full_name, schedule_code: person.schedule_code || 'A', pin: '', active: person.active });
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    const response = await api.saveEmployee(form);
    setBusy(false);
    if (!response.ok) { setError(response.error); return; }
    setForm(null);
    onSaved();
  }

  async function toggle(person) {
    const response = await api.saveEmployee({ ...person, active: !person.active, pin: '' });
    if (!response.ok) { setError(response.error); return; }
    onSaved();
  }

  return <section className="report-panel">
    <div className="panel-head"><h3>Colaboradoras</h3><button className="primary" onClick={() => { setError(''); setForm({ id: null, full_name: '', schedule_code: 'A', pin: '', active: true }); }}><UserPlus size={16} /> Nova colaboradora</button></div>
    {form && <form className="form-card" onSubmit={save}>
      <label>Nome<input value={form.full_name} onChange={(event) => setForm({ ...form, full_name: event.target.value })} required minLength={3} /></label>
      <div className="choice">{['A', 'B'].map((code) => <label key={code} className={form.schedule_code === code ? 'selected' : ''}><input type="radio" name="schedule" checked={form.schedule_code === code} onChange={() => setForm({ ...form, schedule_code: code })} /><strong>{SCHEDULE_INFO[code].label}</strong><span>{SCHEDULE_INFO[code].detail}</span></label>)}</div>
      <label>{form.id ? 'Nova senha' : 'Senha numérica'}<input inputMode="numeric" autoComplete="new-password" value={form.pin} onChange={(event) => setForm({ ...form, pin: event.target.value.replace(/\D/g, '').slice(0, 6) })} placeholder={form.id ? 'Em branco mantém a senha atual' : '4 a 6 números'} required={!form.id} /></label>
        {error && <p className="error">{error}</p>}
      <div className="row-actions"><button className="primary" disabled={busy} type="submit">{busy ? 'Salvando…' : 'Salvar'}</button><button className="secondary" type="button" onClick={() => setForm(null)}>Cancelar</button></div>
    </form>}
    {!form && error && <p className="error">{error}</p>}
    {!staff.length && !form && <div className="empty">Nenhuma colaboradora ainda. Inclua quem já está na loja e quem está entrando.</div>}
    <div className="stack">{staff.map((person) => <div className="person-row" key={person.id}><div><strong>{person.full_name}</strong><span>{SCHEDULE_INFO[person.schedule_code]?.label || person.schedule_code} · {person.active ? 'Ativa' : 'Inativa'}</span></div><div className="row-actions"><button className="secondary" onClick={() => edit(person)}>Editar</button><button className="secondary" onClick={() => toggle(person)}>{person.active ? 'Desativar' : 'Reativar'}</button></div></div>)}</div>
  </section>;
}

function MonthPanel({ month, setMonth, staff, filterPerson, setFilterPerson, reports, totals, openId, setOpenId, onExportPunches, onExportApuration }) {
  return <section className="report-panel">
    <div className="stats">
      <div className="stat"><span>Saldo do filtro</span><strong>{fmtHours(totals.balance)}</strong></div>
      <div className="stat"><span>Horas além da jornada</span><strong>{fmtHours(totals.overtime)}</strong></div>
      <div className="stat"><span>Dias com atraso</span><strong>{totals.lateDays}</strong></div>
    </div>
    {totals.incomplete > 0 && <p className="warn">{totals.incomplete} dia(s) com marcação incompleta. O saldo desses dias fica de fora até o ajuste.</p>}
    <div className="filters">
      <label>Competência<input type="month" value={month} onChange={(event) => event.target.value && setMonth(event.target.value)} /></label>
      <label>Colaboradora<select value={filterPerson} onChange={(event) => setFilterPerson(event.target.value)}><option value="all">Todas</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}</select></label>
      <button className="secondary export" onClick={onExportPunches}><FileSpreadsheet size={17} /> CSV das batidas</button>
      <button className="primary export" onClick={onExportApuration}><FileSpreadsheet size={17} /> CSV da apuração</button>
    </div>
    {!reports.length && <div className="empty">Sem colaboradoras para apurar neste filtro.</div>}
    <div className="stack report-list">{reports.map((report) => <article key={report.person.id}>
      <button className="person-row report-summary" onClick={() => setOpenId(openId === report.person.id ? null : report.person.id)}>
        <div><strong>{report.person.full_name}</strong><span>Previsto {fmtHours(report.totals.expected)} · Trabalhado {fmtHours(report.totals.worked)}</span></div>
        <div className="summary-pills"><span>Saldo {fmtHours(report.totals.balance)}</span><span>Extra {fmtHours(report.totals.overtime)}</span>{report.totals.lateDays > 0 && <span>{report.totals.lateDays} atraso(s)</span>}{report.totals.incomplete > 0 && <span>{report.totals.incomplete} incompleto(s)</span>}</div>
      </button>
      {openId === report.person.id && <div className="day-list">{report.rows.map((row) => <div className="day-row" key={row.dayKey}>
        <div><strong>{fmtDayKey(row.dayKey)}</strong><small>{weekdayName(row.dayKey)}</small></div>
        <div className="day-punches">{row.sequence.map((type) => <span key={type}>{SHORT[type]} {punchTime(row, type)}</span>)}</div>
        <div className="day-balance"><span>Previsto {fmtHours(row.expected)}</span><span>Feito {fmtHours(row.worked)}</span><strong>{row.balance == null ? (row.missing ? 'Sem registro' : row.open ? 'Em aberto' : 'Incompleto') : fmtHours(row.balance)}</strong>{row.late > 0 && <small>Atraso {row.late} min</small>}{row.excuseLabel && <small>{row.excuseLabel}</small>}</div>
      </div>)}{!report.rows.length && <p className="muted">Nenhum dia com jornada ou marcação neste mês.</p>}</div>}
    </article>)}</div>
    <p className="small-print">A apuração usa as jornadas A e B da loja. Domingo não tem horário previsto; se alguém registrar ponto, o tempo entra como saldo. Isto é controle interno, não um registrador de ponto homologado.</p>
  </section>;
}

function AdjustPanel({ staff, justifications, onSaved }) {
  const [excuse, setExcuse] = useState({ employee_id: '', category: 'atestado', starts_on: todayKey(), ends_on: todayKey(), notes: '' });
  const [adjust, setAdjust] = useState({ employee_id: '', day: todayKey(), punch_type: 'entrada', time: '08:00', reason: '' });
  const [dayPunches, setDayPunches] = useState([]);
  const [times, setTimes] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!adjust.employee_id || !/^\d{4}-\d{2}-\d{2}$/.test(adjust.day)) { setDayPunches([]); return undefined; }
    let live = true;
    const range = dayRange(adjust.day);
    api.punchesBetween(range.start, range.end).then((response) => {
      if (!live) return;
      const mine = (response.punches || []).filter((punch) => punch.employee_id === adjust.employee_id && !punch.voided_at);
      setDayPunches(mine);
      setTimes(Object.fromEntries(mine.map((punch) => [punch.id, hhmmOf(punch.recorded_at)])));
    });
    return () => { live = false; };
  }, [adjust.employee_id, adjust.day, revision]);

  const person = staff.find((item) => item.id === adjust.employee_id);
  const sequence = person ? sequenceFor(person.schedule_code, adjust.day) : [];
  const used = new Set(dayPunches.map((punch) => punch.punch_type));
  const available = sequence.filter((type) => !used.has(type));

  async function run(action) {
    setError('');
    setBusy(true);
    const response = await action();
    setBusy(false);
    if (!response.ok) { setError(response.error); return; }
    setRevision((value) => value + 1);
    onSaved();
  }

  async function restoreFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!window.confirm('Restaurar este backup substitui os registros deste tablet.')) return;
    const response = await api.restoreBackup(await file.text());
    if (!response.ok) { setError(response.error); return; }
    onSaved();
  }

  return <div className="adjust-grid">
    <section className="report-panel">
      <h3>Abonar dia</h3>
      <p className="muted">Atestado ou folga tira a jornada prevista do saldo. Se a pessoa mesmo assim trabalhar, as horas feitas continuam aparecendo.</p>
      <form className="form-card" onSubmit={(event) => { event.preventDefault(); run(() => api.saveJustification(excuse)); }}>
        <label>Colaboradora<select value={excuse.employee_id} onChange={(event) => setExcuse({ ...excuse, employee_id: event.target.value })} required><option value="">Selecione</option>{staff.map((item) => <option key={item.id} value={item.id}>{item.full_name}</option>)}</select></label>
        <label>Motivo<select value={excuse.category} onChange={(event) => setExcuse({ ...excuse, category: event.target.value })}>{Object.entries(EXCUSE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="two"><label>De<input type="date" value={excuse.starts_on} onChange={(event) => setExcuse({ ...excuse, starts_on: event.target.value })} required /></label><label>Até<input type="date" value={excuse.ends_on} onChange={(event) => setExcuse({ ...excuse, ends_on: event.target.value })} required /></label></div>
        <label>Observação<input value={excuse.notes} onChange={(event) => setExcuse({ ...excuse, notes: event.target.value })} placeholder="Opcional. O documento fica guardado na loja." /></label>
        <button className="primary" disabled={busy} type="submit">Salvar abono</button>
      </form>
      <div className="stack">{justifications.map((item) => <div className="person-row" key={item.id}><div><strong>{staff.find((person) => person.id === item.employee_id)?.full_name}</strong><span>{EXCUSE_LABELS[item.category] || item.category} · {fmtDayKey(dayKeyOf(item.starts_at))} a {fmtDayKey(dayKeyOf(item.ends_at))}{item.notes ? ` · ${item.notes}` : ''}</span></div><button className="secondary" onClick={() => run(() => api.deleteJustification(item.id))}>Remover</button></div>)}</div>
    </section>
    <section className="report-panel">
      <h3>Corrigir marcação</h3>
      <p className="muted">Use para tratar registros legados. Marcações originais REP-P são imutáveis e não podem ser alteradas ou anuladas nesta tela.</p>
      <div className="form-card">
        <div className="two">
          <label>Colaboradora<select value={adjust.employee_id} onChange={(event) => setAdjust({ ...adjust, employee_id: event.target.value })}><option value="">Selecione</option>{staff.map((item) => <option key={item.id} value={item.id}>{item.full_name}</option>)}</select></label>
          <label>Dia<input type="date" value={adjust.day} onChange={(event) => setAdjust({ ...adjust, day: event.target.value })} /></label>
        </div>
        <label>Motivo do ajuste<input value={adjust.reason} onChange={(event) => setAdjust({ ...adjust, reason: event.target.value })} placeholder="Ex.: esqueceu de bater a saída no movimento do fechamento" /></label>
        {error && <p className="error">{error}</p>}
        <div className="stack">{dayPunches.map((punch) => <div className="person-row" key={punch.id}><div><strong>{PUNCH_LABELS[punch.punch_type]}</strong><span>{punch.nsr ? `Registro original REP-P · NSR ${punch.nsr}` : punch.source === 'ajuste' ? 'Incluída pelo administrador' : 'Registro legado'}</span></div>{punch.nsr ? <span className="muted">Imutável — tratamento separado necessário</span> : <div className="row-actions"><input type="time" value={times[punch.id] || ''} onChange={(event) => setTimes({ ...times, [punch.id]: event.target.value })} /><button className="secondary" disabled={busy} onClick={() => run(() => api.adjustPunch({ action: 'retime', punch_id: punch.id, employee_id: adjust.employee_id, day: adjust.day, time: times[punch.id], reason: adjust.reason }))}>Salvar horário</button><button className="secondary danger" disabled={busy} onClick={() => run(() => api.adjustPunch({ action: 'void', punch_id: punch.id, reason: adjust.reason }))}>Anular</button></div>}</div>)}</div>
        {adjust.employee_id && available.length > 0 && <div className="add-punch"><label>Incluir marcação que faltou<select value={available.includes(adjust.punch_type) ? adjust.punch_type : available[0]} onChange={(event) => setAdjust({ ...adjust, punch_type: event.target.value })}>{available.map((type) => <option key={type} value={type}>{PUNCH_LABELS[type]}</option>)}</select></label><label>Horário de Brasília<input type="time" value={adjust.time} onChange={(event) => setAdjust({ ...adjust, time: event.target.value })} /></label><button className="primary" disabled={busy} onClick={() => run(() => api.adjustPunch({ action: 'insert', employee_id: adjust.employee_id, day: adjust.day, punch_type: available.includes(adjust.punch_type) ? adjust.punch_type : available[0], time: adjust.time, reason: adjust.reason }))}>Incluir</button></div>}
        {adjust.employee_id && !available.length && dayPunches.length > 0 && <p className="muted">As marcações deste dia já estão completas.</p>}
      </div>
      {api.mode !== 'remote' && <div className="backup-box">
        <h3>Cópia do banco</h3>
        <p className="muted">O ponto já fica em data/ponto.sqlite. Baixe uma cópia de tempos em tempos.</p>
        <div className="row-actions">
          <button className="secondary" onClick={downloadBackup}><Download size={16} /> Baixar backup</button>
          <label className="secondary file-btn"><Upload size={16} /> Restaurar backup<input type="file" accept="application/json" onChange={restoreFile} /></label>
        </div>
      </div>}
    </section>
  </div>;
}

async function downloadBackup() {
  const text = await api.exportBackup();
  if (!text) return;
  const blob = new Blob([text], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `ponto-facil-backup-${todayKey()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
