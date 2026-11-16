// As ações do painel sem Render: é rota por rota do painel_web.py, mas devolvendo JSON
// para o Pages. As frases em português ficam no front; daqui só saem os códigos.
import {
  chaveAvisadas,
  espelharLinhas,
  listarEspelho,
  mesclarTelefones,
  obterConfig,
  registrarAviso,
  registrarRenovacao,
  registrarUsuarioCriado,
  resumoConfig,
  salvarConfig,
  salvarTelefone,
  sincronizarLinhas,
  telefonesPorUsuario,
  trocarSenha,
  type Conf,
} from "./banco.ts";
import { consultar, consultar1 } from "./db.ts";
import {
  apagarLinha,
  coletarLinhasVencendo,
  gravarEvento,
  linhaPorId,
  listarLinhas,
  modoTeste,
  tokenDoPainel,
  traduzirLinha,
  varrerMc,
} from "./mcapi.ts";
import {
  cotaEsgotada,
  enviarArquivo,
  enviarRecuperacao,
  estadoInstancia,
  falhaGreenApi,
  infosInstancia,
  type ResultadoEnvio,
} from "./greenapi.ts";
import { gerarImagemAviso, previaAvisoEmB64 } from "./aviso.ts";
import {
  autenticado as encurtadorLogado,
  baseEncurtador,
  encurtar,
  linkRecuperacao,
  resolver,
} from "./encurtador.ts";
import {
  DIAS_SESSAO,
  conferida,
  esquecerHash,
  hashCacheado,
  muitasTentativas,
  novoToken,
  registrarTentativa,
  zerarTentativas,
} from "./sessao.ts";
import {
  gravarPlano,
  iniciarLote,
  pararLote,
  proximoItem,
  registrarItem,
  resumoLote,
  verLote,
  type Item,
  type TipoLote,
} from "./lote.ts";
import { avisarRenovacao, avisarVencimentos } from "./varredura.ts";
import { escreverCsv, lerCsv } from "./csv.ts";
import {
  b64ParaBytes,
  bytesParaB64,
  formatarBrasilia,
  formatarTelefone,
  legendaAviso,
  legendaRecuperar,
  parseExpDate,
  semAcento,
  textoDiasRestantes,
  textoVencido,
} from "./texto.ts";

export type Registro = Record<string, unknown>;
export type Contexto = { ip: string };
export type Saida = { status: number; dados: Registro };
export type Handler = (dados: Registro, ctx: Contexto) => Saida | Promise<Saida>;

const QR_BASE = "https://qr.green-api.com/waInstance";
const LIMITE_FOTO = 1_500_000;
const CAMPOS_TEXTO = [
  "api_url", "media_url", "id_instance", "api_token", "instance_name", "owner_phone", "caption",
  "aviso_pix_key", "aviso_pix_mascara", "aviso_titulo", "aviso_rodape", "aviso_legenda", "aviso_token",
  "renova_legenda", "recupera_legenda",
];
const CAMPOS_BOOL = ["send_photo", "aviso_ativo", "renova_ativo"];
const CAMPOS_NUMERICO = ["aviso_dias", "renova_dias", "renova_janela_dias"];
const OBRIGATORIOS = ["api_url", "media_url", "id_instance", "api_token"];
const TRAVADOS = ["id_instance", "api_token"];
const PARADA_ERROS = 3;
const PALAVRA_APAGAR = "deletar";
const APAGAR_MAX = 300;

function ok(dados: Registro = {}): Saida {
  return { status: 200, dados: { ok: true, ...dados } };
}

function falha(erro: string, status = 400, dados: Registro = {}): Saida {
  return { status, dados: { ok: false, erro, ...dados } };
}

function txt(valor: unknown): string {
  return String(valor ?? "").trim();
}

