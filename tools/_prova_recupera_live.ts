// Prova ao vivo da aba Recuperação na cópia: o Pages com a ajuda nova e a função deployada
// respondendo a recuperacao_ver com o mesmo texto que o código daqui produz.
//
//   npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_recupera_live.ts
//
// Não manda nada para nenhum cliente. O token de sessão é assinado em memória e nunca é
// impresso — só a resposta da função aparece aqui.
import { hashCacheado, novoToken } from "../supabase/functions/peixeiro/sessao.ts";
import { obterConfig } from "../supabase/functions/peixeiro/banco.ts";
import { baseEncurtador, slugRecuperacao } from "../supabase/functions/peixeiro/encurtador.ts";
import { legendaRecuperar } from "../supabase/functions/peixeiro/texto.ts";

const FUNCAO = "https://bzgtptbwcvwpgnhbctjn.supabase.co/functions/v1/peixeiro";
const PAGINA = "https://kuttenc.github.io/2PEER/painel/";

let falhas = 0;
function checar(rotulo: string, verdadeiro: unknown, detalhe = "") {
  if (!verdadeiro) falhas++;
  console.log(`${verdadeiro ? "OK  " : "FAIL"} ${rotulo}${detalhe ? "  → " + detalhe : ""}`);
}

const html = await (await fetch(`${PAGINA}?nocache=${Date.now()}`, { redirect: "follow" })).text();
checar("o Pages publicado traz a lista nova de variáveis",
  html.includes("<code>{nome}</code>") && html.includes("<code>{vence}</code>") &&
    html.includes("<code>{expirou}</code>") && html.includes("<code>{status}</code>") &&
    html.includes("<code>{site}</code>") && html.includes("<code>{link}</code>"));
checar("a ajuda antiga, que só falava de {dias}, {pix} e {link}, saiu da tela",
  !html.includes("Mensagem ({dias} vira"), html.slice(html.indexOf("rcLegenda"), html.indexOf("rcLegenda") + 90));
checar("a legenda da Configuração aponta para a mesma lista",
  html.includes('name="recupera_legenda"') && html.includes("as mesmas variáveis da aba"));
checar("o exemplo da tela explica o cliente de mentira",
  html.includes("Maria da Silva") && html.includes("r7000000007"));

const chamar = async (corpo: Record<string, unknown>, token = "") => {
  const r = await fetch(FUNCAO, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, corpo: await r.json() as Record<string, unknown> };
};

const ping = await chamar({ action: "ping" });
checar("a função da cópia está no ar", ping.status === 200 && ping.corpo.ok === true, JSON.stringify(ping.corpo));

const semToken = await chamar({ action: "recuperacao_ver" });
checar("sem sessão a rota não abre", semToken.status === 401 && semToken.corpo.erro === "sem_sessao");

const hash = await hashCacheado();
if (!hash) {
  checar("há senha de painel guardada no banco da cópia", false, "hash vazio");
} else {
  const token = await novoToken(hash);
  const live = await chamar({ action: "recuperacao_ver" }, token);
  const conf = await obterConfig();
  const exemplo = String((live.corpo as { exemplo?: string }).exemplo || "");
  checar("a função deployada responde o ver da recuperação",
    live.status === 200 && live.corpo.ok === true,
    // O corpo traz o token da GreenAPI: aqui só sai o que não é segredo.
    `${live.status} · chaves: ${Object.keys(live.corpo).join(" ")}`);
  // O mesmo cliente de mentira e o mesmo link de mentira que a funcao monta na tela.
  const ficha = {
    usuario: "r7000000007", nome: "Maria da Silva", telefone: "11999998888",
    status: 0, expira: new Date(Date.now() - 34 * 86_400_000),
  };
  const esperado = legendaRecuperar(conf!, ficha, `${baseEncurtador()}/${slugRecuperacao("r7000000007", "11999998888")}`);
  checar("o texto ao vivo é o mesmo que o código daqui produz com a mesma configuração",
    exemplo === esperado, `esperado: ${esperado.replace(/\n/g, " ⏎ ").slice(0, 200)}`);
  checar("não sobra chave nenhuma no texto que sai", !/\{\{?[a-z_]+\}?\}/i.test(exemplo));
  checar("o PIX gravado aparece no texto", exemplo.includes(conf!.aviso_pix_key), conf!.aviso_pix_key);
  checar("o link curto de exemplo aparece no texto", /https:\/\/\S+\/\S+/.test(exemplo));
}

console.log(`\n${falhas ? falhas + " FALHA(S)" : "todas as provas passaram"}`);
Deno.exit(falhas ? 1 : 0);
