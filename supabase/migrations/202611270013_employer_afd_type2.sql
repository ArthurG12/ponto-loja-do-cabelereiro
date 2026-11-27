-- REP-P — AFD tipo 2: inclusão/alteração da identificação do empregador.
-- O CPF do responsável é cadastrado no perfil administrativo e não é exposto via Data API.
begin;

alter table public.profiles
  add column if not exists cpf text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_cpf_format_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_cpf_format_check
      check (cpf is null or cpf ~ '^[0-9]{11}$');
  end if;
end $$;

create or replace function public.admin_set_responsible_cpf(p_cpf text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  actor uuid := auth.uid();
  normalized_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g');
begin
  if actor is null or not public.is_admin() then
    raise exception 'Acesso de administrador necessário.';
  end if;
  if not public.rep_is_valid_cpf(normalized_cpf) then
    raise exception 'Informe um CPF válido do responsável.';
  end if;

  update public.profiles
     set cpf = normalized_cpf
   where id = actor;

  if not found then
    raise exception 'Perfil administrativo não encontrado.';
  end if;
end;
$$;

revoke all on function public.admin_set_responsible_cpf(text)
  from public, anon;
grant execute on function public.admin_set_responsible_cpf(text)
  to authenticated;

create or replace function public.capture_employer_afd_type2()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  actor uuid := auth.uid();
  actor_cpf text;
  changed boolean := false;
  event_payload jsonb;
  event_time timestamptz := clock_timestamp();
begin
  if tg_op = 'UPDATE' then
    changed := row(
      old.employer_id_type, old.employer_document, old.cno_caepf,
      old.legal_name, old.service_location
    ) is distinct from row(
      new.employer_id_type, new.employer_document, new.cno_caepf,
      new.legal_name, new.service_location
    );
    if not changed then
      return new;
    end if;
  else
    changed := true;
  end if;

  if actor is null or not public.is_admin() then
    raise exception 'Alteração dos dados do empregador exige administrador autenticado.';
  end if;

  select p.cpf into actor_cpf
    from public.profiles p
   where p.id = actor;

  if actor_cpf is null or not public.rep_is_valid_cpf(actor_cpf) then
    raise exception 'Cadastre o CPF válido do responsável antes de alterar os dados do empregador.';
  end if;

  if new.employer_id_type not in ('1','2')
     or new.employer_document is null
     or (new.employer_id_type = '1' and new.employer_document !~ '^[0-9]{14}$')
     or (new.employer_id_type = '2' and new.employer_document !~ '^[0-9]{11}$') then
    raise exception 'Identificação do empregador inválida: informe CNPJ (14 dígitos) ou CPF (11 dígitos).';
  end if;

  if new.cno_caepf is not null and new.cno_caepf !~ '^[0-9]{12,14}$' then
    raise exception 'CNO/CAEPF deve conter de 12 a 14 dígitos.';
  end if;

  if new.legal_name is null or length(btrim(new.legal_name)) not between 1 and 150 then
    raise exception 'Razão social/nome do empregador deve conter de 1 a 150 caracteres.';
  end if;

  if new.service_location is null or length(btrim(new.service_location)) not between 1 and 100 then
    raise exception 'Local de prestação de serviços deve conter de 1 a 100 caracteres.';
  end if;

  event_payload := jsonb_build_object(
    'recorded_at', public.rep_afd_format_dh(event_time, new.timezone),
    'responsible_cpf', actor_cpf,
    'employer_id_type', new.employer_id_type,
    'employer_document', new.employer_document,
    'cno_caepf', new.cno_caepf,
    'legal_name', btrim(new.legal_name),
    'service_location', btrim(new.service_location)
  );

  perform public.append_rep_afd_event(
    new.id,
    '2',
    event_payload,
    event_time,
    actor
  );

  return new;
end;
$$;

drop trigger if exists establishments_capture_afd_type2 on public.establishments;
create trigger establishments_capture_afd_type2
after update of employer_id_type, employer_document, cno_caepf, legal_name, service_location
on public.establishments
for each row
execute function public.capture_employer_afd_type2();

revoke all on function public.capture_employer_afd_type2()
  from public, anon, authenticated;

create or replace function public.admin_save_establishment(
  p_establishment_id uuid,
  p_employer_id_type text,
  p_employer_document text,
  p_cno_caepf text,
  p_legal_name text,
  p_service_location text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  saved_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Acesso de administrador necessário.';
  end if;

  update public.establishments
     set employer_id_type = p_employer_id_type,
         employer_document = regexp_replace(coalesce(p_employer_document, ''), '[^0-9]', '', 'g'),
         cno_caepf = nullif(regexp_replace(coalesce(p_cno_caepf, ''), '[^0-9]', '', 'g'), ''),
         legal_name = btrim(coalesce(p_legal_name, '')),
         service_location = btrim(coalesce(p_service_location, '')),
         updated_at = clock_timestamp()
   where id = p_establishment_id
     and active = true
  returning id into saved_id;

  if saved_id is null then
    raise exception 'Estabelecimento ativo não encontrado.';
  end if;

  return saved_id;
end;
$$;

revoke all on function public.admin_save_establishment(uuid,text,text,text,text,text)
  from public, anon;
grant execute on function public.admin_save_establishment(uuid,text,text,text,text,text)
  to authenticated;

commit;
