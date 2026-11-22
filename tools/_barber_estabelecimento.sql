-- O estabelecimento: a página pública de cada salão e tudo que ela precisa mostrar.
--
-- Nada aqui apaga o que já foi gravado. As tabelas novas guardam o que o site AppBarber
-- mostra e o nosso esquema ainda não tinha: horário de cada dia, forma de pagamento,
-- funcionário com telefone próprio e foto.
--
-- O `set role` é obrigatório no projeto do painel: sem ele a tabela nasce como `postgres`
-- e a Edge Function fica sem permissão de INSERT.
set role peixeiro_2peer;

-- ---------------------------------------------------------------------------- a conta
-- O `slug` é o final do endereço da página: https://kuttenc.github.io/estabelecimento/SLUG
-- Tudo junto, sem espaço, porque o endereço do site não aceita espaço. É o barbeiro que
-- troca isso pelo bot, com NOMESITE.
alter table public.barber_contas add column if not exists slug             text not null default '';
alter table public.barber_contas add column if not exists endereco         text not null default '';
alter table public.barber_contas add column if not exists cidade           text not null default '';
alter table public.barber_contas add column if not exists uf               text not null default '';
alter table public.barber_contas add column if not exists cep              text not null default '';
-- "quem vai cortar o cabelo do cliente" aparece na página antes de agendar?
alter table public.barber_contas add column if not exists mostra_barbeiro  boolean not null default true;
-- Página publicada no GitHub: quando, e com que número de chamada (o `sha` do arquivo).
alter table public.barber_contas add column if not exists site_publicado_em timestamptz;
alter table public.barber_contas add column if not exists site_sha         text not null default '';
-- Controle para enviar uma única vez as instruções de inclusão do link no WhatsApp Business.
alter table public.barber_contas add column if not exists site_instrucoes_whatsapp_tentativa_em timestamptz;
alter table public.barber_contas add column if not exists site_instrucoes_whatsapp_enviado_em  timestamptz;
-- O telefone que a página mostra para o cliente falar (nem todo salão usa o do dono).
alter table public.barber_contas add column if not exists telefone_publico text not null default '';

create unique index if not exists barber_contas_slug
  on public.barber_contas (lower(slug)) where slug <> '';

-- --------------------------------------------------------------------------- catálogo
-- A duração é o que permite calcular a vaga livre na página: corte de 30 não cabe onde
-- já existe um horário de 60 minutos.
alter table public.barber_servico add column if not exists duracao_min integer not null default 30;
alter table public.barber_servico add column if not exists ativo       boolean not null default true;
alter table public.barber_servico add column if not exists descricao   text not null default '';
alter table public.barber_produto add column if not exists ativo       boolean not null default true;

-- ----------------------------------------------------------------------------- horários
-- Um salão que fecha no domingo não tem linha no domingo: é a ausência que diz isso.
create table if not exists public.barber_horario (
  id        serial primary key,
  telefone  text not null,
  -- 0 = domingo, 1 = segunda ... 6 = sábado. É o número que Date.getUTCDay devolve.
  dia       integer not null check (dia between 0 and 6),
  abre      time not null default '09:00',
  fecha     time not null default '19:00',
  primeiro  time,
  intervalo integer not null default 30,
  unique (telefone, dia)
);

-- ------------------------------------------------------------------- formas de pagamento
create table if not exists public.barber_pagamento (
  id        serial primary key,
  telefone  text not null,
  nome      text not null,
  detalhe   text not null default '',
  ordem     integer not null default 0
);
-- O "lower" não pode viver dentro de `unique (...)` na criação da tabela; só como índice.
create unique index if not exists barber_pagamento_unicidade
  on public.barber_pagamento (telefone, lower(nome));

-- --------------------------------------------------------------------------- funcionários
-- O telefone é a chave: é por ele que o webhook sabe quem está falando. Um barbeiro que
-- corta em dois salões tem duas linhas, uma por salão, e cada uma responde pela sua agenda.
create table if not exists public.barber_funcionario (
  id           serial primary key,
  barbearia    text not null,
  telefone     text not null,
  nome         text not null default '',
  cargo        text not null default 'barbeiro',
  cor          text not null default '',
  foto_arquivo text not null default '',
  -- O dono pode tirar alguém da página sem apagar a história dele na agenda.
  na_pagina    boolean not null default true,
  ativo        boolean not null default true,
  criado_em    timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index if not exists barber_funcionario_unicidade
  on public.barber_funcionario (lower(barbearia), lower(telefone));
create index if not exists barber_funcionario_por_telefone
  on public.barber_funcionario (telefone);

-- ---------------------------------------------------------------------------- as fotos
-- O arquivo mora no GitHub (a banda é de lá, não do banco). Aqui fica só o caminho.
create table if not exists public.barber_foto (
  id        serial primary key,
  telefone  text not null,
  arquivo   text not null default '',
  legenda   text not null default '',
  ordem     integer not null default 0,
  criado_em timestamptz not null default now()
);
create index if not exists barber_foto_por_conta on public.barber_foto (telefone, ordem);

-- ---------------------------------------------------------------------------- a agenda
-- `funcionario_id` é quem corta. `duracao_min` fica congelada no horário: se ele trocar o
-- preço ou o tempo do serviço depois, o que já foi marcado não se desmonta.
alter table public.barber_agendamento add column if not exists funcionario_id integer;
alter table public.barber_agendamento add column if not exists funcionario_telefone text not null default '';
alter table public.barber_agendamento add column if not exists duracao_min integer not null default 30;
-- 'site' é o que veio da página pública; 'bot' é o que ele mandou no WhatsApp.
alter table public.barber_agendamento add column if not exists origem text not null default 'bot';

-- --------------------------------------------------------------------------- as pendências
-- A pendência do tipo "foto" espera a próxima mensagem DE IMAGEM dele: a linha guarda para
-- quem vai a foto (salão ou qual funcionário) e a legenda que ele escreveu junto. Não é
-- preciso coluna nova: `barber_pendencias.dados` é jsonb e já comporta isso.

-- --------------------------------------------------------------- o texto novo da entrada
alter table public.barber_config add column if not exists boas_vindas_site text not null default '';
alter table public.barber_config add column if not exists aviso_novo_site  text not null default '';
alter table public.barber_config add column if not exists ajuda_funcionario text not null default '';

reset role;