function lista(valor: unknown): string[] {
  if (Array.isArray(valor)) return valor.map((v) => String(v ?? "").trim()).filter(Boolean);
  const bruto = txt(valor);
  return bruto ? bruto.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

function booleano(valor: unknown): boolean {
  if (typeof valor === "boolean") return valor;
  return ["1", "true", "on", "sim"].includes(txt(valor).toLowerCase());
}

function tipoLote(valor: unknown): TipoLote {
  return txt(valor) === "apagar" ? "apagar" : "recuperar";
}

// ------------------------------------------------------------------ entrar / sair / senha

export async function entrar(dados: Registro, ctx: Contexto): Promise<Saida> {
  if (await muitasTentativas(ctx.ip)) return falha("muitas", 429);
  const armazenado = await hashCacheado();
  if (armazenado && (await conferida(txt(dados.senha), armazenado))) {
    await zerarTentativas(ctx.ip);
    return ok({ token: await novoToken(armazenado), dias: DIAS_SESSAO });
  }
  await registrarTentativa(ctx.ip);
  return falha("senha", 401);
}

export function sair(): Saida {
  return ok();
}

export async function senhaTrocar(dados: Registro): Promise<Saida> {
  const resultado = await trocarSenha(txt(dados.atual), txt(dados.nova));
  if (!resultado.ok) return falha(resultado.erro === "curta" ? "senha_curta" : "senha_atual");
  // A cache de 60 s recusaria o login com a senha que acabou de entrar.
  esquecerHash();
  return ok();
}

// ------------------------------------------------------------------ início

function qrLink(conf: Conf): string {
  const inst = txt(conf.id_instance), token = txt(conf.api_token);
  if (inst && token) return `${QR_BASE}${inst}/${token}`;
  return txt(conf.qr_url);
}

export async function inicio(dados: Registro): Promise<Saida> {
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  return ok({
    conf: resumoConfig(conf),
    estado: await estadoInstancia(conf, booleano(dados.estado)),
    infos: await infosInstancia(conf),
    qr_link: qrLink(conf),
    tem_foto: Boolean(conf.photo_base64),
    foto_kb: Math.round((conf.photo_base64 || "").length / 1024),
    total_telefones: Object.keys(await telefonesPorUsuario()).length,
    total_avisados: (await chaveAvisadas()).length,
    base_links: baseEncurtador(),
    links_logado: encurtadorLogado(),
    modo_teste: modoTeste(),
  });
}

// ------------------------------------------------------------------ configuração

/** A foto chega em base64 (o Pages não tem upload multipart). Devolve [conteudo, nome]. */
function fotoDosDados(dados: Registro): [string, string] | Saida {
  const bruto = txt(dados.foto_base64).split(",").pop() || "";
  if (!bruto) return ["", ""];
  let bytes: Uint8Array;
  try {
    bytes = b64ParaBytes(bruto);
  } catch {
    return falha("foto_grande");
  }
  if (bytes.length > LIMITE_FOTO) return falha("foto_grande");
  return [bytesParaB64(bytes), txt(dados.foto_nome).split(/[\\/]/).pop() || ""];
}

export async function configVer(): Promise<Saida> {
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  return ok({ conf: resumoConfig(conf), travados: TRAVADOS });
}

export async function configSalvar(dados: Registro): Promise<Saida> {
  const campos: Registro = {};
  for (const c of CAMPOS_TEXTO) campos[c] = txt(dados[c]);
  if (!booleano(dados.editar_instancia)) for (const c of TRAVADOS) delete campos[c];
  for (const c of CAMPOS_BOOL) campos[c] = booleano(dados[c]);
  for (const c of CAMPOS_NUMERICO) {
    const bruto = txt(dados[c]).replace(",", ".");
    if (!bruto) continue;
    const n = Number(bruto);
    if (isNaN(n)) return falha("numero");
    campos[c] = n;
  }
  if (OBRIGATORIOS.some((c) => c in campos && !campos[c])) return falha("obrigatorio");

  const avisos: string[] = [];
  const foto = fotoDosDados(dados);
  if (!Array.isArray(foto)) return foto;
  const [base64, nomeArquivo] = foto;
  if (base64) {
    campos.photo_base64 = base64;
    campos.photo_name = nomeArquivo;
  }
  if (booleano(dados.limpar_foto)) {
    campos.photo_base64 = "";
    campos.photo_name = "";
    campos.send_photo = false;
    avisos.push("foto_removida");
  }
  const atual = await obterConfig();
  if (campos.send_photo && !base64 && !atual?.photo_base64) {
    campos.send_photo = false;
    avisos.push("sem_foto");
  }

  const resultado = await salvarConfig(campos);
  if (!resultado.ok) return falha("gravado", 500);
  const resposta: Registro = { campos: resultado.campos, send_photo: campos.send_photo };
  if (resultado.ajuste) resposta.ajuste = String(resultado.ajuste).slice(0, 180);
  if (avisos.length) resposta.aviso = avisos[avisos.length - 1];
  return ok(resposta);
}

// ------------------------------------------------------------------ avisos de vencimento

export async function avisosVer(dados: Registro, ctx: Contexto): Promise<Saida> {
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  const limite = Number(dados.dias ?? conf.aviso_dias ?? 2);
  const mostrarTodos = booleano(dados.todos);
  const info = await tokenDoPainel(ctx.ip);

  let itens: Registro[] = [], status: unknown = null;
  if (info.ok) {
    const coleta = await coletarLinhasVencendo(info.token || "", limite * 24);
    status = coleta.status;
    const telefones = await telefonesPorUsuario();
    const avisados = new Set(await chaveAvisadas());
    itens = coleta.itens.map((linha) => {
      const chave = `${linha.username}|${linha.exp_date}`;
      return { ...linha, telefone: telefones[linha.username] || "", ja_enviado: avisados.has(chave), chave };
    });
    if (!mostrarTodos) itens = itens.filter((i) => !i.ja_enviado);
  }
  const textoDias = itens.length ? String(itens[0].texto_dias) : textoDiasRestantes(limite * 24);
  return ok({
    itens,
    limite,
    mostrar_todos: mostrarTodos,
    previa_dias: textoDias,
    previa: await previaAvisoEmB64(conf, textoDias),
    // A legenda já sai montada daqui: a tela mostra exatamente o texto que o envio usaria,
    // sem precisar conhecer aviso_legenda e aviso_pix_key por fora.
    previa_legenda: legendaAviso(conf, textoDias),
    com_telefone: itens.filter((i) => i.telefone).length,
    sem_token: !info.ok,
    lines_status: status,
    aviso_ativo: conf.aviso_ativo,
    renova_ativo: conf.renova_ativo,
    aviso_dias: conf.aviso_dias,
  });
}

export async function avisosEnviar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  const limite = Number(conf.aviso_dias || 2);
  const info = await tokenDoPainel(ctx.ip);
  if (!info.ok) return falha("mc_login", 502);

  const coleta = await coletarLinhasVencendo(info.token || "", limite * 24);
  const candidatos = new Map(coleta.itens.map((l) => [l.username, l]));
  const telefones = await telefonesPorUsuario();
  let alvos = lista(dados.usernames);
  if (booleano(dados.todos)) alvos = [...candidatos.keys()].filter((u) => telefones[u]);

  let enviados = 0, cota = false;
  const erros: string[] = [];
  let ultimo: ResultadoEnvio = { ok: false };
  for (const username of alvos) {
    const linha = candidatos.get(username);
    const telefone = telefones[username] || "";
    if (!linha || !telefone) continue;
    const imagem = await gerarImagemAviso(conf, linha.texto_dias);
    ultimo = await enviarArquivo(conf, telefone, imagem, "aviso-vencimento.png", legendaAviso(conf, linha.texto_dias));
    if (ultimo.ok) {
      enviados++;
      await registrarAviso(username, linha.exp_date, telefone, linha.horas, ultimo);
    } else {
      erros.push(`${username}: ${String(ultimo.error || JSON.stringify(ultimo.response || {})).slice(0, 120)}`);
      if (cotaEsgotada(ultimo)) {
        cota = true;
        break;
      }
    }
  }

  if (enviados) return ok({ enviados, n: enviados });
  if (erros.length) {
    return falha(cota ? "cota" : "enviar", 502, { detalhe: falhaGreenApi(ultimo).slice(0, 220), erros: erros.slice(0, 8) });
  }
  return falha("sem_destino");
}

