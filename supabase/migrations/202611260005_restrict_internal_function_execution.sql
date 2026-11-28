-- REP-P / segurança — restringe execução de funções internas e administrativas.
-- A autorização de administrador continua sendo validada dentro das rotinas.

begin;

-- Função de trigger: não deve ser invocável pela Data API.
revoke all on function public.assign_employee_establishment()
  from public, anon, authenticated;

-- Rotinas administrativas exigem sessão autenticada e fazem sua própria
-- checagem de is_admin() no corpo da função.
revoke execute on function public.admin_save_employee(uuid, text, text, text, boolean)
  from public, anon;
revoke execute on function public.admin_adjust_punch(text, uuid, uuid, public.punch_kind, timestamptz, text)
  from public, anon;

-- A checagem de papel é usada por políticas RLS, mas não precisa ser pública.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

commit;
