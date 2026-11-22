import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const index = await readFile(
  new URL("../supabase/functions/peixeiro/index.ts", import.meta.url),
  "utf8",
);

test("as rotas públicas da agenda e do cancelamento estão ligadas sem sessão", () => {
  const semSessao = index.match(/const SEM_SESSAO = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
  const acoes = index.match(/const ACAO: Record<string, Handler> = \{([\s\S]*?)\n\};/)?.[1] || "";
  for (const nome of [
    "estab_vagas",
    "estab_marcar",
    "estab_cancelar_solicitar",
    "estab_cancelar_confirmar",
  ]) {
    assert.match(semSessao, new RegExp(`"${nome}"`));
    assert.match(acoes, new RegExp(`\\b${nome}:`));
  }
});

test("o código de cancelamento nunca é enviado de volta na resposta pública", async () => {
  const estabelecimento = await readFile(
    new URL("../supabase/functions/peixeiro/estabelecimento.ts", import.meta.url),
    "utf8",
  );
  const inicio = estabelecimento.indexOf("export const estabCancelarSolicitar");
  const fim = estabelecimento.indexOf("/** Valida o código", inicio);
  assert.notEqual(inicio, -1);
  assert.notEqual(fim, -1);
  const handler = estabelecimento.slice(inicio, fim);
  assert.match(handler, /enviarTexto\(\s*conf,\s*cliente,/);
  assert.match(handler, /return respostaCancelamentoGenerica\(\)/);
  assert.doesNotMatch(handler, /return\s+\{[^}]*codigo\s*:/s);
});

test("o cron tenta enviar o bom-dia antes do horário configurado para lembretes", async () => {
  const acoes = await readFile(
    new URL("../supabase/functions/peixeiro/acoes.ts", import.meta.url),
    "utf8",
  );
  const inicio = acoes.indexOf("export async function barbCron");
  const fim = acoes.indexOf("\n}", inicio);
  const cron = acoes.slice(inicio, fim);
  assert.ok(inicio >= 0);
  assert.ok(fim > inicio);
  assert.ok(cron.indexOf("bomDiaTodos(forcar)") < cron.indexOf("antesDaHoraDoLembrete"));
});

test("horários inválidos são rejeitados antes de apagar os horários atuais", async () => {
  const acoes = await readFile(
    new URL("../supabase/functions/peixeiro/acoes.ts", import.meta.url),
    "utf8",
  );
  const inicio = acoes.indexOf("export async function barbPainelSalvar");
  const fim = acoes.indexOf("\nexport async function barbPainelFoto", inicio);
  const salvar = acoes.slice(inicio, fim);
  assert.ok(inicio >= 0);
  assert.ok(fim > inicio);
  assert.ok(salvar.indexOf('falha("horario_invalido")') < salvar.indexOf("delete from public.barber_horario"));
});

test("o catálogo do painel inclui os IDs editáveis e a duração dos serviços", async () => {
  const barbearia = await readFile(
    new URL("../supabase/functions/peixeiro/barbearia.ts", import.meta.url),
    "utf8",
  );
  const inicio = barbearia.indexOf("export type ItemCatalogo");
  const fim = barbearia.indexOf("\nexport async function catalogo", inicio);
  const leitor = barbearia.slice(inicio, fim);
  assert.ok(inicio >= 0);
  assert.ok(fim > inicio);
  assert.match(leitor, /"id, nome, preco, duracao_min"/);
  assert.match(leitor, /"id, nome, preco"/);
  assert.match(leitor, /id: Number\(l\.id\)/);
  assert.match(leitor, /duracao_min: Number\(l\.duracao_min/);
});

test("edições de serviço e produto recusam IDs inválidos ou que não pertencem à conta", async () => {
  const acoes = await readFile(
    new URL("../supabase/functions/peixeiro/acoes.ts", import.meta.url),
    "utf8",
  );
  const inicio = acoes.indexOf("export async function barbPainelSalvar");
  const fim = acoes.indexOf("\nexport async function barbPainelFoto", inicio);
  const salvar = acoes.slice(inicio, fim);
  assert.ok(inicio >= 0);
  assert.ok(fim > inicio);
  assert.match(salvar, /Number\.isSafeInteger\(id\)/);
  assert.match(salvar, /return falha\("servico_nao_encontrado", 404\)/);
  assert.match(salvar, /return falha\("produto_nao_encontrado", 404\)/);
});
