-- A gravação de eventos AFD é uma operação interna de triggers confiáveis.
-- Não expor uma RPC que aceite establishment/payload/actor arbitrários.
begin;

revoke all on function public.append_rep_afd_event(uuid,text,jsonb,timestamptz,uuid)
  from public, anon, authenticated, service_role;

comment on function public.append_rep_afd_event(uuid,text,jsonb,timestamptz,uuid) is
  'Função interna chamada por triggers SECURITY DEFINER. Não conceder EXECUTE a roles de API; autoria e payload são definidos pelo fluxo transacional que originou o evento.';

commit;