export async function avisosVarrer(dados: Registro, ctx: Contexto): Promise<Saida> {
  const forcar = booleano(dados.reenviar);
  const vencimentos = await avisarVencimentos(ctx.ip, forcar);
  if (!vencimentos.ok) {
    return falha("varrer", 502, { detalhe: String(vencimentos.error || "falha").slice(0, 180) });
  }
  const renovacao = await avisarRenovacao(ctx.ip, forcar);
  const espelho = await sincronizarLinhas(ctx.ip);
  return ok({
    avaliados: vencimentos.avaliados,
    enviados: vencimentos.enviados,
    sem_telefone: vencimentos.sem_telefone,
    cota: Boolean(vencimentos.cota || renovacao.cota),
    renova_avaliados: renovacao.avaliados,
    renova_enviados: renovacao.enviados,
    renova_esperando: renovacao.esperando,
    espelho: espelho.ok ? espelho.linhas : null,
  });
}

// ------------------------------------------------------------------ acessos

export async function acessosVer(dados: Registro, ctx: Contexto): Promise<Saida> {
  const pagina = Math.max(1, Math.trunc(Number(dados.pagina || 1)));
  const busca = txt(dados.q);
  const telefones = await telefonesPorUsuario();
  const info = await tokenDoPainel(ctx.ip);
  if (!info.ok) {
    return ok({ linhas: [], telefones, pagina, info: null, sem_token: true, lines_status: info.login_status });
  }
  const leitura = await listarLinhas(info.token || "", pagina, busca);
  if (leitura.brutos.length) await espelharLinhas(leitura.brutos, telefones);
  return ok({
    linhas: leitura.linhas,
    telefones,
    pagina,
    info: leitura.info,
    sem_token: false,
    lines_status: leitura.info.error || leitura.info.status || null,
  });
}

