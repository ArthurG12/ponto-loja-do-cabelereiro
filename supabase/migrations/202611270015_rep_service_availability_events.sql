-- REP-P / AFD v004 — eventos de disponibilidade do serviço (tipo 6).
-- Registra apenas transições observadas pelo ciclo de vida do backend.
-- Quedas abruptas exigem monitor externo; retorno de energia (02) depende de sensor real.
begin;
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
    'recorded_at', public.rep_afd_format_dh_seconds(event_time, establishment_timezone),
    'event_source', 'rep-p-api-lifecycle'
  );
  return public.append_rep_afd_event(
    p_establishment_id, '6', event_payload, event_time, null
  );
end;
$service$;
revoke all on function public.record_rep_service_event(uuid,text)
  from public, anon, authenticated;
grant execute on function public.record_rep_service_event(uuid,text)
  to service_role;
commit;
