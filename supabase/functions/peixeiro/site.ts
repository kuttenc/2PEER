// O que o clone do site (2PEER/Chatbot) chama quando o cliente aperta "Gerar acesso 4 horas".
// É a mesma régua de sempre — reusa o acesso ativo do IP, respeita a lista de IPs liberados e
// no máximo 1 geração por dia e 2 por semana por IP — mas sem Flask e sem Render.
import { obterConfig, registrarUsuarioCriado, type Conf } from "./banco.ts";
import { consultar, consultar1 } from "./db.ts";
import { criarLinhaTeste, mascararResposta, tokenDoPainel, gravarEvento, type TokenInfo } from "./mcapi.ts";
import { enviarFotoGeracao } from "./greenapi.ts";
import { formatarBrasiliaSegundos, parseExpDate } from "./texto.ts";
import type { Contexto, Registro, Saida } from "./acoes.ts";

export const MSG_TELEFONE = "Para liberar seu teste, informe um WhatsApp valido.";
export const MSG_LIMITE = "Seu teste ja foi gerado recentemente. Assim que liberar novamente, voce consegue gerar de novo.";
export const MSG_FALHA = "Nao conseguimos liberar agora. Tente novamente em instantes ou fale com nosso time no WhatsApp.";
export const MSG_ATIVO = "Seu teste atual ainda esta ativo. Reapresentamos o mesmo acesso para voce continuar.";
export const MSG_LIBERADO = "Teste liberado com sucesso. Agora e so configurar e aproveitar.";

function digitos(bruto: string): string {
  return String(bruto || "").replace(/\D/g, "");
}

/** O telefone que vai na nota do MC é mascarado, do jeitinho que o site sempre mandou:
 *  `cap:119xxxx-6164 | tg:xxxx1234`. Nenhum número completo entra no painel do revendedor. */
export function notaDoLead(telefone: string, telegramId = ""): string {
  const d = digitos(telefone);
  let mascara = "xx9xxxx-xxxx";
  if (d.length >= 4) {
    const base = d.length >= 11 ? d.slice(-11) : d;
    const ddd = base.length >= 2 ? base.slice(0, 2) : "xx";
    const primeiro = base.length >= 3 ? base[2] : "9";
    mascara = `${ddd}${primeiro}xxxx-${base.slice(-4)}`;
  }
  const tg = digitos(telegramId);
  return tg ? `cap:${mascara} | tg:xxxx${tg.slice(-4).padStart(4, "x")}` : `cap:${mascara}`;
}

/** O MC só entrega o IP real quando vem pelo Supabase; se um dia a header sumir, o navegador
 *  traz uma chave do aparelho (uuid no localStorage) para a régua não virar um bucket único. */
export function chaveDoIp(ip: string, dispositivo: string): string {
  const bruto = String(ip || "").trim();
  if (bruto && bruto !== "0.0.0.0") return bruto;
  const dev = String(dispositivo || "").trim().replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  return dev ? `dev:${dev}` : bruto || "0.0.0.0";
}

type Acesso = { usuario: string; senha: string; expira: string; exp_iso: string };

/** A tabela do reuso vive no banco da cópia, criada por aqui na primeira chamada: um registro
 *  por chave de IP, sobrescrito a cada geração. É o único lugar onde a senha do teste fica,
 *  e deixa de existir quando a linha vence (o reuso só lê enquanto `exp_date > now()`). */
export async function esquema(): Promise<void> {
  await consultar(
    `create table if not exists public.site_acessos (
       client_ip text primary key,
       username text not null default '',
       senha text not null default '',
       exp_date timestamptz,
       telefone text not null default '',
       atualizado_em timestamptz not null default now()
     )`,
  );
}

async function gravarAcessoSite(ip: string, cred: Acesso, telefone: string): Promise<void> {
  await consultar(
    `insert into public.site_acessos (client_ip, username, senha, exp_date, telefone, atualizado_em)
     values ($1,$2,$3,$4,$5, now())
     on conflict (client_ip) do update
       set username = excluded.username, senha = excluded.senha, exp_date = excluded.exp_date,
           telefone = excluded.telefone, atualizado_em = now()`,
    [ip, cred.usuario, cred.senha, cred.exp_iso || null, telefone],
  );
}

/** "Ainda tenho um teste aberto?" — no site isso saía da última resposta de `line_test` gravada
 *  em `mcapi_events`; aqui a senha não vai para o log de eventos, então o reuso lê `site_acessos`. */
async function acessoAtivoDoIp(ip: string): Promise<Acesso | null> {
  const guardado = await consultar1(
    `select username, senha, telefone, to_char(exp_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as exp_iso,
            to_char(exp_date at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS') as expira
       from public.site_acessos
      where client_ip = $1 and exp_date > now()
      limit 1`,
    [ip],
  );
  if (!guardado || !String(guardado.username || "")) return null;
  return {
    usuario: String(guardado.username),
    senha: String(guardado.senha || ""),
    expira: String(guardado.expira || ""),
    exp_iso: String(guardado.exp_iso || ""),
  };
}

/** 1 geração por dia e 2 por semana, com o dia e a semana contados em Brasília (dia começa à
 *  meia-noite daqui, semana começa segunda), exatamente como o site calcula. */
