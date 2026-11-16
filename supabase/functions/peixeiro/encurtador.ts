// O encurtador do Fabio (o mesmo do urtador). A chave publica nao e segredo; o token de
// sessao so existe como secret da funcao. Sem token o link nasce como visita.
const API_PADRAO = "https://ggufcvrwctieacvbbwim.supabase.co/functions/v1/kutt-short-links";
const CHAVE_PUBLICA = "sb_publishable_RP6trGNKQOv2EKEl0tqfkw_xHkbIylG";
const BASE_PADRAO = "https://kuttenc.github.io/urtador";

// Nomes que ja sao paginas do proprio encurtador: um link curto com um desses nunca abre.
const RESERVADOS = new Set([
  "index", "404", "admin", "guia", "sobre", "privacidade", "nes", "snes", "ps2",
  "emulador", "investindo", "aluguel", "peixeiro-pedidos", "rapidao", "assets",
  "robots", "sitemap", "ads", "api", "painel",
]);

const SLUG_BOM = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const URL_BOM = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function cfg() {
  return {
    api: (Deno.env.get("URTADOR_API_URL") || API_PADRAO).trim(),
    chave: (Deno.env.get("URTADOR_API_KEY") || CHAVE_PUBLICA).trim(),
    token: (Deno.env.get("URTADOR_TOKEN") || "").trim(),
    sessao: (Deno.env.get("URTADOR_SESSAO") || "").trim(),
    base: (Deno.env.get("URTADOR_BASE_URL") || BASE_PADRAO).trim().replace(/\/+$/, ""),
  };
}

export function baseEncurtador(): string {
  return cfg().base;
}

export function autenticado(): boolean {
  return Boolean(cfg().token);
}

export function limparSlug(slug: unknown): string {
  const texto = String(slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return texto.replace(/^-+|-+$/g, "").slice(0, 48);
}

function cabecalhos(c: ReturnType<typeof cfg>): Record<string, string> {
  const cab: Record<string, string> = { "content-type": "application/json", apikey: c.chave };
  if (c.token) cab.authorization = "Bearer " + c.token;
  return cab;
}

function corpoBase(c: ReturnType<typeof cfg>): Record<string, string> {
  if (c.token) return {};
  return { guestSessionId: c.sessao || crypto.randomUUID() };
}

async function chamar(corpo: Record<string, unknown>, timeout: number) {
  const c = cfg();
  try {
    const resp = await fetch(c.api, {
      method: "POST",
      headers: cabecalhos(c),
      body: JSON.stringify({ ...corpo, ...corpoBase(c) }),
      signal: AbortSignal.timeout(timeout),
    });
    const texto = await resp.text();
    let dados: Record<string, unknown> = {};
    try {
      dados = texto.trim() ? JSON.parse(texto) : {};
    } catch {
      dados = {};
    }
    return { status: resp.status, dados, c };
  } catch (exc) {
    return { erro: `o encurtador nao respondeu (${(exc as Error).name})` };
  }
}

/** Encurta um endereco. Nunca levanta: se o encurtador estiver fora, o chamador usa o comprido. */
export async function encurtar(url: string, slug = "", titulo = "", timeout = 15_000): Promise<Record<string, unknown>> {
  const alvo = String(url || "").trim();
  if (!URL_BOM.test(alvo)) {
    return { ok: false, erro: "o endereco precisa comecar com http:// ou https://" };
  }
  const corpo: Record<string, unknown> = {
    action: "create",
    url: alvo,
    title: String(titulo || "").trim().slice(0, 120),
  };
  const pedido = limparSlug(slug);
  if (pedido) {
    if (RESERVADOS.has(pedido)) {
      return { ok: false, erro: `o final '${pedido}' ja e uma pagina do encurtador, escolha outro` };
    }
    corpo.slug = pedido;
  }
  const resposta = await chamar(corpo, timeout);
  if ("erro" in resposta) return { ok: false, erro: resposta.erro };
  const { status, dados, c } = resposta;
  if (status >= 400 || !dados.slug) {
    return { ok: false, erro: String(dados.error || `o encurtador respondeu ${status}`).slice(0, 200) };
  }
  return {
    ok: true,
    curto: String(dados.shortUrl || `${c.base}/${dados.slug}`),
    slug: String(dados.slug),
    alvo: String(dados.url || alvo),
    visita: !c.token,
  };
}

/** Para onde um link curto aponta agora — da para conferir antes de mandar. */
export async function resolver(slug: string, timeout = 15_000): Promise<Record<string, unknown>> {
  const pedido = limparSlug(String(slug || "").trim().replace(/\/+$/, "").split("/").pop());
  if (!pedido || !SLUG_BOM.test(pedido)) return { ok: false, erro: "final de link invalido" };
  const resposta = await chamar({ action: "resolve", slug: pedido }, timeout);
  if ("erro" in resposta) return { ok: false, erro: resposta.erro };
  const { status, dados, c } = resposta;
  if (status >= 400 || !dados.url) {
    return { ok: false, erro: String(dados.error || `o encurtador respondeu ${status}`).slice(0, 200) };
  }
  return { ok: true, curto: `${c.base}/${pedido}`, alvo: String(dados.url), slug: pedido };
}
