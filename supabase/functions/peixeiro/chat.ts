// O robô de conversa. Cada mensagem que chega no WhatsApp faz o GreenAPI bater aqui: a gente
// reconhece o telefone na base de clientes, responde pela regra que casar e guarda o par
// pergunta → resposta — que é, hoje, a base de treino da IA que ainda vai chegar.
import { obterConfig, type Conf } from "./banco.ts";
import { aleatorio, consultar, consultar1, igual } from "./db.ts";
import { enviarTexto, setWebhookUrl } from "./greenapi.ts";
import { escreverCsv } from "./csv.ts";
import {
  normalizarWhatsapp,
  parseExpDate,
  semAcento,
  variaveisMensagem,
} from "./texto.ts";

type Bruto = Record<string, unknown>;

export type Regra = {
  id: number;
  gatilho: string;
  resposta: string;
  ativo: boolean;
  prioridade: number;
  contagem: number;
  atualizado_em: string;
};

export type Cliente = {
  usuario: string;
  telefone: string;
  nota: string;
  status: number;
  expira: Date | null;
};

export type Mensagem = {
  chave: string;
  telefone: string;
  texto: string;
  grupo: boolean;
  minha: boolean;
  tipo: string;
};

const DIAS_PADRAO = 90;

// -------------------------------------------------------------------------- configuração

/** A chave do webhook, criada na primeira vez que a aba Chat é aberta. */
export async function tokenChat(): Promise<string> {
  const valor = String((await obterConfig())?.chat_token || "").trim();
  if (valor) return valor;
  const novo = aleatorio(16);
  await consultar(`update public.greenapi_config set chat_token = $1 where id = 1`, [novo]);
  return novo;
}

/** O endereço que ele cola no campo webhookUrl do GreenAPI. O token vai na query porque o
 *  corpo da mensagem é do GreenAPI — não há onde encaixar a nossa chave ali. */
export function urlWebhook(enderecoDaFuncao: string, token: string): string {
  const semQuery = String(enderecoDaFuncao || "").split("?")[0].replace(/\/+$/, "");
  return `${semQuery}?action=chat_webhook&token=${token}`;
}

/** O que a aba Chat mostra: regras, estado do webhook na instância e o tamanho do arquivo. */
export async function resumoChat(enderecoDaFuncao: string): Promise<Bruto> {
  const conf = await obterConfig();
  const token = await tokenChat();
  const linhas = await consultar(
    `select (select count(*) from public.chat_mensagens)::bigint as mensagens,
            (select count(*) from public.chat_mensagens where direcao = 'entrada')::bigint as entradas,
            (select count(*) from public.chat_treino)::bigint as treino,
            (select count(*) from public.chat_treino where resposta is null)::bigint as sem_resposta`,
  );
  const contagem = linhas.rows[0] || {};
  return {
    ativo: Boolean(conf?.chat_ativo),
    dias: Number(conf?.chat_dias ?? DIAS_PADRAO),
    desconhecido: Boolean(conf?.chat_desconhecido),
    token,
    webhook: urlWebhook(enderecoDaFuncao, token),
    configurado: Boolean(conf?.api_url && conf?.id_instance && conf?.api_token),
    regras: await listarRegras(),
    mensagens: Number(contagem.mensagens || 0),
    entradas: Number(contagem.entradas || 0),
    treino: Number(contagem.treino || 0),
    sem_resposta: Number(contagem.sem_resposta || 0),
  };
}

