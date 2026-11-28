-- REP-P — rep_events é trilha interna; impedir escrita direta via service_role.
-- Os fluxos legítimos escrevem por funções SECURITY DEFINER/triggers na mesma transação.
begin;

revoke insert, update, delete on table public.rep_events
  from anon, authenticated, service_role;

grant select on table public.rep_events to service_role;

comment on table public.rep_events is
  'Trilha interna REP-P. Escrita exclusivamente por funções SECURITY DEFINER e triggers transacionais; roles da API não recebem DML direto.';

commit;
