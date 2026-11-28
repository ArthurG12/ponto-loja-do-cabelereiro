-- REP-P / ARP — leitura das marcações do próprio funcionário por PIN.
-- A função é chamada somente pelo backend confiável (service_role).
-- Não concede SELECT público em time_marks. Tentativas inválidas são contabilizadas.

begin;

create or replace function public.list_employee_time_marks(
  p_employee_id uuid,
  p_submitted_pin text,
  p_day date
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  employee_row public.employees%rowtype;
  establishment_timezone text;
  marks jsonb;
begin
  if p_submitted_pin is null or p_submitted_pin !~ '^[0-9]{4,6}$' then
    return jsonb_build_object('ok', false, 'error', 'Senha inválida.');
  end if;

  select *
    into employee_row
    from public.employees
   where id = p_employee_id
   for update;

  if not found or not employee_row.active or employee_row.pin_hash is null then
    return jsonb_build_object('ok', false, 'error', 'Senha inválida.');
  end if;

  if employee_row.pin_locked_until is not null
     and employee_row.pin_locked_until > clock_timestamp() then
    return jsonb_build_object(
      'ok', false,
      'error', 'Muitas tentativas. Aguarde 15 minutos e tente de novo.'
    );
  end if;

  if employee_row.pin_hash <> crypt(p_submitted_pin, employee_row.pin_hash) then
    if employee_row.failed_pin_attempts + 1 >= 5 then
      update public.employees
         set failed_pin_attempts = 0,
             pin_locked_until = clock_timestamp() + interval '15 minutes'
       where id = employee_row.id;
    else
      update public.employees
         set failed_pin_attempts = employee_row.failed_pin_attempts + 1,
             pin_locked_until = null
       where id = employee_row.id;
    end if;

    return jsonb_build_object('ok', false, 'error', 'Senha inválida.');
  end if;

  update public.employees
     set failed_pin_attempts = 0,
         pin_locked_until = null
   where id = employee_row.id;

  select timezone
    into establishment_timezone
    from public.establishments
   where id = employee_row.establishment_id
     and active = true;

  if establishment_timezone is null then
    return jsonb_build_object('ok', false, 'error', 'Estabelecimento não configurado.');
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(tm) order by tm.recorded_at, tm.nsr),
    '[]'::jsonb
  )
    into marks
    from public.time_marks tm
   where tm.employee_id = p_employee_id
     and (tm.recorded_at at time zone establishment_timezone)::date = p_day;

  return jsonb_build_object('ok', true, 'punches', marks);
end;
$$;

revoke all on function public.list_employee_time_marks(uuid, text, date)
  from public, anon, authenticated;
grant execute on function public.list_employee_time_marks(uuid, text, date)
  to service_role;

commit;
