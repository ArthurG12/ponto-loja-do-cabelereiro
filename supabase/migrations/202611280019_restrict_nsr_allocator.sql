-- Impede alocação isolada de NSR via RPC: o contador só pode ser alterado
-- dentro das rotinas transacionais que também gravam o registro correspondente.
begin;

revoke all on function public.allocate_rep_nsr(uuid)
  from public, anon, authenticated, service_role;

comment on function public.allocate_rep_nsr(uuid) is
  'Função interna. Não conceder EXECUTE a roles de API; chamar somente por rotinas SECURITY DEFINER que persistem o registro AFD na mesma transação.';

commit;
