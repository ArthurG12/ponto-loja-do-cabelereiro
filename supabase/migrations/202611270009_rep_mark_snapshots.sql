-- REP-P / ARP — snapshots de identificação e origem para novas marcações.
-- Hash continua explicitamente legado até implementação validada do AFD 004.
begin;

create or replace function public.rep_is_valid_cpf(p_cpf text)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  digits text := regexp_replace(p_cpf, '[^0-9]', '', 'g');
  sum_value integer := 0;
  check_digit integer;
  i integer;
begin
  if length(digits) <> 11 or digits = repeat(substring(digits, 1, 1), 11) then
    return false;
  end if;

  for i in 1..9 loop
    sum_value := sum_value + substring(digits, i, 1)::integer * (11 - i);
  end loop;
  check_digit := (sum_value * 10) % 11;
  if check_digit = 10 then check_digit := 0; end if;
  if check_digit <> substring(digits, 10, 1)::integer then
    return false;
  end if;

  sum_value := 0;
  for i in 1..10 loop
    sum_value := sum_value + substring(digits, i, 1)::integer * (12 - i);
  end loop;
  check_digit := (sum_value * 10) % 11;
  if check_digit = 10 then check_digit := 0; end if;
  return check_digit = substring(digits, 11, 1)::integer;
end;
$$;

revoke all on function public.rep_is_valid_cpf(text) from public, anon, authenticated;
grant execute on function public.rep_is_valid_cpf(text) to service_role;


-- Cadastro administrativo coleta o CPF necessário ao snapshot da marcação.
create or replace function public.admin_save_employee(
  p_id uuid, p_name text, p_schedule text, p_pin text, p_active boolean, p_cpf text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $employee$
declare
  new_id uuid;
  current_cpf text;
  digits text := regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g');
begin
  if not public.is_admin() then raise exception 'Acesso de administrador necessário.'; end if;
  if p_name is null or length(trim(p_name)) < 3 then raise exception 'Informe o nome da colaboradora.'; end if;
  if p_schedule not in ('A', 'B') then raise exception 'Escolha a jornada A ou B.'; end if;
  if not public.rep_is_valid_cpf(digits) then raise exception 'Informe um CPF válido.'; end if;
  if p_pin is not null and (p_pin !~ '^[0-9]{4,6}' or length(p_pin) not between 4 and 6) then
    raise exception 'A senha precisa ter de 4 a 6 números.';
  end if;
  if p_id is null and p_pin is null then raise exception 'Defina uma senha numérica de 4 a 6 dígitos.'; end if;

  if p_id is null then
    insert into public.employees (full_name, schedule_code, active, pin_hash, cpf)
    values (trim(p_name), p_schedule, coalesce(p_active, true), crypt(p_pin, gen_salt('bf')), digits)
    returning id into new_id;
  else
    select cpf into current_cpf from public.employees where id = p_id for update;
    if not found then raise exception 'Colaboradora não encontrada.'; end if;
    if current_cpf is not null and current_cpf <> digits then
      raise exception 'O CPF já cadastrado não pode ser alterado nesta etapa de auditoria.';
    end if;
    if exists (select 1 from public.time_marks where employee_id = p_id)
       and current_cpf is distinct from digits then
      raise exception 'Não é possível alterar o CPF após a primeira marcação REP-P.';
    end if;
    update public.employees
       set full_name = trim(p_name),
           schedule_code = p_schedule,
           active = coalesce(p_active, active),
           cpf = digits,
           pin_hash = case when p_pin is null then pin_hash else crypt(p_pin, gen_salt('bf')) end,
           failed_pin_attempts = case when p_pin is null then failed_pin_attempts else 0 end,
           pin_locked_until = case when p_pin is null then pin_locked_until else null end,
           updated_at = now()
     where id = p_id returning id into new_id;
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'employee_saved', 'employee', new_id::text,
    jsonb_build_object('active', coalesce(p_active, true), 'cpf_last_four', right(digits, 4)));
  return new_id;
end;
$employee$;

revoke all on function public.admin_save_employee(uuid,text,text,text,boolean,text) from public, anon;
grant execute on function public.admin_save_employee(uuid,text,text,text,boolean,text) to authenticated;

-- NOT VALID preserva registros históricos sem CPF, mas valida toda nova linha.
alter table public.time_marks
  add constraint time_marks_rep_snapshot_required_check
  check (
    employee_cpf_snapshot is not null
    and employee_cpf_snapshot ~ '^[0-9]{11}$'
    and collector_type is not null
    and collector_type in ('01','02','03','04','05')
    and is_offline = false
  ) not valid;

