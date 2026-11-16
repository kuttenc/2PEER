// Tudo que fala com o painel MC (wwpanel.link / mcapi.knewcms.com). As chaves ficam no
// servidor: o navegador só vê o JSON das linhas.
import { consultar, consultar1 } from "./db.ts";
import { formatarBrasilia, isoUtc, parseExpDate, textoDiasRestantes, textoVencido } from "./texto.ts";

/** A base do painel MC. MC_API_BASE só existe para rodar a função contra um MC de mentira
 *  nos testes locais; na cópia e no site ele fica vazio e cai no endereço real. */
const MC_BASE = (Deno.env.get("MC_API_BASE") || "https://mcapi.knewcms.com:2087").replace(/\/+$/, "");
export const LOGIN_URL = `${MC_BASE}/auth/login`;
export const LINES_URL = `${MC_BASE}/lines`;
const TOKEN_LOCK_KEY = 92745131;

const CABECALHOS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
  "content-type": "application/json",
  origin: "https://wwpanel.link",
  referer: "https://wwpanel.link/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

export type Linha = {
  id: string;
  username: string;
  senha: string;
  expira: string;
  exp_iso: string;
  vencido: boolean;
  texto_dias: string;
  status: number;
  notes: string;
  criado: string;
};

export type Pagina = { pagina: number; paginas: number; total: number; exato: boolean; error?: string; status?: number };

export function modoTeste(): boolean {
  return ["1", "true", "sim", "on"].includes((Deno.env.get("PEIXEIRO_MODO_TESTE") || "").trim().toLowerCase());
}

export function normalizarBearer(token: string): string {
  const bruto = (token || "").trim();
  if (!bruto) return "";
  if (bruto.toLowerCase().startsWith("bearer ")) return bruto.split(" ").slice(1).join(" ").trim();
  return bruto;
}

function cabecalhoAuth(bearer: string): Record<string, string> {
  return { ...CABECALHOS, authorization: `Bearer ${normalizarBearer(bearer)}` };
}

/** Joga fora o bearer guardado. Sem isto um token recusado pelo MC (401) fica no cache até
 *  a expiração e o painel continua mostrando "logado" enquanto toda leitura falha. */
export async function limparCacheToken(): Promise<void> {
  await consultar("delete from public.mcapi_token_cache where id = 1");
}

/** GET /lines pelas páginas. O 401/403 limpa o cache para a próxima chamada logar de novo.
 *  Todo leitor de linha passa por aqui: o MC recusa pedido que não mande os cabeçalhos de
 *  navegador (o `origin`/`referer`/`user-agent`), então um fetch montado à mão dá 401. */
export async function getLinhas(bearer: string, params: URLSearchParams): Promise<Response> {
  const resp = await fetch(`${LINES_URL}?${params}`, { headers: cabecalhoAuth(bearer) });
  if (resp.status === 401 || resp.status === 403) await limparCacheToken();
  return resp;
}

// ---------------------------------------------------------------- login + cache do token

export type TokenInfo = { ok: boolean; token?: string; login_status?: number; erro?: string };

