// Prova da aba Bloqueados: quem respondeu "não" sai de toda fila e volta com um clique.
//
//   npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_bloqueados.ts
//
// Nada aqui manda WhatsApp nem mexe no painel MC: são só as três funções da tabela nova e as
// duas actions da tela. Os números usados são de teste (55 11 90000-00xx) e as linhas que eles
// criam são apagadas no fim, antes de a prova imprimir o total.
import { bloqueadosDesbloquear, bloqueadosVer, type Contexto } from "../supabase/functions/peixeiro/acoes.ts";
import {
  MOTIVO_NAO,
  bloquear,
  desbloquear,
  estaBloqueado,
  listarBloqueados,
  telefonesBloqueados,
} from "../supabase/functions/peixeiro/bloqueados.ts";
import { consultar } from "../supabase/functions/peixeiro/db.ts";

let falhas = 0;
function checar(rotulo: string, verdadeiro: unknown, detalhe = "") {
  if (!verdadeiro) falhas++;
  console.log(`${verdadeiro ? "OK  " : "FAIL"} ${rotulo}${detalhe ? "  → " + detalhe : ""}`);
}

const UM = "5511900000001";
const DOIS = "5511900000002";
const ctx: Contexto = { ip: "127.0.0.1", url: "http://localhost/", query: {} };
const limpar = () => consultar("delete from public.clientes_bloqueados where telefone like '55119000000%'");

await limpar();

// ------------------------------------------------------------------ bloquear e reconhecer
checar("o primeiro \"não\" bloqueia e diz que foi a primeira vez", await bloquear(UM, "rteste01", "Aderlane monteiro", MOTIVO_NAO));
checar("o mesmo número repetido não bloqueia de novo (a resposta não se repete)",
  (await bloquear(UM, "rteste01", "Aderlane", MOTIVO_NAO)) === false);
checar("o número com ponto, traço ou sem o 55 é o mesmo bloqueado",
  await estaBloqueado("(11) 90000-0001") && await estaBloqueado("11900000001") && await estaBloqueado("55 11 90000-0001"),
  "as três grafias do lote, do chat e da agenda");
checar("o motivo vem escrito na linha", (await listarBloqueados("900000001")).itens[0]?.motivo === MOTIVO_NAO,
  (await listarBloqueados("900000001")).itens[0]?.motivo);
checar("a palavra de situação nunca vira nome na lista",
  (await bloquear(DOIS, "rteste02", "ativo", MOTIVO_NAO)) &&
    (await listarBloqueados("900000002")).itens[0]?.nome === "",
  JSON.stringify((await listarBloqueados("900000002")).itens[0]));

const conjunto = await telefonesBloqueados();
checar("a fila inteira consulta o conjunto de uma vez", conjunto.has(UM) && conjunto.has(DOIS), `${conjunto.size} bloqueados`);

// ------------------------------------------------------------------ o que a tela mostra
const tela = await bloqueadosVer({ q: "" });
const itens = ((tela.dados.itens || []) as Record<string, unknown>[]);
checar("a tela lista os dois números de teste", itens.length === 2, `${itens.length}`);
checar("o telefone chega formatado para o celular", itens[0]?.telefone === "(11) 90000-0001" ||
  itens[1]?.telefone === "(11) 90000-0001", JSON.stringify(itens.map((i) => i.telefone)));
checar("a busca por número acha com traço e sem o 55",
  ((await bloqueadosVer({ q: "90000-0002" })).dados.itens as Record<string, unknown>[]).length === 1);
checar("a busca por letra acha pelo usuário",
  ((await bloqueadosVer({ q: "rteste01" })).dados.itens as Record<string, unknown>[]).length === 1);
checar("a busca por letra acha pelo nome cadastrado",
  ((await bloqueadosVer({ q: "Aderlane" })).dados.itens as Record<string, unknown>[]).length === 1);
checar("a busca que não casa com nada devolve lista vazia",
  ((await bloqueadosVer({ q: "nada a ver com a base" })).dados.itens as Record<string, unknown>[]).length === 0);
checar("o total continua sendo o da base, não o da página",
  Number((await bloqueadosVer({ q: "" })).dados.total) === 2);

// ------------------------------------------------------------------ o botão desbloquear
const dito = await bloqueadosDesbloquear({ telefone: "(11) 90000-0001" }, ctx);
checar("desbloquear devolve o número formatado e a lista sem ele",
  dito.dados.telefone === "(11) 90000-0001" &&
    ((dito.dados.itens as Record<string, unknown>[]).length === 1), JSON.stringify(dito.dados.telefone));
checar("depois do clique o número volta a valer para a fila", !(await estaBloqueado(UM)));
checar("o robô ainda encontra o outro bloqueado", await estaBloqueado(DOIS));
const fora = await bloqueadosDesbloquear({ telefone: "5511900000001" }, ctx);
checar("clicar duas vezes no mesmo número avisa, sem quebrar a tela",
  fora.dados.ok === false && fora.status === 409 && fora.dados.erro === "nao_esta_bloqueado",
  JSON.stringify({ ok: fora.dados.ok, status: fora.status }));
checar("um número curto não chega nem no banco",
  (await bloqueadosDesbloquear({ telefone: "1234" }, ctx)).dados.erro === "telefone_invalido");
checar("o desbloqueio fica registrado nos eventos",
  (await consultar(
    `select count(*)::int n from public.mcapi_events where event_type = 'cliente_desbloqueado' and request_payload ->> 'telefone' = $1`,
    [UM],
  )).rows[0]?.n);

// ------------------------------------------------------------------ o caminho do chat
await limpar();
checar("a tabela volta vazia do jeito que estava", (await listarBloqueados("")).total === 0,
  `${(await listarBloqueados("")).total} linhas`);

console.log(falhas === 0 ? "\ntodas as provas passaram" : `\n${falhas} FALHA(S)`);
if (falhas) Deno.exit(1);
