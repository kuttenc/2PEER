import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";

const stubs = new URL("./fixtures/edge-stubs.mjs", import.meta.url).href;
const edgeDependencies = new Set([
  "./banco.ts",
  "./db.ts",
  "./greenapi.ts",
  "./mcapi.ts",
  "./texto.ts",
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (edgeDependencies.has(specifier)) return { url: stubs, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { htmlDaPagina, mapearHorarios } = await import("../supabase/functions/peixeiro/estabelecimento.ts");

function salon(servicos = [], horarios = [{ dia: 1, abre: "09:00", fecha: "18:00", intervalo: 30, primeiro: "" }]) {
  return {
    telefone: "5511999999999",
    nome: "Salão de Teste",
    slug: "salao-teste",
    url: "https://example.test/salao-teste",
    endereco: "Rua de Teste",
    cidade: "São Paulo",
    uf: "SP",
    cep: "",
    telefone_publico: "5511999999999",
    mostra_barbeiro: false,
    servicos,
    produtos: [],
    horarios,
    pagamentos: ["PIX"],
    funcionarios: [],
    fotos: [],
    atualizado_em: "",
  };
}

test("a página renderizada mantém script válido e inclui fluxo de cancelamento", () => {
  const html = htmlDaPagina(
    salon([{ nome: "Corte", preco: 30, duracao_min: 30, descricao: "" }]),
    "https://api.example.test/peixeiro",
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /id="cancelar"/);
  assert.match(html, /id="cancelar-solicitar"/);
  assert.match(html, /id="cancelar-confirmar"/);
  assert.match(script, /estab_cancelar_solicitar/);
  assert.match(script, /estab_cancelar_confirmar/);
  assert.match(html, /--ouro:#efbd72/);
});

test("a página sem serviços ainda carrega o fluxo de cancelamento", () => {
  const html = htmlDaPagina(salon(), "https://api.example.test/peixeiro");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /id="cancelar"/);
});

test("horários vazios permanecem sem expediente presumido", () => {
  assert.deepEqual(mapearHorarios([]), []);
  const html = htmlDaPagina(salon([], mapearHorarios([])), "https://api.example.test/peixeiro");
  assert.match(html, /Este salão ainda não publicou os dias de atendimento/);
  assert.match(html, /segunda<\/b><span>fechado<\/span>/);
});

test("o painel privado edita abertura e fechamento e confirma semana fechada", async () => {
  const source = await readFile(
    new URL("../supabase/functions/peixeiro/estabelecimento.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /abre\.className='abre'/);
  assert.match(source, /fecha\.className='fecha'/);
  assert.match(source, /Preencha abertura e fechamento do mesmo dia/);
  assert.match(source, /Salvar todos os dias como fechados e remover os horários atuais/);
});
