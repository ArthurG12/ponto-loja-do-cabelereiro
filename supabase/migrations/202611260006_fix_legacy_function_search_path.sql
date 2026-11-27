-- REP-P / segurança — fixa search_path das funções auxiliares legadas.

begin;
alter function public.punch_sequence_for(text, date) set search_path = public;
alter function public.punch_label(public.punch_kind) set search_path = public;
commit;
