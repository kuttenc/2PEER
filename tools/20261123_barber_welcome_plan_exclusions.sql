-- Efeito: impede boas-vindas/prospeccao a clientes com plano, incluindo renovações registradas.
-- Reversao: remover o trigger e sua funcao, depois a tabela; isso reabilita os envios sem apagar
-- contas, conversas ou renovacoes existentes.
set role peixeiro_2peer;

create table if not exists public.barber_boas_vindas_bloqueios (
  telefone text primary key check (telefone ~ '^55[0-9]{10,11}$'),
  nome text not null default '',
  motivo text not null default 'plano ativo',
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  desativado_em timestamptz
);
alter table public.barber_boas_vindas_bloqueios enable row level security;
revoke all on table public.barber_boas_vindas_bloqueios from public, anon, authenticated;
create index if not exists barber_boas_vindas_bloqueios_ativos
  on public.barber_boas_vindas_bloqueios (ativo, atualizado_em desc);

create or replace function public.barber_excluir_renovado_de_boas_vindas()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.resultado = 'renovado' then
    insert into public.barber_boas_vindas_bloqueios
      (telefone, nome, motivo, ativo, criado_em, atualizado_em, desativado_em)
    values
      (new.barbeiro_telefone, new.barbeiro_nome, 'plano renovado', true, now(), now(), null)
    on conflict (telefone) do update
      set nome = coalesce(nullif(excluded.nome, ''), barber_boas_vindas_bloqueios.nome),
          motivo = 'plano renovado',
          ativo = true,
          atualizado_em = now(),
          desativado_em = null;
  end if;
  return new;
end;
$$;
revoke all on function public.barber_excluir_renovado_de_boas_vindas() from public, anon, authenticated;

drop trigger if exists barber_renovacao_excluir_boas_vindas on public.barber_renovacoes;
create trigger barber_renovacao_excluir_boas_vindas
  after insert or update on public.barber_renovacoes
  for each row execute function public.barber_excluir_renovado_de_boas_vindas();

insert into public.barber_boas_vindas_bloqueios
  (telefone, nome, motivo, ativo, criado_em, atualizado_em, desativado_em)
select distinct c.telefone, c.nome, 'plano renovado', true, now(), now(), null::timestamptz
  from public.barber_contas c
  join public.barber_renovacoes r on r.barbeiro_telefone = c.telefone
 where r.resultado = 'renovado'
   and c.ativo
   and c.expira_em > now()
on conflict (telefone) do update
  set nome = coalesce(nullif(excluded.nome, ''), barber_boas_vindas_bloqueios.nome),
      motivo = 'plano renovado',
      ativo = true,
      atualizado_em = now(),
      desativado_em = null;

reset role;
