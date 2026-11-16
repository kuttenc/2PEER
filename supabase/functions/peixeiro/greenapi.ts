// GreenAPI: o que manda WhatsApp. As chaves ficam aqui, nunca no navegador.
import { baseDaApi } from "./banco.ts";
import { b64ParaBytes, normalizarWhatsapp } from "./texto.ts";
import { modoTeste } from "./mcapi.ts";

export type ResultadoEnvio = {
  ok: boolean;
  status_code?: number;
  response?: Record<string, unknown>;
  error?: string;
  skipped?: boolean;
  simulado?: boolean;
  com_foto?: boolean;
};

type Conf = { api_url?: string; id_instance?: string; api_token?: string; [chave: string]: unknown };

const ESTADO_TTL = 180_000;
const cacheEstado = new Map<string, { valor: Record<string, unknown>; quando: number }>();

function base(conf: Conf): string {
  return baseDaApi(conf as { api_url?: string });
}

export async function estadoInstancia(conf: Conf, recarregar = false): Promise<Record<string, unknown>> {
  if (!(conf.api_url && conf.id_instance && conf.api_token)) {
    return { ok: false, state: "sem configuracao" };
  }
  const apiBase = base(conf);
  const inst = String(conf.id_instance || "").trim();
  const token = String(conf.api_token || "").trim();
  const chave = `${apiBase}|${inst}|${token}`;
  const agora = Date.now();
  if (!recarregar) {
    const guardado = cacheEstado.get(chave);
    if (guardado && agora - guardado.quando < ESTADO_TTL) return guardado.valor;
  }
  let saida: Record<string, unknown>;
  try {
    const resp = await fetch(`${apiBase}/waInstance${inst}/getStateInstance/${token}`, {
      signal: AbortSignal.timeout(12_000),
    });
    const corpo = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    const estado = String(corpo.stateInstance || corpo.state || corpo.errorCode || "").toUpperCase();
    saida = { ok: resp.status < 400, state: estado || "DESCONHECIDO", status_code: resp.status };
  } catch (exc) {
    const texto = String(exc);
    saida = {
      ok: false,
      state: "sem resposta",
      error: texto.includes("timed out") || texto.includes("Timeout")
        ? "O GreenAPI demorou para responder. Abra de novo."
        : texto.slice(0, 160),
    };
  }
  cacheEstado.set(chave, { valor: saida, quando: agora });
  return saida;
}

export async function infosInstancia(conf: Conf): Promise<Record<string, unknown>> {
  const apiBase = base(conf);
  const inst = String(conf.id_instance || "").trim();
  const token = String(conf.api_token || "").trim();
  if (!(apiBase && inst && token)) return { ok: false, error: "sem configuracao" };
  let resp: Response;
  try {
    resp = await fetch(`${apiBase}/waInstance${inst}/getSettings/${token}`, { signal: AbortSignal.timeout(6_000) });
  } catch (exc) {
    return { ok: false, error: String(exc).slice(0, 160) };
  }
  const corpo = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (resp.status >= 400) return { ok: false, status_code: resp.status, response: corpo };
  const dados = (corpo.params || corpo) as Record<string, unknown>;
  const wid = String(dados.wid || "");
  return {
    ok: true,
    status_code: resp.status,
    numero: wid ? wid.split("@")[0] : "",
    webhook_url: String(dados.webhookUrl || ""),
    incoming_webhook: dados.incomingWebhook ? "sim" : "não",
    delay: dados.delaySendMessagesMilliseconds ?? null,
  };
}

/** Aponta o webhook da instância para a nossa função. Os dois canais: o de entrada (o robô de
 *  conversa) e o de saída (a prova de entrega — é o único jeito de saber se a mensagem chegou). */
