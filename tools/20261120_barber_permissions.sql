-- Efeito: concede ao papel da Edge Function acesso completo somente às tabelas barber_*.
-- Inclui a tabela/índices da triagem e todas as sequências usadas por esses cadastros.
-- Reversão segura: revogar DML das tabelas barber_* deste papel faz o robô/parcialmente o painel parar.

do $$
declare
  item record;
begin
  for item in
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name like 'barber_%'
       and table_type = 'BASE TABLE'
  loop
    execute format(
      'grant select, insert, update, delete on table public.%I to peixeiro_2peer',
      item.table_name
    );
  end loop;

  for item in
    select sequence_name
      from information_schema.sequences
     where sequence_schema = 'public'
       and sequence_name like 'barber_%'
  loop
    execute format(
      'grant usage, select, update on sequence public.%I to peixeiro_2peer',
      item.sequence_name
    );
  end loop;
end;
$$;
