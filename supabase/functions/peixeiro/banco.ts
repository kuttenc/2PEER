// Leitura e escrita das tabelas do painel: configuração, telefones, espelho do MC e os
// registros de "já avisei". É o que o automate_mcapi.py fazia com psycopg, agora em SQL puro.
import { aleatorio, confereSenha, consultar, consultar1, hashSenha, igual } from "./db.ts";
import { formatarBrasilia, isoUtc, normalizarWhatsapp, parseExpDate, telefoneValido, textoVencido } from "./texto.ts";
import { getLinhas, tokenDoPainel } from "./mcapi.ts";

export type Conf = {
  api_url: string;
  media_url: string;
  id_instance: string;
  api_token: string;
  instance_name: string;
  owner_phone: string;
  qr_url: string;
  photo_base64: string;
  photo_name: string;
  caption: string;
  send_photo: boolean;
  aviso_ativo: boolean;
  aviso_dias: number;
  aviso_pix_key: string;
  aviso_pix_mascara: string;
  aviso_titulo: string;
  aviso_rodape: string;
  aviso_legenda: string;
  aviso_token: string;
  painel_token: string;
  renova_ativo: boolean;
  renova_dias: number;
  renova_janela_dias: number;
  renova_legenda: string;
  recupera_legenda: string;
  updated_at: string;
  recupera_photo_base64: string;
  recupera_photo_name: string;
  recupera_send_photo: boolean;
  /** Pausa sorteada entre as mensagens do lote "Não recuperados", em segundos. */
  recupera_pausa_min: number;
  recupera_pausa_max: number;
  chat_ativo: boolean;
  chat_token: string;
  chat_dias: number;
  chat_desconhecido: boolean;
};

const COLUNAS_CONF = `api_url, media_url, id_instance, api_token, instance_name, owner_phone, qr_url,
  photo_base64, photo_name, caption, send_photo, aviso_ativo, aviso_dias, aviso_pix_key, aviso_pix_mascara,
  aviso_titulo, aviso_rodape, aviso_legenda, aviso_token, painel_token, renova_ativo, renova_dias,
  renova_janela_dias, renova_legenda, recupera_legenda, updated_at, recupera_photo_base64,
  recupera_photo_name, recupera_send_photo, recupera_pausa_min, recupera_pausa_max,
  chat_ativo, chat_token, chat_dias, chat_desconhecido`;

export async function obterConfig(): Promise<Conf | null> {
  const linha = await consultar1(`select ${COLUNAS_CONF} from public.greenapi_config where id = 1`);
  if (!linha) return null;
  return {
    api_url: String(linha.api_url || ""),
    media_url: String(linha.media_url || ""),
    id_instance: String(linha.id_instance || ""),
    api_token: String(linha.api_token || ""),
    instance_name: String(linha.instance_name || ""),
    owner_phone: String(linha.owner_phone || ""),
    qr_url: String(linha.qr_url || ""),
    photo_base64: String(linha.photo_base64 || ""),
    photo_name: String(linha.photo_name || ""),
    caption: String(linha.caption || ""),
    send_photo: Boolean(linha.send_photo),
    aviso_ativo: Boolean(linha.aviso_ativo),
    aviso_dias: Number(linha.aviso_dias || 2),
    aviso_pix_key: String(linha.aviso_pix_key || ""),
    aviso_pix_mascara: String(linha.aviso_pix_mascara || ""),
    aviso_titulo: String(linha.aviso_titulo || ""),
    aviso_rodape: String(linha.aviso_rodape || ""),
    aviso_legenda: String(linha.aviso_legenda || ""),
    aviso_token: String(linha.aviso_token || ""),
    painel_token: String(linha.painel_token || ""),
    renova_ativo: Boolean(linha.renova_ativo),
    renova_dias: Number(linha.renova_dias || 3),
    renova_janela_dias: Number(linha.renova_janela_dias || 30),
    renova_legenda: String(linha.renova_legenda || ""),
    recupera_legenda: String(linha.recupera_legenda || ""),
    updated_at: linha.updated_at ? new Date(String(linha.updated_at)).toISOString().replace("Z", "+00:00") : "",
    recupera_photo_base64: String(linha.recupera_photo_base64 || ""),
    recupera_photo_name: String(linha.recupera_photo_name || ""),
    recupera_send_photo: Boolean(linha.recupera_send_photo),
    recupera_pausa_min: Number(linha.recupera_pausa_min ?? 4.5),
    recupera_pausa_max: Number(linha.recupera_pausa_max ?? 105),
    chat_ativo: Boolean(linha.chat_ativo),
    chat_token: String(linha.chat_token || ""),
    chat_dias: Number(linha.chat_dias ?? 90),
    chat_desconhecido: Boolean(linha.chat_desconhecido),
  };
}

