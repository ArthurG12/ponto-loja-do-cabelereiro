-- Teste de integração das migrations REP-P em PostgreSQL limpo.
-- Executado pelo GitHub Actions após schema.sql e migrations 001–004.

do $$
declare
  employee_uuid uuid;
  establishment_uuid uuid;
  result jsonb;
  first_mark jsonb;
  mark_count integer;
  failed_attempts integer;
begin
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
end;
$$;
