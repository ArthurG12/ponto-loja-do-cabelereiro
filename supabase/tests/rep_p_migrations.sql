-- Teste de integração das migrations REP-P em PostgreSQL limpo.
-- Executado pelo GitHub Actions após schema.sql e migrations 001–015.

do $$
declare
  employee_uuid uuid;
  establishment_uuid uuid;
  result jsonb;
  first_mark jsonb;
  mark_count integer;
  failed_attempts integer;
  locked_until timestamptz;
  ledger_count integer;
  event_result jsonb;
begin
  insert into auth.users (id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  if not exists (
    select 1 from public.profiles
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and role = 'employee'::public.app_role
  ) then
    raise exception 'Novo usuário Auth não foi criado como employee.';
  end if;

  insert into public.employees (full_name, schedule_code, active, pin_hash, cpf)
  values ('Funcionário de teste', 'A', true, crypt('1234', gen_salt('bf')), '52998224725')
  returning id, establishment_id into employee_uuid, establishment_uuid;

  if establishment_uuid is null then
    raise exception 'Trigger não associou o funcionário ao estabelecimento.';
  end if;

  if not exists (
    select 1 from public.rep_ledger
    where establishment_id = establishment_uuid
      and nsr = 1 and record_type = '5'
      and record_payload->>'operation' = 'I'
      and record_payload->>'cpf' = '52998224725'
      and record_payload->>'full_name' = 'Funcionário de teste'
  ) then
    raise exception 'Inclusão de empregado não gerou AFD tipo 5 com snapshot cadastral.';
  end if;

  update public.employees
     set full_name = 'Funcionário de teste atualizado', schedule_code = 'B'
   where id = employee_uuid;

  if not exists (
    select 1 from public.rep_ledger
    where establishment_id = establishment_uuid
      and nsr = 2 and record_type = '5'
      and record_payload->>'operation' = 'A'
      and record_payload->>'full_name' = 'Funcionário de teste atualizado'
      and record_payload->>'schedule_code' = 'B'
  ) then
    raise exception 'Alteração de empregado não gerou AFD tipo 5.';
  end if;

  result := public.register_time_mark(employee_uuid, '9999', 'entrada', gen_random_uuid(), 'ci-test-collector', '02');
  if result->>'ok' <> 'false' then raise exception 'PIN incorreto deveria ser rejeitado.'; end if;

  select failed_pin_attempts into failed_attempts from public.employees where id = employee_uuid;
  if failed_attempts <> 1 then raise exception 'Tentativa inválida não foi persistida.'; end if;

  result := public.register_time_mark(employee_uuid, '1234', 'entrada', gen_random_uuid(), 'ci-test-collector', '02');
  if result->>'ok' <> 'true' then raise exception 'Marcação válida não foi registrada: %', result; end if;

  first_mark := result->'punch';
  if (first_mark->>'nsr')::bigint <> 3 then raise exception 'NSR da marcação deveria seguir os dois eventos cadastrais.'; end if;
  if length(first_mark->>'record_hash') <> 64 then raise exception 'Hash SHA-256 interno inválido.'; end if;
  if first_mark->>'hash_version' <> 'afd-v004-fixed-concat-candidate-v1' then raise exception 'Versão candidata do hash AFD não identificada.'; end if;
  if first_mark->>'employee_cpf_snapshot' <> '52998224725' then raise exception 'Snapshot CPF ausente.'; end if;
  if first_mark->>'collector_type' <> '02' or first_mark->>'is_offline' <> 'false' then
    raise exception 'Metadados do coletor incorretos.';
  end if;
  if first_mark->>'previous_hash' is not null then raise exception 'Primeira marcação não deveria possuir hash anterior.'; end if;
  if first_mark->>'record_hash' <> public.rep_afd_v004_mark_hash(
    (first_mark->>'nsr')::bigint, (first_mark->>'recorded_at')::timestamptz,
    first_mark->>'employee_cpf_snapshot', (first_mark->>'created_at')::timestamptz,
    first_mark->>'collector_type', (first_mark->>'is_offline')::boolean,
    first_mark->>'previous_hash', 'America/Sao_Paulo'
  ) then raise exception 'Hash persistido diverge do verificador AFD.'; end if;

  result := public.register_time_mark(
    employee_uuid, '1234', 'entrada', (first_mark->>'client_request_id')::uuid, 'ci-test-collector', '02'
  );
  if (result->'punch'->>'id') <> (first_mark->>'id') then raise exception 'Idempotência falhou.'; end if;

  select count(*) into mark_count from public.time_marks where employee_id = employee_uuid;
  if mark_count <> 1 then raise exception 'Requisição repetida criou marcação duplicada.'; end if;

  result := public.list_employee_time_marks(
    employee_uuid, '1234',
    ((first_mark->>'recorded_at')::timestamptz at time zone 'America/Sao_Paulo')::date
  );
  if result->>'ok' <> 'true' or jsonb_array_length(result->'punches') <> 1 then
    raise exception 'Consulta do funcionário não retornou a marcação.';
  end if;

  begin
    update public.time_marks set source = 'alterado' where id = (first_mark->>'id')::uuid;
    raise exception 'Trigger de imutabilidade não bloqueou UPDATE.';
  exception when raise_exception then
    if sqlerrm = 'Trigger de imutabilidade não bloqueou UPDATE.' then raise; end if;
  end;
  begin
    delete from public.time_marks where id = (first_mark->>'id')::uuid;
    raise exception 'Trigger de imutabilidade não bloqueou DELETE.';
  exception when raise_exception then
    if sqlerrm = 'Trigger de imutabilidade não bloqueou DELETE.' then raise; end if;
  end;

  for attempt_no in 1..5 loop
    result := public.list_employee_time_marks(employee_uuid, '9999', current_date);
    if result->>'ok' <> 'false' then raise exception 'PIN incorreto não foi rejeitado.'; end if;
  end loop;
  select pin_locked_until, failed_pin_attempts into locked_until, failed_attempts
    from public.employees where id = employee_uuid;
  if locked_until is null or locked_until <= clock_timestamp() or failed_attempts <> 0 then
    raise exception 'Bloqueio de PIN após cinco tentativas não foi persistido.';
  end if;

  select count(*) into ledger_count from public.rep_ledger
   where establishment_id = establishment_uuid and nsr = 3 and record_type = '7'
     and source_table = 'time_marks' and source_id = (first_mark->>'id')::uuid;
  if ledger_count <> 1 then raise exception 'Marcação não foi espelhada no livro AFD.'; end if;

  event_result := public.append_rep_afd_event(
    establishment_uuid, '6', jsonb_build_object('event_code', '07', 'description', 'CI test'),
    clock_timestamp(), null
  );
  if event_result->>'ok' <> 'true' or (event_result->>'nsr')::bigint <> 4 then
    raise exception 'Evento AFD não consumiu NSR compartilhado: %', event_result;
  end if;

  select count(*) into ledger_count from public.rep_ledger where establishment_id = establishment_uuid;
  if ledger_count <> 4 then raise exception 'Livro AFD deveria conter quatro registros após inclusão, alteração, marcação e evento técnico.'; end if;

  begin
    update public.rep_ledger set record_payload = '{}'::jsonb where establishment_id = establishment_uuid and nsr = 1;
    raise exception 'Livro AFD permitiu UPDATE.';
  exception when raise_exception then
    if sqlerrm = 'Livro AFD permitiu UPDATE.' then raise; end if;
  end;
  begin
    delete from public.rep_ledger where establishment_id = establishment_uuid and nsr = 1;
    raise exception 'Livro AFD permitiu DELETE.';
  exception when raise_exception then
    if sqlerrm = 'Livro AFD permitiu DELETE.' then raise; end if;
  end;

  update public.employees set active = false where id = employee_uuid;
  if not exists (
    select 1 from public.rep_ledger
    where establishment_id = establishment_uuid
      and nsr = 5 and record_type = '5'
      and record_payload->>'operation' = 'E'
      and record_payload->>'active' = 'false'
  ) then
    raise exception 'Desativação de empregado não gerou evento AFD tipo 5.';
  end if;

  -- Tipo 2: o responsável deve ter CPF válido; sem ele a alteração inteira falha.
  update public.profiles
     set role = 'admin'::public.app_role
   where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

  begin
    perform public.admin_save_establishment(
      establishment_uuid, '1', '12345678000195', null,
      'Loja do Cabeleireiro LTDA', 'Rua de Teste, 100'
    );
    raise exception 'Alteração do empregador sem CPF responsável deveria falhar.';
  exception when raise_exception then
    if sqlerrm = 'Alteração do empregador sem CPF responsável deveria falhar.' then raise; end if;
    if sqlerrm not like '%CPF válido do responsável%' then raise; end if;
  end;

  if exists (
    select 1 from public.establishments
    where id = establishment_uuid and employer_document is not null
  ) then
    raise exception 'Alteração do empregador sem CPF foi parcialmente persistida.';
  end if;

  perform public.admin_set_responsible_cpf('52998224725');
  perform public.admin_save_establishment(
    establishment_uuid, '1', '12345678000195', null,
    'Loja do Cabeleireiro LTDA', 'Rua de Teste, 100'
  );

  if not exists (
    select 1 from public.rep_ledger
    where establishment_id = establishment_uuid
      and nsr = 6 and record_type = '2'
      and record_payload->>'responsible_cpf' = '52998224725'
      and record_payload->>'employer_id_type' = '1'
      and record_payload->>'employer_document' = '12345678000195'
      and record_payload->>'legal_name' = 'Loja do Cabeleireiro LTDA'
      and record_payload->>'service_location' = 'Rua de Teste, 100'
  ) then
    raise exception 'Alteração do empregador não gerou AFD tipo 2 completo.';
  end if;

  if (select count(*) from public.rep_ledger where establishment_id = establishment_uuid) <> 6 then
    raise exception 'Livro AFD deveria conter seis eventos após a alteração do empregador.';
  end if;


  -- Tipo 4: ajuste explícito do relógio, com segundos e CPF do responsável.
  event_result := public.admin_adjust_rep_clock(
    establishment_uuid,
    '2026-11-27T12:00:30-03:00'::timestamptz,
    '2026-11-27T12:01:15-03:00'::timestamptz
  );
  if event_result->>'ok' <> 'true'
     or (event_result->>'nsr')::bigint <> 7
     or event_result->>'record_type' <> '4' then
    raise exception 'Ajuste do relógio não consumiu o NSR compartilhado: %', event_result;
  end if;

  if not exists (
    select 1 from public.rep_ledger
     where establishment_id = establishment_uuid
       and nsr = 7 and record_type = '4'
       and record_payload->>'before_at' = '2026-11-27T12:00:00-0300'
       and record_payload->>'adjusted_at' = '2026-11-27T12:01:00-0300'
       and record_payload->>'responsible_cpf' = '52998224725'
       and length(record_payload->>'recorded_at') = 24
       and record_payload->>'adjustment_seconds' = '45.000000'
  ) then
    raise exception 'Registro AFD tipo 4 incompleto ou com formato DH incorreto.';
  end if;

  begin
    perform public.admin_adjust_rep_clock(
      establishment_uuid,
      '2026-11-27T12:00:10-03:00'::timestamptz,
      '2026-11-27T12:00:10-03:00'::timestamptz
    );
    raise exception 'Ajuste sem diferença deveria ser rejeitado.';
  exception when raise_exception then
    if sqlerrm = 'Ajuste sem diferença deveria ser rejeitado.' then raise; end if;
    if sqlerrm not like '%instantes válidos e distintos%' then raise; end if;
  end;

  if (select count(*) from public.rep_ledger where establishment_id = establishment_uuid) <> 7 then
    raise exception 'Tentativa inválida alterou o livro AFD.';
  end if;

  -- Tipo 6: somente transições observadas do ciclo de vida do backend.
  event_result := public.record_rep_service_event(establishment_uuid, '07');
  if event_result->>'ok' <> 'true' or (event_result->>'nsr')::bigint <> 8 then
    raise exception 'Disponibilidade do serviço não consumiu o NSR compartilhado: %', event_result;
  end if;
  if not exists (
    select 1 from public.rep_ledger where establishment_id = establishment_uuid
      and nsr = 8 and record_type = '6' and record_payload->>'event_code' = '07'
      and length(record_payload->>'recorded_at') = 24
      and record_payload->>'event_source' = 'rep-p-api-lifecycle'
  ) then raise exception 'Evento AFD tipo 6 de disponibilidade incompleto.'; end if;

  event_result := public.record_rep_service_event(establishment_uuid, '08');
  if event_result->>'ok' <> 'true' or (event_result->>'nsr')::bigint <> 9 then
    raise exception 'Indisponibilidade do serviço não consumiu o NSR compartilhado: %', event_result;
  end if;
  if not exists (
    select 1 from public.rep_ledger where establishment_id = establishment_uuid
      and nsr = 9 and record_type = '6' and record_payload->>'event_code' = '08'
      and length(record_payload->>'recorded_at') = 24
  ) then raise exception 'Evento AFD tipo 6 de indisponibilidade incompleto.'; end if;

  begin
    perform public.record_rep_service_event(establishment_uuid, '99');
    raise exception 'Código de evento técnico inválido deveria ser rejeitado.';
  exception when raise_exception then
    if sqlerrm = 'Código de evento técnico inválido deveria ser rejeitado.' then raise; end if;
    if sqlerrm not like '%use 07 ou 08%' then raise; end if;
  end;

  if (select count(*) from public.rep_ledger where establishment_id = establishment_uuid) <> 9 then
    raise exception 'Eventos de serviço inválidos alteraram o livro AFD.';
  end if;

  if public.rep_afd_format_dh('2026-01-02T13:03:42+00'::timestamptz, 'America/Sao_Paulo') <> '2026-01-02T10:03:00-0300' then
    raise exception 'Formatação DH AFD incorreta.';
  end if;
  if public.rep_afd_v004_hash_input(1, '2026-01-02T13:03:42+00'::timestamptz, '52998224725', '2026-01-02T13:03:59+00'::timestamptz, '02', false, null, 'America/Sao_Paulo') <> '00000000172026-01-02T10:03:00-030052998224725 2026-01-02T10:03:00-0300020' then
    raise exception 'Serialização fixa do hash AFD divergiu do vetor de teste.';
  end if;
  if public.rep_afd_v004_mark_hash(1, '2026-01-02T13:03:42+00'::timestamptz, '52998224725', '2026-01-02T13:03:59+00'::timestamptz, '02', false, null, 'America/Sao_Paulo') <> 'ae9d6fb9ce501d6ab4626c7df591de4682880817b1cdde141b9c1ab1e5de5c4d' then
    raise exception 'SHA-256 AFD divergiu do vetor independente.';
  end if;

  if public.rep_afd_v004_mark_hash(1, '2026-01-02T13:03:42+00'::timestamptz, '52998224725', '2026-01-02T13:03:59+00'::timestamptz, '02', false, repeat('a', 64), 'America/Sao_Paulo') <> '2175f4c09a0cb097834bbdb87659d44b8aa86ae45c778e208175eb58389cdb81' then
    raise exception 'Encadeamento do hash anterior divergiu do vetor de teste.';
  end if;

  if not public.rep_is_valid_cpf('52998224725')
     or public.rep_is_valid_cpf('11111111111') then
    raise exception 'Validação matemática de CPF falhou.';
  end if;

  if has_function_privilege('anon', 'public.append_rep_afd_event(uuid,text,jsonb,timestamptz,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.append_rep_afd_event(uuid,text,jsonb,timestamptz,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.register_time_mark(uuid,text,public.punch_kind,uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.register_time_mark(uuid,text,public.punch_kind,uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_save_employee(uuid,text,text,text,boolean,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.list_active_employees()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.list_active_employees()', 'EXECUTE')
     or has_function_privilege('anon', 'public.verify_employee_pin(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.verify_employee_pin(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.list_employee_punches(uuid,text,date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.list_employee_punches(uuid,text,date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.register_punch(uuid,text,public.punch_kind,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.register_punch(uuid,text,public.punch_kind,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.admin_save_employee(uuid,text,text,text,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_save_establishment(uuid,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_set_responsible_cpf(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_adjust_rep_clock(uuid,timestamptz,timestamptz)', 'EXECUTE')
     or has_function_privilege('anon', 'public.record_rep_service_event(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.record_rep_service_event(uuid,text)', 'EXECUTE') then
    raise exception 'RPC legada ou função interna REP-P executável por papel não confiável.';
  end if;

  if not has_function_privilege('service_role', 'public.record_rep_service_event(uuid,text)', 'EXECUTE') then
    raise exception 'Backend perdeu acesso à RPC de eventos de disponibilidade.';
  end if;

  if not has_function_privilege('authenticated', 'public.admin_adjust_rep_clock(uuid,timestamptz,timestamptz)', 'EXECUTE') then
    raise exception 'Administrador autenticado perdeu acesso à RPC de ajuste do relógio.';
  end if;

  if not has_function_privilege('service_role', 'public.list_employee_punches(uuid,text,date)', 'EXECUTE') then
    raise exception 'Backend perdeu acesso à consulta do histórico legado.';
  end if;
end;
$$;
