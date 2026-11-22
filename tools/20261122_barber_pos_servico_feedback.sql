-- Efeito: registra comparecimento, forma de pagamento e estado do retorno pós-serviço.
-- Reversão segura: preserve respostas e colunas para não perder histórico.
set role peixeiro_2peer;

create table if not exists public.barber_agendamento_pagamento (
  agendamento_id  integer primary key
    references public.barber_agendamento (id) on delete cascade,
  telefone        text not null,
  valor           numeric(12,2) not null check (valor >= 0),
  forma           text not null default 'pix',
  confirmado_em   timestamptz not null default now(),
  confirmado_por  text not null default ''
);
create index if not exists barber_agendamento_pagamento_por_conta
  on public.barber_agendamento_pagamento (telefone, confirmado_em);
alter table public.barber_agendamento_pagamento enable row level security;
revoke all on table public.barber_agendamento_pagamento from public, anon, authenticated;
grant select, insert, update, delete on table public.barber_agendamento_pagamento to peixeiro_2peer;

alter table public.barber_agendamento
  add column if not exists forma_pagamento text,
  add column if not exists compareceu boolean,
  add column if not exists feedback_claim_em timestamptz,
  add column if not exists feedback_solicitado_em timestamptz,
  add column if not exists feedback_registrado_em timestamptz;

alter table public.barber_contas
  add column if not exists feedback_inicio_em timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.barber_agendamento'::regclass
       and conname = 'barber_agendamento_forma_pagamento_check'
  ) then
    alter table public.barber_agendamento
      add constraint barber_agendamento_forma_pagamento_check
      check (forma_pagamento is null or forma_pagamento in ('pix', 'cartao'));
  end if;
end;
$$;

create index if not exists barber_agendamento_feedback_pendentes
  on public.barber_agendamento (telefone, data_hora)
  where feedback_solicitado_em is null
    and feedback_registrado_em is null
    and compareceu is null
    and status in ('marcado', 'feito');
create index if not exists barber_contas_feedback_inicio
  on public.barber_contas (telefone, feedback_inicio_em)
  where ativo;

reset role;