// ------------------------------------------------------------------ clientes (espelho do MC)

export async function clientesVer(): Promise<Saida> {
  const linhas = await listarEspelho();
  return ok({ linhas, com_telefone: linhas.filter((l) => l.telefone).length });
}

export async function clientesSincronizar(_dados: Registro, ctx: Contexto): Promise<Saida> {
  const resultado = await sincronizarLinhas(ctx.ip);
  if (!resultado.ok) return falha("mc_login", 502, { detalhe: String(resultado.error || "").slice(0, 180) });
  return ok({ n: resultado.linhas });
}

export async function clientesExportar(): Promise<Saida> {
  const r = await consultar(
    "select username, telefone, exp_date, status, notes from public.mc_linhas order by username",
  );
  const linhas: string[][] = [["Usuário", "Telefone", "Expira", "Status", "Nota"]];
  for (const l of r.rows) {
    linhas.push([
      String(l.username || ""),
      String(l.telefone || ""),
      l.exp_date ? formatarBrasilia(new Date(String(l.exp_date))) : "",
      Number(l.status || 0) === 1 ? "ativo" : "parado",
      String(l.notes || "").trim(),
    ]);
  }
  return ok({ csv: "﻿" + escreverCsv(linhas), nome: "clientes.csv" });
}

export async function clientesImportar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const linhas = lerCsv(String(dados.texto || ""));
  if (!linhas.length) return falha("csv_vazio");
  let novos = 0, semUsuario = 0;
  for (const colunas of linhas) {
    const nome = String(colunas[0] || "").trim();
    if (!nome) {
      semUsuario++;
      continue;
    }
    const telefone = String(colunas[1] || "").trim();
    const expira = parseDataBr(String(colunas[2] || ""));
    const status = parseStatus(String(colunas[3] || ""));
    const nota = String(colunas[4] || "").trim();
    await consultar(
      `insert into public.mc_linhas (username, telefone, exp_date, status, notes, synced_at)
       values ($1,$2,$3,$4,$5, now())
       on conflict (username) do update
         set telefone = coalesce(nullif($2, ''), mc_linhas.telefone),
             exp_date = coalesce($3, mc_linhas.exp_date),
             status = $4,
             notes = $5,
             synced_at = now()`,
      [nome, telefone, expira, status, nota],
    );
    if (telefone) await registrarUsuarioCriado("csv", nome, telefone);
    novos++;
  }
  await gravarEvento({
    event_type: "painel_clientes_import",
    status_code: 200,
    request_payload: { arquivo: txt(dados.nome_arquivo), linhas: novos },
    response_payload: { sem_usuario: semUsuario },
    client_ip: ctx.ip,
  });
  return ok({ n: novos, sem_usuario: semUsuario });
}

function parseStatus(texto: string): number {
  return ["1", "ativo", "true", "on"].includes(semAcento(texto).toLowerCase()) ? 1 : 0;
}

/** As datas do CSV dele são de Brasília; o banco guarda UTC. */
function parseDataBr(texto: string): Date | null {
  const valor = String(texto || "").trim();
  if (!valor) return null;
  const br = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(valor);
  if (br) {
    return new Date(Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1]), Number(br[4] || 0) - 3, Number(br[5] || 0)));
  }
  return parseExpDate(valor);
}

// ------------------------------------------------------------------ telefones

export async function telefoneSalvar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const username = txt(dados.username);
  if (!username) return falha("sem_destino");
  const resultado = await salvarTelefone(username, String(dados.telefone || ""));
  if (!resultado.ok) return falha(resultado.error || "telefone_invalido", 400, { telefone: resultado.telefone });
  await gravarEvento({
    event_type: "painel_telefone",
    status_code: 200,
    request_payload: { username },
    response_payload: { telefone: resultado.telefone, linhas: resultado.linhas },
    client_ip: ctx.ip,
  });
  return ok({ telefone: resultado.telefone });
}

export async function telefonesMesclar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const resultado = await mesclarTelefones(txt(dados.origem), txt(dados.destino));
  if (!resultado.ok) return falha(resultado.error || "sem_destino");
  await gravarEvento({
    event_type: "painel_mesclar",
    status_code: 200,
    request_payload: { origem: resultado.origem, destino: resultado.destino },
    response_payload: { telefone: resultado.telefone, linhas: resultado.linhas },
    client_ip: ctx.ip,
  });
  return ok({ de: resultado.origem, para: resultado.destino, tel: resultado.telefone });
}

// ------------------------------------------------------------------ aba Recuperação

