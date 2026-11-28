-- REP-P / AFD v004 — corrigir serialização DH para segundos fixos em 00.
-- A função rep_afd_format_dh já implementa o formato normativo; os eventos
-- tipo 4 e 6 passam a reutilizá-la e removem o helper intermediário incorreto.
begin;

create or replace function public.admin_adjust_rep_clock(
  p_establishment_id uuid,
  p_before timestamptz,
  p_after timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $adjust$
declare
  actor uuid := auth.uid();
  actor_cpf text;
  establishment_timezone text;
  event_time timestamptz := clock_timestamp();
  event_payload jsonb;
  result jsonb;
begin
  if actor is null or not public.is_admin() then
    raise exception 'Acesso de administrador necessário.';
  end if;
  if p_before is null or p_after is null
     or not isfinite(p_before) or not isfinite(p_after)
     or p_before = p_after then
    raise exception 'Informe os instantes válidos e distintos do relógio antes e depois do ajuste.';
  end if;

  select e.timezone into establishment_timezone
    from public.establishments e
   where e.id = p_establishment_id and e.active = true
   for update;
  if establishment_timezone is null then
    raise exception 'Estabelecimento ativo não encontrado ou sem fuso horário.';
  end if;

  select p.cpf into actor_cpf
    from public.profiles p where p.id = actor;
  if actor_cpf is null or not public.rep_is_valid_cpf(actor_cpf) then
    raise exception 'Cadastre o CPF válido do responsável antes de ajustar o relógio.';
  end if;

  event_payload := jsonb_build_object(
    'before_at', public.rep_afd_format_dh(p_before, establishment_timezone),
    'adjusted_at', public.rep_afd_format_dh(p_after, establishment_timezone),
    'recorded_at', public.rep_afd_format_dh(event_time, establishment_timezone),
    'responsible_cpf', actor_cpf,
    'timezone', establishment_timezone,
    'adjustment_seconds', extract(epoch from (p_after - p_before))::numeric
  );

  result := public.append_rep_afd_event(
    p_establishment_id, '4', event_payload, event_time, actor
  );
  return result || jsonb_build_object('record_type', '4');
end;
$adjust$;

create or replace function public.record_rep_service_event(
  p_establishment_id uuid,
  p_event_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $service$
declare
  event_time timestamptz := clock_timestamp();
  establishment_timezone text;
  event_payload jsonb;
begin
  if p_event_code is null or p_event_code not in ('07','08') then
    raise exception 'Transição de serviço REP-P inválida; use 07 ou 08.';
  end if;
  select e.timezone into establishment_timezone
    from public.establishments e
   where e.id = p_establishment_id and e.active = true;
  if establishment_timezone is null then
    raise exception 'Estabelecimento ativo não encontrado ou sem fuso horário.';
  end if;
  event_payload := jsonb_build_object(
    'event_code', p_event_code,
    'recorded_at', public.rep_afd_format_dh(event_time, establishment_timezone),
    'event_source', 'rep-p-api-lifecycle'
  );
  return public.append_rep_afd_event(
    p_establishment_id, '6', event_payload, event_time, null
  );
end;
$service$;

revoke all on function public.admin_adjust_rep_clock(uuid,timestamptz,timestamptz)
  from public, anon;
grant execute on function public.admin_adjust_rep_clock(uuid,timestamptz,timestamptz)
  to authenticated;
revoke all on function public.record_rep_service_event(uuid,text)
  from public, anon, authenticated;
grant execute on function public.record_rep_service_event(uuid,text)
  to service_role;

drop function if exists public.rep_afd_format_dh_seconds(timestamptz,text);

commit;