const CAMPOS_CONF = [
  "api_url", "media_url", "id_instance", "api_token", "instance_name", "owner_phone", "qr_url",
  "photo_base64", "photo_name", "caption", "send_photo", "aviso_ativo", "aviso_dias", "aviso_pix_key",
  "aviso_pix_mascara", "aviso_titulo", "aviso_rodape", "aviso_legenda", "aviso_token", "renova_ativo",
  "renova_dias", "renova_janela_dias", "renova_legenda", "recupera_legenda", "recupera_photo_base64",
  "recupera_photo_name", "recupera_send_photo", "recupera_pausa_min", "recupera_pausa_max",
] as const;

const BOOLEANOS = new Set(["send_photo", "aviso_ativo", "renova_ativo", "recupera_send_photo"]);
const NUMERICOS: Record<string, [number, number, number]> = {
  aviso_dias: [0.1, 30, 2],
  renova_dias: [1, 30, 3],
  renova_janela_dias: [1, 365, 30],
  recupera_pausa_min: [0.5, 600, 4.5],
  recupera_pausa_max: [1, 900, 105],
};

const RE = /(\d{2,6})\.(api|media)\.green-?api\.com/i;

export function servidorGreenApi(valor: string): string {
  const m = RE.exec(String(valor || ""));
  return m ? m[1] : "";
}

/** Corrigir o par de hosts: chamar é sempre .api, baixar mídia é sempre .media. */
export function hostsGreenApi(apiUrl: string, mediaUrl: string, idInstance = ""): [string, string] {
  let servidor = servidorGreenApi(apiUrl) || servidorGreenApi(mediaUrl);
  if (!servidor) {
    const m = String(idInstance || "").match(/^\s*(\d{4})/);
    servidor = m ? m[1] : "";
  }
  if (!servidor) return [String(apiUrl || "").trim(), String(mediaUrl || "").trim()];
  return [`https://${servidor}.api.greenapi.com`, `https://${servidor}.media.greenapi.com`];
}

export function baseDaApi(conf: { api_url?: string }): string {
  const api = String(conf.api_url || "").trim();
  const m = RE.exec(api);
  if (m && m[2].toLowerCase() === "media") return `https://${m[1]}.api.greenapi.com`;
  return api.replace(/\/+$/, "");
}

export type Ajuste = { ok: boolean; campos?: string[]; ajuste?: string; error?: string };

