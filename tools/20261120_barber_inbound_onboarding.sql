-- Efeito: guarda por até sete dias a etapa da triagem de contatos desconhecidos do bot.
-- Não altera clientes, contas, funcionários nem dados do chatbot do O Peixeiro.
-- Reversão segura: reverter o código da triagem e deixar a tabela sem uso; não é necessário
-- apagar estados pendentes para voltar ao fluxo anterior.
set role peixeiro_2peer;

create table if not exists public.barber_entrada (
  telefone      text primary key,
  estado        text not null,
  dados         jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now(),
  expira_em     timestamptz not null default now() + interval '7 days'
);

reset role;
