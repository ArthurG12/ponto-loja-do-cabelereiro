-- Teste de integração das migrations REP-P em PostgreSQL limpo.
-- Executado pelo GitHub Actions após schema.sql e migrations 001–007.

do $$
declare
  employee_uuid uuid;
  establishment_uuid uuid;
  result jsonb;
  first_mark jsonb;
  mark_count integer;
  failed_attempts integer;
  locked_until timestamptz;
begin

  -- O cadastro Auth nunca deve promover automaticamente alguém a admin.
  insert into auth.users (id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  if not exists (
    select 1 from public.profiles
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and role = 'employee'::public.app_role
  ) then
    raise exception 'Novo usuário Auth não foi criado como employee.';
  end if;

  insert into public.employees (
    full_name, schedule_code, active, pin_hash
  ) values (
    'Funcionário de teste', 'A', true, crypt('1234', gen_salt('bf'))
  ) returning id, establishment_id
    into employee_uuid, establishment_uuid;

  if establishment_uuid is null then
    raise exception 'Trigger não associou o funcionário ao estabelecimento.';
  end if;

  -- A falha de PIN deve ser persistida porque a função retorna JSON normalmente.
  result := public.register_time_mark(
    employee_uuid, '9999', 'entrada', gen_random_uuid(), 'ci-test-collector'
  );
  if result->>'ok' <> 'false' then
    raise exception 'PIN incorreto deveria ser rejeitado.';
  end if;

  select e.failed_pin_attempts into failed_attempts
    from public.employees e where e.id = employee_uuid;
  if failed_attempts <> 1 then
    raise exception 'Tentativa inválida não foi persistida; valor encontrado: %', failed_attempts;
  end if;

  result := public.register_time_mark(
    employee_uuid, '1234', 'entrada', gen_random_uuid(), 'ci-test-collector'
  );
  if result->>'ok' <> 'true' then
    raise exception 'Marcação válida não foi registrada: %', result;
  end if;

  first_mark := result->'punch';
  if (first_mark->>'nsr')::bigint <> 1 then
    raise exception 'NSR inicial deveria ser 1.';
  end if;
  if length(first_mark->>'record_hash') <> 64 then
    raise exception 'Hash SHA-256 inválido.';
  end if;
  if first_mark->>'previous_hash' is not null then
    raise exception 'Primeira marcação não deveria possuir hash anterior.';
  end if;

  -- Repetir o mesmo request_id deve devolver o mesmo registro sem novo NSR.
  result := public.register_time_mark(
    employee_uuid, '1234', 'entrada',
    (first_mark->>'client_request_id')::uuid,
    'ci-test-collector'
  );
  if (result->'punch'->>'id') <> (first_mark->>'id') then
    raise exception 'Idempotência não devolveu a marcação original.';
  end if;

  select count(*) into mark_count
    from public.time_marks where employee_id = employee_uuid;
  if mark_count <> 1 then
    raise exception 'Requisição repetida criou marcação duplicada.';
  end if;

  result := public.list_employee_time_marks(
    employee_uuid, '1234',
    ((first_mark->>'recorded_at')::timestamptz at time zone 'America/Sao_Paulo')::date
  );
  if result->>'ok' <> 'true'
     or jsonb_array_length(result->'punches') <> 1 then
    raise exception 'Consulta do funcionário não retornou a marcação.';
  end if;

  begin
    update public.time_marks set source = 'alterado'
      where id = (first_mark->>'id')::uuid;
    raise exception 'Trigger de imutabilidade não bloqueou UPDATE.';
  exception when raise_exception then
    if sqlerrm = 'Trigger de imutabilidade não bloqueou UPDATE.' then
      raise;
    end if;
  end;

  -- DELETE também deve ser bloqueado para preservar o registro original.
  begin
    delete from public.time_marks where id = (first_mark->>'id')::uuid;
    raise exception 'Trigger de imutabilidade não bloqueou DELETE.';
  exception when raise_exception then
    if sqlerrm = 'Trigger de imutabilidade não bloqueou DELETE.' then
      raise;
    end if;
  end;

  -- Cinco tentativas incorretas bloqueiam o funcionário por 15 minutos.
  for attempt_no in 1..5 loop
    result := public.list_employee_time_marks(employee_uuid, '9999', current_date);
    if result->>'ok' <> 'false' then
      raise exception 'PIN incorreto não foi rejeitado na tentativa %.', attempt_no;
    end if;
  end loop;

  select pin_locked_until, failed_pin_attempts
    into locked_until, failed_attempts
    from public.employees where id = employee_uuid;
  if locked_until is null or locked_until <= clock_timestamp() or failed_attempts <> 0 then
    raise exception 'Bloqueio de PIN após cinco tentativas não foi persistido.';
  end if;

  result := public.list_employee_time_marks(employee_uuid, '1234', current_date);
  if result->>'ok' <> 'false' or result->>'error' not like 'Muitas tentativas%' then
    raise exception 'PIN correto não deveria liberar consulta durante o bloqueio.';
  end if;

  -- Funções internas/administrativas não podem ser chamadas como anon.
  if has_function_privilege('anon', 'public.assign_employee_establishment()', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_save_employee(uuid,text,text,text,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_adjust_punch(text,uuid,uuid,public.punch_kind,timestamptz,text)', 'EXECUTE') then
    raise exception 'Função interna ou administrativa ainda está executável por anon.';
  end if;
end;
$$;
