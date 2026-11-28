-- REP-P — restaurar RPC administrativa compatível com o cliente e CPF obrigatório.
-- O trigger employees_capture_afd_type5 grava o snapshot AFD na mesma transação.
begin;

create or replace function public.admin_save_employee(
  p_id uuid,
  p_name text,
  p_schedule text,
  p_pin text,
  p_active boolean,
  p_cpf text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $employee$
declare
  actor uuid := auth.uid();
  saved_id uuid;
  existing_cpf text;
  normalized_cpf text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g');
begin
  if actor is null or not public.is_admin() then
    raise exception 'Acesso de administrador necessário.';
  end if;
  if p_name is null or length(btrim(p_name)) < 3 then
    raise exception 'Informe o nome da colaboradora.';
  end if;
  if p_schedule is null or p_schedule not in ('A', 'B') then
    raise exception 'Escolha a jornada A ou B.';
  end if;
  if not public.rep_is_valid_cpf(normalized_cpf) then
    raise exception 'Informe um CPF válido da colaboradora.';
  end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'A senha precisa ter de 4 a 6 números.';
  end if;
  if p_id is null and p_pin is null then
    raise exception 'Defina uma senha numérica de 4 a 6 dígitos.';
  end if;

  if p_id is null then
    insert into public.employees (
      full_name, schedule_code, active, pin_hash, cpf
    ) values (
      btrim(p_name), p_schedule, coalesce(p_active, true),
      crypt(p_pin, gen_salt('bf')), normalized_cpf
    ) returning id into saved_id;
  else
    select e.cpf into existing_cpf
      from public.employees e
     where e.id = p_id
     for update;
    if not found then
      raise exception 'Colaboradora não encontrada.';
    end if;
    if existing_cpf is not null and existing_cpf <> normalized_cpf then
      raise exception 'O CPF cadastrado não pode ser alterado por este fluxo.';
    end if;

    update public.employees
       set full_name = btrim(p_name),
           schedule_code = p_schedule,
           active = coalesce(p_active, active),
           cpf = normalized_cpf,
           pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf')) end,
           failed_pin_attempts = case when p_pin is null then failed_pin_attempts else 0 end,
           pin_locked_until = case when p_pin is null then pin_locked_until else null end,
           updated_at = clock_timestamp()
     where id = p_id
     returning id into saved_id;
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (
    actor, 'employee_saved', 'employee', saved_id::text,
    jsonb_build_object('active', coalesce(p_active, true), 'cpf_present', true)
  );

  return saved_id;
end;
$employee$;

revoke all on function public.admin_save_employee(uuid,text,text,text,boolean,text)
  from public, anon, service_role;
grant execute on function public.admin_save_employee(uuid,text,text,text,boolean,text)
  to authenticated;

commit;
