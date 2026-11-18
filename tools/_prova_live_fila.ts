// Prova ao vivo dos últimos ajustes na cópia: o texto sem primeiro nome, a aba Bloqueados, o
// campo de pular envios e a janela que parou de baixar a fila inteira.
//
//   npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_live_fila.ts
//
// Nada aqui manda WhatsApp, bloqueia número nem mexe na fila: as rotas novas são chamadas com
// entrada inválida ou sem sessão, e o lote_fila é leitura pura. A ordem do index.ts — rota
// desconhecida devolve 404 antes de olhar o token — é o que prova, sem escrever nada, que a action
// nova está no build deployado.
import { hashCacheado, novoToken } from "../supabase/functions/peixeiro/sessao.ts";

const FUNCAO = "https://bzgtptbwcvwpgnhbctjn.supabase.co/functions/v1/peixeiro";
const PAINEL = "https://kuttenc.github.io/2PEER/painel/";

let falhas = 0;
function checar(rotulo: string, verdadeiro: unknown, detalhe = "") {
  if (!verdadeiro) falhas++;
  console.log(`${verdadeiro ? "OK  " : "FAIL"} ${rotulo}${detalhe ? "  → " + detalhe : ""}`);
}

async function chamar(corpo: Record<string, unknown>, token = "") {
  const r = await fetch(FUNCAO, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(corpo),
  });
  const buf = await r.arrayBuffer();
  return {
    status: r.status,
    bytes: buf.byteLength,
    corpo: JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>,
  };
}

const ping = await chamar({ action: "ping" });
checar("a função da cópia está no ar", ping.status === 200 && ping.corpo.ok === true,
  JSON.stringify(ping.corpo));

// ---------------------------------------------------------------- as rotas novas, sem escrever nada
const pulo = await chamar({ action: "lote_pular" });
checar("a rota de pular envios existe no build deployado", pulo.status === 401 && pulo.corpo.erro === "sem_sessao",
  `${pulo.status} ${JSON.stringify(pulo.corpo)}`);
const lista = await chamar({ action: "bloqueados_ver" });
checar("a rota da aba Bloqueados existe no build deployado",
  lista.status === 401 && lista.corpo.erro === "sem_sessao",
  `${lista.status} ${JSON.stringify(lista.corpo)}`);
const saida = await chamar({ action: "bloqueados_desbloquear" });
checar("a rota do desbloqueio existe no build deployado",
  saida.status === 401 && saida.corpo.erro === "sem_sessao",
  `${saida.status} ${JSON.stringify(saida.corpo)}`);
const velho = await chamar({ action: "rota_que_nao_existe" });
checar("uma rota que não foi escrita continua em 404 (o 401 de cima é registro, não coincidência)",
  velho.status === 404 && velho.corpo.erro === "acao_inexistente", `${velho.status}`);

