import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const raiz = new URL("../", import.meta.url);
const [acoes, index, greenapi, html, painel] = await Promise.all([
  readFile(new URL("supabase/functions/peixeiro/acoes.ts", raiz), "utf8"),
  readFile(new URL("supabase/functions/peixeiro/index.ts", raiz), "utf8"),
  readFile(new URL("supabase/functions/peixeiro/greenapi.ts", raiz), "utf8"),
  readFile(new URL("painel/index.html", raiz), "utf8"),
  readFile(new URL("painel/app.js", raiz), "utf8"),
]);

test("bloqueio manual exige número válido, grava no blocklist global e audita sem expor telefone", () => {
  const inicio = acoes.indexOf("export async function bloqueadosBloquear");
  const fim = acoes.indexOf("/** Devolve o número para as filas", inicio);
  assert.ok(inicio >= 0 && fim > inicio);
  const handler = acoes.slice(inicio, fim);
  assert.match(handler, /normalizarWhatsapp\(txt\(dados\.telefone\)\)/);
  assert.match(handler, /telefone\.length < 10 \|\| telefone\.length > 15/);
  assert.match(handler, /bloquear\(telefone, "", nome, motivo\)/);
  assert.match(handler, /event_type: "cliente_bloqueado_manual"/);
  assert.match(handler, /request_payload: \{ origem: "painel_bloquear" \}/);
  assert.match(index, /bloqueados_bloquear: acoes\.bloqueadosBloquear/);
});

test("todo envio GreenAPI de texto e arquivo consulta o bloqueio antes de enviar", () => {
  const enviadores = ["enviarArquivo", "enviarTexto"];
  for (const nome of enviadores) {
    const inicio = greenapi.indexOf(`export async function ${nome}`);
    const fim = greenapi.indexOf("\nexport async function ", inicio + 1);
    assert.ok(inicio >= 0);
    const funcao = greenapi.slice(inicio, fim < 0 ? undefined : fim);
    assert.match(funcao, /estaBloqueado\(chat\)/);
    assert.match(funcao, /error: "bloqueado"/);
  }
});

test("aba Bloquear permite incluir telefone e nome, pesquisar e desbloquear com confirmação", () => {
  assert.match(html, /data-tela="bloqueados">Bloquear<\/a>/);
  assert.match(html, /id="formBloquear"/);
  assert.match(html, /id="blTelefone"/);
  assert.match(html, /id="blBusca"/);
  assert.match(html, /app\.js\?v=20261122-bloquear-chatbot/);
  assert.match(painel, /chamar\("bloqueados_bloquear"/);
  assert.match(painel, /window\.confirm\("Bloquear este telefone para respostas do chatbot e mensagens pela GreenAPI\?"\)/);
  assert.match(painel, /chamar\("bloqueados_desbloquear"/);
});
