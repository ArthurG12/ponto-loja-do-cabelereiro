-- REP-P / ARP — leitura das marcações do próprio funcionário por PIN.
-- A função é chamada somente pelo backend confiável (service_role).
-- Não concede SELECT público em time_marks.

begin;

create or replace function public.list_employee_time_marks(
  p_employee_id uuid,
  p_submitted_pin text,
  p_day date
) returns setof public.time_marks
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  employee_row public.employees%rowtype;
  establishment_timezone text;
begin
  if p_submitted_pin is null or p_submitted_pin !~ '^[0-9]{4,6}$' then
    raise exception 'Senha inválida.';
  end if;

  select *
    into employee_row
    from public.employees
   where id = p_employee_id
   for update;

  if not found
     or not employee_row.active
     or employee_row.pin_hash is null
     or employee_row.pin_locked_until > clock_timestamp()
     or employee_row.pin_hash <> crypt(p_submitted_pin, employee_row.pin_hash) then
    raise exception 'Senha inválida ou acesso indisponível.';
  end if;

  select timezone
    into establishment_timezone
    from public.establishments
   where id = employee_row.establishment_id
     and active = true;

  if establishment_timezone is null then
    raise exception 'Estabelecimento não configurado.';
  end if;

  return query
  select tm.*
    from public.time_marks tm
   where tm.employee_id = p_employee_id
     and (tm.recorded_at at time zone establishment_timezone)::date = p_day
   order by tm.recorded_at, tm.nsr;
end;
$$;

revoke all on function public.list_employee_time_marks(uuid, text, date)
  from public, anon, authenticated;
grant execute on function public.list_employee_time_marks(uuid, text, date)
  to service_role;

commit;
