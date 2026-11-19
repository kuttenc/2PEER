-- Recarga TOTAL do banco novo a partir da cópia, pela ponte fdw `mig`.
-- Uso: imediatamente antes de virar o painel para o projeto novo (e de novo a qualquer
-- momento se ele voltar para a cópia por um tempo), para que nenhuma linha escrita na
-- cópia depois da primeira migração fique para trás.
-- É seguro porque só o painel escreve nestas tabelas e, enquanto o config.js aponta para
-- a cópia, o banco novo está parado. O `truncate` apaga também as linhas de teste que eu
-- mesmo criar na prova.
set role peixeiro_2peer;

truncate table
  greenapi_config, painel_lote, mc_linhas, cliente_pix, usuarios_criados_ip, mcapi_events,
  chat_regras, chat_mensagens, chat_treino, painel_links, painel_tentativas, renovacao_avisos,
  vencimento_avisos, clientes_bloqueados, ip_liberados, site_acessos, whatsapp_status,
  kirvano_webhooks, mcapi_token_cache, mcapi_user_token_cache;

insert into public.greenapi_config      select * from mig.greenapi_config;
insert into public.painel_lote          select * from mig.painel_lote;
insert into public.mc_linhas            select * from mig.mc_linhas;
insert into public.cliente_pix          select * from mig.cliente_pix;
insert into public.usuarios_criados_ip  select * from mig.usuarios_criados_ip;
insert into public.mcapi_events         select * from mig.mcapi_events;
insert into public.chat_regras          select * from mig.chat_regras;
insert into public.chat_mensagens       select * from mig.chat_mensagens;
insert into public.chat_treino          select * from mig.chat_treino;
insert into public.painel_links         select * from mig.painel_links;
insert into public.painel_tentativas    select * from mig.painel_tentativas;
insert into public.renovacao_avisos     select * from mig.renovacao_avisos;
insert into public.vencimento_avisos    select * from mig.vencimento_avisos;
insert into public.clientes_bloqueados  select * from mig.clientes_bloqueados;
insert into public.ip_liberados         select * from mig.ip_liberados;
insert into public.site_acessos         select * from mig.site_acessos;
insert into public.whatsapp_status      select * from mig.whatsapp_status;
insert into public.kirvano_webhooks     select * from mig.kirvano_webhooks;
insert into public.mcapi_token_cache    select * from mig.mcapi_token_cache;
insert into public.mcapi_user_token_cache select * from mig.mcapi_user_token_cache;

-- As sequências voltam para cima do maior id copiado; sem isso o primeiro insert novo
-- bate em chave duplicada.
do $body$ declare r record; alvo bigint; seq text; begin
  for r in select c.table_name as tabela, c.column_name as coluna
             from information_schema.columns c
            where c.table_schema = 'public'
              and c.table_name in ('greenapi_config','painel_lote','mc_linhas','cliente_pix',
                'usuarios_criados_ip','mcapi_events','chat_regras','chat_mensagens','chat_treino',
                'painel_links','painel_tentativas','renovacao_avisos','vencimento_avisos',
                'clientes_bloqueados','ip_liberados','site_acessos','whatsapp_status',
                'kirvano_webhooks','mcapi_token_cache','mcapi_user_token_cache')
              and c.column_default like 'nextval%' loop
    seq := pg_get_serial_sequence('public.' || r.tabela, r.coluna);
    if seq is null then continue; end if;
    execute format('select coalesce(max(%I), 0) from public.%I', r.coluna, r.tabela) into alvo;
    if alvo > 0 then perform setval(seq, alvo); else perform setval(seq, 1, false); end if;
  end loop;
end $body$;
