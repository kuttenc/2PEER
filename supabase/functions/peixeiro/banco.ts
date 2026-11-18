// Leitura e escrita das tabelas do painel: configuração, telefones, espelho do MC e os
// registros de "já avisei". É o que o automate_mcapi.py fazia com psycopg, agora em SQL puro.
import { aleatorio, confereSenha, consultar, consultar1, hashSenha, igual } from "./db.ts";
import { formatarBrasilia, isoUtc, normalizarWhatsapp, parseExpDate, telefoneValido, textoVencido, type ClienteMensagem } from "./texto.ts";
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

/** O que a mensagem do "recuperar" sabe daquele cliente. O nome vem da lista colada na aba
 *  Clientes (`cliente_pix`) e, quando não existe, da nota do espelho do MC. Medido na cópia em
 *  17/11/2026: 16.382 linhas têm nome em `cliente_pix`, 921 têm nota no espelho e nenhuma tem os
 *  dois — por isso essa é a ordem, e não o contrário. Quem não está no espelho ainda tem o
 *  telefone da agenda, mas fica sem data e sem situação (a mensagem usa o fallback). */
export async function dadosDoCliente(username: string): Promise<ClienteMensagem & { usuario: string }> {
  const nome = (username || "").trim();
  // Sempre a mesma forma, com ou sem consulta: quem monta a mensagem lê os cinco campos.
  const vazio: ClienteMensagem & { usuario: string } = { usuario: nome, nome: "", telefone: "", status: null, expira: null };
  if (!nome) return vazio;
  const linha = await consultar1(
    `with q as (
       select 1 as origem,
              coalesce(nullif(trim(p.nome), ''), nullif(trim(m.notes), ''), '') as nome,
              coalesce(nullif(m.telefone, ''), '') as telefone,
              m.status, m.exp_date
         from public.mc_linhas m
         left join public.cliente_pix p on p.usuario = m.username
        where m.username = $1
       union all
       select 2, coalesce(nullif(trim(p.nome), ''), ''), coalesce(nullif(u.telefone, ''), ''), null, null
         from (select username, telefone from public.usuarios_criados_ip
                where username = $1 and coalesce(telefone, '') <> ''
                order by updated_at desc limit 1) u
         left join public.cliente_pix p on p.usuario = u.username
     )
     select nome, telefone, status, exp_date from q order by origem limit 1`,
    [nome],
  );
  if (!linha) return vazio;
  return {
    usuario: nome,
    nome: String(linha.nome || ""),
    telefone: String(linha.telefone || ""),
    status: linha.status === null || linha.status === undefined ? null : Number(linha.status),
    expira: linha.exp_date ? parseExpDate(String(linha.exp_date)) : null,
  };
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

/** A linha do espelho na forma que a tela usa; o `agora` entra por fora para o "faltam X dias"
 *  de uma página inteira calcular com um único instante. */
function desenhoDaLinha(linha: Record<string, unknown>, agora: number) {
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
}

export async function listarEspelho() {
  const r = await consultar(
    `select username, linha_id, telefone, exp_date, status, notes, synced_at
       from public.mc_linhas order by exp_date desc nulls last`,
  );
  const agora = Date.now();
  return r.rows.map((linha) => desenhoDaLinha(linha, agora));
}

/** Quem só existe na agenda de telefones (`usuarios_criados_ip`): cliente importado por CSV ou
 *  apagado do painel MC depois, mas que ainda tem número para receber WhatsApp. A aba Clientes
 *  mostra essa gente junto com o espelho — sem isso ela some da tela e não sobra para quem
 *  mandar mensagem comum. */
export async function listarSoAgenda() {
  const r = await consultar(
    `select distinct on (a.username) a.username, a.telefone, a.updated_at
       from public.usuarios_criados_ip a
      where coalesce(a.telefone, '') <> ''
        and not exists (select 1 from public.mc_linhas m where m.username = a.username)
      order by a.username, a.updated_at desc`,
  );
  return r.rows.map((linha: Record<string, unknown>) => ({
    username: String(linha.username || ""),
    linha_id: "",
    telefone: String(linha.telefone || ""),
    expira: "",
    exp_iso: "",
    texto_dias: "",
    vencido: false,
    status: 0,
    ativo: false,
    notes: "",
    sincronizado: "",
    so_agenda: true,
  }));
}

/** A lista da aba Clientes: o espelho do MC em cima e a gente que só tem telefone embaixo. */
export async function listarClientes() {
  return [...await listarEspelho(), ...await listarSoAgenda()];
}

/** Quantas linhas a aba Clientes mostra de uma vez. Com a base inteira na tela (17 mil em
 *  17/11/2026) o navegador não consegue desenhar e a aba não abre, então o servidor devolve
 *  uma página por vez — o mesmo caminho que a aba Acessos já tinha. */
export const CLIENTES_POR_PAGINA = 900;

/** As duas consultas de clientes lêem esta união: o espelho do MC com o nome e o CPF do PIX em
 *  cima, e embaixo quem só tem telefone na agenda (CSV importado ou linha apagada do MC). */
const BASE_CLIENTES = `
  with base as (
    select m.username, m.linha_id, m.telefone, m.exp_date, m.status, m.notes, m.synced_at,
           p.nome, p.cpf, false as so_agenda
      from public.mc_linhas m
      left join public.cliente_pix p on p.usuario = m.username
    union all
    select a.username, '', a.telefone, null, 0, '', null, p.nome, p.cpf, true
      from (select distinct on (u.username) u.username, u.telefone
              from public.usuarios_criados_ip u
             where coalesce(u.telefone, '') <> ''
               and not exists (select 1 from public.mc_linhas m where m.username = u.username)
             order by u.username, u.updated_at desc) a
      left join public.cliente_pix p on p.usuario = a.username
  )`;

/** Um campo só pesquisa em tudo, pelo formato do que foi digitado: com letra procura usuário,
 *  nome e nota; só com números procura CPF, telefone e usuário. Assim "(11) 99204-8213" acha o
 *  número mesmo com a máscara e um nome com algarismos no meio não inunda a tela com quem tem
 *  aqueles dígitos no telefone. `$3` é o termo aproveitado; vazio quer dizer "sem busca", que
 *  devolve a base inteira. */
const FILTRO_CLIENTES = `($3 = ''
      or ($1 <> '' and (b.username ilike '%'||$1||'%'
                        or coalesce(b.nome, '') ilike '%'||$1||'%'
                        or coalesce(b.notes, '') ilike '%'||$1||'%'))
      or ($2 <> '' and (coalesce(b.cpf, '') like '%'||$2||'%'
                        or coalesce(b.telefone, '') like '%'||$2||'%'
                        or b.username like '%'||$2||'%')))`;

export async function listarClientesPagina(pagina: number, termo: string) {
  const bruto = (termo || "").trim();
  // A régua é letra ou não é: pontuação de telefone e de CPF não conta como palavra.
  const temLetra = /\p{L}/u.test(bruto);
  // `%` e `_` são curingas do LIKE: dentro de um termo pesquisado eles não significam nada.
  const texto = temLetra ? bruto.replace(/[%_]/g, "") : "";
  const digitos = temLetra ? "" : bruto.replace(/\D/g, "");
  const params = [texto, digitos, texto || digitos];
  const numero = Math.max(1, Math.trunc(Number(pagina) || 1));

  const totais = await consultar(
    `${BASE_CLIENTES}
     select count(*)::int as na_base,
            count(*) filter (where coalesce(b.telefone, '') <> '')::int as com_telefone,
            count(*) filter (where b.so_agenda)::int as so_agenda,
            count(*) filter (where ${FILTRO_CLIENTES})::int as encontrados,
            max(b.synced_at) as sincronizado
       from base b`,
    params,
  );
  const r = await consultar(
    `${BASE_CLIENTES}
     select b.username, b.linha_id, b.telefone, b.exp_date, b.status, b.notes, b.synced_at,
            b.nome, b.cpf, b.so_agenda
       from base b
      where ${FILTRO_CLIENTES}
      order by b.exp_date desc nulls last, b.username
      limit ${CLIENTES_POR_PAGINA} offset $4`,
    [...params, (numero - 1) * CLIENTES_POR_PAGINA],
  );

  const t = totais.rows[0] || {};
  const encontrados = Number(t.encontrados || 0);
  const agora = Date.now();
  return {
    linhas: r.rows.map((linha) => ({
      ...desenhoDaLinha(linha, agora),
      nome: String(linha.nome || ""),
      cpf: String(linha.cpf || ""),
      so_agenda: Boolean(linha.so_agenda),
    })),
    info: {
      pagina: numero,
      paginas: Math.max(1, Math.ceil(encontrados / CLIENTES_POR_PAGINA)),
      por_pagina: CLIENTES_POR_PAGINA,
      encontrados,
      na_base: Number(t.na_base || 0),
      com_telefone: Number(t.com_telefone || 0),
      so_agenda: Number(t.so_agenda || 0),
      sincronizado: t.sincronizado ? formatarBrasilia(new Date(String(t.sincronizado))) : "",
    },
  };
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