export async function limitesDoIp(ip: string): Promise<{ permitido: boolean; liberado: boolean; dia: number; semana: number }> {
  const contagem = await consultar1(
    `select
       count(*) filter (where created_at >= (date_trunc('day',   now() at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo') as dia,
       count(*) filter (where created_at >= (date_trunc('week',  now() at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo') as semana
     from public.mcapi_events
     where event_type = 'line_test' and status_code < 400 and client_ip = $1`,
    [ip],
  );
  const liberado = Boolean(await consultar1(
    `select 1 from public.ip_liberados where ip = $1 and ativo = true limit 1`,
    [ip],
  ));
  const dia = Number(contagem?.dia || 0);
  const semana = Number(contagem?.semana || 0);
  return { permitido: liberado || (dia < 1 && semana < 2), liberado, dia, semana };
}

function saida(titulo: string, texto: string, cred?: Acesso, ip = "", status = 200): Saida {
  return {
    status,
    dados: {
      ...(cred ? { ok: true, titulo, texto, cred } : { ok: false, titulo, texto }),
      // O IP que a régua usou: sem isto, nenhuma prova de "é por IP" dá para ser lida na tela.
      ip,
    },
  };
}

/** O POST do clone. Anônimo de propósito: quem aperta o botão é o cliente, sem sessão do painel. */
export async function gerarAcesso(dados: Registro, ctx: Contexto): Promise<Saida> {
  const telefone = digitos(String(dados.telefone || ""));
  const telegramId = String(dados.telegram_id || "").trim();
  const ip = chaveDoIp(ctx.ip, String(dados.dispositivo || ""));
  await esquema();
  if (telefone.length < 10) return saida("Nao liberado agora", MSG_TELEFONE, undefined, ip);

  const ativo = await acessoAtivoDoIp(ip);
  if (ativo) {
    await registrarUsuarioCriado(ip, ativo.usuario, telefone, telegramId);
    await gravarEvento({
      event_type: "line_test_reuse",
      status_code: 200,
      request_payload: { reason: "active_access_reused" },
      response_payload: { username: ativo.usuario, expira: ativo.expira },
      client_ip: ip,
    });
    return saida("Acesso pronto", MSG_ATIVO, ativo, ip);
  }

  const limite = await limitesDoIp(ip);
  if (!limite.permitido) {
    return saida("Nao liberado agora", MSG_LIMITE, undefined, ip, 429);
  }

  const info: TokenInfo = await tokenDoPainel(ip);
  if (!info.ok) {
    await gravarEvento({
      event_type: "site_login",
      status_code: info.login_status ?? 0,
      response_payload: { erro: info.erro || "login no painel mc falhou" },
      error_message: "site: login no painel mc falhou",
      client_ip: ip,
    });
    return saida("Nao liberado agora", MSG_FALHA, undefined, ip);
  }

  const nota = notaDoLead(telefone, telegramId);
  let chamada = await criarLinhaTeste(info.token || "", nota);
  if (chamada.status === 401 || chamada.status === 403) {
    await gravarEvento({
      event_type: "line_test_token_expired",
      status_code: chamada.status,
      request_payload: chamada.pedido,
      response_payload: mascararResposta(chamada.corpo),
      error_message: "token expirado/invalido - tentando refresh",
      client_ip: ip,
    });
    const novo = await tokenDoPainel(ip, true);
    if (novo.ok) chamada = await criarLinhaTeste(novo.token || "", nota);
  }

  const deuCert = chamada.status < 400;
  await gravarEvento({
    event_type: "line_test",
    status_code: chamada.status,
    request_payload: chamada.pedido,
    // A senha do teste não vai para o log: `mcapi_events` é texto puro e a régua de reuso lê
    // a linha direto do painel MC.
    response_payload: mascararResposta(chamada.corpo),
    error_message: deuCert ? null : "line test failed",
    client_ip: ip,
  });

  if (!deuCert) return saida("Nao liberado agora", MSG_FALHA, undefined, ip);

  const expira = parseExpDate(String(chamada.corpo.exp_date || ""));
  // A resposta do /lines/test traz tudo no nível de cima (username, password, id, exp_date);
  // `line` só aparece em outras chamadas, então serve de sobressalente.
  const linha = (chamada.corpo.line || {}) as Record<string, unknown>;
  const cred: Acesso = {
    usuario: String(chamada.corpo.username || linha.username || ""),
    senha: String(chamada.corpo.password || linha.password || ""),
    expira: expira ? formatarBrasiliaSegundos(expira) : "",
    exp_iso: expira ? expira.toISOString() : "",
  };

  await registrarUsuarioCriado(ip, cred.usuario, telefone, telegramId);
  // A linha de teste NÃO aparece no GET /lines do painel (14 linhas, a nova fora — visto em
  // 16/11), então o reuso por IP só tem como sair desta tabela: ela é a única cópia do que o
  // MC respondeu. Um registro por IP, sempre sobrescrito.
  await gravarAcessoSite(ip, cred, telefone);

  const conf: Conf | null = await obterConfig();
  if (conf && conf.send_photo) {
    try {
      const foto = await enviarFotoGeracao(conf, telefone);
      await gravarEvento({
        event_type: "greenapi_send_photo",
        status_code: foto.status_code ?? 0,
        request_payload: { origem: "site_clone" },
        response_payload: foto.response || { error: foto.error || "" },
        error_message: foto.ok ? null : "greenapi send failed",
        client_ip: ip,
      });
    } catch (exc) {
      await gravarEvento({
        event_type: "greenapi_send_photo",
        status_code: 0,
        error_message: String(exc).slice(0, 200),
        client_ip: ip,
      });
    }
  }

  return saida("Acesso pronto", MSG_LIBERADO, cred);
}
