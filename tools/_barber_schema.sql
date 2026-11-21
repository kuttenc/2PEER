-- Esquema do segundo chatbot: o robô de controle financeiro das barbearias.
--
-- Nada aqui toca nas tabelas do O Peixeiro. As duas bases dividem a mesma instância do
-- GreenAPI e o mesmo webhook, mas cada dado tem sua própria tabela, com o prefixo
-- `barber_`, e a chave de tudo é o telefone da barbearia (`telefone`), não o usuário do
-- painel MC. Quem decide qual robô responde é o `rotearWebhook`, em barbearia.ts.
--
-- O `set role` é o que faz as tabelas nascerem do papel certo: a Edge Function escreve com
-- `peixeiro_2peer`, e uma tabela nascida como `postgres` ficaria sem permissão de INSERT.
set role peixeiro_2peer;

-- --------------------------------------------------------------------------- configuração
create table if not exists public.barber_config (
  id                integer primary key check (id = 1),
  ativo             boolean not null default true,
  -- Quantos dias as conversas ficam guardadas (a mesma régua do robô do Peixeiro).
  dias_retencao     integer not null default 90,
  -- O tempo de teste que todo barbeiro ganha no cadastro, em dias.
  trial_dias        integer not null default 1,
  -- Hora de Brasília em que o lembrete do dia sai.
  lembrete_hora     integer not null default 8,
  menu              text not null default '',
  abordagem         text not null default '',
  boas_vindas       text not null default '',
  lembrete          text not null default '',
  aviso_cliente     text not null default '',
  atualizado_em     timestamptz not null default now()
);
insert into public.barber_config (id) values (1) on conflict (id) do nothing;

-- --------------------------------------------------------------------------------- base
create table if not exists public.barber_contas (
  telefone       text primary key,
  nome           text not null default '',
  nota           text not null default '',
  ativo          boolean not null default true,
  -- Fim do teste. É daqui que saem {vence}, {expira} e {dias} das mensagens.
  expira_em      timestamptz,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

-- ------------------------------------------------------------------- catálogo de cada um
create table if not exists public.barber_servico (
  id            serial primary key,
  telefone      text not null,
  nome          text not null,
  preco         numeric(12,2) not null default 0,
  atualizado_em timestamptz not null default now()
);
create unique index if not exists barber_servico_unicidade
  on public.barber_servico (telefone, lower(nome));

create table if not exists public.barber_produto (
  id            serial primary key,
  telefone      text not null,
  nome          text not null,
  preco         numeric(12,2) not null default 0,
  atualizado_em timestamptz not null default now()
);
create unique index if not exists barber_produto_unicidade
  on public.barber_produto (telefone, lower(nome));

create table if not exists public.barber_pacote (
  id            serial primary key,
  telefone      text not null,
  nome          text not null,
  servico       text not null default '',
  quantidade    integer not null default 1,
  preco         numeric(12,2) not null default 0,
  valido_dias   integer not null default 90,
  atualizado_em timestamptz not null default now()
);
create unique index if not exists barber_pacote_unicidade
  on public.barber_pacote (telefone, lower(nome));

-- ----------------------------------------------------------------- entradas e saídas
create table if not exists public.barber_lancamento (
  id        serial primary key,
  telefone  text not null,
  tipo      text not null check (tipo in ('entrada', 'saida')),
  descricao text not null default '',
  valor     numeric(12,2) not null,
  -- De onde veio o lançamento: 'chat' é o bot, 'painel' é ele corrigindo na tela.
  origem    text not null default 'chat',
  quando    timestamptz not null default now(),
  criado_em timestamptz not null default now()
);
create index if not exists barber_lancamento_por_dia
  on public.barber_lancamento (telefone, quando);

-- ------------------------------------------------------------------------ agendamentos
create table if not exists public.barber_agendamento (
  id                 serial primary key,
  telefone           text not null,
  cliente_telefone   text not null default '',
  cliente_nome       text not null default '',
  -- O serviço fica escrito como ele foi cadastrado no catálogo: é isso que o lembrete
  -- das 8h repete, e é por isso que o bot não aceita um serviço que ele não cadastrou.
  servico            text not null default '',
  data_hora          timestamptz not null,
  status             text not null default 'marcado'
    check (status in ('marcado', 'feito', 'cancelado', 'remarcado')),
  observacao         text not null default '',
  -- Quando o lembrete do dia já saiu, para o cron não mandar duas vezes.
  lembrete_enviado_em timestamptz,
  criado_em          timestamptz not null default now(),
  atualizado_em      timestamptz not null default now()
);
create index if not exists barber_agendamento_por_barbeiro
  on public.barber_agendamento (telefone, data_hora);

-- ------------------------------------------------- a conversa do robô das barbearias
create table if not exists public.barber_mensagens (
  id        serial primary key,
  chave     text unique,
  telefone  text not null,
  direcao   text not null check (direcao in ('entrada', 'saida')),
  texto     text not null default '',
  expira_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists barber_mensagens_por_telefone
  on public.barber_mensagens (telefone, criado_em);

-- O que ele diz quando o bot não entendeu: é a fila de treino, igual ao chat_treino do Peixeiro.
create table if not exists public.barber_treino (
  id        serial primary key,
  telefone  text not null,
  texto     text not null,
  criado_em timestamptz not null default now()
);

-- ------------------------------------------------------------------- a confirmação
-- Cada lançamento, agendamento e cadastro fica pendurado aqui até ele responder SIM.
-- Uma linha por barbearia: o bot pergunta, ele responde, e a pergunta morre.
create table if not exists public.barber_pendencias (
  telefone   text primary key,
  acao       text not null,
  dados      jsonb not null default '{}'::jsonb,
  criado_em  timestamptz not null default now()
);

-- ------------------------------------------------------- quem respondeu "CONTROLE"
-- Ainda não é barbearia: é a fila da aba Adicionar Barbeiros. Só entra número que pediu
-- para ser atendido, e a coluna `telefone_conta` diz em qual conta ele virou cliente.
create table if not exists public.barber_interessados (
  telefone      text primary key,
  texto         text not null default '',
  telefone_conta text not null default '',
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- O `numero` é o código curto que aparece na lista dele (AVISA 2, FEITO 2). O `id` é global,
-- e ninguém digita um número de seis dígitos no WhatsApp.
alter table public.barber_agendamento add column if not exists numero integer;
create unique index if not exists barber_agendamento_numero
  on public.barber_agendamento (telefone, numero);

-- As duas colunas novas da config, para o arquivo ser reaplicável sem recriar nada.
alter table public.barber_config add column if not exists responder_controle boolean not null default true;
alter table public.barber_config add column if not exists msg_interesse text not null default '';
alter table public.barber_config add column if not exists msg_vencido text not null default '';

reset role;

-- ----------------------------------------------------------------------- a fila do disparo
-- O lote das barbearias: o navegador puxa um de cada vez (barb_fila_proximo), então fechar a
-- tela não perde o andamento e nada aqui depende de uma requisição longa na Edge Function.
create table if not exists public.barber_fila (
  telefone    text primary key,
  texto       text not null,
  estado      text not null default 'pendente'
    check (estado in ('pendente', 'enviado', 'falha', 'pulado')),
  detalhe     text not null default '',
  id_message  text not null default '',
  criado_em   timestamptz not null default now(),
  enviado_em  timestamptz
);
create index if not exists barber_fila_pendentes on public.barber_fila (estado, criado_em);
