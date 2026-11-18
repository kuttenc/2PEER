// A varredura das 6h (vencendo + já vencidos) sem Render: é o mesmo corpo do
// avisar_vencimentos()/avisar_renovacao() do site, só que lendo e gravando pelo db.ts.
import { gerarImagemAviso } from "./aviso.ts";
import { telefonesBloqueados } from "./bloqueados.ts";
import { obterConfig, sincronizarLinhas, telefonesPorUsuario, dadosDoCliente, type Conf } from "./banco.ts";
import { consultar } from "./db.ts";
import { coletarLinhasVencendo, coletarLinhasVencidas, gravarEvento, tokenDoPainel } from "./mcapi.ts";
import { cotaEsgotada, enviarArquivo, enviarTexto, type ResultadoEnvio } from "./greenapi.ts";
import {
  legendaAviso,
  legendaRenovacao,
  normalizarWhatsapp,
  parseExpDate,
  type ClienteMensagem,
} from "./texto.ts";

/** A ficha que as mensagens da agenda usam: o número é o da agenda (é para lá que se manda) e a
 *  data é a que o painel MC acabou de calcular, não a do espelho (que pode estar velha). */
export async function fichaPara(
  username: string,
  expDate: string,
  telefone: string,
): Promise<ClienteMensagem> {
  const ficha = await dadosDoCliente(username);
  return {
    ...ficha,
    telefone: telefone || ficha.telefone,
    expira: parseExpDate(expDate) || ficha.expira || null,
  };
}

export type ResultadoVarredura = Record<string, unknown>;

/** Guarda o "já avisei" e diz se esta chamada foi a primeira (reivindicação). */
async function reivindicarVencimento(username: string, expDate: string, telefone: string, horas: number) {
  const r = await consultar(
    `insert into public.vencimento_avisos (username, exp_date, telefone, horas_restantes)
     values ($1,$2,$3,$4)
     on conflict (username, exp_date) do nothing`,
    [username, expDate, telefone, Math.round(horas * 100) / 100],
  );
  return (r.rowCount || 0) > 0;
}

async function finalizarVencimento(username: string, expDate: string, resultado: ResultadoEnvio) {
  const corpo = resultado.response || {};
  if (resultado.ok) {
    await consultar(
      `update public.vencimento_avisos set status_code = $1, id_message = $2, response = $3::jsonb
        where username = $4 and exp_date = $5`,
      [resultado.status_code ?? null, String(corpo.idMessage || ""), JSON.stringify(corpo), username, expDate],
    );
    return;
  }
  await consultar("delete from public.vencimento_avisos where username = $1 and exp_date = $2", [username, expDate]);
}

export async function avisarVencimentos(clientIp: string, forcar = false): Promise<ResultadoVarredura> {
  const conf = await obterConfig();
  if (!conf) return { ok: false, error: "greenapi_config sem linha 1" };
  if (!conf.aviso_ativo) return { ok: true, ativo: false, enviados: 0, avaliados: 0 };

  const limiteDias = Number(conf.aviso_dias || 2);
  const info = await tokenDoPainel(clientIp);
  if (!info.ok) return { ok: false, error: "login no painel mc falhou", login_status: info.login_status };

  const coleta = await coletarLinhasVencendo(info.token || "", limiteDias * 24);
  const telefones = await telefonesPorUsuario();
  const bloqueados = await telefonesBloqueados();
  const falhas: { username: string; erro: unknown }[] = [];
  let enviados = 0, semTelefone = 0, foraDaBase = 0, cota = false;

  for (const linha of coleta.itens) {
    const telefone = telefones[linha.username] || "";
    if (!linha.username || !telefone) {
      semTelefone++;
      continue;
    }
    if (bloqueados.has(normalizarWhatsapp(telefone))) {
      foraDaBase++;
      continue;
    }
    const primeira = await reivindicarVencimento(linha.username, linha.exp_date, telefone, linha.horas);
    if (!primeira && !forcar) continue;

    const imagem = await gerarImagemAviso(conf, linha.texto_dias);
    const cliente = await fichaPara(linha.username, linha.exp_date, telefone);
    const resultado = await enviarArquivo(conf, telefone, imagem, "aviso-vencimento.png",
      legendaAviso(conf, linha.texto_dias, cliente));
    await finalizarVencimento(linha.username, linha.exp_date, resultado);
    if (resultado.ok) enviados++;
    else falhas.push({ username: linha.username, erro: resultado.error || resultado.response });

    await gravarEvento({
      event_type: "aviso_vencimento",
      status_code: resultado.status_code ?? null,
      request_payload: { username: linha.username, expira: linha.expira_brasilia, dias: linha.texto_dias },
      response_payload: resultado.response || { error: resultado.error || "" },
      error_message: resultado.ok ? null : "aviso de vencimento falhou",
      client_ip: clientIp,
    });

    if (!resultado.ok && cotaEsgotada(resultado)) {
      cota = true;
      break;
    }
  }

  return {
    ok: true,
    ativo: true,
    cota,
    limite_dias: limiteDias,
    avaliados: coleta.itens.length,
    enviados,
    sem_telefone: semTelefone,
    bloqueados: foraDaBase,
    falhas: falhas.slice(0, 10),
    lines_status: coleta.status,
  };
}

