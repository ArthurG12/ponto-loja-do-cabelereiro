-- REP-P / AFD v004 — registrar também exclusões reais de empregados.
-- Mudança de estabelecimento é bloqueada: a transferência exige fluxo próprio
-- para gerar exclusão no estabelecimento de origem e inclusão no destino.
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
  employee_data public.employees%rowtype;
begin
  if tg_op = 'UPDATE' then
    if old.establishment_id is distinct from new.establishment_id then
      raise exception 'A transferência entre estabelecimentos exige fluxo REP-P específico; alteração direta bloqueada.';
    end if;

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
    employee_data := new;
  elsif tg_op = 'DELETE' then
    operation_code := 'E';
    employee_data := old;
  else
    operation_code := 'I';
    employee_data := new;
  end if;

  if actor_id is null or not public.is_admin() then
    raise exception 'Acesso de administrador necessário para evento AFD tipo 5.';
  end if;

  select p.cpf into responsible_cpf
    from public.profiles p where p.id = actor_id;
  if responsible_cpf is null or not public.rep_is_valid_cpf(responsible_cpf) then
    raise exception 'Cadastre o CPF válido do responsável antes de alterar empregados.';
  end if;
  if employee_data.cpf is null or not public.rep_is_valid_cpf(employee_data.cpf) then
    raise exception 'O CPF válido do empregado é obrigatório para registro AFD tipo 5.';
  end if;
  if employee_data.establishment_id is null then
    raise exception 'Empregada sem estabelecimento: evento AFD tipo 5 não pode ser registrado.';
  end if;

  event_payload := jsonb_build_object(
    'operation', operation_code,
    'employee_id', employee_data.id,
    'cpf', employee_data.cpf,
    'full_name', employee_data.full_name,
    'hire_date', employee_data.hire_date,
    'schedule_code', employee_data.schedule_code,
    'active', employee_data.active,
    'email', employee_data.email,
    'phone', employee_data.phone,
    'responsible_cpf', responsible_cpf
  );

  perform public.append_rep_afd_event(
    employee_data.establishment_id, '5', event_payload, clock_timestamp(), actor_id
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$employee$;

drop trigger if exists employees_capture_afd_type5 on public.employees;
create trigger employees_capture_afd_type5
after insert or update or delete on public.employees
for each row execute function public.capture_employee_afd_event();

revoke all on function public.capture_employee_afd_event()
  from public, anon, authenticated;

commit;
