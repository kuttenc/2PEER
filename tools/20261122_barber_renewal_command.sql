-- Efeito: guarda a autorização privada do comando e torna cada renovação mensal idempotente
-- pelo identificador da mensagem Green API. Reversão: remover a função, a tabela de auditoria
-- e a coluna; isso desativa o comando e elimina seu histórico de renovações.
set role peixeiro_2peer;

alter table public.barber_config
  add column if not exists renovar_admin_telefone text not null default '';

create table if not exists public.barber_renovacoes (
  message_id text primary key,
  barbeiro_telefone text not null,
  barbeiro_nome text not null default '',
  resultado text not null default 'processando'
    check (resultado in ('processando', 'renovado', 'nao_encontrado')),
  expira_anterior timestamptz,
  expira_nova timestamptz,
  criado_em timestamptz not null default now()
);
alter table public.barber_renovacoes enable row level security;

create or replace function public.barber_renovar_um_mes(
  p_message_id text,
  p_telefone text
)
returns table (
  resultado text,
  nome text,
  expira_anterior timestamptz,
  expira_nova timestamptz
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_claimed text;
  v_nome text;
  v_anterior timestamptz;
  v_nova timestamptz;
begin
  if p_message_id is null or btrim(p_message_id) = ''
     or p_telefone is null or p_telefone !~ '^55[0-9]{10,11}$' then
    raise exception 'invalid renewal command';
  end if;

  insert into public.barber_renovacoes (message_id, barbeiro_telefone)
  values (p_message_id, p_telefone)
  on conflict (message_id) do nothing
  returning message_id into v_claimed;

  if v_claimed is null then
    return query
      select 'duplicado'::text, r.barbeiro_nome, r.expira_anterior, r.expira_nova
        from public.barber_renovacoes r
       where r.message_id = p_message_id;
    return;
  end if;

  select c.nome, c.expira_em
    into v_nome, v_anterior
    from public.barber_contas c
   where c.telefone = p_telefone
   for update;

  if not found then
    update public.barber_renovacoes r
       set resultado = 'nao_encontrado'
     where r.message_id = p_message_id;
    return query select 'nao_encontrado'::text, ''::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  v_nova := greatest(coalesce(v_anterior, now()), now()) + interval '1 month';

  update public.barber_contas c
     set expira_em = v_nova, ativo = true, atualizado_em = now()
   where c.telefone = p_telefone;

  update public.barber_renovacoes r
     set barbeiro_nome = coalesce(v_nome, ''),
         resultado = 'renovado',
         expira_anterior = v_anterior,
         expira_nova = v_nova
   where r.message_id = p_message_id;

  return query select 'renovado'::text, coalesce(v_nome, ''), v_anterior, v_nova;
end;
$$;

revoke all on function public.barber_renovar_um_mes(text, text) from public, anon, authenticated;
grant execute on function public.barber_renovar_um_mes(text, text) to peixeiro_2peer;
