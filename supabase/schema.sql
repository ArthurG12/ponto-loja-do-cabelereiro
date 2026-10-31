-- Ponto Fácil — esquema para um projeto Supabase novo ou já iniciado.
-- Pode ser executado de novo: cria o que falta e recria funções e políticas.
-- Não coloque a chave service_role no aplicativo. Só a chave anon.

create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('admin', 'employee');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.punch_kind as enum ('entrada', 'saida_intervalo', 'retorno_intervalo', 'saida');
exception when duplicate_object then null;
end $$;

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null,
  email text,
  phone text,
  photo_url text,
  schedule_code text not null default 'A' check (schedule_code in ('A', 'B')),
  hire_date date,
  active boolean not null default true,
  pin_hash text,
  failed_pin_attempts integer not null default 0,
  pin_locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employees add column if not exists failed_pin_attempts integer not null default 0;
alter table public.employees add column if not exists pin_locked_until timestamptz;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'employee',
  employee_id uuid unique,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.profiles
    add constraint profiles_employee_fk
    foreign key (employee_id) references public.employees(id) on delete set null;
exception when duplicate_object then null;
end $$;

create table if not exists public.punches (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  punch_type public.punch_kind not null,
  recorded_at timestamptz not null default now(),
  source text not null default 'tablet',
  client_request_id uuid not null,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  unique (employee_id, client_request_id)
);

alter table public.punches add column if not exists voided_at timestamptz;
alter table public.punches add column if not exists void_reason text;
create index if not exists punches_employee_recorded_idx on public.punches (employee_id, recorded_at);

