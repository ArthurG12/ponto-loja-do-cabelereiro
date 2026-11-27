-- Teste de integração das migrations REP-P em PostgreSQL limpo.
-- Executado pelo GitHub Actions após schema.sql e migrations 001–009.

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

  result := public.register_time_mark(employee_uuid, '9999', 'entrada', gen_random_uuid(), 'ci-test-collector', '02');
  if result->>'ok' <> 'false' then raise exception 'PIN incorreto deveria ser rejeitado.'; end if;

  select failed_pin_attempts into failed_attempts from public.employees where id = employee_uuid;
  if failed_attempts <> 1 then raise exception 'Tentativa inválida não foi persistida.'; end if;

  result := public.register_time_mark(employee_uuid, '1234', 'entrada', gen_random_uuid(), 'ci-test-collector', '02');
  if result->>'ok' <> 'true' then raise exception 'Marcação válida não foi registrada: %', result; end if;

  first_mark := result->'punch';
  if (first_mark->>'nsr')::bigint <> 1 then raise exception 'NSR inicial deveria ser 1.'; end if;
  if length(first_mark->>'record_hash') <> 64 then raise exception 'Hash SHA-256 interno inválido.'; end if;
  if first_mark->>'hash_version' <> 'legacy-json-v1' then raise exception 'Hash legado não identificado.'; end if;
  if first_mark->>'employee_cpf_snapshot' <> '52998224725' then raise exception 'Snapshot CPF ausente.'; end if;
  if first_mark->>'collector_type' <> '02' or first_mark->>'is_offline' <> 'false' then
    raise exception 'Metadados do coletor incorretos.';
  end if;
  if first_mark->>'previous_hash' is not null then raise exception 'Primeira marcação não deveria possuir hash anterior.'; end if;

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
   where establishment_id = establishment_uuid and nsr = 1 and record_type = '7'
     and source_table = 'time_marks' and source_id = (first_mark->>'id')::uuid;
  if ledger_count <> 1 then raise exception 'Marcação não foi espelhada no livro AFD.'; end if;

  event_result := public.append_rep_afd_event(
    establishment_uuid, '6', jsonb_build_object('event_code', '07', 'description', 'CI test'),
    clock_timestamp(), null
  );
  if event_result->>'ok' <> 'true' or (event_result->>'nsr')::bigint <> 2 then
    raise exception 'Evento AFD não consumiu NSR compartilhado: %', event_result;
  end if;

  select count(*) into ledger_count from public.rep_ledger where establishment_id = establishment_uuid;
  if ledger_count <> 2 then raise exception 'Livro AFD deveria conter dois registros.'; end if;

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

  if not public.rep_is_valid_cpf('52998224725')
     or public.rep_is_valid_cpf('11111111111') then
    raise exception 'Validação matemática de CPF falhou.';
  end if;

  if has_function_privilege('anon', 'public.append_rep_afd_event(uuid,text,jsonb,timestamptz,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.append_rep_afd_event(uuid,text,jsonb,timestamptz,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.register_time_mark(uuid,text,public.punch_kind,uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.register_time_mark(uuid,text,public.punch_kind,uuid,text,text)', 'EXECUTE')\n     or has_function_privilege('anon', 'public.admin_save_employee(uuid,text,text,text,boolean,text)', 'EXECUTE') then
    raise exception 'Função interna REP-P executável por usuário não confiável.';
  end if;
end;
$$;
