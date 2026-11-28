-- REP-P / AFD v004 — ajuste real do relógio (registro tipo 4).
-- Os instantes anterior e posterior devem ser lidos pelo controlador de relógio
-- imediatamente antes/depois do ajuste físico; esta RPC apenas registra a operação.
begin;

create or replace function public.rep_afd_format_dh_seconds(
  p_at timestamptz,
  p_timezone text
) returns text
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

  return to_char(local_time, 'YYYY-MM-DD"T"HH24:MI:SS')
    || case when offset_minutes < 0 then '-' else '+' end
    || lpad((absolute_offset / 60)::text, 2, '0')
    || lpad((absolute_offset % 60)::text, 2, '0');
end;
$format$;

revoke all on function public.rep_afd_format_dh_seconds(timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.rep_afd_format_dh_seconds(timestamptz,text)
  to service_role;

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

  select e.timezone
    into establishment_timezone
    from public.establishments e
   where e.id = p_establishment_id
     and e.active = true
   for update;

  if establishment_timezone is null then
    raise exception 'Estabelecimento ativo não encontrado ou sem fuso horário.';
  end if;

  select p.cpf
    into actor_cpf
    from public.profiles p
   where p.id = actor;

  if actor_cpf is null or not public.rep_is_valid_cpf(actor_cpf) then
    raise exception 'Cadastre o CPF válido do responsável antes de ajustar o relógio.';
  end if;

  event_payload := jsonb_build_object(
    'before_at', public.rep_afd_format_dh_seconds(p_before, establishment_timezone),
    'adjusted_at', public.rep_afd_format_dh_seconds(p_after, establishment_timezone),
    'recorded_at', public.rep_afd_format_dh_seconds(event_time, establishment_timezone),
    'responsible_cpf', actor_cpf,
    'timezone', establishment_timezone,
    'adjustment_seconds', extract(epoch from (p_after - p_before))::numeric
  );

  result := public.append_rep_afd_event(
    p_establishment_id,
    '4',
    event_payload,
    event_time,
    actor
  );

  return result || jsonb_build_object('record_type', '4');
end;
$adjust$;

revoke all on function public.admin_adjust_rep_clock(uuid,timestamptz,timestamptz)
  from public, anon;
grant execute on function public.admin_adjust_rep_clock(uuid,timestamptz,timestamptz)
  to authenticated;

commit;
