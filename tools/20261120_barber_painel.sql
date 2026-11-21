-- Efeito: cria acesso privado por chave para o painel simples de cada barbearia.
-- A chave fica na URL publicada e é validada pelas actions do Supabase antes de editar dados.
-- Reversão segura: retirar esta tabela e as ações públicas correspondentes desativa o painel.
set role peixeiro_2peer;

create table if not exists public.barber_painel (
  telefone text primary key,
  chave text not null unique,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists barber_painel_chave
  on public.barber_painel (chave) where ativo;

reset role;

grant select, insert, update, delete on table public.barber_painel to peixeiro_2peer;
