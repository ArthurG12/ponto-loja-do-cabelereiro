import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, Settings, ShieldCheck } from 'lucide-react';
import { api, randomId } from './api.js';
import Admin from './Admin.jsx';
import { fmtDate, fmtTime, nextType, PUNCH_LABELS, saoPauloParts, sequenceFor } from './time.js';

function punchLabel(type, schedule, day) {
  if (type === 'saida' && sequenceFor(schedule, day).length === 2) return 'Saída';
  return PUNCH_LABELS[type] || 'Ponto';
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export default function App() {
  const [now, setNow] = useState(new Date());
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState('home');
  const [selected, setSelected] = useState(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [busy, setBusy] = useState(false);
  const [punches, setPunches] = useState([]);
  const [result, setResult] = useState(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminConfirm, setAdminConfirm] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminError, setAdminError] = useState('');
  const requestId = useRef('');

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function loadPeople() {
    const response = await api.listActiveEmployees();
    setPeople(response.employees);
    if (!response.ok) setNotice(response.error);
    setLoading(false);
  }

  useEffect(() => { loadPeople(); }, []);

  function goHome() {
    setSelected(null);
    setPin('');
    setPinError('');
    setPunches([]);
    setResult(null);
    setView('home');
    loadPeople();
  }

  async function openPerson(person) {
    setSelected(person);
    setPin('');
    setPinError('');
    setPunches([]);
    setResult(null);
    setView('pin');
  }

  function pressDigit(digit) {
    setPinError('');
    if (digit === '←') {
      setPin((current) => current.slice(0, -1));
      return;
    }
    setPin((current) => (current.length >= 6 ? current : current + digit));
  }

  async function verifyPin(event) {
    event.preventDefault();
    if (!/^\d{4,6}$/.test(pin)) {
      setPinError('A senha tem de 4 a 6 números.');
      return;
    }
    setBusy(true);
    try {
      const verified = await api.verifyPin(selected.id, pin);
      if (!verified.ok) {
        setPinError(verified.error);
        return;
      }
      const today = await api.todayPunches(selected.id, pin);
      if (!today.ok) {
        setPinError(today.error);
        return;
      }
      requestId.current = randomId();
      setPunches(today.punches);
      setView('confirm');
    } catch (error) {
      setPinError(error?.message || 'Não foi possível conferir a senha.');
    } finally {
      setBusy(false);
    }
  }

  async function registerPunch(type) {
    setBusy(true);
    setNotice('');
    const saved = await api.registerPunch(selected.id, pin, type, requestId.current);
    setBusy(false);
    if (!saved.ok) {
      setNotice(saved.error);
      return;
    }
    setResult(saved.punch);
    setPin('');
    setView('success');
  }

  async function openAdmin() {
    setAdminError('');
    if (api.refreshStatus) await api.refreshStatus();
    if (await api.isAdminUnlocked()) {
      setView('admin');
      return;
    }
    setAdminPassword('');
    setAdminConfirm('');
    setAdminOpen(true);
  }

  async function submitAdmin(event) {
    event.preventDefault();
    setAdminError('');
    setBusy(true);
    const response = api.adminConfigured()
      ? await api.adminLogin({ email: adminEmail, password: adminPassword })
      : await api.setupAdmin(adminPassword, adminConfirm);
    setBusy(false);
    if (!response.ok) {
      setAdminError(response.error);
      return;
    }
    setAdminOpen(false);
    setAdminPassword('');
    setAdminConfirm('');
    setView('admin');
  }

  const today = saoPauloParts(now).dayKey;
  const expected = selected ? nextType(selected.schedule_code, today, punches) : null;
  const setup = !api.adminConfigured();

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><img src={`${import.meta.env.BASE_URL}logo-loja.png`} alt="Loja do Cabeleireiro" /><div><span className="eyebrow">CONTROLE INTERNO DE JORNADA</span><h1>Ponto Fácil</h1></div></div>
      <div className="clock"><div>{fmtDate(now)}</div><strong>{fmtTime(now)}</strong><span>Pedro Leopoldo · MG</span></div>
    </header>
    {notice && <div className="notice"><AlertCircle size={18} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Fechar aviso">×</button></div>}

    {view === 'home' && <main className="main">
      <section className="welcome">
        <div><span className="eyebrow gold">BEM-VINDA À LOJA</span><h2>Registro de ponto</h2><p>Selecione seu nome para iniciar uma marcação.</p></div>
        <div className="welcome-icon"><Clock3 size={27} /></div>
      </section>
      {api.mode !== 'remote' && <div className="demo-banner"><AlertCircle size={18} /><div><strong>Registros salvos no banco deste computador.</strong><span>Limpar o navegador não apaga o ponto. O arquivo fica em data/ponto.sqlite. Para usar em mais de um aparelho, conecte o Supabase.</span></div></div>}
      {loading ? <div className="empty">Carregando colaboradoras…</div> : people.length === 0 ? <div className="empty">Nenhuma colaboradora cadastrada. O administrador pode incluir a equipe no painel.</div> : <div className="people-grid">{people.map((person) => <button className="person-card" key={person.id} onClick={() => openPerson(person)}><div className="avatar">{person.photo_url ? <img src={person.photo_url} alt="" /> : <span>{initials(person.full_name)}</span>}</div><strong>{person.full_name}</strong><span className="person-schedule">Jornada {person.schedule_code || 'não definida'}</span><span className="card-cta">Bater ponto <span>→</span></span></button>)}</div>}
      <div className="footer-note"><ShieldCheck size={17} /> Registro individual · Acesso protegido por senha</div>
      <button className="admin-link" onClick={openAdmin}><Settings size={16} /> Acesso do administrador</button>
    </main>}

    {view === 'pin' && selected && <main className="narrow panel">
      <button className="back" onClick={goHome}>← Voltar à tela inicial</button>
      <div className="avatar large">{selected.photo_url ? <img src={selected.photo_url} alt="" /> : <span>{initials(selected.full_name)}</span>}</div>
      <h2>{selected.full_name}</h2>
      <p className="muted">Confirme sua identidade com sua senha pessoal.</p>
      <form onSubmit={verifyPin} className="pin-form">
        <label htmlFor="pin">Senha pessoal</label>
        <div className="pin-dots" aria-hidden="true">{Array.from({ length: Math.max(4, pin.length) }, (_, index) => <span key={index} className={index < pin.length ? 'on' : ''} />)}</div>
        <input id="pin" className="pin-field" type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(event) => { setPin(event.target.value.replace(/\D/g, '').slice(0, 6)); setPinError(''); }} placeholder="••••" autoFocus />
        <div className="pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '←'].map((digit) => digit
            ? <button type="button" key={digit} onClick={() => pressDigit(digit)}>{digit}</button>
            : <span key="gap" />)}
        </div>
        <button className="primary" disabled={busy}>{busy ? 'Verificando…' : 'Continuar'}</button>
        {pinError && <p className="error">{pinError}</p>}
      </form>
      <p className="small-muted">Não compartilhe sua senha com outras pessoas.</p>
    </main>}

    {view === 'confirm' && selected && <main className="narrow panel">
      <div className="success-icon"><CheckCircle2 size={32} /></div>
      <h2>{expected ? 'Confirmar marcação' : 'Jornada de hoje'}</h2>
      <p className="muted">{selected.full_name}</p>
      {punches.length > 0 && <ul className="punch-recap">{[...punches].sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)).map((punch) => <li key={punch.id}><span>{PUNCH_LABELS[punch.punch_type]}</span><strong>{fmtTime(new Date(punch.recorded_at))}</strong></li>)}</ul>}
      {expected ? <>
        <div className="next-punch"><span>Próxima marcação</span><strong>{punchLabel(expected, selected.schedule_code, today)}</strong><small>{fmtDate(now)} às {fmtTime(now)}</small></div>
        <p className="muted">{api.mode === 'remote' ? 'O horário gravado é o do servidor.' : 'O horário gravado é o deste computador e fica no banco.'}</p>
        <div className="actions">
          <button className="primary" onClick={() => registerPunch(expected)} disabled={busy}>{busy ? 'Registrando…' : `Confirmar ${punchLabel(expected, selected.schedule_code, today).toLowerCase()}`}</button>
          <button className="secondary" onClick={goHome}>Cancelar</button>
        </div>
      </> : <>
        <div className="next-punch"><span>Marcações de hoje</span><strong>Tudo registrado</strong><small>Se houver algum erro, peça o ajuste ao administrador.</small></div>
        <button className="primary full" onClick={goHome}>Voltar</button>
      </>}
    </main>}

    {view === 'success' && selected && result && <main className="narrow panel">
      <div className="success-icon"><CheckCircle2 size={34} /></div>
      <h2>Marcação concluída</h2>
      <p className="muted">{selected.full_name}</p>
      <div className="next-punch"><span>{punchLabel(result.punch_type, selected.schedule_code, today)}</span><strong>{fmtTime(new Date(result.recorded_at))}</strong><small>{fmtDate(new Date(result.recorded_at))}</small></div>
      <p className="muted">Guarde esta confirmação. O administrador consegue consultar o registro.</p>
      <button className="primary full" onClick={goHome}>Concluir</button>
    </main>}

    {view === 'admin' && <Admin onClose={goHome} onNotice={setNotice} />}

    {adminOpen && <div className="modal-backdrop"><div className="modal">
      <button className="modal-close" onClick={() => setAdminOpen(false)} aria-label="Fechar">×</button>
      <div className="modal-icon"><ShieldCheck /></div>
      <h2>{setup ? 'Criar acesso do administrador' : 'Acesso do administrador'}</h2>
      <p className="muted">{setup ? 'Esta senha abre o cadastro da equipe e os relatórios neste tablet.' : 'Entre para consultar a jornada, corrigir marcações e exportar o mês.'}</p>
      <form onSubmit={submitAdmin}>
        {api.mode === 'remote' && <label>E-mail administrativo<input type="email" required value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} placeholder="seu@email.com" autoComplete="username" /></label>}
        <label>{setup ? 'Senha do administrador' : 'Senha'}<input type="password" required value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} placeholder={setup ? 'Mínimo de 6 caracteres' : 'Sua senha'} autoComplete={setup ? 'new-password' : 'current-password'} /></label>
        {setup && <label>Confirmar senha<input type="password" required value={adminConfirm} onChange={(event) => setAdminConfirm(event.target.value)} autoComplete="new-password" /></label>}
        {adminError && <p className="error">{adminError}</p>}
        <button className="primary full" disabled={busy} type="submit">{busy ? 'Entrando…' : setup ? 'Criar e entrar' : 'Entrar'}</button>
      </form>
    </div></div>}
    <footer>LOJA DO CABELEIREIRO <span>•</span> PONTO FÁCIL <span>•</span> CONTROLE INTERNO</footer>
  </div>;
}