export async function salvarConfig(campos: Record<string, unknown>): Promise<Ajuste> {
  let ajuste = "";
  if ("api_url" in campos || "media_url" in campos || "id_instance" in campos) {
    const guardado = (await obterConfig()) || ({} as Conf);
    const [apiNovo, mediaNovo] = hostsGreenApi(
      String(campos.api_url || guardado.api_url || ""),
      String(campos.media_url || guardado.media_url || ""),
      String(campos.id_instance || guardado.id_instance || ""),
    );
    if (apiNovo && apiNovo !== String(guardado.api_url || "").trim()) ajuste = `apiUrl corrigida para ${apiNovo}`;
    if (mediaNovo && mediaNovo !== String(guardado.media_url || "").trim()) {
      ajuste = (ajuste ? ajuste + " | " : "") + `mediaUrl corrigida para ${mediaNovo}`;
    }
    if (apiNovo) campos.api_url = apiNovo;
    if (mediaNovo) campos.media_url = mediaNovo;
    if (ajuste && ("id_instance" in campos || "api_token" in campos)) campos.qr_url = "";
  }

  const clausulas: string[] = [], valores: unknown[] = [];
  for (const chave of CAMPOS_CONF) {
    if (!(chave in campos)) continue;
    let valor = campos[chave];
    if (BOOLEANOS.has(chave)) valor = Boolean(valor);
    else if (chave in NUMERICOS) {
      const [min, max, padrao] = NUMERICOS[chave];
      const n = Number(valor ?? padrao);
      valor = isNaN(n) ? padrao : Math.max(min, Math.min(max, n));
    } else valor = String(valor ?? "").trim();
    clausulas.push(`${chave} = $${clausulas.length + 1}`);
    valores.push(valor);
  }
  if (!clausulas.length) return { ok: false, error: "nenhum campo reconhecido para salvar" };

  clausulas.push("updated_at = now()");
  await consultar(`update public.greenapi_config set ${clausulas.join(", ")} where id = 1`, valores);
  await consultar(
    `insert into public.mcapi_events (event_type, status_code, request_payload, response_payload)
     values ($1, 200, $2, $3)`,
    [
      "painel_config_write",
      JSON.stringify({ campos: CAMPOS_CONF.filter((c) => c in campos).sort() }),
      JSON.stringify({ atualizado: true }),
    ],
  );
  return { ok: true, campos: CAMPOS_CONF.filter((c) => c in campos).sort(), ajuste };
}

export function resumoConfig(conf: Conf) {
  const saida: Record<string, unknown> = { ...conf };
  const foto = String(saida.photo_base64 || "");
  const fotoRecupera = String(saida.recupera_photo_base64 || "");
  delete saida.photo_base64;
  delete saida.recupera_photo_base64;
  delete saida.painel_token;
  saida.photo_present = foto !== "";
  saida.photo_kb = Math.round(foto.length / 1024);
  saida.recupera_photo_present = fotoRecupera !== "";
  saida.recupera_photo_kb = Math.round(fotoRecupera.length / 1024);
  return saida;
}

// ---------------------------------------------------------------- telefones

export async function telefonesPorUsuario(): Promise<Record<string, string>> {
  const r = await consultar(
    `select username, telefone from public.usuarios_criados_ip
      where telefone <> '' order by updated_at desc`,
  );
  const saida: Record<string, string> = {};
  for (const linha of r.rows as Record<string, unknown>[]) {
    const nome = String(linha.username || "").trim();
    if (nome && !(nome in saida)) saida[nome] = String(linha.telefone || "").trim();
  }
  return saida;
}

export type TelefoneResultado = {
  ok: boolean;
  error?: string;
  telefone?: string;
  linhas?: number;
  espelho?: number;
  origem?: string;
  destino?: string;
};

export async function salvarTelefone(username: string, telefone: string): Promise<TelefoneResultado> {
  const digitos = normalizarWhatsapp(telefone);
  const nome = (username || "").trim();
  if (!nome) return { ok: false, error: "sem_destino" };
  if (!telefoneValido(digitos)) return { ok: false, error: "telefone_invalido", telefone: digitos };

  const alteradas = await consultar(
    `update public.usuarios_criados_ip set telefone = $1, updated_at = now() where username = $2`,
    [digitos, nome],
  );
  if (!alteradas.rowCount) {
    await consultar(
      `insert into public.usuarios_criados_ip (client_ip, username, telefone, updated_at)
       values ('painel', $1, $2, now())
       on conflict (client_ip, username) do update set telefone = excluded.telefone, updated_at = now()`,
      [nome, digitos],
    );
  }
  const espelho = await consultar(
    `insert into public.mc_linhas (username, telefone, synced_at)
     values ($1, $2, now())
     on conflict (username) do update set telefone = excluded.telefone, synced_at = now()`,
    [nome, digitos],
  );
  return { ok: true, telefone: digitos, linhas: alteradas.rowCount || 0, espelho: espelho.rowCount || 0 };
}