export async function recuperacaoVer(): Promise<Saida> {
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  return ok({
    conf: resumoConfig(conf),
    // O {link} do exemplo é de mentira de propósito: criar link de verdade a cada abertura da
    // aba loteria o encurtador. No envio, quem põe o link real é linkRecuperacao().
    exemplo: legendaRecuperar(conf, "há 1 mês e 4 dias", `${baseEncurtador()}/rc-usuario-1234`),
    tem_foto: Boolean(conf.recupera_photo_base64),
    foto_kb: Math.round((conf.recupera_photo_base64 || "").length / 1024),
    foto_nome: conf.recupera_photo_name,
    send_photo: conf.recupera_send_photo,
  });
}

/** A foto guardada vem em chamada separada: são até 1,5 MB de base64 fora da tela. */
export async function recuperacaoFoto(): Promise<Saida> {
  const linha = await consultar1(
    "select recupera_photo_base64, recupera_photo_name from public.greenapi_config where id = 1",
  );
  const bruto = String(linha?.recupera_photo_base64 || "");
  if (!bruto) return falha("sem_foto_recupera", 404);
  return ok({ foto_base64: bruto, nome: String(linha?.recupera_photo_name || "") });
}

export async function recuperacaoAlternar(): Promise<Saida> {
  const atual = await obterConfig();
  if (!atual) return falha("banco", 500);
  const alvo = !atual.recupera_send_photo;
  if (alvo && !atual.recupera_photo_base64) return falha("sem_foto_recupera");
  const resultado = await salvarConfig({ recupera_send_photo: alvo });
  if (!resultado.ok) return falha("gravado", 500);
  return ok({ send_photo: alvo });
}

export async function recuperacaoSalvar(dados: Registro): Promise<Saida> {
  const campos: Registro = {
    recupera_legenda: txt(dados.recupera_legenda),
    recupera_send_photo: booleano(dados.recupera_send_photo),
  };
  const avisos: string[] = [];
  const foto = fotoDosDados(dados);
  if (!Array.isArray(foto)) return foto;
  const [base64, nomeArquivo] = foto;
  if (base64) {
    campos.recupera_photo_base64 = base64;
    campos.recupera_photo_name = nomeArquivo.slice(0, 60);
    campos.recupera_send_photo = true;
    avisos.push("recupera_foto");
  }
  if (booleano(dados.limpar_foto)) {
    campos.recupera_photo_base64 = "";
    campos.recupera_photo_name = "";
    campos.recupera_send_photo = false;
    avisos.push("recupera_foto_removida");
  }
  const atual = await obterConfig();
  if (campos.recupera_send_photo && !base64 && !atual?.recupera_photo_base64) {
    campos.recupera_send_photo = false;
    avisos.push("sem_foto_recupera");
  }
  const resultado = await salvarConfig(campos);
  if (!resultado.ok) return falha("gravado", 500);
  return ok({ aviso: avisos.length ? avisos[avisos.length - 1] : "recupera_gravado", send_photo: campos.recupera_send_photo });
}

export async function recuperarUm(dados: Registro, ctx: Contexto): Promise<Saida> {
  const username = txt(dados.username);
  if (!username) return falha("sem_destino");
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  const telefone = (await telefonesPorUsuario())[username] || "";
  if (!telefone) return falha("sem_telefone", 400, { q: username });

  let expira = parseExpDate(txt(dados.exp_iso));
  let fonte = txt(dados.destino) === "clientes" ? "espelho" : "linha";
  if (!expira) {
    expira = await expiraDoEspelho(username);
    fonte = expira ? "espelho" : "nenhuma";
  }
  const horas = expira ? (expira.getTime() - Date.now()) / 3_600_000 : 0;
  const dias = textoVencido(horas);
  const link = await linkRecuperacao(username, telefone);
  const resultado = await enviarRecuperacao(conf, telefone, legendaRecuperar(conf, dias, link.url));
  if (!resultado.ok) {
    return falha(cotaEsgotada(resultado) ? "cota" : "enviar", 502, { detalhe: falhaGreenApi(resultado).slice(0, 220) });
  }

  const expDate = txt(dados.exp_iso) || (expira ? expira.toISOString() : "");
  await registrarRenovacao(username, expDate, telefone, horas, resultado, "painel");
  await gravarEvento({
    event_type: "recuperar_envio",
    status_code: resultado.status_code ?? null,
    request_payload: {
      username, telefone, dias, link: link.url, fonte_data: fonte, exp_iso: expDate.slice(0, 40),
      com_foto: Boolean(resultado.com_foto),
    },
    response_payload: resultado.response,
    client_ip: ctx.ip,
  });
  const foto = resultado.com_foto ? "1" : conf.recupera_photo_base64 ? "desligada" : "sem_foto";
  return ok({ dias, data: fonte, foto, telefone, link: link.url, link_curto: link.curto });
}