/** Liga/desliga o robô e ajusta a retenção — sem passar por configSalvar, que valida a chave do GreenAPI. */
export async function ajustarChat(campos: {
  ativo?: boolean;
  dias?: number;
  desconhecido?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const partes: string[] = [];
  const valores: unknown[] = [];
  if (typeof campos.ativo === "boolean") {
    partes.push(`chat_ativo = $${partes.length + 1}`);
    valores.push(campos.ativo);
  }
  if (typeof campos.dias === "number") {
    partes.push(`chat_dias = $${partes.length + 1}`);
    valores.push(Math.min(365, Math.max(1, campos.dias)));
  }
  if (typeof campos.desconhecido === "boolean") {
    partes.push(`chat_desconhecido = $${partes.length + 1}`);
    valores.push(campos.desconhecido);
  }
  if (!partes.length) return { ok: false, error: "nada para gravar" };
  partes.push("updated_at = now()");
  const r = await consultar(`update public.greenapi_config set ${partes.join(", ")} where id = 1`, valores);
  return { ok: (r.rowCount || 0) > 0 };
}

/** Manda o GreenAPI apontar o webhook de entrada para esta função. É a configuração que ele
 *  não precisa fazer na mão: uma chamada, e a instância passa a entregar aqui. */
export async function instalarWebhook(enderecoDaFuncao: string): Promise<Bruto> {
  const conf = await obterConfig();
  if (!(conf?.api_url && conf?.id_instance && conf?.api_token)) {
    return { ok: false, error: "sem configuracao" };
  }
  const token = await tokenChat();
  const resultado = await setWebhookUrl(conf, urlWebhook(enderecoDaFuncao, token));
  return { ...resultado, webhook: urlWebhook(enderecoDaFuncao, token) };
}

// ----------------------------------------------------------------------------- regras

export async function listarRegras(): Promise<Regra[]> {
  const r = await consultar(
    `select id, gatilho, resposta, ativo, prioridade, contagem,
            to_char(atualizado_em, 'DD/MM/YYYY "às" HH24:MI') as atualizado_em
       from public.chat_regras
      order by prioridade asc, id asc
      limit 200`,
  );
  return r.rows.map((l) => ({
    id: Number(l.id || 0),
    gatilho: String(l.gatilho || ""),
    resposta: String(l.resposta || ""),
    ativo: Boolean(l.ativo),
    prioridade: Number(l.prioridade ?? 10),
    contagem: Number(l.contagem || 0),
    atualizado_em: String(l.atualizado_em || ""),
  }));
}

export type RegraNova = { gatilho: string; resposta: string; prioridade: number };

export async function novaRegra(dados: RegraNova): Promise<{ ok: boolean; id?: number; error?: string }> {
  const r = await consultar(
    `insert into public.chat_regras (gatilho, resposta, prioridade) values ($1, $2, $3) returning id`,
    [dados.gatilho, dados.resposta, dados.prioridade],
  );
  const linha = r.rows[0] || {};
  return linha.id ? { ok: true, id: Number(linha.id) } : { ok: false, error: "banco" };
}

export async function salvarRegra(
  id: number,
  dados: { gatilho: string; resposta: string; prioridade: number; ativo: boolean },
): Promise<boolean> {
  const r = await consultar(
    `insert into public.chat_regras (id, gatilho, resposta, prioridade, ativo, atualizado_em)
     values ($1, $2, $3, $4, $5, now())
     on conflict (id) do update
       set gatilho = excluded.gatilho, resposta = excluded.resposta,
           prioridade = excluded.prioridade, ativo = excluded.ativo, atualizado_em = now()`,
    [id, dados.gatilho, dados.resposta, dados.prioridade, dados.ativo],
  );
  return (r.rowCount || 0) > 0;
}

/** A chave de um chat só, sem regravar o texto: assim dá para desligar uma resposta enquanto o
 *  restante continua respondendo e enquanto ele ainda está escrevendo nos outros campos. */
export async function ligarRegra(id: number, ativo: boolean): Promise<boolean> {
  const r = await consultar(
    "update public.chat_regras set ativo = $2, atualizado_em = now() where id = $1",
    [id, ativo],
  );
  return (r.rowCount || 0) > 0;
}

export async function apagarRegra(id: number): Promise<boolean> {
  const r = await consultar(`delete from public.chat_regras where id = $1`, [id]);
  return (r.rowCount || 0) > 0;
}

// -------------------------------------------------------------------------- conversas

export type Conversa = {
  telefone: string;
  usuario: string;
  quantidade: number;
  ultima: string;
  ultimo_texto: string;
};

/** Um resumo por telefone, o que a aba lista antes de abrir a conversa. */
export async function telefonesConversados(dias: number, limite = 50): Promise<Conversa[]> {
  const r = await consultar(
    `select telefone,
            max(usuario) as usuario,
            count(*) as quantidade,
            to_char(max(criado_em), 'DD/MM/YYYY "às" HH24:MI') as ultima,
            max(criado_em) as quando
       from public.chat_mensagens
      where direcao = 'entrada' and criado_em > now() - ($1 * interval '1 day')
      group by telefone
      order by quando desc
      limit $2`,
    [dias, limite],
  );
  return r.rows.map((l) => ({
    telefone: String(l.telefone || ""),
    usuario: String(l.usuario || ""),
    quantidade: Number(l.quantidade || 0),
    ultima: String(l.ultima || ""),
    ultimo_texto: "",
  }));
}

export async function mensagensDe(telefone: string, limite = 200): Promise<Bruto[]> {
  const r = await consultar(
    `select direcao, texto, usuario,
            to_char(criado_em, 'DD/MM/YYYY "às" HH24:MI') as criado_em
       from public.chat_mensagens
      where telefone = $1
      order by id desc
      limit $2`,
    [telefone, limite],
  );
  return r.rows.map((l) => ({
    direcao: String(l.direcao || ""),
    texto: String(l.texto || ""),
    usuario: String(l.usuario || ""),
    criado_em: String(l.criado_em || ""),
  })).reverse();
}

/** O arquivo de treino, em CSV: é o que a IA come depois. Sem prazo de 90 dias — aqui fica tudo. */
export async function exportarTreino(limite = 5000): Promise<{ csv: string; nome: string; n: number }> {
  const r = await consultar(
    `select entrada, coalesce(resposta, '') as resposta, cadastrado, usuario,
            coalesce(regra_id::text, '') as regra_id,
            to_char(criado_em, 'DD/MM/YYYY HH24:MI') as criado_em
       from public.chat_treino
      order by id desc
      limit $1`,
    [limite],
  );
  const linhas: string[][] = [["Pergunta", "Resposta", "Regra", "Cliente", "Cadastrado", "Quando"]];
  for (const l of r.rows) {
    linhas.push([
      String(l.entrada || ""), String(l.resposta || ""), String(l.regra_id || ""),
      String(l.usuario || ""), Boolean(l.cadastrado) ? "sim" : "não", String(l.criado_em || ""),
    ]);
  }
  return { csv: "﻿" + escreverCsv(linhas), nome: "treino-ia.csv", n: r.rows.length };
}

// ------------------------------------------------------------------- reconhecer o cliente

/** O telefone é cliente nosso? mc_linhas (o espelho do painel MC) primeiro, e depois a lista
 *  de envios — o mesmo caminho que o botão recuperar usa. O nome vem da lista colada na aba
 *  Clientes quando ela existe (16.382 na cópia) e da nota do MC nos outros casos (921). */
export async function clientePorTelefone(digitos: string): Promise<Cliente | null> {
  if (digitos.length < 10) return null;
  const linha = await consultar1(
    `select usuario, telefone, exp_date, status, nota from (
       select m.username as usuario, m.telefone, m.exp_date, m.status,
              coalesce(nullif(trim(p.nome), ''), nullif(trim(m.notes), ''), '') as nota, 1 as origem
         from public.mc_linhas m
         left join public.cliente_pix p on p.usuario = m.username
        where m.telefone = $1
       union all
       select username, telefone, exp_date, null::integer, null::text, 2
         from public.usuarios_criados_ip where telefone = $1 and username <> ''
     ) q order by origem limit 1`,
    [digitos],
  );
  if (!linha) return null;
  return {
    usuario: String(linha.usuario || ""),
    telefone: String(linha.telefone || digitos),
    nota: String(linha.nota || "").trim(),
    status: Number(linha.status ?? 0),
    expira: linha.exp_date ? parseExpDate(String(linha.exp_date)) : null,
  };
}

/** As variáveis da resposta do robô são as mesmas da mensagem de recuperação — quem escreve
 *  uma regra e quem escreve a mensagem do "recuperar" usam os mesmos nomes. A régua das três
 *  maneiras de falar do vencimento (`expira` / `expirou` / `vence`) está em `variaveisMensagem`. */
export function variaveis(cliente: Cliente | null, conf: Conf, telefone: string): Record<string, string> {
  return variaveisMensagem(conf, {
    nome: cliente?.nota || "",
    usuario: cliente?.usuario || "",
    telefone: cliente?.telefone || telefone,
    status: cliente ? cliente.status : null,
    expira: cliente?.expira ?? null,
  });
}

/** {{nome}} vira o dado do cliente. O que a gente não conhece fica escrito do mesmo jeito,
 *  para ele ver na tela que a variável está errada em vez de sair uma mensagem muda. */
export function renderizar(modelo: string, v: Record<string, string>): string {
  return String(modelo || "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (tudo, chave: string) => {
    const valor = v[String(chave).toLowerCase()];
    return valor === undefined ? tudo : valor;
  });
}

