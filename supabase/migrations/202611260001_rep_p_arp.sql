-- REP-P / ARP — estrutura inicial aditiva
-- Aplicar somente após backup do banco. Não altera nem remove punches existentes.
-- As migrations seguintes integram o fluxo transacional de marcação à ARP.

begin;

create table if not exists public.establishments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  document_number text,
  timezone text not null default 'America/Sao_Paulo',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint establishments_document_number_unique unique (document_number)
);

-- A instalação atual atende a um único estabelecimento. Cria o registro inicial
-- apenas se ainda não existir e associa os empregados legados a ele.
insert into public.establishments (name)
select 'Loja do Cabeleireiro'
where not exists (select 1 from public.establishments);

alter table public.employees
  add column if not exists cpf text,
  add column if not exists establishment_id uuid;

update public.employees
set establishment_id = (select id from public.establishments order by created_at, id limit 1)
where establishment_id is null;

alter table public.employees
  add constraint employees_establishment_fk
  foreign key (establishment_id) references public.establishments(id);

create unique index if not exists employees_cpf_unique
  on public.employees (cpf)
  where cpf is not null and btrim(cpf) <> '';

create index if not exists employees_establishment_idx
  on public.employees (establishment_id);

-- Sequência NSR independente por estabelecimento.
create table if not exists public.rep_sequences (
  establishment_id uuid primary key references public.establishments(id),
  last_nsr bigint not null default 0 check (last_nsr >= 0),
  updated_at timestamptz not null default now()
);

insert into public.rep_sequences (establishment_id, last_nsr)
select e.id, 0
from public.establishments e
on conflict (establishment_id) do nothing;

-- Registro original de marcações da ARP. Não substitui a tabela legada punches.
create table if not exists public.time_marks (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments(id),
  employee_id uuid not null references public.employees(id),
  nsr bigint not null check (nsr > 0),
  punch_type public.punch_kind not null,
  recorded_at timestamptz not null,
  timezone text not null default 'America/Sao_Paulo',
  source text not null default 'tablet',
  collector_id text not null,
  client_request_id uuid not null,
  previous_hash text,
  record_hash text not null,
  created_at timestamptz not null default now(),
  constraint time_marks_establishment_nsr_unique unique (establishment_id, nsr),
  constraint time_marks_employee_request_unique unique (employee_id, client_request_id)
);

create index if not exists time_marks_employee_recorded_idx
  on public.time_marks (employee_id, recorded_at);

create index if not exists time_marks_establishment_recorded_idx
  on public.time_marks (establishment_id, recorded_at);

-- Eventos técnicos e administrativos relacionados ao REP-P.
create table if not exists public.rep_events (
  id uuid primary key default gen_random_uuid(),
  establishment_id uuid not null references public.establishments(id),
  event_type text not null,
  actor_id uuid references auth.users(id) on delete set null,
  related_mark_id uuid references public.time_marks(id),
  event_payload jsonb not null default '{}'::jsonb,
  event_hash text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists rep_events_establishment_occurred_idx
  on public.rep_events (establishment_id, occurred_at);

-- Alocação atômica: o UPDATE bloqueia a linha da sequência durante a transação.
create or replace function public.allocate_rep_nsr(p_establishment_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  allocated bigint;
begin
  update public.rep_sequences
     set last_nsr = last_nsr + 1,
         updated_at = clock_timestamp()
   where establishment_id = p_establishment_id
   returning last_nsr into allocated;

  if allocated is null then
    raise exception 'Sequência NSR não configurada para o estabelecimento.';
  end if;

  return allocated;
end;
$$;

-- Proteção adicional no banco: marcações originais não podem ser alteradas
-- ou removidas. Correções devem ser registradas em fluxo separado de tratamento.
create or replace function public.reject_time_mark_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Marcações originais são imutáveis; registre o tratamento em evento separado.';
end;
$$;

drop trigger if exists time_marks_immutable on public.time_marks;
create trigger time_marks_immutable
before update or delete on public.time_marks
for each row execute function public.reject_time_mark_mutation();

alter table public.establishments enable row level security;
alter table public.rep_sequences enable row level security;
alter table public.time_marks enable row level security;
alter table public.rep_events enable row level security;

drop policy if exists "establishments admin read" on public.establishments;
create policy "establishments admin read" on public.establishments
  for select to authenticated using (public.is_admin());

drop policy if exists "rep sequences admin read" on public.rep_sequences;
create policy "rep sequences admin read" on public.rep_sequences
  for select to authenticated using (public.is_admin());

drop policy if exists "time marks admin or own read" on public.time_marks;
create policy "time marks admin or own read" on public.time_marks
  for select to authenticated
  using (
    public.is_admin()
    or employee_id in (
      select e.id from public.employees e where e.auth_user_id = auth.uid()
    )
  );

drop policy if exists "rep events admin read" on public.rep_events;
create policy "rep events admin read" on public.rep_events
  for select to authenticated using (public.is_admin());

-- Escrita da ARP será feita exclusivamente pelo backend confiável (service_role).
revoke insert, update, delete on public.establishments from anon, authenticated;
revoke insert, update, delete on public.rep_sequences from anon, authenticated;
revoke insert, update, delete on public.time_marks from anon, authenticated;
revoke insert, update, delete on public.rep_events from anon, authenticated;
revoke all on function public.allocate_rep_nsr(uuid) from public, anon, authenticated;
grant execute on function public.allocate_rep_nsr(uuid) to service_role;

commit;