export async function mesclarTelefones(origem: string, destino: string) {
  const deNome = (origem || "").trim();
  const paraNome = (destino || "").trim();
  if (!deNome || !paraNome) return { ok: false, error: "sem_destino" };
  if (deNome === paraNome) return { ok: false, error: "mesmo_usuario" };
  const numero = (await telefonesPorUsuario())[deNome] || "";
  if (!numero) return { ok: false, error: "origem_sem_telefone", origem: deNome };
  const resultado = await salvarTelefone(paraNome, numero);
  if (!resultado.ok) return resultado;
  return { ok: true, origem: deNome, destino: paraNome, telefone: numero, linhas: resultado.linhas };
}

export async function registrarUsuarioCriado(clientIp: string, username: string, telefone = "", telegramId = "") {
  if (!clientIp || !username) return;
  await consultar(
    `insert into public.usuarios_criados_ip (client_ip, username, telefone, telegram_id, updated_at)
     values ($1,$2,$3,$4, now())
     on conflict (client_ip, username)
       do update set telefone = excluded.telefone, telegram_id = excluded.telegram_id, updated_at = now()`,
    [clientIp, username, telefone || null, telegramId || null],
  );
}

// ---------------------------------------------------------------- espelho do MC

export async function espelharLinhas(itens: Record<string, unknown>[], telefones: Record<string, string>): Promise<number> {
  let gravadas = 0;
  for (const item of itens) {
    const username = String(item.username || "").trim();
    if (!username) continue;
    const expira = parseExpDate(String(item.exp_date || ""));
    await consultar(
      `insert into public.mc_linhas (username, linha_id, telefone, exp_date, status, notes, synced_at)
       values ($1,$2,$3,$4,$5,$6, now())
       on conflict (username) do update
         set linha_id = excluded.linha_id,
             telefone = coalesce(nullif(excluded.telefone, ''), mc_linhas.telefone),
             exp_date = excluded.exp_date,
             status = excluded.status,
             notes = excluded.notes,
             synced_at = now()`,
      [
        username,
        String(item.id ?? ""),
        telefones[username] || "",
        expira,
        Number(item.status || 0),
        String(item.notes || "").slice(0, 200),
      ],
    );
    gravadas++;
  }
  return gravadas;
}

export async function sincronizarLinhas(clientIp: string, maxPaginas = 5) {
  const info = await tokenDoPainel(clientIp);
  if (!info.ok) return { ok: false, error: "login no painel mc falhou", login_status: info.login_status };
  const bearer = info.token || "";
  const brutos: Record<string, unknown>[] = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const params = new URLSearchParams({
      page: String(pagina),
      quantityPerPage: "200",
      orderBy: "createdAt.DESC",
    });
    const resp = await getLinhas(bearer, params);
    if (resp.status >= 400) return { ok: false, error: `MC devolveu ${resp.status}`, lines_status: resp.status };
    const body = (await resp.json()) as Record<string, unknown>;
    const itens = (body.items || []) as Record<string, unknown>[];
    brutos.push(...itens);
    if (itens.length < 200) break;
  }
  const linhas = await espelharLinhas(brutos, await telefonesPorUsuario());
  return { ok: true, linhas };
}

