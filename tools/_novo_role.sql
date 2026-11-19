do $body$ begin
  if not exists (select 1 from pg_roles where rolname = $q$peixeiro_2peer$q$) then
    create role peixeiro_2peer login password $q$__PWD__$q$;
  else
    alter role peixeiro_2peer with login password $q$__PWD__$q$;
  end if;
  grant usage, create on schema public to peixeiro_2peer;
end $body$;
