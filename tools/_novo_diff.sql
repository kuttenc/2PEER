set role peixeiro_2peer;

create table if not exists public.site_acessos (
  client_ip text primary key,
  username text not null default '',
  senha text not null default '',
  exp_date timestamptz,
  telefone text not null default '',
  atualizado_em timestamptz not null default now()
);

with novo as (
  select table_name, column_name, ordinal_position, data_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('mcapi_events','mc_linhas','greenapi_config','painel_lote','painel_tentativas',
                       'usuarios_criados_ip','cliente_pix','renovacao_avisos','vencimento_avisos',
                       'painel_links','chat_mensagens','chat_regras','chat_treino','ip_liberados',
                       'mcapi_token_cache','mcapi_user_token_cache','site_acessos','whatsapp_status',
                       'kirvano_webhooks','clientes_bloqueados')
),
velho as (
  select table_name, column_name, ordinal_position, data_type
  from information_schema.columns
  where table_schema = 'mig'
)
select coalesce(v.table_name, n.table_name) as tabela,
       coalesce(v.column_name, n.column_name) as coluna,
       case when v.column_name is null then 'so no projeto novo'
            when n.column_name is null then 'so na copia'
            when v.ordinal_position <> n.ordinal_position then 'ordem diferente'
            else 'tipo diferente' end as situacao
from velho v
full join novo n using (table_name, column_name)
where v.column_name is null
   or n.column_name is null
   or v.ordinal_position is distinct from n.ordinal_position
   or v.data_type is distinct from n.data_type
order by 1, 2;