/** Linha sem linha_id (CSV ou caixinha) tem data velha demais para anunciar dias. */
async function expiraDoEspelho(username: string): Promise<Date | null> {
  const linha = await consultar1(
    `select exp_date from public.mc_linhas
      where username = $1 and linha_id <> '' and synced_at > now() - interval '2 days'`,
    [username],
  );
  return linha?.exp_date ? new Date(String(linha.exp_date)) : null;
}

// ------------------------------------------------------------------ lotes (recuperar todos / apagar intervalo)

export async function loteContagem(dados: Registro, ctx: Contexto): Promise<Saida> {
  return tipoLote(dados.tipo) === "apagar" ? apagarContagem(dados, ctx) : recuperarContagem(dados, ctx);
}

async function recuperarContagem(dados: Registro, ctx: Contexto): Promise<Saida> {
  const busca = txt(dados.q);
  const pular = new Set(lista(dados.pular));
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  const info = await tokenDoPainel(ctx.ip);
  if (!info.ok) return falha("mc_login", 502);

  const telefones = await telefonesPorUsuario();
  const recentes = new Set(
    (await consultar(`select username from public.renovacao_avisos where updated_at > now() - interval '3 hours'`))
      .rows.map((r: Record<string, unknown>) => String(r.username)),
  );
  const vencidasNoEspelho = new Set(
    (await consultar(`select username from public.mc_linhas where exp_date is not null and exp_date <= now()`))
      .rows.map((r: Record<string, unknown>) => String(r.username)),
  );

  const varrida = await varrerMc(info.token || "", busca, (l) => l.vencido);
  const alvos: Item[] = [];
  let semTelefone = 0, pulados = 0, esperando = 0;
  for (const linha of varrida.escolhidas) {
    if (pular.has(linha.username)) pulados++;
    else if (!telefones[linha.username]) semTelefone++;
    else if (recentes.has(linha.username)) esperando++;
    else alvos.push({ username: linha.username, telefone: telefones[linha.username], exp_iso: linha.exp_iso, busca });
  }
  // Linha que só existe no espelho (apagada do MC depois da última sincronização) fica fora.
  const foraDoMc = varrida.aviso ? [] : [...vencidasNoEspelho].filter((u) => !varrida.todos.has(u)).sort();
  await gravarPlano("recuperar", alvos, varrida.aviso);

  return ok({
    vencidos: varrida.escolhidas.length,
    marcados: pular.size,
    so_no_espelho: foraDoMc.length,
    fora_do_mc: foraDoMc.slice(0, 8),
    alvos: alvos.length,
    sem_telefone: semTelefone,
    pulados,
    esperando,
    busca,
    aviso: varrida.aviso,
    foto: Boolean(conf.recupera_send_photo && conf.recupera_photo_base64),
    primeiros: alvos.slice(0, 8).map((a) => a.username),
  });
}

function numeroDoNome(username: string, prefixo = ""): number | null {
  const nome = (username || "").trim();
  if (prefixo && nome.slice(0, prefixo.length).toLowerCase() !== prefixo.toLowerCase()) return null;
  const resto = nome.slice(prefixo.length);
  return /^\d+$/.test(resto) ? Number(resto) : null;
}

async function apagarContagem(dados: Registro, ctx: Contexto): Promise<Saida> {
  const prefixo = txt(dados.prefixo);
  const deTxt = txt(dados.de), ateTxt = txt(dados.ate);
  if (prefixo.length > 24 || prefixo.includes(" ")) return falha("prefixo_ruim");
  if (!deTxt || !ateTxt || !/^-?\d+$/.test(deTxt) || !/^-?\d+$/.test(ateTxt)) return falha("intervalo_obrigatorio");
  const de = Number(deTxt), ate = Number(ateTxt);
  const qtd = ate - de + 1;
  if (qtd <= 0) return falha("intervalo_invertido");
  if (qtd > APAGAR_MAX) return falha("intervalo_grande", 400, { qtd, limite: APAGAR_MAX });

  const info = await tokenDoPainel(ctx.ip);
  if (!info.ok) return falha("mc_login", 502);
  const telefones = await telefonesPorUsuario();
  const varrida = await varrerMc(info.token || "", "", (l) => {
    const n = numeroDoNome(l.username, prefixo);
    return n !== null && n >= de && n <= ate;
  });
  const intervalo = `${prefixo}${de}..${prefixo}${ate}`;
  const linhas: Item[] = varrida.escolhidas
    .map((l) => ({
      id: String(l.id),
      usuario: l.username,
      numero: numeroDoNome(l.username, prefixo) || 0,
      expira: l.expira,
      nota: l.notes.slice(0, 60),
      telefone: formatarTelefone(telefones[l.username] || ""),
      vencido: l.vencido,
      intervalo,
    }))
    .sort((a, b) => Number(a.numero) - Number(b.numero) || String(a.usuario).localeCompare(String(b.usuario)));
  await gravarPlano("apagar", linhas, varrida.aviso);

  const vencidos = linhas.filter((l) => l.vencido).length;
  return ok({
    prefixo,
    de,
    ate,
    qtd,
    no_mc: linhas.length,
    vencidos,
    ativos: linhas.length - vencidos,
    faltando: Math.max(0, qtd - linhas.length),
    aviso: varrida.aviso,
    mc_total: varrida.todos.size,
    painel_inteiro: Boolean(linhas.length && !varrida.aviso && varrida.todos.size > 0 && linhas.length >= varrida.todos.size),
    linhas,
    palavra: PALAVRA_APAGAR,
    limite: APAGAR_MAX,
  });
}

