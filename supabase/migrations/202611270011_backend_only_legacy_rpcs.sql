-- REP-P — retirar do navegador RPCs legadas SECURITY DEFINER.
-- O navegador passa a consumir somente a API REP-P; o histórico legado continua
-- consultável pelo backend confiável usando service_role.
begin;

revoke all on function public.list_active_employees()
  from public, anon, authenticated;

revoke all on function public.verify_employee_pin(uuid, text)
  from public, anon, authenticated;

revoke all on function public.list_employee_punches(uuid, text, date)
  from public, anon, authenticated;
grant execute on function public.list_employee_punches(uuid, text, date)
  to service_role;

revoke all on function public.register_punch(uuid, text, public.punch_kind, uuid)
  from public, anon, authenticated;

-- A assinatura antiga não coleta CPF e não deve continuar exposta.
revoke all on function public.admin_save_employee(uuid, text, text, text, boolean)
  from public, anon, authenticated;

commit;
