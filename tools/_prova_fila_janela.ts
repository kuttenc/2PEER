// Prova da janela do lote_fila: a tela do "Não recuperados" sem a lista inteira no bolso.
//
//   npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_fila_janela.ts
//
// Nada aqui manda WhatsApp: é só leitura do plano congelado. Para não mexer na fila real, o teste
// trabalha na chave do lote de apagada, tira um retrato da linha e devolve exatamente do mesmo
// jeito no fim — mesmo se der erro no meio.
import { loteFila } from "../supabase/functions/peixeiro/acoes.ts";
import { consultar, consultar1 } from "../supabase/functions/peixeiro/db.ts";
import { estadoVazio, gravarPlano, salvarEstado, verLote } from "../supabase/functions/peixeiro/lote.ts";

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

const linha = (n: number) => ({ username: `zzteste${n}`, telefone: "", exp_iso: "" });

/** Devolve o corpo da resposta e quantos bytes ele tem — o número que importa aqui. */
async function fila(dados: Record<string, unknown>) {
  const saida = await loteFila({ tipo: "apagar", ...dados });
  const corpo = saida.dados as Record<string, unknown>;
  return { corpo, bytes: JSON.stringify(corpo).length, itens: (corpo.itens || []) as Record<string, unknown>[] };
}

/** Congela o plano e escreve as marcas que a tela precisa ver. */
async function montar(
  quantos: number,
  marcas: Record<number, { ok?: boolean; erro?: string; marca?: string }>,
  enviando: number | null,
) {
  await gravarPlano("apagar", Array.from({ length: quantos }, (_, i) => linha(i)));
  const vista = await verLote("apagar");
  const estado = estadoVazio(vista!.plano.length);
  estado.rodando = true;
  estado.enviando = enviando;
  estado.indice = enviando === null ? 0 : enviando;
  estado.enviados = Object.values(marcas).filter((m) => m.ok && !m.marca).length;
  estado.falhas = Object.values(marcas).filter((m) => !m.ok).length;
  estado.resultados = Object.fromEntries(Object.entries(marcas).map(([i, m]) => [
    i,
    { ok: Boolean(m.ok), erro: String(m.erro || ""), ...(m.marca ? { marca: m.marca } : {}) },
  ]));
  await salvarEstado("apagar", estado);
}

try {
  // ------------------------------------------------------------------ 2.000 linhas, uma janela
  await montar(2000, {
    0: { ok: true }, 1: { ok: true }, 2: { ok: false, erro: "recusou" }, 3: { ok: false, erro: "sem saldo" },
    4: { ok: true, marca: "bloqueado" },
  }, 1000);

  const janela = await fila({ janela: 150 });
  const teto = await fila({ janela: 5000 });
  checar("a janela pedida é o teto: 150 linhas e não as 2.000 do plano",
    janela.itens.length === 150 && teto.itens.length === 400,
    `${janela.itens.length} × ${teto.itens.length}`);
  checar("com o envio na linha 1001, a janela anda até ele",
    Number(janela.itens[0].i) === 950 && Number(janela.itens[149].i) === 1099,
    `linhas ${Number(janela.itens[0].i) + 1} a ${Number(janela.itens[149].i) + 1}`);
  checar("a linha que está no ar vem dentro da janela (a tela procura por ela)",
    janela.itens.some((i) => Number(i.i) === 1000 && i.situacao === "enviando"));
  checar("o corpo diz desde onde até onde ele mostrou",
    Number(janela.corpo.desde) === 950 && Number(janela.corpo.ate) === 1100 &&
      Number(janela.corpo.mostraveis) === 2000,
    JSON.stringify({ d: janela.corpo.desde, a: janela.corpo.ate, m: janela.corpo.mostraveis }));
  checar("a janela pesa uma fração do teto e cabe num celular",
    janela.bytes * 2 < teto.bytes && janela.bytes < 100_000,
    `${(janela.bytes / 1024).toFixed(0)} KB na janela · ${(teto.bytes / 1024).toFixed(0)} KB no teto`);
  checar("as contagens continuam sendo do plano todo, não da janela",
    Number(janela.corpo.total) === 2000 && Number(janela.corpo.na_fila) === 1995 &&
      Number(janela.corpo.bloqueados) === 1 &&
      Number((janela.corpo.estado as Record<string, unknown>).enviados) === 2,
    JSON.stringify({ total: janela.corpo.total, na_fila: janela.corpo.na_fila, bloqueados: janela.corpo.bloqueados }));

  const estado = (janela.corpo.estado || {}) as Record<string, unknown>;
  checar("o resultado linha por linha não vai mais no estado (é ele que incha com o lote)",
    estado.resultados === undefined && Object.hasOwn(estado, "enviando") &&
      Object.hasOwn(estado, "rodando") && Object.hasOwn(estado, "motivo"),
    Object.keys(estado).join(" "));

  // ------------------------------------------------------------------ só os com erro
  const erros = await fila({ so_erro: true, janela: 150 });
  checar("o filtro de erros é feito na função: só sai quem falhou",
    erros.itens.length === 2 && erros.itens.every((i) => i.situacao === "falhou") &&
      Number(erros.corpo.mostraveis) === 2,
    erros.itens.map((i) => `${i.i}:${i.situacao}`).join(" "));
  checar("o erro continua escrito na linha, com a janela pequena",
    erros.itens[0].erro === "recusou" && Number(erros.itens[0].i) === 2, JSON.stringify(erros.itens[0]));

  // ------------------------------------------------------------------ fila pequena não muda
  await montar(10, { 0: { ok: true } }, 3);
  const curta = await fila({});
  checar("fila de 10 linhas vem inteira, como vinha antes",
    curta.itens.length === 10 && Number(curta.corpo.desde) === 0 && Number(curta.corpo.ate) === 10,
    `${curta.itens.length} linhas`);

  // ------------------------------------------------------------------ sem nada no ar
  await montar(2000, { 0: { ok: true } }, null);
  const parado = await fila({});
  checar("com o lote parado no começo, a janela abre da primeira linha",
    Number(parado.itens[0].i) === 0 && parado.itens.length === 150,
    `desde ${Number(parado.itens[0].i) + 1}, ${parado.itens.length} linhas`);

  await gravarPlano("apagar", []);
  const vazia = await fila({});
  checar("a fila vazia também devolve os campos novos",
    vazia.corpo.vazia === true && Number(vazia.corpo.mostraveis) === 0 && Number(vazia.corpo.desde) === 0,
    JSON.stringify({ m: vazia.corpo.mostraveis, d: vazia.corpo.desde }));
} finally {
  if (original) {
    await consultar(
      "update public.painel_lote set plano = $2::jsonb, estado = $3::jsonb, aviso = $4, atualizado_em = now() where chave = $1",
      [CHAVE, JSON.stringify(original.plano), JSON.stringify(original.estado), String(original.aviso || "")],
    );
  } else {
    await consultar("delete from public.painel_lote where chave = $1", [CHAVE]);
  }
  const volta = await consultar1("select plano, estado from public.painel_lote where chave = $1", [CHAVE]);
  checar("a linha do lote volta exatamente como estava",
    original ? JSON.stringify(volta?.plano) === JSON.stringify(original.plano) &&
      JSON.stringify(volta?.estado) === JSON.stringify(original.estado)
      : volta === null,
    original ? "restaurada" : "não existia e continua não existindo");
}

console.log(`\n${falhas === 0 ? "todas as provas passaram" : `${falhas} FALHA(S)`}`);
if (falhas) Deno.exit(1);
