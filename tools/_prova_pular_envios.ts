// Prova do "pular envios" da fila que está rodando.
//
//   npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_pular_envios.ts
//
// Nada aqui manda WhatsApp nem abre o painel MC: são só as funções de plano e estado. Para não
// mexer na fila real do "Não recuperados", o teste trabalha na chave do lote de apagada, guarda
// a linha como ela está e devolve exatamente do mesmo jeito no fim — mesmo se der erro no meio.
import { loteFila, lotePular } from "../supabase/functions/peixeiro/acoes.ts";
import { consultar, consultar1 } from "../supabase/functions/peixeiro/db.ts";
import {
  gravarPlano,
  iniciarLote,
  pularEnvios,
  proximoItem,
  registrarItem,
  verLote,
} from "../supabase/functions/peixeiro/lote.ts";

const CHAVE = "deletar_lote";
let falhas = 0;
function checar(rotulo: string, verdadeiro: unknown, detalhe = "") {
  if (!verdadeiro) falhas++;
  console.log(`${verdadeiro ? "OK  " : "FAIL"} ${rotulo}${detalhe ? "  → " + detalhe : ""}`);
}

const original = await consultar1(
  "select plano, estado, aviso from public.painel_lote where chave = $1",
  [CHAVE],
) as Record<string, unknown> | null;

const plano = (quantos: number) =>
  Array.from({ length: quantos }, (_, i) => ({ username: `zzteste${i}`, telefone: "", exp_iso: "" }));

async function marcas(): Promise<string[]> {
  const vista = await verLote("apagar");
  return (vista?.plano || []).map((item) => (item.pulado === true ? "P" : item.ignorado === true ? "X" : "."));
}