/** O mesmo pg_advisory_lock do site: duas varreduras seguidas não logam no MC ao mesmo tempo. */
export async function tokenDoPainel(clientIp: string, forcar = false): Promise<TokenInfo> {
  await consultar(`select pg_advisory_lock(${TOKEN_LOCK_KEY})`);
  try {
    if (!forcar) {
      const guardado = await consultar1(
        `select bearer_token, expires_at from public.mcapi_token_cache where id = 1`,
      );
      if (guardado && guardado.bearer_token) {
        const expira = guardado.expires_at ? new Date(String(guardado.expires_at)).getTime() : 0;
        if (expira - Date.now() > 60_000) {
          return { ok: true, token: String(guardado.bearer_token) };
        }
      }
    }

    const usuario = (Deno.env.get("MC_USERNAME") || "").trim();
    const senha = (Deno.env.get("MC_PASSWORD") || "").trim();
    if (!usuario || !senha) {
      return { ok: false, erro: "MC_USERNAME/MC_PASSWORD não configurados na função" };
    }

    const corpo = { username: usuario, password: senha, twoFacToken: "" };
    let status = 0, resposta: Record<string, unknown> = {}, token = "";
    try {
      const r = await fetch(LOGIN_URL, { method: "POST", headers: CABECALHOS, body: JSON.stringify(corpo) });
      status = r.status;
      resposta = (await r.json().catch(() => ({ raw: "corpo não é JSON" }))) as Record<string, unknown>;
      for (const chave of ["token", "accessToken", "access_token", "jwt"]) {
        if (resposta[chave]) {
          token = String(resposta[chave]);
          break;
        }
      }
    } catch (exc) {
      await gravarEvento({
        event_type: "login_refresh",
        status_code: 0,
        request_payload: { username: usuario },
        response_payload: { error: String(exc).slice(0, 200) },
        error_message: "login refresh falhou",
        client_ip: clientIp,
      });
      return { ok: false, erro: String(exc).slice(0, 160) };
    }

    await gravarEvento({
      event_type: "login_refresh",
      status_code: status,
      bearer_token: normalizarBearer(token),
      request_payload: corpo,
      response_payload: resposta,
      error_message: status >= 400 ? "login refresh failed" : null,
      client_ip: clientIp,
    });

    if (status >= 400 || !token) return { ok: false, login_status: status };

    let expira = expDoJwt(token) ?? new Date(Date.now() + 18 * 60_000);
    await consultar(
      `insert into public.mcapi_token_cache (id, bearer_token, expires_at, updated_at)
       values (1, $1, $2, now())
       on conflict (id) do update set bearer_token = excluded.bearer_token,
                                      expires_at = excluded.expires_at,
                                      updated_at = now()`,
      [token, expira],
    );
    await guardarTokenPorUsuario(token);
    return { ok: true, token };
  } finally {
    await consultar(`select pg_advisory_unlock(${TOKEN_LOCK_KEY})`);
  }
}

async function guardarTokenPorUsuario(token: string) {
  const payload = corpoJwt(token);
  const user_id = String(payload.sub || payload.id || payload.userId || "painel-online");
  const expira = expDoJwt(token);
  await consultar(
    `insert into public.mcapi_user_token_cache (user_id, bearer_token, expires_at, updated_at)
     values ($1, $2, $3, now())
     on conflict (user_id) do update set bearer_token = excluded.bearer_token,
                                         expires_at = excluded.expires_at,
                                         updated_at = now()`,
    [user_id, token, expira],
  );
}