export async function listarEspelho() {
  const r = await consultar(
    `select username, linha_id, telefone, exp_date, status, notes, synced_at
       from public.mc_linhas order by exp_date desc nulls last`,
  );
  const agora = Date.now();
  return r.rows.map((linha: Record<string, unknown>) => {
    const exp = linha.exp_date ? new Date(String(linha.exp_date)) : null;
    return {
      username: String(linha.username || ""),
      linha_id: String(linha.linha_id || ""),
      telefone: String(linha.telefone || ""),
      expira: exp ? formatarBrasilia(exp) : "",
      exp_iso: exp ? isoUtc(exp) : "",
      texto_dias: exp ? textoVencido((exp.getTime() - agora) / 3_600_000) : "",
      vencido: Boolean(exp && exp.getTime() <= agora),
      status: Number(linha.status || 0),
      ativo: Number(linha.status || 0) === 1,
      notes: String(linha.notes || "").slice(0, 80),
      sincronizado: linha.synced_at ? formatarBrasilia(new Date(String(linha.synced_at))) : "",
    };
  });
}

// ---------------------------------------------------------------- "já avisei"

export async function chaveAvisadas(): Promise<string[]> {
  const r = await consultar(`select username, exp_date from public.vencimento_avisos`);
  return r.rows.map((l: Record<string, unknown>) => `${String(l.username).trim()}|${String(l.exp_date).trim()}`);
}

export async function registrarAviso(
  username: string,
  expDate: string,
  telefone: string,
  horas: number,
  resultado: { status_code?: number; response?: Record<string, unknown> },
) {
  const corpo = resultado.response || {};
  await consultar(
    `insert into public.vencimento_avisos
       (username, exp_date, telefone, horas_restantes, status_code, id_message, response, created_at)
     values ($1,$2,$3,$4,$5,$6,$7, now())
     on conflict (username, exp_date) do update
       set telefone = excluded.telefone,
           horas_restantes = excluded.horas_restantes,
           status_code = excluded.status_code,
           id_message = excluded.id_message,
           response = excluded.response`,
    [
      username,
      expDate,
      telefone,
      Math.round(horas * 100) / 100,
      resultado.status_code ?? null,
      String(corpo.idMessage || ""),
      JSON.stringify(corpo),
    ],
  );
}

export async function registrarRenovacao(
  username: string,
  expDate: string,
  telefone: string,
  horas: number,
  resultado: { status_code?: number; response?: Record<string, unknown> },
  via: string,
) {
  const corpo = resultado.response || {};
  await consultar(
    `insert into public.renovacao_avisos
       (username, exp_date, telefone, dias_vencido, via, status_code, id_message, response, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (username, exp_date) do update
       set telefone = excluded.telefone,
           dias_vencido = excluded.dias_vencido,
           via = excluded.via,
           status_code = excluded.status_code,
           id_message = excluded.id_message,
           response = excluded.response,
           updated_at = now()`,
    [
      username,
      expDate,
      telefone,
      Math.round((Math.abs(horas) / 24) * 10) / 10,
      via,
      resultado.status_code ?? null,
      String(corpo.idMessage || ""),
      JSON.stringify(corpo),
    ],
  );
}

// ---------------------------------------------------------------- senha do painel

export async function hashArmazenado(): Promise<string> {
  const linha = await consultar1(`select painel_senha_hash from public.greenapi_config where id = 1`);
  return linha ? String(linha.painel_senha_hash || "") : "";
}

export async function trocarSenha(atual: string, nova: string): Promise<{ ok: boolean; erro?: string }> {
  const armazenada = await hashArmazenado();
  if (!(await confereSenha(atual, armazenada))) return { ok: false, erro: "atual" };
  if (nova.length < 8) return { ok: false, erro: "curta" };
  await consultar(
    `update public.greenapi_config set painel_senha_hash = $1, updated_at = now() where id = 1`,
    [await hashSenha(nova)],
  );
  return { ok: true };
}

export async function tokenPainel(): Promise<string> {
  const linha = await consultar1(`select painel_token from public.greenapi_config where id = 1`);
  const valor = linha ? String(linha.painel_token || "") : "";
  if (valor) return valor;
  const novo = aleatorio(16);
  await consultar(`update public.greenapi_config set painel_token = $1 where id = 1`, [novo]);
  return novo;
}

export function mesmaChave(a: string, b: string): boolean {
  return igual(a, b);
}