/** Na renovação quem já foi avisado há menos do intervalo fica de fora (esperando). */
async function reivindicarRenovacao(
  username: string,
  expDate: string,
  telefone: string,
  diasVencido: number,
  corte: Date,
  forcar: boolean,
) {
  const valores = [username, expDate, telefone, diasVencido];
  const clausula = forcar ? "" : "where renovacao_avisos.updated_at < $5";
  const r = await consultar(
    `insert into public.renovacao_avisos (username, exp_date, telefone, dias_vencido, via, updated_at)
     values ($1,$2,$3,$4,'agenda', now())
     on conflict (username, exp_date) do update
       set telefone = excluded.telefone,
           dias_vencido = excluded.dias_vencido,
           via = excluded.via,
           updated_at = now()
     ${clausula}
     returning username`,
    forcar ? valores : [...valores, corte],
  );
  return r.rows.length > 0;
}

async function finalizarRenovacao(username: string, expDate: string, resultado: ResultadoEnvio) {
  const corpo = resultado.response || {};
  if (resultado.ok) {
    await consultar(
      `update public.renovacao_avisos set status_code = $1, id_message = $2, response = $3::jsonb
        where username = $4 and exp_date = $5`,
      [resultado.status_code ?? null, String(corpo.idMessage || ""), JSON.stringify(corpo), username, expDate],
    );
    return;
  }
  await consultar("delete from public.renovacao_avisos where username = $1 and exp_date = $2", [username, expDate]);
}

export async function avisarRenovacao(clientIp: string, forcar = false): Promise<ResultadoVarredura> {
  const conf = await obterConfig();
  if (!conf) return { ok: false, error: "greenapi_config sem linha 1" };
  if (!conf.renova_ativo) return { ok: true, ativo: false, enviados: 0, avaliados: 0 };

  const intervalo = Number(conf.renova_dias || 3);
  const janela = Number(conf.renova_janela_dias || 30);
  const info = await tokenDoPainel(clientIp);
  if (!info.ok) return { ok: false, error: "login no painel mc falhou", login_status: info.login_status };

  const coleta = await coletarLinhasVencidas(info.token || "", janela);
  const telefones = await telefonesPorUsuario();
  const bloqueados = await telefonesBloqueados();
  const corte = new Date(Date.now() - intervalo * 86_400_000);
  const falhas: { username: string; erro: unknown }[] = [];
  let enviados = 0, semTelefone = 0, esperando = 0, foraDaBase = 0, cota = false;

  for (const linha of coleta.itens) {
    const telefone = telefones[linha.username] || "";
    if (!linha.username || !telefone) {
      semTelefone++;
      continue;
    }
    if (bloqueados.has(normalizarWhatsapp(telefone))) {
      foraDaBase++;
      continue;
    }
    const diasVencido = Math.round((Math.abs(linha.horas) / 24) * 10) / 10;
    if (!(await reivindicarRenovacao(linha.username, linha.exp_date, telefone, diasVencido, corte, forcar))) {
      esperando++;
      continue;
    }

    const resultado = await enviarTexto(conf, telefone,
      legendaRenovacao(conf, linha.texto_dias, await fichaPara(linha.username, linha.exp_date, telefone)));
    await finalizarRenovacao(linha.username, linha.exp_date, resultado);
    if (resultado.ok) enviados++;
    else falhas.push({ username: linha.username, erro: resultado.error || resultado.response });

    await gravarEvento({
      event_type: "aviso_renovacao",
      status_code: resultado.status_code ?? null,
      request_payload: { username: linha.username, venceu: linha.expira_brasilia, dias: linha.texto_dias },
      response_payload: resultado.response || { error: resultado.error || "" },
      error_message: resultado.ok ? null : "aviso de renovacao falhou",
      client_ip: clientIp,
    });

    if (!resultado.ok && cotaEsgotada(resultado)) {
      cota = true;
      break;
    }
  }

  return {
    ok: true,
    ativo: true,
    cota,
    intervalo_dias: intervalo,
    janela_dias: janela,
    avaliados: coleta.itens.length,
    enviados,
    sem_telefone: semTelefone,
    esperando,
    bloqueados: foraDaBase,
    falhas: falhas.slice(0, 10),
    lines_status: coleta.status,
  };
}

/** A chamada do cron: o token é o aviso_token do banco, não a sessão do painel. */
export async function avisoCron(token: string, forcar: boolean, clientIp: string): Promise<ResultadoVarredura> {
  const conf = await obterConfig();
  const esperado = String((conf as Conf | null)?.aviso_token || "").trim();
  if (!esperado) return { ok: false, error: "aviso_token vazio no greenapi_config", status: 503 };
  if (token !== esperado) return { ok: false, error: "token invalido", status: 401 };
  return { status: 200, ...(await varrerAgenda(forcar, clientIp)) };
}

/** Vencimentos + espelho + renovação, na mesma ordem do executar_aviso_vencimentos(). */
export async function varrerAgenda(
  forcar: boolean,
  clientIp: string,
): Promise<ResultadoVarredura> {
  const vencimentos = await avisarVencimentos(clientIp, forcar);
  const espelho = await sincronizarLinhas(clientIp);
  const renovacao = await avisarRenovacao(clientIp, forcar);
  return {
    ...vencimentos,
    espelho,
    renovacao,
    ok: Boolean(vencimentos.ok) && Boolean(renovacao.ok),
    status: Boolean(vencimentos.ok) && Boolean(renovacao.ok) ? 200 : 500,
  };
}