export async function loteExecutar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const tipo = tipoLote(dados.tipo);
  if (tipo === "apagar" && txt(dados.palavra).toLowerCase() !== PALAVRA_APAGAR) return falha("sem_palavra");
  if (!booleano(dados.confirmar)) return falha("sem_confirmar");

  const vista = await verLote(tipo);
  if (!vista || !vista.fresco) return falha("conferencia_venceu", 409);
  if (vista.estado.rodando) return falha("lote_rodando", 409, { rodando: true });

  let plano = vista.plano, mantidos = 0;
  if (tipo === "apagar") {
    // O filtro nunca acrescenta ninguém: só tira da lista congelada na conferência.
    const manter = new Set(lista(dados.manter));
    const incluirAtivos = booleano(dados.ativos);
    const tirarEspelho = booleano(dados.espelho);
    const filtrado = plano.filter((l) => !manter.has(String(l.usuario)) && (incluirAtivos || l.vencido) && l.id);
    mantidos = plano.length - filtrado.length;
    plano = filtrado.map((l) => ({ ...l, tirar_espelho: tirarEspelho }));
    if (!plano.length) return falha("sem_sobra_apagar", 400);
    await gravarPlano("apagar", plano, vista.aviso);
  } else if (!plano.length) {
    return falha("sem_sobra");
  }

  const iniciado = await iniciarLote(tipo);
  if (!iniciado.ok) return falha(iniciado.erro || "lote_rodando", 409);
  await gravarEvento({
    event_type: tipo === "apagar" ? "painel_online_lote_inicio" : "recuperar_lote_inicio",
    status_code: 200,
    request_payload: { tipo, total: plano.length, busca: txt(dados.busca) },
    response_payload: { mantidos, aviso: vista.aviso },
    client_ip: ctx.ip,
  });
  return ok({ total: plano.length, mantidos });
}

/** O navegador chama isto até o lote acabar; cada chamada processa exatamente um item. */
export async function loteItem(dados: Registro, ctx: Contexto): Promise<Saida> {
  const tipo = tipoLote(dados.tipo);
  const proximo = await proximoItem(tipo);
  if (!proximo) return ok({ terminado: true, estado: await resumoLote(tipo) });

  const resultado = tipo === "apagar" ? await itemApagar(proximo.item, ctx) : await itemRecuperar(proximo.item, ctx);
  const estado = await registrarItem(tipo, {
    ok: resultado.ok,
    erro: resultado.erro,
    ...(resultado.parar ? { parar: resultado.parar } : { limiteSeguidas: PARADA_ERROS }),
  });
  return ok({ item: resultado.info, estado, proximo: estado.rodando && estado.indice < estado.total });
}

async function itemRecuperar(
  item: Item,
  ctx: Contexto,
): Promise<{ ok: boolean; erro?: string; parar?: string; info: Registro }> {
  const conf = await obterConfig();
  const username = String(item.username || ""), telefone = String(item.telefone || "");
  if (!conf) return { ok: false, erro: `${username}: config ausente`, info: { username } };

  const expira = parseExpDate(String(item.exp_iso || ""));
  const horas = expira ? (expira.getTime() - Date.now()) / 3_600_000 : 0;
  const dias = textoVencido(horas);
  const link = await linkRecuperacao(username, telefone);
  let resultado: ResultadoEnvio;
  try {
    resultado = await enviarRecuperacao(conf, telefone, legendaRecuperar(conf, dias, link.url));
  } catch (exc) {
    resultado = { ok: false, error: String(exc).slice(0, 160) };
  }
  if (resultado.ok) await registrarRenovacao(username, String(item.exp_iso || ""), telefone, horas, resultado, "lote");
  await gravarEvento({
    event_type: "recuperar_envio",
    status_code: resultado.status_code ?? null,
    request_payload: { username, telefone, dias, link: link.url, fonte_data: "linha", exp_iso: String(item.exp_iso || "").slice(0, 40), via: "lote" },
    response_payload: resultado.response,
    client_ip: ctx.ip,
  });
  return {
    ok: resultado.ok,
    erro: resultado.ok ? undefined : `${username}: ${falhaGreenApi(resultado).slice(0, 120)}`,
    parar: !resultado.ok && cotaEsgotada(resultado) ? "cota" : undefined,
    info: { username, dias, com_foto: Boolean(resultado.com_foto) },
  };
}

