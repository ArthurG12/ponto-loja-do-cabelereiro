-- REP-P — registrar inclusões, alterações e desativações de empregados no AFD tipo 5.
-- O trigger roda na mesma transação da alteração cadastral; qualquer falha no
-- livro/NSR cancela também a alteração em employees.
begin;

create or replace function public.capture_employee_afd_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  operation_code text;
  event_payload jsonb;
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

    operation_code := case
      when old.active and not new.active then 'E'
      else 'A'
    end;
  else
    operation_code := 'I';
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
    'phone', new.phone
  );

  perform public.append_rep_afd_event(
    new.establishment_id,
    '5',
    event_payload,
    clock_timestamp(),
    auth.uid()
  );

  return new;
end;
$$;

drop trigger if exists employees_capture_afd_type5 on public.employees;
create trigger employees_capture_afd_type5
after insert or update on public.employees
for each row
execute function public.capture_employee_afd_event();

revoke all on function public.capture_employee_afd_event()
  from public, anon, authenticated;

commit;