function normalizar(bruto: string): string {
  return semAcento(bruto).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function gatilhosDe(regra: Regra): string[] {
  return regra.gatilho
    .split(/[,;|\n]+/)
    .map((g) => normalizar(g))
    .filter((g) => g.length >= 2);
}

/** A primeira que casar, na ordem da prioridade. Igualdade vale mais que "contém", por isso
 *  uma regra curta não atropela a resposta exata que ele escreveu para a palavra sozinha. */
export function casar(entrada: string, regras: Regra[]): Regra | null {
  const texto = normalizar(entrada);
  if (!texto) return null;
  for (const regra of regras.filter((r) => r.ativo)) {
    const gatilhos = gatilhosDe(regra);
    if (gatilhos.some((g) => texto === g)) return regra;
  }
  for (const regra of regras.filter((r) => r.ativo)) {
    const gatilhos = gatilhosDe(regra);
    if (gatilhos.some((g) => g.length >= 3 && texto.includes(g))) return regra;
  }
  return null;
}

// ------------------------------------------------------------------------- o webhook

function caminho(objeto: unknown, ...chaves: string[]): unknown {
  let atual = objeto;
  for (const chave of chaves) {
    if (!atual || typeof atual !== "object") return undefined;
    atual = (atual as Bruto)[chave];
  }
  return atual;
}

function primeira(opcoes: unknown[]): string {
  for (const valor of opcoes) {
    if (typeof valor === "string" && valor.trim()) return valor.trim();
    if (typeof valor === "number") return String(valor);
  }
  return "";
}

/** O tipo do evento, escrito em qualquer um dos dois lugares que o GreenAPI já usou. */
function tipos(bruto: Bruto, corpo: unknown): string {
  return [semAcento(primeira([caminho(corpo, "type")])), semAcento(primeira([bruto.type, bruto.event]))].join(" ").trim();
}

/** O GreenAPI entrega de tudo nesta URL, e o corpo muda de versão para versão: cada campo é
 *  procurado em vários lugares. Mudança de estado, QR code, notificação e comando assíncrono
 *  são recusados de propósito — responder a isso é o que entope a fila de quem recebe webhook.
 *
 *  O telefone vem SEMPRE do chatId: no corpo da GreenAPI o `senderDeviceId` de fora é o
 *  aparelho da nossa própria instância, e responder a ele é o robô conversar sozinho. */
const NAO_E_CONVERSA = ["status", "statechange", "notification", "qrcode", "call", "command", "ack"];

export function interpretar(bruto: Bruto): { mensagem?: Mensagem; motivo?: string } {
  const corpo = (bruto.message || bruto.body || bruto.data || bruto) as Bruto;
  const tipo = tipos(bruto, corpo);
  if (NAO_E_CONVERSA.some((t) => tipo.includes(t))) return { motivo: `tipo:${tipo.trim() || "vazio"}` };
  const texto = primeira([
    typeof corpo === "string" ? corpo : "",
    caminho(corpo, "content", "text"),
    caminho(corpo, "content", "caption"),
    caminho(corpo, "data", "textMessage", "text"),
    caminho(corpo, "textMessage", "text"),
    caminho(corpo, "_data", "textMessage", "text"),
    caminho(corpo, "data", "buttonMessageReplyMessage", "text"),
    caminho(corpo, "data", "templateButtonReplyMessage", "text"),
    caminho(corpo, "data", "listMessageReplyMessage", "description"),
    caminho(corpo, "body"),
    caminho(corpo, "captionText"),
    corpo.caption,
    bruto.text,
  ]);
  if (!texto) return { motivo: "sem texto" };
  const chatId = primeira([
    caminho(corpo, "chatId"),
    caminho(corpo, "messageId", "chat_id"),
    bruto.chatId,
    caminho(corpo, "data", "chatId"),
    caminho(corpo, "_data", "chatId"),
  ]);
  const de = primeira([
    chatId,
    caminho(corpo, "senderDeviceId"),
    caminho(corpo, "data", "sender"),
    bruto.senderPhone,
    caminho(corpo, "messageId", "device_id"),
  ]);
  const minha = [
    bruto.isFromMe,
    caminho(corpo, "messageId", "fromMe"),
    caminho(corpo, "isFromMe"),
    caminho(corpo, "data", "isFromMe"),
  ].some((v) => v === true);
  const chave = primeira([
    caminho(corpo, "messageId", "id"),
    caminho(corpo, "data", "id"),
    caminho(corpo, "_data", "id"),
    bruto.idMessage,
    corpo.id,
    bruto.messageId,
  ]);
  return {
    mensagem: {
      chave,
      telefone: normalizarWhatsapp(de),
      texto,
      grupo: chatId.includes("@g.us"),
      minha,
      tipo,
    },
  };
}

async function gravarMensagem(
  m: Mensagem,
  usuario: string,
  direcao: string,
  texto: string,
  regraId: number | null,
  dias: number,
): Promise<boolean> {
  const expira = new Date(Date.now() + Math.max(1, dias) * 86_400_000).toISOString();
  const r = await consultar(
    `insert into public.chat_mensagens (chave, telefone, usuario, direcao, texto, regra_id, expira_em)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (chave) do nothing`,
    [m.chave || null, m.telefone, usuario || null, direcao, texto, regraId, expira],
  );
  return (r.rowCount || 0) > 0;
}

async function gravarTreino(
  entrada: string,
  resposta: string | null,
  telefone: string,
  cliente: Cliente | null,
  regraId: number | null,
): Promise<void> {
  await consultar(
    `insert into public.chat_treino (entrada, resposta, telefone, usuario, regra_id, cadastrado)
     values ($1, $2, $3, $4, $5, $6)`,
    [entrada, resposta, telefone, cliente?.usuario || null, regraId, Boolean(cliente)],
  );
}

/** O "chegou ou não chegou". É o que o 200 do GreenAPI não diz: ele responde o id da mensagem
 *  antes do WhatsApp confirmar qualquer entrega. Sem este webhook o painel só sabe que pediu. */
export type StatusEntrega = {
  idMessage: string;
  telefone: string;
  status: string;
  detalhe: string;
};

export function interpretarStatus(bruto: Bruto): StatusEntrega | null {
  const corpo = (bruto.payload || bruto.body || bruto.data || bruto) as Bruto;
  const idMessage = primeira([
    caminho(corpo, "messageId", "id"),
    caminho(bruto.message, "messageId", "id"),
    caminho(corpo, "idMessage"),
    caminho(corpo, "data", "idMessage"),
  ]);
  const status = primeira([
    caminho(corpo, "status"),
    caminho(corpo, "state"),
    caminho(corpo, "data", "status"),
  ]).toUpperCase();
  // Os dois juntos são a assinatura do evento de entrega: mensagem recebida não traz status.
  if (!idMessage || !status) return null;
  const chatId = primeira([
    caminho(corpo, "chatId"),
    caminho(corpo, "messageId", "chat_id"),
    caminho(corpo, "recipient"),
    caminho(bruto.message, "messageId", "chat_id"),
  ]);
  return {
    idMessage,
    telefone: normalizarWhatsapp(chatId),
    status,
    detalhe: primeira([corpo.description, corpo.error, corpo.message]).slice(0, 200),
  };
}

async function registrarStatus(s: StatusEntrega): Promise<boolean> {
  const r = await consultar(
    `insert into public.whatsapp_status (id_message, telefone, status, detalhe)
     values ($1, $2, $3, $4)
     on conflict (id_message) do update
       set status = excluded.status, detalhe = excluded.detalhe, atualizado_em = now()
       where public.whatsapp_status.status <> excluded.status`,
    [s.idMessage, s.telefone, s.status, s.detalhe],
  );
  return (r.rowCount || 0) > 0;
}

/** O estado de entrega da última mensagem que o painel mandou para cada um desses clientes.
 *  É o que a fila do Não recuperados mostra no lugar de confiar no "enviado" de verdade. */
export async function entregasPorUsuario(usuarios: string[]): Promise<Record<string, string>> {
  const nomes = usuarios.map((u) => String(u || "").trim()).filter(Boolean);
  if (!nomes.length) return {};
  const r = await consultar(
    `select distinct on (a.username) a.username, coalesce(s.status, '') as status, s.detalhe
       from public.renovacao_avisos a
       join public.whatsapp_status s on s.id_message = a.id_message
      where a.username = any($1::text[])
      order by a.username, a.updated_at desc`,
    [nomes],
  );
  const saida: Record<string, string> = {};
  for (const l of r.rows) {
    const status = String(l.status || "");
    saida[String(l.username || "")] = status ? `${status}${l.detalhe ? ` (${String(l.detalhe).slice(0, 60)})` : ""}` : "";
  }
  return saida;
}

/** O que o GreenAPI manda a cada mensagem recebida. Responde sempre 200 rápido: erro aqui é
 *  retrabalho na fila dele, e pilha de webhook repetindo resposta para o mesmo cliente. */
export async function receberWebhook(
  bruto: Bruto,
  chave: string,
): Promise<{ status: number; dados: Bruto }> {
  const esperado = await tokenChat();
  if (!igual(String(chave || ""), esperado)) return { status: 401, dados: { ok: false, error: "token invalido" } };

  const status = interpretarStatus(bruto);
  if (status) {
    const guardado = await registrarStatus(status);
    return { status: 200, dados: { ok: true, entrega: status.status, novo: guardado } };
  }

  const lida = interpretar(bruto);
  if (!lida.mensagem) return { status: 200, dados: { ok: true, ignorado: lida.motivo || "sem texto" } };
  const m = lida.mensagem;
  if (m.minha) return { status: 200, dados: { ok: true, ignorado: "envio nosso" } };
  if (m.grupo) return { status: 200, dados: { ok: true, ignorado: "grupo" } };
  if (m.telefone.length < 10) return { status: 200, dados: { ok: true, ignorado: "telefone curto" } };

  const conf = await obterConfig();
  const dias = Number(conf?.chat_dias ?? DIAS_PADRAO);
  const cliente = await clientePorTelefone(m.telefone);
  if (!(await gravarMensagem(m, cliente?.usuario || "", "entrada", m.texto, null, dias))) {
    return { status: 200, dados: { ok: true, duplicado: true } };
  }
  await consultar(`delete from public.chat_mensagens where expira_em < now()`);

  if (!conf) return { status: 200, dados: { ok: true, ignorado: "sem banco" } };
  if (!conf.chat_ativo) {
    return { status: 200, dados: { ok: true, ignorado: "robô desligado", cadastrado: Boolean(cliente) } };
  }
  if (!conf.api_url || !conf.id_instance || !conf.api_token) {
    return { status: 200, dados: { ok: false, error: "sem configuracao", cadastrado: Boolean(cliente) } };
  }

  const regra = casar(m.texto, await listarRegras());
  if (!regra || !regra.resposta.trim()) {
    await gravarTreino(m.texto, null, m.telefone, cliente, regra?.id ?? null);
    return {
      status: 200,
      dados: { ok: true, sem_regra: true, cadastrado: Boolean(cliente), telefone: m.telefone },
    };
  }
  if (!cliente && !conf.chat_desconhecido) {
    await gravarTreino(m.texto, null, m.telefone, cliente, regra.id);
    return { status: 200, dados: { ok: true, ignorado: "telefone sem cadastro", regra: regra.id } };
  }

  const resposta = renderizar(regra.resposta, variaveis(cliente, conf, m.telefone));
  const envio = await enviarTexto(conf, m.telefone, resposta);
  if (envio.ok) {
    const idRecebido = primeira([caminho(envio.response, "messageId", "id"), caminho(envio.response, "idMessage")]);
    await gravarMensagem(
      { ...m, chave: idRecebido ? `saida-${idRecebido}` : "" },
      cliente?.usuario || "", "saida", resposta, regra.id, dias,
    );
    await consultar(`update public.chat_regras set contagem = contagem + 1 where id = $1`, [regra.id]);
    await gravarTreino(m.texto, resposta, m.telefone, cliente, regra.id);
  }
  return {
    status: 200,
    dados: {
      ok: Boolean(envio.ok),
      respondido: Boolean(envio.ok),
      regra: regra.id,
      simulado: Boolean(envio.simulado),
      error: envio.ok ? undefined : String(envio.error || `status ${envio.status_code || "?"}`),
    },
  };
}
