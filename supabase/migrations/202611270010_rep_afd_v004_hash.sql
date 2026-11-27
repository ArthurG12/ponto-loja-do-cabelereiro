-- REP-P / AFD 004 — hash encadeado candidato para o registro tipo 7.
-- Serialização: concatenação, sem separadores, dos campos fixos 1–7 já formatados
-- (NSR 9 dígitos, DH 24, CPF 12 posições com espaços à direita, coletor 2 e flag 1),
-- seguida do hash anterior tipo 7, quando existir.
-- A Portaria enumera os campos, mas não declara literalmente os separadores/bytes;
-- manter esta versão identificada como candidata até validação independente do leiaute.

begin;

create or replace function public.rep_afd_format_dh(p_at timestamptz, p_timezone text)
returns text
language plpgsql
stable
strict
set search_path = pg_catalog
as $format$
declare
  local_time timestamp without time zone;
  offset_minutes integer;
  absolute_offset integer;
begin
  local_time := p_at at time zone p_timezone;
  offset_minutes := round(extract(epoch from (
    (p_at at time zone p_timezone) - (p_at at time zone 'UTC')
  )) / 60)::integer;
  absolute_offset := abs(offset_minutes);

  return to_char(local_time, 'YYYY-MM-DD"T"HH24:MI:') || '00'
    || case when offset_minutes < 0 then '-' else '+' end
    || lpad((absolute_offset / 60)::text, 2, '0')
    || lpad((absolute_offset % 60)::text, 2, '0');
end;
$format$;

create or replace function public.rep_afd_v004_hash_input(
  p_nsr bigint,
  p_marked_at timestamptz,
  p_cpf text,
  p_recorded_at timestamptz,
  p_collector_type text,
  p_is_offline boolean,
  p_previous_hash text,
  p_timezone text
) returns text
language plpgsql
stable
set search_path = public, pg_catalog
as $input$
begin
  if p_nsr is null or p_nsr < 1 or p_nsr > 999999999 then raise exception 'NSR fora do intervalo AFD.'; end if;
  if p_cpf is null or length(p_cpf) <> 11 or p_cpf ~ '[^0-9]' or not public.rep_is_valid_cpf(p_cpf) then
    raise exception 'CPF inválido para o hash AFD.';
  end if;
  if p_collector_type is null or p_collector_type not in ('01','02','03','04','05') then
    raise exception 'Tipo de coletor inválido para o hash AFD.';
  end if;
  if p_marked_at is null or p_recorded_at is null or p_timezone is null or p_is_offline is null then
    raise exception 'Campos de data, fuso ou modo da marcação são obrigatórios.';
  end if;
  if p_previous_hash is not null and (length(p_previous_hash) <> 64 or p_previous_hash ~ '[^0-9a-f]') then
    raise exception 'Hash anterior inválido.';
  end if;

  return lpad(p_nsr::text, 9, '0')
    || '7'
    || public.rep_afd_format_dh(p_marked_at, p_timezone)
    || rpad(p_cpf, 12, ' ')
    || public.rep_afd_format_dh(p_recorded_at, p_timezone)
    || p_collector_type
    || case when p_is_offline then '1' else '0' end
    || coalesce(p_previous_hash, '');
end;
$input$;

create or replace function public.rep_afd_v004_mark_hash(
  p_nsr bigint,
  p_marked_at timestamptz,
  p_cpf text,
  p_recorded_at timestamptz,
  p_collector_type text,
  p_is_offline boolean,
  p_previous_hash text,
  p_timezone text
) returns text
language sql
stable
set search_path = public, extensions
as $hash$
  select encode(
    digest(convert_to(public.rep_afd_v004_hash_input(
      p_nsr, p_marked_at, p_cpf, p_recorded_at,
      p_collector_type, p_is_offline, p_previous_hash, p_timezone
    ), 'UTF8'), 'sha256'),
    'hex'
  );
$hash$;

revoke all on function public.rep_afd_format_dh(timestamptz,text) from public, anon, authenticated;
revoke all on function public.rep_afd_v004_hash_input(bigint,timestamptz,text,timestamptz,text,boolean,text,text) from public, anon, authenticated;
revoke all on function public.rep_afd_v004_mark_hash(bigint,timestamptz,text,timestamptz,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.rep_afd_format_dh(timestamptz,text) to service_role;
grant execute on function public.rep_afd_v004_hash_input(bigint,timestamptz,text,timestamptz,text,boolean,text,text) to service_role;
grant execute on function public.rep_afd_v004_mark_hash(bigint,timestamptz,text,timestamptz,text,boolean,text,text) to service_role;

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
  previous_hash_version text;
  registered_at timestamptz;
  trusted_recorded_at timestamptz;
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
  registered_at := clock_timestamp();
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

  select record_hash, hash_version
    into previous_record_hash, previous_hash_version
    from public.time_marks
   where establishment_id = establishment_row.id
   order by nsr desc
   limit 1;

  if found and previous_hash_version <> 'afd-v004-fixed-concat-candidate-v1' then
    raise exception 'Há marcações anteriores com hash legado; é necessário validar o histórico antes de continuar a cadeia AFD.';
  end if;

  -- O hash usa os campos fixos 1–7 do registro AFD, sem separadores,
  -- e acrescenta o hash anterior tipo 7 quando existir.


  insert into public.time_marks (
    establishment_id, employee_id, nsr, punch_type, recorded_at, created_at, timezone,
    source, collector_id, client_request_id, previous_hash, record_hash,
    employee_cpf_snapshot, collector_type, is_offline, hash_version
  ) values (
    establishment_row.id, employee_row.id, next_nsr, p_punch_type,
    trusted_recorded_at, registered_at, establishment_row.timezone, 'tablet',
    btrim(p_collector_id), p_client_request_id, previous_record_hash,
    public.rep_afd_v004_mark_hash(
      next_nsr, trusted_recorded_at, cpf_digits, registered_at,
      p_collector_type, false, previous_record_hash, establishment_row.timezone
    ),
    cpf_digits, p_collector_type, false, 'afd-v004-fixed-concat-candidate-v1'
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
      'record_hash', new_mark.record_hash,
      'hash_version', new_mark.hash_version
    ),
    new_mark.record_hash, registered_at
  );

  return jsonb_build_object('ok', true, 'punch', to_jsonb(new_mark));
end;
$$;



-- A ARP mantém também a data/hora de gravação usada no campo 5 do registro tipo 7.
create or replace function public.mirror_time_mark_to_rep_ledger()
returns trigger
language plpgsql
security definer
set search_path = public
as $mirror$
begin
  insert into public.rep_ledger (
    establishment_id, nsr, record_type, source_table, source_id,
    occurred_at, record_payload, hash_version, record_hash
  ) values (
    new.establishment_id, new.nsr, '7', 'time_marks', new.id,
    new.recorded_at,
    jsonb_build_object(
      'employee_id', new.employee_id,
      'employee_cpf_snapshot', new.employee_cpf_snapshot,
      'punch_type', new.punch_type,
      'recorded_at', new.recorded_at,
      'recorded_on', new.created_at,
      'timezone', new.timezone,
      'collector_id', new.collector_id,
      'collector_type', new.collector_type,
      'is_offline', new.is_offline
    ),
    new.hash_version, new.record_hash
  );
  return new;
end;
$mirror$;

revoke all on function public.mirror_time_mark_to_rep_ledger() from public, anon, authenticated;

commit;
