-- REP-P / ARP — gravação transacional de marcações originais
-- Esta função é acessível somente ao backend com service_role.
-- O relógio usado é o relógio do PostgreSQL; a sincronização/rastreabilidade HLB
-- precisa ser comprovada e monitorada operacionalmente antes de uso legal.

begin;

create or replace function public.register_time_mark(
  p_employee_id uuid,
  p_submitted_pin text,
  p_punch_type public.punch_kind,
  p_client_request_id uuid,
  p_collector_id text
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
begin
  if p_client_request_id is null then
    raise exception 'Identificador da solicitação é obrigatório.';
  end if;

  if p_collector_id is null or length(btrim(p_collector_id)) < 3 or length(p_collector_id) > 120 then
    raise exception 'Identificação do coletor inválida.';
  end if;

  -- Esta rotina valida PIN, situação ativa e bloqueio de tentativas.
  -- A função também bloqueia a linha do funcionário, serializando solicitações
  -- simultâneas do mesmo funcionário.
  if p_submitted_pin is null or p_submitted_pin !~ '^[0-9]{4,6}
  from public.time_marks
  where employee_id = p_employee_id
    and client_request_id = p_client_request_id;

  if found then
    return jsonb_build_object('ok', true, 'punch', to_jsonb(existing_mark));
  end if;

  if employee_row.establishment_id is null then
    raise exception 'Funcionário sem estabelecimento vinculado.';
  end if;

  select * into establishment_row
  from public.establishments
  where id = employee_row.establishment_id
    and active = true;

  if not found then
    raise exception 'Estabelecimento inativo ou não configurado.';
  end if;

  trusted_recorded_at := clock_timestamp();
  local_day := (trusted_recorded_at at time zone establishment_row.timezone)::date;
  mark_sequence := public.punch_sequence_for(employee_row.schedule_code, local_day);

  select punch_type into last_type
  from public.time_marks
  where employee_id = employee_row.id
    and (recorded_at at time zone establishment_row.timezone)::date = local_day
  order by nsr desc
  limit 1;

  if last_type is null then
    expected_type := mark_sequence[1];
  else
    sequence_index := array_position(mark_sequence, last_type);
    if sequence_index is null or sequence_index >= array_length(mark_sequence, 1) then
      raise exception 'As marcações previstas para hoje já foram realizadas.';
    end if;
    expected_type := mark_sequence[sequence_index + 1];
  end if;

  if p_punch_type is distinct from expected_type then
    raise exception 'A próxima marcação esperada é %.', public.punch_label(expected_type);
  end if;

  -- O incremento bloqueia a linha da sequência até o fim da transação.
  -- Assim, NSR e cadeia de hashes são serializados por estabelecimento.
  next_nsr := public.allocate_rep_nsr(establishment_row.id);

  select record_hash into previous_record_hash
  from public.time_marks
  where establishment_id = establishment_row.id
  order by nsr desc
  limit 1;

  canonical_payload := jsonb_build_object(
    'establishment_id', establishment_row.id,
    'nsr', next_nsr,
    'employee_id', employee_row.id,
    'punch_type', p_punch_type,
    'recorded_at_utc', to_char(
      trusted_recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'timezone', establishment_row.timezone,
    'collector_id', btrim(p_collector_id),
    'client_request_id', p_client_request_id,
    'previous_hash', previous_record_hash
  );

  insert into public.time_marks (
    establishment_id,
    employee_id,
    nsr,
    punch_type,
    recorded_at,
    timezone,
    source,
    collector_id,
    client_request_id,
    previous_hash,
    record_hash
  ) values (
    establishment_row.id,
    employee_row.id,
    next_nsr,
    p_punch_type,
    trusted_recorded_at,
    establishment_row.timezone,
    'tablet',
    btrim(p_collector_id),
    p_client_request_id,
    previous_record_hash,
    encode(digest(convert_to(canonical_payload::text, 'UTF8'), 'sha256'), 'hex')
  )
  returning * into new_mark;

  insert into public.rep_events (
    establishment_id,
    event_type,
    related_mark_id,
    event_payload,
    event_hash,
    occurred_at
  ) values (
    establishment_row.id,
    'time_mark_registered',
    new_mark.id,
    jsonb_build_object(
      'nsr', new_mark.nsr,
      'employee_id', new_mark.employee_id,
      'punch_type', new_mark.punch_type,
      'record_hash', new_mark.record_hash
    ),
    new_mark.record_hash,
    trusted_recorded_at
  );

  return jsonb_build_object('ok', true, 'punch', to_jsonb(new_mark));
end;
$$;

revoke all on function public.register_time_mark(uuid, text, public.punch_kind, uuid, text)
  from public, anon, authenticated;
grant execute on function public.register_time_mark(uuid, text, public.punch_kind, uuid, text)
  to service_role;

commit;
 then
    return jsonb_build_object('ok', false, 'error', 'Senha inválida.');
  end if;

  select * into employee_row
  from public.employees
  where id = p_employee_id
  for update;

  if not found or not employee_row.active or employee_row.pin_hash is null then
    return jsonb_build_object('ok', false, 'error', 'Senha inválida.');
  end if;

  if employee_row.pin_locked_until is not null and employee_row.pin_locked_until > clock_timestamp() then
    return jsonb_build_object('ok', false, 'error', 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
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
    -- Retorno normal para que a transação confirme a contagem de tentativas.
    return jsonb_build_object('ok', false, 'error', 'Senha inválida.');
  end if;

  update public.employees
  set failed_pin_attempts = 0, pin_locked_until = null
  where id = employee_row.id;

  select * into existing_mark
  from public.time_marks
  where employee_id = p_employee_id
    and client_request_id = p_client_request_id;

  if found then
    return existing_mark;
  end if;

  if employee_row.establishment_id is null then
    raise exception 'Funcionário sem estabelecimento vinculado.';
  end if;

  select * into establishment_row
  from public.establishments
  where id = employee_row.establishment_id
    and active = true;

  if not found then
    raise exception 'Estabelecimento inativo ou não configurado.';
  end if;

  trusted_recorded_at := clock_timestamp();
  local_day := (trusted_recorded_at at time zone establishment_row.timezone)::date;
  mark_sequence := public.punch_sequence_for(employee_row.schedule_code, local_day);

  select punch_type into last_type
  from public.time_marks
  where employee_id = employee_row.id
    and (recorded_at at time zone establishment_row.timezone)::date = local_day
  order by nsr desc
  limit 1;

  if last_type is null then
    expected_type := mark_sequence[1];
  else
    sequence_index := array_position(mark_sequence, last_type);
    if sequence_index is null or sequence_index >= array_length(mark_sequence, 1) then
      raise exception 'As marcações previstas para hoje já foram realizadas.';
    end if;
    expected_type := mark_sequence[sequence_index + 1];
  end if;

  if p_punch_type is distinct from expected_type then
    raise exception 'A próxima marcação esperada é %.', public.punch_label(expected_type);
  end if;

  -- O incremento bloqueia a linha da sequência até o fim da transação.
  -- Assim, NSR e cadeia de hashes são serializados por estabelecimento.
  next_nsr := public.allocate_rep_nsr(establishment_row.id);

  select record_hash into previous_record_hash
  from public.time_marks
  where establishment_id = establishment_row.id
  order by nsr desc
  limit 1;

  canonical_payload := jsonb_build_object(
    'establishment_id', establishment_row.id,
    'nsr', next_nsr,
    'employee_id', employee_row.id,
    'punch_type', p_punch_type,
    'recorded_at_utc', to_char(
      trusted_recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'timezone', establishment_row.timezone,
    'collector_id', btrim(p_collector_id),
    'client_request_id', p_client_request_id,
    'previous_hash', previous_record_hash
  );

  insert into public.time_marks (
    establishment_id,
    employee_id,
    nsr,
    punch_type,
    recorded_at,
    timezone,
    source,
    collector_id,
    client_request_id,
    previous_hash,
    record_hash
  ) values (
    establishment_row.id,
    employee_row.id,
    next_nsr,
    p_punch_type,
    trusted_recorded_at,
    establishment_row.timezone,
    'tablet',
    btrim(p_collector_id),
    p_client_request_id,
    previous_record_hash,
    encode(digest(convert_to(canonical_payload::text, 'UTF8'), 'sha256'), 'hex')
  )
  returning * into new_mark;

  insert into public.rep_events (
    establishment_id,
    event_type,
    related_mark_id,
    event_payload,
    event_hash,
    occurred_at
  ) values (
    establishment_row.id,
    'time_mark_registered',
    new_mark.id,
    jsonb_build_object(
      'nsr', new_mark.nsr,
      'employee_id', new_mark.employee_id,
      'punch_type', new_mark.punch_type,
      'record_hash', new_mark.record_hash
    ),
    new_mark.record_hash,
    trusted_recorded_at
  );

  return new_mark;
end;
$$;

revoke all on function public.register_time_mark(uuid, text, public.punch_kind, uuid, text)
  from public, anon, authenticated;
grant execute on function public.register_time_mark(uuid, text, public.punch_kind, uuid, text)
  to service_role;

commit;
