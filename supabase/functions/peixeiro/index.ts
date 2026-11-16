// A porta de entrada do painel sem Render: o Pages manda um POST com {"action": ...} e o
// token da sessão no Authorization. Nada de cookie, nada de Render, nada de chave no front.
import * as acoes from "./acoes.ts";
import { avisoCron } from "./varredura.ts";
import { usuarioAutenticado } from "./sessao.ts";
import { modoTeste } from "./mcapi.ts";
import type { Handler, Registro } from "./acoes.ts";

// O clique de um cliente na página r/ é anônimo por natureza: ele não tem, e não pode ter,
// sessão do painel — e só pede o endereço para onde o link dele já mandava.
const SEM_SESSAO = new Set(["ping", "entrar", "aviso_cron", "links_destino"]);

/** O contrato público do painel: cada rota do Flask vira uma action com nome de rota.
 *  Escrita à mão de propósito — assim dá para conferir, linha por linha, que nenhuma
 *  tela ficou sem par no outro lado. */
const ACAO: Record<string, Handler> = {
  ping: () => ({ status: 200, dados: { ok: true, modo_teste: modoTeste() } }),
  aviso_cron: async (dados, ctx) => {
    const forcar = ["1", "true", "sim"].includes(String(dados.reenviar || "").trim().toLowerCase());
    const corpo = await avisoCron(String(dados.token || ""), forcar, ctx.ip);
    return { status: Number(corpo.status || 200), dados: corpo };
  },

  entrar: acoes.entrar,
  sair: acoes.sair,
  senha_trocar: acoes.senhaTrocar,

  inicio: acoes.inicio,
  config_ver: acoes.configVer,
  config_salvar: acoes.configSalvar,

  avisos_ver: acoes.avisosVer,
  avisos_enviar: acoes.avisosEnviar,
  avisos_varrer: acoes.avisosVarrer,

  acessos_ver: acoes.acessosVer,

  clientes_ver: acoes.clientesVer,
  clientes_sincronizar: acoes.clientesSincronizar,
  clientes_exportar: acoes.clientesExportar,
  clientes_importar: acoes.clientesImportar,

  telefone_salvar: acoes.telefoneSalvar,
  telefones_mesclar: acoes.telefonesMesclar,

  recuperacao_ver: acoes.recuperacaoVer,
  recuperacao_foto: acoes.recuperacaoFoto,
  recuperacao_alternar: acoes.recuperacaoAlternar,
  recuperacao_salvar: acoes.recuperacaoSalvar,
  recuperar_um: acoes.recuperarUm,

  lote_contagem: acoes.loteContagem,
  lote_executar: acoes.loteExecutar,
  lote_item: acoes.loteItem,
  lote_status: acoes.loteStatus,
  lote_parar: acoes.loteParar,

  apagar_linha_ver: acoes.apagarLinhaVer,
  apagar_linha_fazer: acoes.apagarLinhaFazer,

  links_ver: acoes.linksVer,
  links_encurtar: acoes.linksEncurtar,
  links_resolver: acoes.linksResolver,
  links_padrao_salvar: acoes.linksPadraoSalvar,
  links_destino_salvar: acoes.linksDestinoSalvar,
  links_destino: acoes.linksDestino,
};

function origensPermitidas(): string[] {
  return (Deno.env.get("PAINEL_ORIGENS") || "https://kuttenc.github.io")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function origemBoa(origin: string): string {
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  const permitidas = origensPermitidas();
  return permitidas.includes(origin) ? origin : permitidas[0];
}

function cabecalhos(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origemBoa(origin),
    "access-control-allow-headers": "authorization, content-type, x-painel-token, x-aviso-token",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
    "cache-control": "no-store",
  };
}

function json(dados: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cabecalhos(origin) },
  });
}

function ipDaRequisicao(req: Request): string {
  const direta = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "";
  return (direta.split(",")[0] || "").trim() || "0.0.0.0";
}

async function corpoDaRequisicao(req: Request, url: URL): Promise<Registro> {
  if (req.method === "GET") return Object.fromEntries(url.searchParams.entries());
  try {
    return (await req.json()) as Registro;
  } catch {
    return {};
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cabecalhos(origin) });

  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/healthz")) {
    return json({ ok: true, service: "peixeiro-painel", modo_teste: modoTeste() }, 200, origin);
  }

  const corpo = await corpoDaRequisicao(req, url);
  const acao = String(corpo.action || url.searchParams.get("action") || "").trim();
  const dados: Registro = { ...corpo };
  delete dados.action;

  const executada = ACAO[acao];
  if (!executada) return json({ ok: false, erro: "acao_inexistente", acao }, 404, origin);

  if (!SEM_SESSAO.has(acao) && !(await usuarioAutenticado(req.headers.get("authorization") || ""))) {
    return json({ ok: false, erro: "sem_sessao" }, 401, origin);
  }

  try {
    const saida = await executada(dados, { ip: ipDaRequisicao(req) });
    return json(saida.dados, saida.status, origin);
  } catch (exc) {
    const detalhe = String(exc instanceof Error ? exc.message : exc).slice(0, 220);
    return json({ ok: false, erro: detalhe.includes("DATABASE_URL") ? "banco" : "interna", detalhe }, 500, origin);
  }
});