export async function setWebhookUrl(
  conf: Conf,
  url: string,
): Promise<{ ok: boolean; status_code?: number; response?: Record<string, unknown>; error?: string }> {
  if (!(base(conf) && conf.id_instance && conf.api_token && url)) return { ok: false, error: "sem configuracao" };
  try {
    const resp = await fetch(`${base(conf)}/waInstance${conf.id_instance}/setWebhookUrl/${conf.api_token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incomingWebhook: true, outgoingWebhook: true, webhookUrl: url }),
      signal: AbortSignal.timeout(20_000),
    });
    const corpo = await jsonOuTexto(resp);
    return { ok: resp.status < 400, status_code: resp.status, response: corpo };
  } catch (exc) {
    return { ok: false, error: String(exc).slice(0, 160) };
  }
}

function semConfig(conf: Conf, chat: string): ResultadoEnvio | null {
  if (!(base(conf) && conf.id_instance && conf.api_token && chat)) return { ok: false, skipped: true };
  if (chat.length < 10) return { ok: false, skipped: true, error: "telefone_invalido" };
  return null;
}

async function jsonOuTexto(resp: Response): Promise<Record<string, unknown>> {
  const bruto = await resp.text();
  try {
    return JSON.parse(bruto);
  } catch {
    return { raw: bruto.slice(0, 500) };
  }
}

export async function enviarArquivo(
  conf: Conf,
  phone: string,
  conteudo: Uint8Array,
  fileName: string,
  caption: string,
): Promise<ResultadoEnvio> {
  const chat = normalizarWhatsapp(phone);
  const bloqueado = semConfig(conf, chat);
  if (bloqueado) return bloqueado;
  if (modoTeste()) {
    return { ok: true, simulado: true, status_code: 200, response: { chatId: `${chat}@c.us`, simulado: true } };
  }
  const forma = new FormData();
  forma.set("chatId", `${chat}@c.us`);
  forma.set("fileName", fileName);
  forma.set("caption", caption || "");
  const mime = fileName.toLowerCase().endsWith("png") ? "image/png" : "image/jpeg";
  forma.set("file", new Blob([new Uint8Array(conteudo)], { type: mime }), fileName);
  try {
    const resp = await fetch(`${base(conf)}/waInstance${conf.id_instance}/sendFileByUpload/${conf.api_token}`, {
      method: "POST",
      body: forma,
      signal: AbortSignal.timeout(90_000),
    });
    const corpo = await jsonOuTexto(resp);
    return { ok: resp.status < 400 && Boolean(corpo.idMessage), status_code: resp.status, response: corpo };
  } catch (exc) {
    return { ok: false, error: String(exc) };
  }
}

export async function enviarTexto(conf: Conf, phone: string, message: string): Promise<ResultadoEnvio> {
  const chat = normalizarWhatsapp(phone);
  const bloqueado = semConfig(conf, chat);
  if (bloqueado) return bloqueado;
  if (modoTeste()) {
    // O mesmo desenho da resposta de verdade, para o resto do código (guarda da conversa,
    // prova de entrega) ser provado no modo teste sem precisar de um envio real.
    return {
      ok: true,
      simulado: true,
      status_code: 200,
      response: { chatId: `${chat}@c.us`, idMessage: `simulada-${Date.now()}`, simulado: true },
    };
  }
  if (!message) return { ok: false, skipped: true, error: "mensagem vazia" };
  // sem parseMode: nas instâncias novas o campo é rejeitado na validação (400)
  try {
    const resp = await fetch(`${base(conf)}/waInstance${conf.id_instance}/sendMessage/${conf.api_token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: `${chat}@c.us`, message }),
      signal: AbortSignal.timeout(60_000),
    });
    const corpo = await jsonOuTexto(resp);
    return { ok: resp.status < 400 && Boolean(corpo.idMessage), status_code: resp.status, response: corpo };
  } catch (exc) {
    return { ok: false, error: String(exc) };
  }
}

export async function enviarFotoGeracao(conf: Conf, phone: string): Promise<ResultadoEnvio> {
  const base64 = String(conf.photo_base64 || "").trim();
  if (!base64) return { ok: false, skipped: true };
  let foto: Uint8Array;
  try {
    foto = b64ParaBytes(base64);
  } catch (exc) {
    return { ok: false, error: `photo_base64 invalido: ${exc}` };
  }
  return enviarArquivo(conf, phone, foto, String(conf.photo_name || "imagem.jpg"), String(conf.caption || ""));
}

