-- REP-P — tabelas internas de registro e cadastro sem escrita direta via service_role.
-- Os fluxos legítimos escrevem por funções SECURITY DEFINER/triggers na mesma transação.
begin;

revoke insert, update, delete on table public.rep_events, public.time_marks,
  public.rep_sequences, public.establishments, public.employees
  from anon, authenticated, service_role;

grant select on table public.rep_events to service_role;

comment on table public.rep_events is
  'Dados internos REP-P. Escrita exclusivamente por funções administrativas e SECURITY DEFINER/triggers transacionais; roles da API não recebem DML direto.';

commit;
