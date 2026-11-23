import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  paginaPublicadaCompleta,
  parseComandoBoasVindas,
} from "../supabase/functions/_shared/barber-site-onboarding.mjs";

const pagina = {
  nome: "Barbearia Teste",
  endereco: "Rua Um, 10",
  telefone: "5511999999999",
  telefone_publico: "5511999999999",
  aceita_agendamento: true,
  servicos: [{ nome: "Corte" }],
  horarios: [{ abre: "09:00", fecha: "18:00" }],
  pagamentos: ["Pix"],
};

const html = `<!doctype html><html><head><title>Barbearia Teste</title></head><body>
<header><h1>Barbearia Teste</h1><p>Rua Um, 10</p></header>
<section id="agendar"><h2>Agendar horário</h2><div id="servicos-escolha"></div>
<div id="dias"></div><div id="horas"></div><button id="gravar"></button></section>
<section><h2>Serviços</h2><b>Corte</b></section>
<section><h2>Horários de atendimento</h2><span>09:00 às 18:00</span></section>
<section><h2>Formas de pagamento</h2><span class="chip">Pix</span></section>
<script id="dados" type="application/json">{}</script>
<script>document.getElementById('dados')</script>
</body></html>`;

test("reconhece somente o comando administrativo de boas-vindas", () => {
  for (const comando of ["enviar boasvindas", "ENVIAR BOAS VINDAS", "Enviar boas-vindas.", "/enviar boasvindas"]) {
    assert.equal(parseComandoBoasVindas(comando), true);
  }
  for (const comando of ["boasvindas", "enviar boas vindas para todos", "enviar boasvindas 5511999999999"]) {
    assert.equal(parseComandoBoasVindas(comando), false);
  }
});

test("só considera pronta uma página pública não vazia com endereço e agenda funcional", () => {
  assert.equal(paginaPublicadaCompleta(html, pagina), true);
  assert.equal(paginaPublicadaCompleta("", pagina), false);
  assert.equal(paginaPublicadaCompleta(html.replace("id=\"gravar\"", "id=\"indisponivel\""), pagina), false);
  assert.equal(paginaPublicadaCompleta(html, { ...pagina, endereco: "" }), false);
});

test("os marcadores de prontidão existem no HTML gerado pelo site", async () => {
  const estabelecimento = await readFile(
    new URL("../supabase/functions/peixeiro/estabelecimento.ts", import.meta.url),
    "utf8",
  );
  for (const trecho of [
    '<section id="agendar">',
    'id="servicos-escolha"',
    'id="dias"',
    'id="horas"',
    'id="gravar"',
    '<script id="dados" type="application/json">',
    "<h2>Serviços</h2>",
    "<h2>Horários de atendimento</h2>",
    "<h2>Formas de pagamento</h2>",
  ]) {
    assert.ok(estabelecimento.includes(trecho), `HTML do site deve conter ${trecho}`);
  }
});

test("o webhook restringe o comando ao administrador e registra envios sem repetir", async () => {
  const barbearia = await readFile(
    new URL("../supabase/functions/peixeiro/barbearia.ts", import.meta.url),
    "utf8",
  );
  const acoes = await readFile(
    new URL("../supabase/functions/peixeiro/acoes.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../tools/20261123_barber_welcome_command.sql", import.meta.url),
    "utf8",
  );
  const painelHtml = await readFile(new URL("../painel/index.html", import.meta.url), "utf8");
  const painelJs = await readFile(new URL("../painel/app.js", import.meta.url), "utf8");
  assert.match(barbearia, /parseComandoBoasVindas\(m\.texto\)/);
  assert.match(barbearia, /m\.telefone !== telefoneAdmin/);
  assert.match(barbearia, /site_boas_vindas_solicitada_em is not null/);
  assert.match(barbearia, /site_boas_vindas_enviado_em/);
  assert.ok(
    barbearia.indexOf("validarPaginaParaBoasVindas(telefone)") <
      barbearia.indexOf("enviarParaBarbeiro(telefone, textos.boas_vindas, true)"),
  );
  assert.match(barbearia, /export async function processarBoasVindasPendentes\(limite = 10\)/);
  assert.match(barbearia, /site_boas_vindas_tentativa_em <= now\(\) - interval '15 minutes'/);
  assert.match(acoes, /const boasVindas = await processarBoasVindasPendentes\(10\)/);
  assert.match(acoes, /boas_vindas: boasVindas/);
  assert.match(acoes, /validarPaginaParaBoasVindas/);
  assert.match(painelHtml, /id="bbEndereco"/);
  assert.match(painelHtml, /id="bbAvisar"/);
  assert.match(painelJs, /endereco: \$\("bbEndereco"\)\.value/);
  assert.match(barbearia, /validarPaginaParaBoasVindas\(telefone\)[\s\S]*enviarParaBarbeiro\(telefone, textos\.boas_vindas, true\)/);
  assert.match(barbearia, /if \(publicado\.ok\) await enviarBoasVindasPendente/);
  assert.match(migration, /add column if not exists site_boas_vindas_solicitada_em timestamptz/);
  assert.match(migration, /update public\.barber_contas[\s\S]*site_boas_vindas_enviado_em is null/);
});
