-- Efeito: registra confirmações de entrega dos lembretes recorrentes e permite pausá-los
-- após entregas em dois dias consecutivos sem nova mensagem do barbeiro.
-- Reversão: remover a verificação de pausa do código e descartar esta tabela; nenhum dado
-- preexistente é alterado.
set role peixeiro_2peer;

create table if not exists public.barber_reminder_deliveries (
  id_message text primary key,
  telefone   text not null,
  categoria  text not null check (categoria in ('bom_dia', 'agenda')),
  enviado_em timestamptz not null default now(),
  entregue_em timestamptz
);
create index if not exists barber_reminder_deliveries_por_conta
  on public.barber_reminder_deliveries (telefone, entregue_em desc)
  where entregue_em is not null;

alter table public.barber_reminder_deliveries enable row level security;
revoke all on table public.barber_reminder_deliveries from public, anon, authenticated;
grant select, insert, update, delete on table public.barber_reminder_deliveries to peixeiro_2peer;

reset role;