create table if not exists public.punch_corrections (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  original_punch_id uuid references public.punches(id),
  requested_at timestamptz,
  requested_type public.punch_kind,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

create table if not exists public.justifications (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  category text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  notes text,
  document_path text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (ends_at >= starts_at)
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.employees enable row level security;
alter table public.punches enable row level security;
alter table public.punch_corrections enable row level security;
alter table public.justifications enable row level security;
alter table public.audit_log enable row level security;

revoke select (pin_hash, failed_pin_attempts, pin_locked_until) on public.employees from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

create or replace function public.punch_sequence_for(p_schedule text, p_day date)
returns public.punch_kind[]
language sql
immutable
as $$
  select case
    when extract(dow from p_day) in (0, 6) then array['entrada', 'saida']::public.punch_kind[]
    else array['entrada', 'saida_intervalo', 'retorno_intervalo', 'saida']::public.punch_kind[]
  end;
$$;

create or replace function public.punch_label(p_type public.punch_kind)
returns text
language sql
immutable
as $$
  select case p_type
    when 'entrada' then 'Entrada'
    when 'saida_intervalo' then 'Saída para almoço'
    when 'retorno_intervalo' then 'Retorno do almoço'
    when 'saida' then 'Saída'
    else p_type::text
  end;
$$;

-- Confere a senha no servidor, trava depois de 5 erros e nunca devolve o hash.
create or replace function public.assert_employee_pin(employee_uuid uuid, submitted_pin text)
returns public.employees
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e public.employees%rowtype;
begin
  if submitted_pin is null or submitted_pin !~ '^[0-9]{4,6}$' then
    raise exception 'Senha inválida.';
  end if;

  select * into e from public.employees where id = employee_uuid for update;
  if not found or not e.active or e.pin_hash is null then
    raise exception 'Senha inválida.';
  end if;

  if e.pin_locked_until is not null and e.pin_locked_until > now() then
    raise exception 'Muitas tentativas. Aguarde 15 minutos e tente de novo.';
  end if;

  if e.pin_hash <> crypt(submitted_pin, e.pin_hash) then
    if e.failed_pin_attempts + 1 >= 5 then
      update public.employees
        set failed_pin_attempts = 0,
            pin_locked_until = now() + interval '15 minutes'
      where id = e.id;
    else
      update public.employees
        set failed_pin_attempts = e.failed_pin_attempts + 1,
            pin_locked_until = null
      where id = e.id;
    end if;
    raise exception 'Senha inválida.';
  end if;

  update public.employees
    set failed_pin_attempts = 0, pin_locked_until = null
  where id = e.id;
  return e;
end;
$$;

create or replace function public.assert_punch_order(
  p_employee uuid,
  p_schedule text,
  p_day date,
  p_ignore uuid,
  p_type public.punch_kind,
  p_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  seq public.punch_kind[] := public.punch_sequence_for(p_schedule, p_day);
  new_idx int := array_position(seq, p_type);
  other public.punches%rowtype;
  other_idx int;
begin
  if new_idx is null then
    raise exception 'Esse tipo de marcação não faz parte da jornada deste dia.';
  end if;
  for other in
    select * from public.punches p
    where p.employee_id = p_employee
      and p.voided_at is null
      and (p_ignore is null or p.id <> p_ignore)
      and (p.recorded_at at time zone 'America/Sao_Paulo')::date = p_day
  loop
    other_idx := array_position(seq, other.punch_type);
    if other_idx is null then
      continue;
    end if;
    if other_idx < new_idx and other.recorded_at >= p_at then
      raise exception 'Os horários precisam seguir a ordem da jornada.';
    end if;
    if other_idx > new_idx and other.recorded_at <= p_at then
      raise exception 'Os horários precisam seguir a ordem da jornada.';
    end if;
    if other.punch_type = p_type then
      raise exception 'Já existe essa marcação neste dia.';
    end if;
  end loop;
end;
$$;

create or replace function public.list_active_employees()
returns table (
  id uuid,
  full_name text,
  photo_url text,
  schedule_code text,
  active boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.full_name, e.photo_url, e.schedule_code, e.active
  from public.employees e
  where e.active
  order by e.full_name;
$$;

create or replace function public.verify_employee_pin(employee_uuid uuid, submitted_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_employee_pin(employee_uuid, submitted_pin);
  return true;
end;
$$;

create or replace function public.list_employee_punches(
  employee_uuid uuid,
  submitted_pin text,
  p_day date
)
returns table (
  id uuid,
  employee_id uuid,
  punch_type public.punch_kind,
  recorded_at timestamptz,
  source text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_employee_pin(employee_uuid, submitted_pin);
  return query
    select p.id, p.employee_id, p.punch_type, p.recorded_at, p.source
    from public.punches p
    where p.employee_id = employee_uuid
      and p.voided_at is null
      and (p.recorded_at at time zone 'America/Sao_Paulo')::date = p_day
    order by p.recorded_at;
end;
$$;

create or replace function public.register_punch(
  employee_uuid uuid,
  submitted_pin text,
  requested_type public.punch_kind,
  client_request_id uuid
) returns public.punches
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.employees%rowtype;
  result public.punches%rowtype;
  day date := (now() at time zone 'America/Sao_Paulo')::date;
  seq public.punch_kind[];
  last_type public.punch_kind;
  expected public.punch_kind;
  idx int;
begin
  e := public.assert_employee_pin(employee_uuid, submitted_pin);

  select * into result
  from public.punches p
  where p.employee_id = employee_uuid and p.client_request_id = register_punch.client_request_id;
  if found then
    return result;
  end if;

  select p.punch_type into last_type
  from public.punches p
  where p.employee_id = employee_uuid
    and p.voided_at is null
    and (p.recorded_at at time zone 'America/Sao_Paulo')::date = day
  order by p.recorded_at desc
  limit 1;

  seq := public.punch_sequence_for(e.schedule_code, day);
  if last_type is null then
    expected := seq[1];
  else
    idx := array_position(seq, last_type);
    if idx is null or idx = array_length(seq, 1) then
      raise exception 'As marcações de hoje já foram realizadas.';
    end if;
    expected := seq[idx + 1];
  end if;

  if requested_type is distinct from expected then
    raise exception 'A próxima marcação esperada é %.', public.punch_label(expected);
  end if;

  insert into public.punches (employee_id, punch_type, source, client_request_id)
  values (employee_uuid, requested_type, 'tablet', register_punch.client_request_id)
  returning * into result;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (
    auth.uid(),
    'punch_registered',
    'punch',
    result.id::text,
    jsonb_build_object('employee_id', employee_uuid, 'type', requested_type)
  );
  return result;
end;
$$;

create or replace function public.admin_save_employee(
  p_id uuid,
  p_name text,
  p_schedule text,
  p_pin text,
  p_active boolean
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário.';
  end if;
  if p_name is null or length(trim(p_name)) < 3 then
    raise exception 'Informe o nome da colaboradora.';
  end if;
  if p_schedule not in ('A', 'B') then
    raise exception 'Escolha a jornada A ou B.';
  end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'A senha precisa ter de 4 a 6 números.';
  end if;
  if p_id is null and p_pin is null then
    raise exception 'Defina uma senha numérica de 4 a 6 dígitos.';
  end if;

  if p_id is null then
    insert into public.employees (full_name, schedule_code, active, pin_hash)
    values (trim(p_name), p_schedule, coalesce(p_active, true), crypt(p_pin, gen_salt('bf')))
    returning id into new_id;
  else
    update public.employees
      set full_name = trim(p_name),
          schedule_code = p_schedule,
          active = coalesce(p_active, active),
          pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf')) end,
          failed_pin_attempts = case when p_pin is null then failed_pin_attempts else 0 end,
          pin_locked_until = case when p_pin is null then pin_locked_until else null end,
          updated_at = now()
    where id = p_id
    returning id into new_id;
    if new_id is null then
      raise exception 'Colaboradora não encontrada.';
    end if;
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'employee_saved', 'employee', new_id::text, jsonb_build_object('active', coalesce(p_active, true)));
  return new_id;
end;
$$;

create or replace function public.admin_adjust_punch(
  p_action text,
  p_punch_id uuid,
  p_employee_id uuid,
  p_type public.punch_kind,
  p_recorded_at timestamptz,
  p_reason text
) returns public.punches
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.punches%rowtype;
  result public.punches%rowtype;
  day date;
  sched text;
begin
  if not public.is_admin() then
    raise exception 'Acesso de administrador necessário.';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'Informe o motivo do ajuste.';
  end if;

  if p_action = 'void' then
    select * into target from public.punches where id = p_punch_id and voided_at is null;
    if not found then
      raise exception 'Marcação não encontrada.';
    end if;
    update public.punches
      set voided_at = now(), void_reason = trim(p_reason)
    where id = target.id
    returning * into result;
    insert into public.punch_corrections (employee_id, original_punch_id, requested_type, reason, status, reviewed_by, reviewed_at, review_note)
    values (result.employee_id, result.id, result.punch_type, trim(p_reason), 'approved', auth.uid(), now(), 'Anulada pelo administrador');
    insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'punch_voided', 'punch', result.id::text, jsonb_build_object('reason', trim(p_reason)));
    return result;
  end if;

  if p_recorded_at is null then
    raise exception 'Informe o horário.';
  end if;
  day := (p_recorded_at at time zone 'America/Sao_Paulo')::date;

  if p_action = 'retime' then
    select * into target from public.punches where id = p_punch_id and voided_at is null;
    if not found then
      raise exception 'Marcação não encontrada.';
    end if;
    if (target.recorded_at at time zone 'America/Sao_Paulo')::date <> day then
      raise exception 'A correção precisa permanecer no mesmo dia.';
    end if;
    select schedule_code into sched from public.employees where id = target.employee_id;
    perform public.assert_punch_order(target.employee_id, sched, day, target.id, target.punch_type, p_recorded_at);
    update public.punches set recorded_at = p_recorded_at where id = target.id returning * into result;
    insert into public.punch_corrections (employee_id, original_punch_id, requested_at, requested_type, reason, status, reviewed_by, reviewed_at, review_note)
    values (result.employee_id, result.id, p_recorded_at, result.punch_type, trim(p_reason), 'approved', auth.uid(), now(), 'Horário corrigido');
    insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'punch_retimed', 'punch', result.id::text, jsonb_build_object('reason', trim(p_reason)));
    return result;
  end if;

  if p_action = 'insert' then
    if p_employee_id is null or p_type is null then
      raise exception 'Informe a colaboradora e o tipo da marcação.';
    end if;
    select schedule_code into sched from public.employees where id = p_employee_id;
    if sched is null then
      raise exception 'Colaboradora não encontrada.';
    end if;
    perform public.assert_punch_order(p_employee_id, sched, day, null, p_type, p_recorded_at);
    insert into public.punches (employee_id, punch_type, recorded_at, source, client_request_id)
    values (p_employee_id, p_type, p_recorded_at, 'ajuste', gen_random_uuid())
    returning * into result;
    insert into public.punch_corrections (employee_id, original_punch_id, requested_at, requested_type, reason, status, reviewed_by, reviewed_at, review_note)
    values (p_employee_id, result.id, p_recorded_at, p_type, trim(p_reason), 'approved', auth.uid(), now(), 'Marcação incluída');
    insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'punch_inserted', 'punch', result.id::text, jsonb_build_object('reason', trim(p_reason)));
    return result;
  end if;

  raise exception 'Ajuste inválido.';
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_count int;
begin
  select count(*) into admin_count from public.profiles where role = 'admin';
  insert into public.profiles (id, role)
  values (new.id, case when admin_count = 0 then 'admin'::public.app_role else 'employee'::public.app_role end)
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$ begin
  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
exception when insufficient_privilege or undefined_table then
  raise notice 'Não foi possível criar o gatilho do primeiro administrador. Depois de criar o usuário em Authentication, rode: insert into public.profiles (id, role) values (''UUID'', ''admin'');';
end $$;

drop policy if exists "profiles self or admin" on public.profiles;
drop policy if exists "employees admin or own profile" on public.employees;
drop policy if exists "employees admin insert" on public.employees;
drop policy if exists "employees admin update" on public.employees;
drop policy if exists "punches admin or own" on public.punches;
drop policy if exists "corrections self or admin read" on public.punch_corrections;
drop policy if exists "corrections self insert" on public.punch_corrections;
drop policy if exists "corrections admin update" on public.punch_corrections;
drop policy if exists "justifications admin only" on public.justifications;
drop policy if exists "audit admin read" on public.audit_log;

create policy "profiles self or admin" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy "employees admin or own profile" on public.employees
  for select to authenticated
  using (public.is_admin() or auth_user_id = auth.uid());

create policy "employees admin insert" on public.employees
  for insert to authenticated
  with check (public.is_admin());

create policy "employees admin update" on public.employees
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "punches admin or own" on public.punches
  for select to authenticated
  using (
    public.is_admin()
    or employee_id in (select e.id from public.employees e where e.auth_user_id = auth.uid())
  );

create policy "corrections self or admin read" on public.punch_corrections
  for select to authenticated
  using (
    public.is_admin()
    or employee_id in (select e.id from public.employees e where e.auth_user_id = auth.uid())
  );

create policy "corrections self insert" on public.punch_corrections
  for insert to authenticated
  with check (employee_id in (select e.id from public.employees e where e.auth_user_id = auth.uid()) or public.is_admin());

create policy "corrections admin update" on public.punch_corrections
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "justifications admin only" on public.justifications
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "audit admin read" on public.audit_log
  for select to authenticated
  using (public.is_admin());

revoke all on function public.assert_employee_pin(uuid, text) from public, anon, authenticated;
revoke all on function public.assert_punch_order(uuid, text, date, uuid, public.punch_kind, timestamptz) from public, anon, authenticated;
revoke all on function public.punch_sequence_for(text, date) from public, anon, authenticated;
revoke all on function public.punch_label(public.punch_kind) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.list_active_employees() to anon, authenticated;
grant execute on function public.verify_employee_pin(uuid, text) to anon, authenticated;
grant execute on function public.list_employee_punches(uuid, text, date) to anon, authenticated;
grant execute on function public.register_punch(uuid, text, public.punch_kind, uuid) to anon, authenticated;
grant execute on function public.admin_save_employee(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.admin_adjust_punch(text, uuid, uuid, public.punch_kind, timestamptz, text) to authenticated;

-- Primeiro usuário criado em Authentication vira administrador pelo gatilho acima.
-- Se o gatilho não puder ser criado, insira o perfil na mão:
-- insert into public.profiles (id, role) values ('UUID-DO-USUARIO', 'admin');