/** O botão "recuperar": a foto da aba Recuperação junto do texto, quando estiver ligada. */
export async function enviarRecuperacao(conf: Conf, phone: string, texto: string): Promise<ResultadoEnvio> {
  const base64 = String(conf.recupera_photo_base64 || "").trim();
  if (conf.recupera_send_photo && base64) {
    let foto: Uint8Array;
    try {
      foto = b64ParaBytes(base64);
    } catch (exc) {
      return { ok: false, error: `recupera_photo_base64 invalido: ${exc}` };
    }
    const resultado = await enviarArquivo(conf, phone, foto, String(conf.recupera_photo_name || "imagem.jpg"), texto);
    resultado.com_foto = true;
    return resultado;
  }
  const resultado = await enviarTexto(conf, phone, texto);
  resultado.com_foto = false;
  return resultado;
}

// ---------------------------------------------------------------- leitura dos erros

function invokeStatus(resultado: ResultadoEnvio): Record<string, unknown> {
  const corpo = (resultado.response || {}) as Record<string, unknown>;
  const invoke = corpo.invokeStatus;
  return invoke && typeof invoke === "object" ? (invoke as Record<string, unknown>) : {};
}

export function cotaEsgotada(resultado: { status_code?: number; response?: Record<string, unknown> }): boolean {
  const invoke = invokeStatus(resultado as ResultadoEnvio);
  const texto = String(invoke.description || "").toLowerCase();
  if (texto.includes("quota")) return true;
  return String(resultado.status_code || "") === "466";
}

function hostErrado(resultado: ResultadoEnvio): boolean {
  if (!["403", "404"].includes(String(resultado.status_code || ""))) return false;
  const corpo = resultado.response || {};
  return String(corpo.raw || "").toLowerCase().includes("<html") || String(corpo).toLowerCase().includes("forbidden");
}

function validacao(resultado: ResultadoEnvio): string {
  if (String(resultado.status_code || "") !== "400") return "";
  const corpo = resultado.response || {};
  const texto = String(corpo.message || corpo.description || "");
  return texto.toLowerCase().includes("validation") ? texto : "";
}

/** Traduz o erro do GreenAPI em uma frase que dá para agir pelo celular. */
export function falhaGreenApi(resultado: ResultadoEnvio): string {
  if (resultado.error === "telefone_invalido") {
    return "O numero guardado para este cliente e curto demais para o WhatsApp (falta o DDD). " +
      "Digite o numero completo na caixinha da linha e tente de novo.";
  }
  if (cotaEsgotada(resultado)) {
    const invoke = invokeStatus(resultado);
    return `GreenAPI sem saldo do mes: ${invoke.used ?? "?"} chamadas usadas, ${invoke.total ?? 0} restantes. ` +
      "O plano gratuito (Developer) so libera 3 conversas por mes; mude o tariff da instancia para " +
      "Business no painel do GreenAPI e espere virar o mes.";
  }
  if (hostErrado(resultado)) {
    return "A URL de API esta errada: o servidor devolveu 403 do nginx. Chamar e postar arquivo usam " +
      "https://NUMERO.api.greenapi.com; o host .media so serve para baixar midia. " +
      "O painel agora corrige esse par sozinho ao gravar.";
  }
  const detalhe = validacao(resultado);
  if (detalhe) {
    if (detalhe.toLowerCase().replace(/\s/g, "").includes("chatid")) {
      return `O GreenAPI nao aceitou o numero guardado para este cliente (telefone invalido). ` +
        `Corrija o numero na caixinha da linha e tente de novo. Detalhe: ${detalhe.slice(0, 120)}`;
    }
    return `O GreenAPI recusou o pedido antes de enviar (corpo da mensagem invalido). Detalhe: ${detalhe.slice(0, 150)}`;
  }
  const corpo = resultado.response || {};
  return String(corpo.description || corpo.message || resultado.error || JSON.stringify(corpo) || "falha").slice(0, 180);
}
