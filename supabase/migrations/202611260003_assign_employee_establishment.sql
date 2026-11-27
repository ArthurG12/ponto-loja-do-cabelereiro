-- REP-P / ARP — vincula novos funcionários ao estabelecimento ativo.
-- A instalação atual foi definida para a Loja do Cabeleireiro.
-- Se houver mais de um estabelecimento ativo, a inclusão deve informar
-- explicitamente o estabelecimento em fluxo administrativo próprio.

begin;

create or replace function public.assign_employee_establishment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_establishment_id uuid;
  active_establishment_count integer;
begin
  if new.establishment_id is not null then
    return new;
  end if;

  select count(*), min(id)
    into active_establishment_count, active_establishment_id
    from public.establishments
   where active = true;

  if active_establishment_count <> 1 then
    raise exception 'Não foi possível identificar um único estabelecimento ativo para o funcionário.';
  end if;

  new.establishment_id := active_establishment_id;
  return new;
end;
$$;

drop trigger if exists employees_assign_establishment on public.employees;
create trigger employees_assign_establishment
before insert on public.employees
for each row
execute function public.assign_employee_establishment();

commit;
