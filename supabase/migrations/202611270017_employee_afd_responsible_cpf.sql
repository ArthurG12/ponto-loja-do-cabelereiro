-- REP-P / AFD v004 — completar o responsável nos registros cadastrais tipo 5.
begin;

create or replace function public.capture_employee_afd_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $employee$
declare
  operation_code text;
  event_payload jsonb;
  actor_id uuid := auth.uid();
  responsible_cpf text;
begin
  if tg_op = 'UPDATE' then
    if row(
      old.full_name, old.cpf, old.hire_date, old.schedule_code,
      old.active, old.email, old.phone
    ) is not distinct from row(
      new.full_name, new.cpf, new.hire_date, new.schedule_code,
      new.active, new.email, new.phone
    ) then
      return new;
    end if;
    operation_code := case when old.active and not new.active then 'E' else 'A' end;
  else
    operation_code := 'I';
  end if;

  if actor_id is null or not public.is_admin() then
    raise exception 'Acesso de administrador necessário para evento AFD tipo 5.';
  end if;

  select p.cpf into responsible_cpf
    from public.profiles p where p.id = actor_id;
  if responsible_cpf is null or not public.rep_is_valid_cpf(responsible_cpf) then
    raise exception 'Cadastre o CPF válido do responsável antes de alterar empregados.';
  end if;
  if new.cpf is null or not public.rep_is_valid_cpf(new.cpf) then
    raise exception 'O CPF válido do empregado é obrigatório para registro AFD tipo 5.';
  end if;
  if new.establishment_id is null then
    raise exception 'Empregada sem estabelecimento: evento AFD tipo 5 não pode ser registrado.';
  end if;

  event_payload := jsonb_build_object(
    'operation', operation_code,
    'employee_id', new.id,
    'cpf', new.cpf,
    'full_name', new.full_name,
    'hire_date', new.hire_date,
    'schedule_code', new.schedule_code,
    'active', new.active,
    'email', new.email,
    'phone', new.phone,
    'responsible_cpf', responsible_cpf
  );

  perform public.append_rep_afd_event(
    new.establishment_id, '5', event_payload, clock_timestamp(), actor_id
  );
  return new;
end;
$employee$;

revoke all on function public.capture_employee_afd_event()
  from public, anon, authenticated;

commit;
