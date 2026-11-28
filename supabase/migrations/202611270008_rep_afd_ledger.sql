-- REP-P / ARP — livro único de registros AFD e metadados normativos.
-- A migration preserva marcações existentes e não reclassifica hashes legados como normativos.
begin;

alter table public.establishments
  add column if not exists employer_id_type char(1),
  add column if not exists employer_document text,
  add column if not exists cno_caepf text,
  add column if not exists legal_name text,
  add column if not exists service_location text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'establishments_employer_id_type_check') then
    alter table public.establishments
      add constraint establishments_employer_id_type_check
      check (employer_id_type is null or employer_id_type in ('1','2'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'establishments_employer_document_digits_check') then
    alter table public.establishments
      add constraint establishments_employer_document_digits_check
      check (employer_document is null or employer_document ~ '^[0-9]{11,14}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'establishments_cno_caepf_digits_check') then
    alter table public.establishments
      add constraint establishments_cno_caepf_digits_check
      check (cno_caepf is null or cno_caepf ~ '^[0-9]{12,14}$');
  end if;
end $$;

alter table public.employees
  add column if not exists cpf_snapshot_version integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_cpf_format_check') then
    alter table public.employees
      add constraint employees_cpf_format_check
      check (cpf is null or cpf ~ '^[0-9]{11}$') not valid;
  end if;
end $$;

alter table public.time_marks
  add column if not exists employee_cpf_snapshot text,
  add column if not exists collector_type char(2),
  add column if not exists is_offline boolean not null default false,
  add column if not exists hash_version text not null default 'legacy-json-v1';

-- Livro canônico: cada NSR de um estabelecimento pertence a exatamente um registro AFD.
create table if not exists public.rep_ledger (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments(id),
  nsr bigint not null check (nsr > 0 and nsr <= 999999999),
  record_type char(1) not null check (record_type in ('2','4','5','6','7')),
  source_table text not null check (source_table in ('time_marks','rep_events')),
  source_id uuid not null,
  occurred_at timestamptz not null,
  record_payload jsonb not null,
  hash_version text not null,
  record_hash text,
  created_at timestamptz not null default clock_timestamp(),
  constraint rep_ledger_establishment_nsr_unique unique (establishment_id, nsr),
  constraint rep_ledger_source_unique unique (source_table, source_id)
);

create index if not exists rep_ledger_establishment_nsr_idx
  on public.rep_ledger (establishment_id, nsr);

create index if not exists rep_ledger_establishment_occurred_idx
  on public.rep_ledger (establishment_id, occurred_at);

alter table public.rep_ledger enable row level security;
revoke all on public.rep_ledger from anon, authenticated;
grant select on public.rep_ledger to service_role;
grant insert, update, delete on public.rep_ledger to service_role;

-- Preserva o NSR original e identifica explicitamente que o hash antigo não é
-- o hash normativo do registro 7 do AFD versão 004.
insert into public.rep_ledger (
  establishment_id, nsr, record_type, source_table, source_id,
  occurred_at, record_payload, hash_version, record_hash
)
select
  tm.establishment_id,
  tm.nsr,
  '7',
  'time_marks',
  tm.id,
  tm.recorded_at,
  jsonb_build_object(
    'employee_id', tm.employee_id,
    'employee_cpf_snapshot', tm.employee_cpf_snapshot,
    'punch_type', tm.punch_type,
    'recorded_at', tm.recorded_at,
    'timezone', tm.timezone,
    'collector_id', tm.collector_id,
    'collector_type', tm.collector_type,
    'is_offline', tm.is_offline
  ),
  tm.hash_version,
  tm.record_hash
from public.time_marks tm
on conflict (establishment_id, nsr) do nothing;

create or replace function public.reject_rep_ledger_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'O livro de registros REP-P é imutável.';
end;
$$;

drop trigger if exists rep_ledger_immutable on public.rep_ledger;
create trigger rep_ledger_immutable
before update or delete on public.rep_ledger
for each row execute function public.reject_rep_ledger_mutation();

create or replace function public.mirror_time_mark_to_rep_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.rep_ledger (
    establishment_id, nsr, record_type, source_table, source_id,
    occurred_at, record_payload, hash_version, record_hash
  ) values (
    new.establishment_id,
    new.nsr,
    '7',
    'time_marks',
    new.id,
    new.recorded_at,
    jsonb_build_object(
      'employee_id', new.employee_id,
      'employee_cpf_snapshot', new.employee_cpf_snapshot,
      'punch_type', new.punch_type,
      'recorded_at', new.recorded_at,
      'timezone', new.timezone,
      'collector_id', new.collector_id,
      'collector_type', new.collector_type,
      'is_offline', new.is_offline
    ),
    new.hash_version,
    new.record_hash
  );
  return new;
end;
$$;

drop trigger if exists time_marks_to_rep_ledger on public.time_marks;
create trigger time_marks_to_rep_ledger
after insert on public.time_marks
for each row execute function public.mirror_time_mark_to_rep_ledger();

-- Registra eventos que efetivamente compõem o AFD (tipos 2, 4, 5 e 6).
-- O NSR é alocado na mesma sequência usada pelas marcações tipo 7.
revoke all on function public.reject_rep_ledger_mutation() from public, anon, authenticated;
revoke all on function public.mirror_time_mark_to_rep_ledger() from public, anon, authenticated;

create or replace function public.append_rep_afd_event(
  p_establishment_id uuid,
  p_record_type text,
  p_payload jsonb,
  p_occurred_at timestamptz default null,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  next_nsr bigint;
  event_id uuid;
  event_time timestamptz := coalesce(p_occurred_at, clock_timestamp());
begin
  if p_record_type is null or p_record_type not in ('2','4','5','6') then
    raise exception 'Tipo de registro AFD não permitido para evento.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Payload do evento AFD deve ser um objeto JSON.';
  end if;
  if not exists (
    select 1 from public.establishments
    where id = p_establishment_id and active = true
  ) then
    raise exception 'Estabelecimento não encontrado ou inativo.';
  end if;
  if p_record_type = '6'
     and coalesce(p_payload->>'event_code','') not in ('02','07','08') then
    raise exception 'Evento sensível REP-P inválido.';
  end if;

  next_nsr := public.allocate_rep_nsr(p_establishment_id);

  insert into public.rep_events (
    establishment_id, event_type, actor_id, event_payload, occurred_at
  ) values (
    p_establishment_id,
    'afd_record_' || p_record_type,
    p_actor_id,
    p_payload,
    event_time
  ) returning id into event_id;

  insert into public.rep_ledger (
    establishment_id, nsr, record_type, source_table, source_id,
    occurred_at, record_payload, hash_version
  ) values (
    p_establishment_id, next_nsr, p_record_type, 'rep_events', event_id,
    event_time, p_payload, 'pending-afd-v004'
  );

  return jsonb_build_object('ok', true, 'nsr', next_nsr, 'event_id', event_id);
end;
$$;

revoke all on function public.append_rep_afd_event(uuid,text,jsonb,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.append_rep_afd_event(uuid,text,jsonb,timestamptz,uuid)
  to service_role;

commit;
