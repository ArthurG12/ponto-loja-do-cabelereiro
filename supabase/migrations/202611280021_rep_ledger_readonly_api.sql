-- O ledger só recebe linhas pelos triggers e funções transacionais internas.
-- service_role mantém leitura para emissão/verificação, mas não pode forjar linhas.
begin;

revoke insert, update, delete on table public.rep_ledger from anon, authenticated, service_role;
grant select on table public.rep_ledger to service_role;

comment on table public.rep_ledger is
  'Livro REP-P append-only. Escrita exclusivamente por funções SECURITY DEFINER e triggers internos; service_role possui somente leitura.';

commit;
