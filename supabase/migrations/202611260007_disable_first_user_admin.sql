-- Segurança: cadastro público nunca deve conceder privilégios administrativos.
-- O primeiro administrador deve ser promovido manualmente por um operador confiável
-- após criar/verificar a conta em Supabase Auth.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'employee'::public.app_role)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
