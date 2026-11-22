import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { interpretarRetornoPagamento } from "../supabase/functions/_shared/barber-payment-feedback.mjs";

const raiz = new URL("../", import.meta.url);
const [barbearia, acoes, index, painel, migration, migrationCron] = await Promise.all([
  readFile(new URL("supabase/functions/peixeiro/barbearia.ts", raiz), "utf8"),
  readFile(new URL("supabase/functions/peixeiro/acoes.ts", raiz), "utf8"),
  readFile(new URL("supabase/functions/peixeiro/index.ts", raiz), "utf8"),
  readFile(new URL("painel/app.js", raiz), "utf8"),
  readFile(new URL("tools/20261122_barber_pos_servico_feedback.sql", raiz), "utf8"),
  readFile(new URL("tools/20261123_barber_pos_servico_feedback_cron.sql", raiz), "utf8"),
]);

test("normaliza PIX, cartão e ausência com tolerância à acentuação e pontuação", () => {
  assert.equal(interpretarRetornoPagamento("PIX!"), "pix");
  assert.equal(interpretarRetornoPagamento("Cartão"), "cartao");
  assert.equal(interpretarRetornoPagamento("CARTAO DE CREDITO"), "cartao");
  assert.equal(interpretarRetornoPagamento("não veio"), "nao_veio");
  assert.equal(interpretarRetornoPagamento("nao compareceu."), "nao_veio");
  assert.equal(interpretarRetornoPagamento("paguei no pix"), null);
});

test("comandos de agenda listam hoje e os próximos sete dias, com retorno registrado", () => {
  assert.match(barbearia, /t === "ver agendamentos" \|\| t === "ver agendamentos semanal"/);
  assert.match(barbearia, /agendamentosDe\(telefone, periodo\.desde, periodo\.ate, "", 500\)/);
  assert.match(barbearia, /a\.compareceu === false/);
  assert.match(barbearia, /feedback_registrado_em = now\(\)/);
});

test("cron é token-protegido e não processa agendamentos anteriores à ativação", () => {
  const semSessao = index.match(/const SEM_SESSAO = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
  assert.match(semSessao, /"barb_pagamento_cron"/);
  assert.match(index, /barb_pagamento_cron: acoes\.barbPagamentoCron/);
  assert.match(acoes, /dados\.token/);
  assert.match(barbearia, /a\.data_hora >= c\.feedback_inicio_em/);
  assert.match(barbearia, /a\.data_hora \+ make_interval\([\s\S]*\+ 40/);
  assert.match(barbearia, /barber_agendamento_pagamento p/);
  assert.match(barbearia, /PIX, CARTÃO ou NÃO VEIO/);
});

test("painel exibe agendamentos, mensagem vazia e botão para copiar a página", () => {
  assert.match(acoes, /agendamentos_clientes: agendamentosParaTela\(agendaClientes\)/);
  assert.match(acoes, /pagina_url: pagina\?\.url/);
  assert.match(painel, /Sem agendamentos\. Peça para seu cliente agendar pelo link da página\./);
  assert.match(painel, /Copiar link da página/);
  assert.match(painel, /navigator\.clipboard\.writeText\(pagina\)/);
});

test("migrações de esquema e cron não dependem da tabela de Vision", () => {
  assert.match(migration, /create table if not exists public\.barber_agendamento_pagamento/);
  assert.match(migration, /add column if not exists feedback_inicio_em timestamptz not null default now\(\)/);
  assert.match(migrationCron, /'\*\/5 \* \* \* \*'/);
  assert.match(migrationCron, /'barb_pagamento_cron'/);
});
