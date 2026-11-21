// A porta de entrada do painel sem Render: o Pages manda um POST com {"action": ...} e o
// token da sessão no Authorization. Nada de cookie, nada de Render, nada de chave no front.
import * as acoes from "./acoes.ts";
import { avisoCron } from "./varredura.ts";
import { usuarioAutenticado } from "./sessao.ts";
import { modoTeste } from "./mcapi.ts";
import { gerarAcesso } from "./site.ts";
import {
  estabCancelarConfirmar,
  estabCancelarSolicitar,
  estabMarcar,
  estabVagas,
} from "./estabelecimento.ts";
import type { Handler, Registro } from "./acoes.ts";

// As páginas públicas de estabelecimento e o webhook do GreenAPI não têm sessão do painel:
// as primeiras usam o slug e o telefone do cliente; o webhook traz sua chave na URL.
const SEM_SESSAO = new Set([
  "ping", "entrar", "aviso_cron", "barb_cron", "links_destino", "chat_webhook", "site_gerar",
  "barb_painel_ver", "barb_painel_salvar", "barb_painel_foto", "barb_painel_foto_apagar",
  "estab_vagas", "estab_marcar", "estab_cancelar_solicitar", "estab_cancelar_confirmar",
]);

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
  clientes_importar_pix: acoes.clientesImportarPix,

  telefone_salvar: acoes.telefoneSalvar,
  telefones_mesclar: acoes.telefonesMesclar,

  recuperacao_ver: acoes.recuperacaoVer,
  recuperacao_foto: acoes.recuperacaoFoto,
  recuperacao_alternar: acoes.recuperacaoAlternar,
  recuperacao_salvar: acoes.recuperacaoSalvar,
  recuperar_um: acoes.recuperarUm,

  mensagem_um: acoes.mensagemUm,

  // O botão "Gerar acesso 4 horas" do clone do site, sem sessão e sem Render.
  site_gerar: gerarAcesso,

  estab_vagas: async (dados, ctx) => ({ status: 200, dados: await estabVagas(dados, ctx) }),
  estab_marcar: async (dados, ctx) => ({ status: 200, dados: await estabMarcar(dados, ctx) }),
  estab_cancelar_solicitar: async (dados, ctx) => ({
    status: 200,
    dados: await estabCancelarSolicitar(dados, ctx),
  }),
  estab_cancelar_confirmar: async (dados, ctx) => ({
    status: 200,
    dados: await estabCancelarConfirmar(dados, ctx),
  }),

  lote_contagem: acoes.loteContagem,
  lote_executar: acoes.loteExecutar,
  lote_item: acoes.loteItem,
  lote_status: acoes.loteStatus,
  lote_parar: acoes.loteParar,
  lote_fila: acoes.loteFila,
  lote_retomar: acoes.loteRetomar,
  lote_tirar: acoes.loteTirar,
  lote_pular: acoes.lotePular,

  apagar_linha_ver: acoes.apagarLinhaVer,
  apagar_linha_fazer: acoes.apagarLinhaFazer,

  links_ver: acoes.linksVer,
  links_encurtar: acoes.linksEncurtar,
  links_resolver: acoes.linksResolver,
  links_padrao_salvar: acoes.linksPadraoSalvar,
  links_destino_salvar: acoes.linksDestinoSalvar,
  links_destino: acoes.linksDestino,

  chat_webhook: acoes.chatWebhook,
  chat_ver: acoes.chatVer,
  chat_novo: acoes.chatNovo,
  chat_salvar: acoes.chatSalvar,
  chat_apagar: acoes.chatApagar,
  chat_ligar: acoes.chatLigar,
  chat_ativar: acoes.chatAtivar,
  chat_fluxo: acoes.chatFluxo,
  chat_instalar: acoes.chatInstalar,
  chat_conversas: acoes.chatConversas,
  chat_treino_exportar: acoes.chatTreino,

  bloqueados_ver: acoes.bloqueadosVer,
  bloqueados_desbloquear: acoes.bloqueadosDesbloquear,

  // ------------------------------------------------------------------ barbearias
  // O segundo robô: a mesma instância de WhatsApp, duas bases que nunca se misturam. As
  // rotas abaixo só mexem em `barber_*`; o telefone da barbearia é a chave de tudo aqui.
  barb_ver: acoes.barbVer,
  barb_salvar: acoes.barbSalvar,
  barb_contas: acoes.barbContas,
  barb_conta_adicionar: acoes.barbContaAdicionar,
  barb_conta_ligar: acoes.barbContaLigar,
  barb_conta_fechar: acoes.barbContaFechar,
  barb_conta_apagar: acoes.barbContaApagar,
  barb_conta_exportar: acoes.barbContaExportar,
  barb_conta_importar: acoes.barbContaImportar,
  barb_pagina_importar: acoes.barbPaginaImportar,
  barb_pagina_publicar: acoes.barbPaginaPublicar,
  barb_painel_gerar: acoes.barbPainelGerar,
  barb_painel_ver: acoes.barbPainelVer,
  barb_painel_salvar: acoes.barbPainelSalvar,
  barb_painel_foto: acoes.barbPainelFoto,
  barb_painel_foto_apagar: acoes.barbPainelFotoApagar,
  barb_interessados: acoes.barbInteressados,
  barb_detalhe: acoes.barbDetalhe,
  barb_conversas: acoes.barbConversas,
  barb_conversas_exportar: acoes.barbConversasExportar,
  barb_treino: acoes.barbTreino,
  barb_mensagem: acoes.barbMensagem,
  barb_boas_vindas: acoes.barbBoasVindas,
  barb_fila_montar: acoes.barbFilaMontar,
  barb_fila_status: acoes.barbFilaStatus,
  barb_fila_proximo: acoes.barbFilaProximo,
  barb_fila_tirar: acoes.barbFilaTirar,
  barb_fila_limpar: acoes.barbFilaLimpar,
  barb_lembrete: acoes.barbLembrete,
  barb_bom_dia: acoes.barbBomDia,
  barb_cron: acoes.barbCron,
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

/** A URL da função em si — é o endereço que o webhook do GreenAPI precisa receber, e o
 *  navegador não tem como saber o caminho depois do proxy do Supabase. */
function enderecoProprio(url: URL): string {
  const direto = (Deno.env.get("PAINEL_FUNCAO_URL") || "").trim();
  return direto || `${url.origin}${url.pathname}`;
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
    const saida = await executada(dados, {
      ip: ipDaRequisicao(req),
      url: enderecoProprio(url),
      query: Object.fromEntries(url.searchParams.entries()),
    });
    return json(saida.dados, saida.status, origin);
  } catch (exc) {
    const detalhe = String(exc instanceof Error ? exc.message : exc).slice(0, 220);
    return json({ ok: false, erro: detalhe.includes("DATABASE_URL") ? "banco" : "interna", detalhe }, 500, origin);
  }
});
