do $body$ begin
  if not exists (select 1 from pg_foreign_data_wrapper where fdwname = $$postgres_fdw$$) then
    create extension postgres_fdw;
  end if;

  if not exists (select 1 from pg_foreign_server where srvname = $$copia_2peer$$) then
    create server copia_2peer foreign data wrapper postgres_fdw
      options (host $$__HOST__$$, port $$__PORT__$$, dbname $$postgres$$,
               sslmode $$require$$, fetch_size $$50000$$);
  else
    alter server copia_2peer options (set host $$__HOST__$$, set port $$__PORT__$$,
               set dbname $$postgres$$, set sslmode $$require$$, set fetch_size $$50000$$);
  end if;

  if exists (select 1 from pg_user_mappings where srvname = $$copia_2peer$$ and usename = current_user) then
    alter user mapping for current_user server copia_2peer
      options (set user $$__USER__$$, set password $$__PASS__$$);
  else
    create user mapping for current_user server copia_2peer
      options (user $$__USER__$$, password $$__PASS__$$);
  end if;
end $body$;

-- O papel do painel também precisa da ponte: sem este mapping o `select` feito como
-- `peixeiro_2peer` na schema `mig` volta "permission denied for foreign server".
do $body$ begin
  if not exists (select 1 from pg_roles where rolname = $$peixeiro_2peer$$) then
    raise notice $$papel peixeiro_2peer ainda não existe: rode tools/_novo_role.sql antes$$;
    return;
  end if;

  grant usage on schema mig to peixeiro_2peer;
  grant select on all tables in schema mig to peixeiro_2peer;

  if exists (select 1 from pg_user_mappings where srvname = $$copia_2peer$$ and usename = $$peixeiro_2peer$$) then
    alter user mapping for peixeiro_2peer server copia_2peer
      options (set user $$__USER__$$, set password $$__PASS__$$);
  else
    create user mapping for peixeiro_2peer server copia_2peer
      options (user $$__USER__$$, password $$__PASS__$$);
  end if;
end $body$;