-- Nova assinatura: código do coletor é informado pelo backend confiável.
create or replace function public.register_time_mark(
  p_employee_id uuid,
  p_submitted_pin text,
  p_punch_type public.punch_kind,
  p_client_request_id uuid,
  p_collector_id text,
  p_collector_type text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  employee_row public.employees%rowtype;
  establishment_row public.establishments%rowtype;
  existing_mark public.time_marks%rowtype;
  new_mark public.time_marks%rowtype;
  next_nsr bigint;
  previous_record_hash text;
  trusted_recorded_at timestamptz;
  canonical_payload jsonb;
  local_day date;
  mark_sequence public.punch_kind[];
  last_type public.punch_kind;
  expected_type public.punch_kind;
  sequence_index integer;
  cpf_digits text;
begin
  if p_client_request_id is null then
    raise exception 'Identificador da solicitação é obrigatório.';
  end if;

  if p_collector_id is null
     or length(btrim(p_collector_id)) < 3
     or length(p_collector_id) > 120 then
    raise exception 'Identificação do coletor inválida.';
  end if;

  if p_collector_type is null or p_collector_type not in ('01','02','03','04','05') then
    raise exception 'Tipo normativo do coletor inválido.';
  end if;

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

  select *
    into existing_mark
    from public.time_marks
   where employee_id = p_employee_id
     and client_request_id = p_client_request_id;

  if found then
    return jsonb_build_object('ok', true, 'punch', to_jsonb(existing_mark));
  end if;

  if employee_row.establishment_id is null then
    raise exception 'Funcionário sem estabelecimento vinculado.';
  end if;

  cpf_digits := regexp_replace(coalesce(employee_row.cpf, ''), '[^0-9]', '', 'g');
  if not public.rep_is_valid_cpf(cpf_digits) then
    raise exception 'Cadastre um CPF válido para liberar a marcação REP-P.';
  end if;

  select *
    into establishment_row
    from public.establishments
   where id = employee_row.establishment_id
     and active = true;

  if not found then
    raise exception 'Estabelecimento inativo ou não configurado.';
  end if;

  trusted_recorded_at := clock_timestamp();
  local_day := (trusted_recorded_at at time zone establishment_row.timezone)::date;
  mark_sequence := public.punch_sequence_for(employee_row.schedule_code, local_day);

  select punch_type
    into last_type
    from public.time_marks
   where employee_id = employee_row.id
     and (recorded_at at time zone establishment_row.timezone)::date = local_day
   order by nsr desc
   limit 1;

  if last_type is null then
    expected_type := mark_sequence[1];
  else
    sequence_index := array_position(mark_sequence, last_type);
    if sequence_index is null
       or sequence_index >= array_length(mark_sequence, 1) then
      raise exception 'As marcações previstas para hoje já foram realizadas.';
    end if;
    expected_type := mark_sequence[sequence_index + 1];
  end if;

  if p_punch_type is distinct from expected_type then
    raise exception 'A próxima marcação esperada é %.', public.punch_label(expected_type);
  end if;

  next_nsr := public.allocate_rep_nsr(establishment_row.id);

  select record_hash
    into previous_record_hash
    from public.time_marks
   where establishment_id = establishment_row.id
   order by nsr desc
   limit 1;

  canonical_payload := jsonb_build_object(
    'establishment_id', establishment_row.id,
    'nsr', next_nsr,
    'employee_id', employee_row.id,
    'employee_cpf_snapshot', cpf_digits,
    'punch_type', p_punch_type,
    'recorded_at_utc', to_char(
      trusted_recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'timezone', establishment_row.timezone,
    'collector_id', btrim(p_collector_id),
    'collector_type', p_collector_type,
    'is_offline', false,
    'client_request_id', p_client_request_id,
    'previous_hash', previous_record_hash
  );

  insert into public.time_marks (
    establishment_id, employee_id, nsr, punch_type, recorded_at, timezone,
    source, collector_id, client_request_id, previous_hash, record_hash,
    employee_cpf_snapshot, collector_type, is_offline, hash_version
  ) values (
    establishment_row.id, employee_row.id, next_nsr, p_punch_type,
    trusted_recorded_at, establishment_row.timezone, 'tablet',
    btrim(p_collector_id), p_client_request_id, previous_record_hash,
    encode(digest(convert_to(canonical_payload::text, 'UTF8'), 'sha256'), 'hex'),
    cpf_digits, p_collector_type, false, 'legacy-json-v1'
  )
  returning * into new_mark;

  insert into public.rep_events (
    establishment_id, event_type, related_mark_id, event_payload, event_hash, occurred_at
  ) values (
    establishment_row.id, 'time_mark_registered', new_mark.id,
    jsonb_build_object(
      'nsr', new_mark.nsr,
      'employee_id', new_mark.employee_id,
      'employee_cpf_snapshot', new_mark.employee_cpf_snapshot,
      'punch_type', new_mark.punch_type,
      'collector_type', new_mark.collector_type,
      'record_hash', new_mark.record_hash
    ),
    new_mark.record_hash, trusted_recorded_at
  );

  return jsonb_build_object('ok', true, 'punch', to_jsonb(new_mark));
end;
$$;

revoke all on function public.register_time_mark(uuid,text,public.punch_kind,uuid,text)
  from public, anon, authenticated, service_role;
drop function public.register_time_mark(uuid,text,public.punch_kind,uuid,text);
revoke all on function public.register_time_mark(uuid,text,public.punch_kind,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.register_time_mark(uuid,text,public.punch_kind,uuid,text,text)
  to service_role;

commit;
