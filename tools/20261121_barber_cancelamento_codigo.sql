-- Efeito: guarda códigos temporários para cancelamento seguro de agendamentos pelo site.
-- Reversão segura: desative as rotas do site; depois remova somente esta tabela se necessário.
set role peixeiro_2peer;

create table if not exists public.barber_cancelamento_codigo (
  agendamento_id integer primary key
    references public.barber_agendamento (id) on delete cascade,
  telefone text not null,
  cliente_telefone text not null,
  codigo_hash text not null,
  salt text not null,
  expira_em timestamptz not null,
  tentativas smallint not null default 0,
  solicitacoes smallint not null default 1,
  janela_inicio_em timestamptz not null default now(),
  ultima_solicitacao_em timestamptz not null default now(),
  usado_em timestamptz,
  atualizado_em timestamptz not null default now()
);

create index if not exists barber_cancelamento_codigo_por_cliente
  on public.barber_cancelamento_codigo (telefone, cliente_telefone, expira_em)
  where usado_em is null;

reset role;