const hash = await hashCacheado();
if (!hash) {
  checar("há senha de painel guardada no banco da cópia", false, "hash vazio");
} else {
  const token = await novoToken(hash);

  // O pulo com o número errado tem de voltar 400 da função, não cair no plano congelado: assim o
  // teste exercita a validação sem tirar ninguém da fila real do "Não recuperados".
  const ruim = await chamar({ action: "lote_pular", tipo: "recuperar", quantos: "abc" }, token);
  checar("a função deployada recusa o que não é número",
    ruim.status === 400 && ruim.corpo.erro === "quantidade_invalida",
    `${ruim.status} ${JSON.stringify(ruim.corpo)}`);
  const demais = await chamar({ action: "lote_pular", tipo: "recuperar", quantos: 99999 }, token);
  checar("a função deployada recusa pular o mundo inteiro",
    demais.status === 400 && demais.corpo.erro === "muita_marca",
    `${demais.status} ${JSON.stringify(demais.corpo)}`);

  // ---------------------------------------------------------- a janela que corta a banda
  const total = Number((await chamar({ action: "lote_fila", tipo: "recuperar", janela: 1 }, token)).corpo.total || 0);
  checar("a fila da cópia está congelada com o plano inteiro dentro", total > 1000, `${total} linhas`);

  const teto = await chamar({ action: "lote_fila", tipo: "recuperar", janela: 400 }, token);
  const janela = await chamar({ action: "lote_fila", tipo: "recuperar", janela: 150 }, token);
  const itens = (janela.corpo.itens || []) as Record<string, unknown>[];
  checar("a tela não baixa mais o plano inteiro: 150 linhas e não as " + total,
    janela.status === 200 && itens.length === 150 && Number(janela.corpo.total) === total,
    `${itens.length} linhas · ${(janela.bytes / 1024).toFixed(0)} KB (o teto de 400 pesa ${(teto.bytes / 1024).toFixed(0)} KB)`);
  checar("as contagens continuam do plano todo, com a janela pequena",
    Number(janela.corpo.na_fila) > 1000 && Object.hasOwn(janela.corpo, "pulados") &&
      Number(janela.corpo.mostraveis) === total,
    JSON.stringify({ na_fila: janela.corpo.na_fila, mostraveis: janela.corpo.mostraveis }));
  const estado = (janela.corpo.estado || {}) as Record<string, unknown>;
  checar("o resultado linha por linha saiu do estado (era ele que incha com o lote)",
    estado.resultados === undefined && Object.hasOwn(estado, "enviando"), Object.keys(estado).join(" "));
  const erros = await chamar({ action: "lote_fila", tipo: "recuperar", so_erro: true }, token);
  const itensErro = (erros.corpo.itens || []) as Record<string, unknown>[];
  checar("o filtro de erros é feito na função, não no navegador",
    erros.status === 200 && itensErro.every((i) => i.situacao === "falhou") &&
      Number(erros.corpo.mostraveis) === itensErro.length,
    `${itensErro.length} com erro`);
  console.log(`     antes, cada poll da fila descia ${total} linhas; agora descem 150.`);

  const bl = await chamar({ action: "bloqueados_ver", q: "" }, token);
  checar("a tela de bloqueados abre com a busca vazia (foi o erro que a prova pegou)",
    bl.status === 200 && Array.isArray(bl.corpo.itens),
    `${bl.status} · ${Array.isArray(bl.corpo.itens) ? `${(bl.corpo.itens as unknown[]).length} bloqueados` : ""}`);
}

// ---------------------------------------------------------------- o Pages publicado
const html = await (await fetch(`${PAINEL}?nocache=${Date.now()}`, { redirect: "follow" })).text();
const js = await (await fetch(`${PAINEL}app.js?v=${Date.now()}`, { redirect: "follow" })).text();

checar("a aba Bloqueados está na barra do painel publicado",
  html.includes('data-tela="bloqueados"') && html.includes('<section data-pagina="bloqueados"'));
checar("o campo de busca da aba Bloqueados está na tela",
  html.includes('id="blBusca"') && html.includes('id="blBuscar"') && html.includes('id="blTotal"'));
checar("o aviso de pular envios está em cima da fila do Não recuperados",
  html.includes('id="frPularCaixa"') && html.includes('id="frPularQtd"') && html.includes("Pular envios"));
checar("a busca que ele pediu também chegou nas abas Clientes e Acessos",
  html.includes('id="clBusca"') && html.includes('id="acBusca"'));

checar("o app.js publicado chama a rota do pulo", js.includes('"lote_pular"') && js.includes("pularEnviosDaFila"));
checar("o app.js publicado cuida da aba Bloqueados",
  js.includes('"bloqueados_ver"') && js.includes('"bloqueados_desbloquear"') && js.includes("carregarBloqueados"));
checar("o app.js publicado conhece a linha que ele mandou pular",
  js.includes("pulou") && js.includes("pulados por você"));
checar("o app.js publicado pede a janela, não a fila inteira",
  js.includes("so_erro: frSoErro") && js.includes("janela: FR_TOPO"));

console.log(`\n${falhas ? falhas + " FALHA(S)" : "todas as provas passaram"}`);
Deno.exit(falhas ? 1 : 0);