async function itemApagar(
  item: Item,
  ctx: Contexto,
): Promise<{ ok: boolean; erro?: string; parar?: string; info: Registro }> {
  const usuario = String(item.usuario || ""), linhaId = String(item.id || "");
  const info = await tokenDoPainel(ctx.ip);
  if (!info.ok) return { ok: false, erro: `${usuario}: ${"mc_login"}`, parar: "mc_login", info: { usuario } };

  const resposta = await apagarLinha(info.token || "", linhaId);
  const bom = resposta.status >= 200 && resposta.status < 300;
  if (bom && booleano(item.tirar_espelho)) {
    await consultar("delete from public.mc_linhas where username = $1", [usuario]);
  }
  await gravarEvento({
    event_type: "painel_online_batch_delete",
    status_code: resposta.status,
    request_payload: { line_id: linhaId, username: usuario, via: "lote", intervalo: String(item.intervalo || "").slice(0, 40) },
    response_payload: resposta.corpo,
    error_message: bom ? null : "exclusao em lote falhou",
    client_ip: ctx.ip,
  });
  return {
    ok: bom,
    erro: bom ? undefined : `${usuario}: o MC respondeu ${resposta.status}`,
    parar: resposta.status === 401 || resposta.status === 403 ? "chave_recusada" : undefined,
    info: { usuario, status: resposta.status },
  };
}

export async function loteStatus(dados: Registro): Promise<Saida> {
  return ok({ estado: await resumoLote(tipoLote(dados.tipo)) });
}

export async function loteParar(dados: Registro): Promise<Saida> {
  return ok({ estado: await pararLote(tipoLote(dados.tipo)) });
}

// ------------------------------------------------------------------ apagar uma linha só

export async function apagarLinhaVer(dados: Registro, ctx: Contexto): Promise<Saida> {
  const linhaId = txt(dados.linha_id);
  if (!/^\d+$/.test(linhaId)) return falha("apagar");
  const telefones = await telefonesPorUsuario();
  const info = await tokenDoPainel(ctx.ip);
  let alvo: Registro = {};
  if (info.ok) {
    const item = await linhaPorId(info.token || "", linhaId);
    if (item) {
      const linha = traduzirLinha(item);
      alvo = {
        username: linha.username,
        expira: linha.expira,
        exp_iso: linha.exp_iso,
        notes: String(item.notes || "").slice(0, 120),
        parado: linha.status !== 1,
      };
    }
  }
  return ok({ linha_id: linhaId, alvo, telefone: formatarTelefone(telefones[txt(alvo.username)] || "") });
}

export async function apagarLinhaFazer(dados: Registro, ctx: Contexto): Promise<Saida> {
  const linhaId = txt(dados.linha_id);
  if (!/^\d+$/.test(linhaId)) return falha("apagar");
  if (!booleano(dados.confirmar)) return falha("sem_confirmar");
  const info = await tokenDoPainel(ctx.ip);
  if (!info.ok) return falha("mc_login", 502);

  const resposta = await apagarLinha(info.token || "", linhaId);
  await gravarEvento({
    event_type: "painel_online_delete",
    status_code: resposta.status,
    request_payload: { line_id: linhaId },
    response_payload: resposta.corpo,
    error_message: resposta.status >= 400 ? "exclusao pelo painel online falhou" : null,
    client_ip: ctx.ip,
  });
  if (resposta.status >= 200 && resposta.status < 300) return ok({ linha: linhaId });
  return falha("apagar", 502, { detalhe: JSON.stringify(resposta.corpo).slice(0, 180) });
}

// ------------------------------------------------------------------ links

export async function linksVer(): Promise<Saida> {
  return ok({ base: baseEncurtador(), logado: encurtadorLogado() });
}

export async function linksEncurtar(dados: Registro): Promise<Saida> {
  const resultado = await encurtar(txt(dados.url), txt(dados.slug), txt(dados.titulo));
  return { status: resultado.ok ? 200 : 400, dados: { ...resultado } };
}

export async function linksResolver(dados: Registro): Promise<Saida> {
  const resultado = await resolver(txt(dados.slug));
  return { status: resultado.ok ? 200 : 400, dados: { ...resultado } };
}