try {
  // ------------------------------------------------------------------ o pulo do meio da fila
  await gravarPlano("apagar", plano(10));
  await iniciarLote("apagar");
  const primeiro = await proximoItem("apagar");
  checar("o item que está no ar é o #1", primeiro !== null && "item" in primeiro && primeiro.indice === 0,
    primeiro === null ? "null" : "emEnvio" in primeiro ? "emEnvio" : `#${primeiro.indice + 1}`);

  const meio = await pularEnvios("apagar", 3);
  checar("com um item no ar, o pulo começa no próximo que ainda não saiu", meio.pulados === 3, `${meio.pulados}`);
  checar("o item no ar não é marcado e os três seguintes viram pulados",
    (await marcas()).join("") === ".PPP......", (await marcas()).join(""));

  const depois = await registrarItem("apagar", { ok: true });
  checar("registrado o que estava no ar, a fila continua no primeiro que não foi pulado",
    depois.indice === 4 && depois.enviados === 1, `indice ${depois.indice}, enviados ${depois.enviados}`);
  checar("pulado não entra na conta de enviados nem de erros",
    depois.enviados === 1 && depois.falhas === 0, JSON.stringify({ enviados: depois.enviados, falhas: depois.falhas }));

  // ------------------------------------------------------------------ o que a tela mostra
  const tela = await loteFila({ tipo: "apagar" });
  const itens = (tela.dados.itens || []) as Record<string, unknown>[];
  checar("a linha pulada diz \"pulou\", e não \"fila\" nem \"fora\"",
    itens.slice(1, 4).every((i) => i.situacao === "pulou") && itens[4].situacao === "fila" &&
      itens[0].situacao === "enviado",
    itens.slice(0, 6).map((i) => `${i.i}:${i.situacao}`).join(" "));
  checar("o resumo separa os pulados dos que ele tirou da fila",
    Number(tela.dados.pulados) === 3 && Number(tela.dados.fora) === 0 && Number(tela.dados.na_fila) === 6,
    JSON.stringify({ pulados: tela.dados.pulados, fora: tela.dados.fora, na_fila: tela.dados.na_fila }));

  // ------------------------------------------------------------------ pular mais do que existe
  await proximoItem("apagar");
  const demais = await pularEnvios("apagar", 20);
  checar("pedir 20 quando restam 5 pula os cinco que existem e nada além disso",
    demais.pulados === 5 && (await marcas()).join("") === ".PPP.PPPPP", (await marcas()).join(""));
  const fim = await registrarItem("apagar", { ok: true });
  checar("pulada a última, o lote se encerra sozinho e libera o próximo",
    fim.rodando === false && fim.indice >= 10, JSON.stringify({ rodando: fim.rodando, indice: fim.indice }));

  // ------------------------------------------------------------------ pulo sem nada no ar
  await gravarPlano("apagar", plano(5));
  await iniciarLote("apagar");
  const resto = await pularEnvios("apagar", 5);
  checar("sem nada no ar, o pulo começa na posição que a fila ia pegar",
    resto.pulados === 5 && (await marcas()).join("") === "PPPPP", (await marcas()).join(""));
  const parada = await verLote("apagar");
  checar("pulado o resto, o lote para com o motivo próprio e não fica \"rodando\"",
    parada?.estado.rodando === false && parada.estado.motivo === "pulou_restou",
    JSON.stringify({ rodando: parada?.estado.rodando, motivo: parada?.estado.motivo }));
  checar("a fila não entrega mais nenhum item depois do pulo total", (await proximoItem("apagar")) === null);
  const recomeco = await iniciarLote("apagar");
  checar("o próximo \"Não recuperados\" não trava em lote_rodando", recomeco.ok === true, recomeco.erro || "ok");

  // ------------------------------------------------------------------ quem já estava fora
  await gravarPlano("apagar", plano(6));
  await iniciarLote("apagar");
  await pularEnvios("apagar", 1);
  const comSaida = (await verLote("apagar"))!.plano.map((item, i) => (i === 2 ? { ...item, ignorado: true } : item));
  await consultar("update public.painel_lote set plano = $2::jsonb where chave = $1",
    [CHAVE, JSON.stringify(comSaida)]);
  const quota = await pularEnvios("apagar", 2);
  checar("quem ele já tinha tirado da fila não gasta a quota do pulo",
    quota.pulados === 2 && (await marcas()).join("") === "PPXP..", (await marcas()).join(""));

  // ------------------------------------------------------------------ entradas erradas
  const zero = await pularEnvios("apagar", 0);
  checar("zero não pula nada e avisa", zero.ok === false && zero.erro === "quantidade_invalida", zero.erro || "");
  const action = await lotePular({ tipo: "apagar", quantos: "abc" }, { ip: "127.0.0.1", url: "", query: {} });
  checar("a action devolve 400 para o que não é número", action.status === 400 &&
    action.dados.erro === "quantidade_invalida", JSON.stringify({ s: action.status, e: action.dados.erro }));
  await gravarPlano("apagar", []);
  const vazio = await pularEnvios("apagar", 3);
  checar("sem fila montada o pulo diz que a lista venceu", vazio.ok === false && vazio.erro === "plano_vazio",
    vazio.erro || "");
} finally {
  if (original) {
    await consultar(
      "update public.painel_lote set plano = $2::jsonb, estado = $3::jsonb, aviso = $4, atualizado_em = now() where chave = $1",
      [CHAVE, JSON.stringify(original.plano), JSON.stringify(original.estado), String(original.aviso || "")],
    );
  } else {
    await consultar("delete from public.painel_lote where chave = $1", [CHAVE]);
  }
  const linha = await consultar1("select plano, estado from public.painel_lote where chave = $1", [CHAVE]);
  checar("a linha do lote volta exatamente como estava",
    original ? JSON.stringify(linha?.plano) === JSON.stringify(original.plano) &&
      JSON.stringify(linha?.estado) === JSON.stringify(original.estado)
      : linha === null,
    original ? "restaurada" : "não existia e continua não existindo");
}

console.log(falhas === 0 ? "\ntodas as provas passaram" : `\n${falhas} FALHA(S)`);
if (falhas) Deno.exit(1);