function corpoJwt(token: string): Record<string, unknown> {
  try {
    const parte = normalizarBearer(token).split(".")[1];
    if (!parte) return {};
    return JSON.parse(atob(parte.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

function expDoJwt(token: string): Date | null {
  const exp = corpoJwt(token).exp;
  if (exp === undefined || exp === null) return null;
  const ms = Number(exp) * 1000;
  return isNaN(ms) ? null : new Date(ms);
}

// ---------------------------------------------------------------- leitura das linhas

export async function listarLinhas(
  bearer: string,
  pagina = 1,
  busca = "",
  porPagina = 40,
): Promise<{ linhas: Linha[]; info: Pagina; brutos: Record<string, unknown>[] }> {
  const params = new URLSearchParams({ page: String(pagina), quantityPerPage: String(porPagina), orderBy: "createdAt.DESC" });
  if (busca) params.set("generalSearch", busca);
  let resp: Response;
  try {
    resp = await getLinhas(bearer, params);
  } catch (exc) {
    return { linhas: [], info: { pagina, paginas: pagina, total: 0, exato: false, error: String(exc).slice(0, 160) }, brutos: [] };
  }
  if (resp.status >= 400) {
    return { linhas: [], info: { pagina, paginas: pagina, total: 0, exato: false, status: resp.status }, brutos: [] };
  }
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...mapearPagina(body, pagina, porPagina), info: paginaInfo(body, pagina, porPagina) };
}

function mapearPagina(body: Record<string, unknown>, pagina: number, porPagina: number) {
  const agora = Date.now();
  const brutos = (body.items || []) as Record<string, unknown>[];
  const linhas = brutos.map((item) => traduzirLinha(item, agora));
  return { linhas, brutos, pagina, porPagina };
}

export function traduzirLinha(item: Record<string, unknown>, agora = Date.now()): Linha {
  const expira = parseExpDate(String(item.exp_date || ""));
  const horas = expira ? (expira.getTime() - agora) / 3_600_000 : null;
  return {
    id: String(item.id ?? ""),
    username: String(item.username || "").trim(),
    senha: String(item.password || ""),
    expira: expira ? formatarBrasilia(expira) : "",
    exp_iso: expira ? isoUtc(expira) : "",
    vencido: horas !== null && horas <= 0,
    texto_dias: horas === null ? "" : textoVencido(horas),
    status: Number(item.status || 0),
    notes: String(item.notes || "").slice(0, 80),
    criado: String(item.createdAt || "").slice(0, 16),
  };
}

function paginaInfo(body: Record<string, unknown>, pagina: number, porPagina: number): Pagina {
  const total = inteiro(body.count ?? body.total ?? body.totalCount);
  const paginas = inteiro(body.pagesQuantity ?? body.totalPages);
  const recebidos = ((body.items || []) as unknown[]).length;
  const cheia = recebidos >= porPagina;
  return {
    pagina,
    paginas: paginas || (cheia ? pagina + 1 : pagina),
    total: total !== null ? total : recebidos,
    exato: total !== null,
  };
}

function inteiro(valor: unknown): number | null {
  const n = Number(valor);
  return valor === null || valor === undefined || valor === "" || isNaN(n) ? null : Math.trunc(n);
}

/** Varre TODAS as páginas do painel MC: nenhum lote pode depender do que está na tela. */
export async function varrerMc(
  bearer: string,
  busca = "",
  fica?: (l: Linha) => boolean,
  limitePaginas = 60,
  porPagina = 200,
): Promise<{ escolhidas: Linha[]; aviso: string; todos: Set<string> }> {
  const escolhidas: Linha[] = [];
  const todos = new Set<string>();
  let aviso = "", vistas = 0, tamanho = porPagina;
  for (let pagina = 1; pagina <= limitePaginas; pagina++) {
    const params = new URLSearchParams({ page: String(pagina), quantityPerPage: String(tamanho), orderBy: "createdAt.DESC" });
    if (busca) params.set("generalSearch", busca);
    let body: Record<string, unknown> = {}, status = 0;
    try {
      const resp = await getLinhas(bearer, params);
      status = resp.status;
      body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (exc) {
      aviso = `a leitura da página ${pagina} falhou: ${String(exc).slice(0, 80)}`;
      break;
    }
    const itens = ((body.items || []) as Record<string, unknown>[]).map((i) => traduzirLinha(i));
    if (status >= 400 && itens.length === 0) {
      aviso = `o painel MC respondeu ${status} na página ${pagina}`;
      break;
    }
    vistas += itens.length;
    for (const linha of itens) {
      if (!linha.username) continue;
      todos.add(linha.username);
      if (!fica || fica(linha)) escolhidas.push(linha);
    }
    if (pagina === 1 && itens.length > 0 && itens.length < tamanho) tamanho = itens.length;
    if (itens.length < tamanho) return { escolhidas, aviso, todos };
    const total = inteiro(body.count ?? body.total ?? body.totalCount);
    if (total !== null && vistas >= total) return { escolhidas, aviso, todos };
  }
  if (!aviso) aviso = `a varredura parou no limite de ${limitePaginas} páginas (${vistas} linhas vistas)`;
  return { escolhidas, aviso, todos };
}

/** Vencendo nas próximas `limiteHoras`, ordenados pela expiração ascendente do MC. */
export async function coletarLinhasVencendo(
  bearer: string,
  limiteHoras: number,
  maxPaginas = 8,
): Promise<{ itens: Vencendo[]; status: number | string }> {
  const agora = Date.now();
  const saida: Vencendo[] = [];
  let status: number | string = 0;
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const params = new URLSearchParams({ quantityPerPage: "200", orderBy: "exp_date.ASC", page: String(pagina) });
    let body: Record<string, unknown>;
    try {
      const resp = await getLinhas(bearer, params);
      status = resp.status;
      if (resp.status >= 400) return { itens: saida, status };
      body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (exc) {
      return { itens: saida, status: String(exc) };
    }
    const itens = (body.items || []) as Record<string, unknown>[];
    for (const item of itens) {
      const expira = parseExpDate(String(item.exp_date || ""));
      if (!expira) continue;
      const horas = (expira.getTime() - agora) / 3_600_000;
      if (horas >= limiteHoras) return { itens: saida, status };
      if (horas <= 0 || Number(item.status || 0) !== 1) continue;
      saida.push({
        username: String(item.username || "").trim(),
        exp_date: isoUtc(expira),
        expira_brasilia: formatarBrasilia(expira),
        horas,
        texto_dias: textoDiasRestantes(horas),
      });
    }
    if (itens.length < 200 || pagina >= Number(body.pagesQuantity || 1)) break;
  }
  return { itens: saida, status };
}

export type Vencendo = { username: string; exp_date: string; expira_brasilia: string; horas: number; texto_dias: string };

/** Já venceram dentro da janela, da mais recente para a mais antiga. */
export async function coletarLinhasVencidas(
  bearer: string,
  janelaDias = 30,
  maxPaginas = 8,
): Promise<{ itens: Vencendo[]; status: number | string }> {
  const agora = Date.now();
  const corte = agora - janelaDias * 86_400_000;
  const saida: Vencendo[] = [];
  let status: number | string = 0;
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const params = new URLSearchParams({ quantityPerPage: "200", orderBy: "exp_date.DESC", page: String(pagina) });
    let body: Record<string, unknown>;
    try {
      const resp = await getLinhas(bearer, params);
      status = resp.status;
      if (resp.status >= 400) return { itens: saida, status };
      body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (exc) {
      return { itens: saida, status: String(exc) };
    }
    const itens = (body.items || []) as Record<string, unknown>[];
    for (const item of itens) {
      const expira = parseExpDate(String(item.exp_date || ""));
      if (!expira) continue;
      if (expira.getTime() > agora) continue;
      if (expira.getTime() < corte) return { itens: saida, status };
      const horas = (expira.getTime() - agora) / 3_600_000;
      saida.push({
        username: String(item.username || "").trim(),
        exp_date: isoUtc(expira),
        expira_brasilia: formatarBrasilia(expira),
        horas,
        texto_dias: textoVencido(horas),
      });
    }
    if (itens.length < 200 || pagina >= Number(body.pagesQuantity || 1)) break;
  }
  return { itens: saida, status };
}

// ---------------------------------------------------------------- apagar linha

export async function apagarLinha(bearer: string, linhaId: string): Promise<{ status: number; corpo: Record<string, unknown> }> {
  if (modoTeste()) return { status: 200, corpo: { simulado: true } };
  let resp = await fetch(`${LINES_URL}/${linhaId}`, { method: "DELETE", headers: cabecalhoAuth(bearer) });
  if (resp.status === 401 || resp.status === 403) {
    const chave = (Deno.env.get("MC_PANEL_KEY") || "").trim();
    if (chave) {
      resp = await fetch(`${LINES_URL}/${linhaId}`, {
        method: "DELETE",
        headers: { ...CABECALHOS, "x-api-key": chave, authorization: `Bearer ${chave}` },
      });
    }
  }
  const bruto = await resp.text();
  let corpo: Record<string, unknown>;
  try {
    corpo = JSON.parse(bruto);
  } catch {
    corpo = { raw: bruto.slice(0, 300) };
  }
  return { status: resp.status, corpo };
}

/** O generalSearch do MC não acha pelo id, então varremos as linhas até bater. */
export async function linhaPorId(bearer: string, linhaId: string, maxPaginas = 4): Promise<Record<string, unknown> | null> {
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const params = new URLSearchParams({ page: String(pagina), quantityPerPage: "200", orderBy: "createdAt.DESC" });
    let itens: Record<string, unknown>[] = [];
    try {
      const resp = await getLinhas(bearer, params);
      itens = (((await resp.json()) || {}) as Record<string, unknown>).items as Record<string, unknown>[] || [];
    } catch {
      return null;
    }
    for (const item of itens) if (String(item.id) === String(linhaId)) return item;
    if (itens.length < 200) return null;
  }
  return null;
}

// ---------------------------------------------------------------- eventos do banco

export async function gravarEvento(e: {
  event_type: string;
  status_code?: number | null;
  bearer_token?: string | null;
  request_payload?: unknown;
  response_payload?: unknown;
  error_message?: string | null;
  client_ip?: string | null;
}) {
  await consultar(
    `insert into public.mcapi_events
       (event_type, status_code, bearer_token, request_payload, response_payload, error_message, client_ip)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      e.event_type,
      e.status_code ?? null,
      e.bearer_token ?? null,
      e.request_payload === undefined ? null : JSON.stringify(e.request_payload),
      e.response_payload === undefined ? null : JSON.stringify(e.response_payload),
      e.error_message ?? null,
      e.client_ip ?? null,
    ],
  );
}
