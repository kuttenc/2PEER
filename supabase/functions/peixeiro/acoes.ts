// As ações do painel sem Render: é rota por rota do painel_web.py, mas devolvendo JSON
// para o Pages. As frases em português ficam no front; daqui só saem os códigos.
import {
  chaveAvisadas,
  espelharLinhas,
  listarClientes,
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
  enviarTexto,
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
  limparSlug,
  painelBase,
  resolver,
  slugDoPayload,
  slugRecuperacao,
} from "./encurtador.ts";
import {
  destinoComTelefone,
  destinoNoClique,
  destinoPadrao,
  listarLinks,
  registrarLink,
  salvarDestino,
  salvarPadrao,
  telefoneNoClique,
} from "./destinos.ts";
import {
  ajustarChat, apagarRegra, exportarTreino, instalarWebhook, ligarRegra, listarRegras, mensagensDe,
  novaRegra, receberWebhook, renderizar, resumoChat, salvarRegra, telefonesConversados, tokenChat,
  variaveis,
  entregasPorUsuario,
} from "./chat.ts";
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
  estadoVazio,
  foraDaFila,
  gravarPlano,
  iniciarLote,
  pararLote,
  proximoItem,
  registrarItem,
  resumoLote,
  retomarLote,
  tirarDaFila,
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
  normalizarWhatsapp,
  parseExpDate,
  semAcento,
  telefoneValido,
  textoDiasRestantes,
  textoVencido,
} from "./texto.ts";

export type Registro = Record<string, unknown>;
export type Contexto = { ip: string; url: string; query: Record<string, string> };
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
const CAMPOS_NUMERICO = ["aviso_dias", "renova_dias", "renova_janela_dias", "recupera_pausa_min", "recupera_pausa_max"];
const OBRIGATORIOS = ["api_url", "media_url", "id_instance", "api_token"];
const TRAVADOS = ["id_instance", "api_token"];
const PARADA_ERROS = 3;
const PALAVRA_APAGAR = "deletar";
const APAGAR_MAX = 300;
/** O teto do WhatsApp é bem maior, mas um texto desse tamanho já é print de tela cheia no celular. */
const MAX_TEXTO = 1200;

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
  const tipo = txt(valor);
  if (tipo === "apagar") return "apagar";
  if (tipo === "mensagem") return "mensagem";
  return "recuperar";
}

/** O nome do evento no `mcapi_events` segue o tipo do lote, com o mesmo sufixo para os três. */
function eventoLote(tipo: TipoLote, sufixo: string): string {
  if (tipo === "apagar") return `painel_online_lote_${sufixo}`;
  return `${tipo}_lote_${sufixo}`;
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
  const numero = await sincronizarDono();
  if (numero) resposta.numero_instancia = numero;
  if (avisos.length) resposta.aviso = avisos[avisos.length - 1];
  return ok(resposta);
}

/** Quem manda no WhatsApp é a instância, não o que foi digitado. Depois de gravar a chave,
 *  perguntar o número real para ela e consertar o telefone/nome da instância quando estiverem
 *  fora — é assim que o painel para de mostrar um número que não é o que respondeu ao cliente. */
async function sincronizarDono(): Promise<string> {
  const conf = await obterConfig();
  if (!(conf?.api_url && conf?.id_instance && conf?.api_token)) return "";
  const infos = await infosInstancia(conf);
  const numero = String(infos.numero || "");
  if (!infos.ok || !numero) return "";
  const campos: Registro = {};
  if (normalizarWhatsapp(conf.owner_phone) !== numero) campos.owner_phone = numero;
  const nome = `Instance ${conf.id_instance}`;
  if (/^Instance \d+$/.test(conf.instance_name) && conf.instance_name !== nome) campos.instance_name = nome;
  if (Object.keys(campos).length) await salvarConfig(campos);
  return numero;
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
  const linhas = await listarClientes();
  return ok({
    linhas,
    com_telefone: linhas.filter((l) => l.telefone).length,
    so_agenda: linhas.filter((l) => !l.linha_id).length,
  });
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
    exemplo: legendaRecuperar(conf, "há 1 mês e 4 dias",
      `${baseEncurtador()}/${slugRecuperacao("usuario", "11999998888")}`),
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
  await registrarLink(link.slug, username, telefone);
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

// ------------------------------------------------------------------ mensagem comum (sem painel MC)

/** O número de quem vai receber: o digitado na tela manda, senão a agenda de telefones, senão o
 *  espelho. Nada aqui pergunta nada ao painel MC — cliente apagado de lá continua tendo WhatsApp. */
async function telefoneDaMensagem(username: string, bruto: string): Promise<string> {
  const digitos = normalizarWhatsapp(bruto);
  if (telefoneValido(digitos)) return digitos;
  if (!username) return "";
  const daAgenda = (await telefonesPorUsuario())[username] || "";
  if (daAgenda) return daAgenda;
  const linha = await consultar1(
    "select telefone from public.mc_linhas where username = $1 and coalesce(telefone, '') <> '' limit 1",
    [username],
  );
  return normalizarWhatsapp(String(linha?.telefone || ""));
}

/** `{{usuario}}`, `{{pix}}`, `{{site}}` e o resto das variáveis do robô, com o que a gente sabe
 *  do cliente. Quem não tem data — o apagado do painel MC — recebe `{{vence}}` = "não está no nosso
 *  sistema" de propósito: é melhor o texto honesto do que uma data velha passando por verdade. */
function corpoMensagem(texto: string, username: string, telefone: string, conf: Conf, expira: Date | null): string {
  const cliente = { usuario: username, telefone, nota: "", status: 0, expira };
  return renderizar(texto, variaveis(cliente, conf, telefone)).slice(0, 4000);
}

/** Um cliente só, texto livre, sem link e sem foto. */
export async function mensagemUm(dados: Registro, ctx: Contexto): Promise<Saida> {
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  const texto = String(dados.texto || "").trim();
  if (!texto) return falha("sem_texto", 400);
  if (texto.length > MAX_TEXTO) return falha("texto_grande", 400, { maximo: MAX_TEXTO });
  const username = txt(dados.username);
  const telefone = await telefoneDaMensagem(username, String(dados.telefone || ""));
  if (!telefone) return falha("sem_telefone", 400, { q: username });

  // A data que a linha tinha na tela: sem ela {{vence}} mentiria para quem ainda tem linha no MC.
  const resultado = await enviarTexto(
    conf, telefone, corpoMensagem(texto, username, telefone, conf, parseExpDate(txt(dados.exp_iso))),
  );
  await gravarEvento({
    event_type: "mensagem_envio",
    status_code: resultado.status_code ?? null,
    request_payload: { username, telefone, via: "avulso", texto: texto.slice(0, 160) },
    response_payload: resultado.response,
    client_ip: ctx.ip,
  });
  if (!resultado.ok) {
    return falha(cotaEsgotada(resultado) ? "cota" : "enviar", 502, { detalhe: falhaGreenApi(resultado).slice(0, 220) });
  }
  return ok({ telefone, caracteres: texto.length });
}

async function itemMensagem(
  item: Item,
  ctx: Contexto,
): Promise<{ ok: boolean; erro?: string; parar?: string; info: Registro }> {
  const conf = await obterConfig();
  const username = String(item.username || ""), telefone = String(item.telefone || "");
  if (!conf) return { ok: false, erro: `${username}: config ausente`, info: { username } };
  const texto = String(item.texto || "").trim();
  if (!texto) return { ok: false, erro: `${username}: a mensagem sumiu do plano`, parar: "sem_texto", info: { username } };
  if (!telefone) return { ok: false, erro: `${username}: sem telefone`, info: { username } };

  let resultado: ResultadoEnvio;
  try {
    resultado = await enviarTexto(
      conf, telefone, corpoMensagem(texto, username, telefone, conf, parseExpDate(txt(item.expira))),
    );
  } catch (exc) {
    resultado = { ok: false, error: String(exc).slice(0, 160) };
  }
  // A linha vazia no `exp_date` é o que separa o registro desta mensagem do aviso de vencimento
  // do mesmo cliente, e é dela que a tela da fila puxa a prova de entrega.
  if (resultado.ok) await registrarRenovacao(username, "", telefone, 0, resultado, "mensagem");
  await gravarEvento({
    event_type: "mensagem_envio",
    status_code: resultado.status_code ?? null,
    request_payload: { username, telefone, via: "lote", quem: String(item.quem || "fora"), texto: texto.slice(0, 160) },
    response_payload: resultado.response,
    client_ip: ctx.ip,
  });
  return {
    ok: resultado.ok,
    erro: resultado.ok ? undefined : `${username}: ${falhaGreenApi(resultado).slice(0, 120)}`,
    parar: !resultado.ok && cotaEsgotada(resultado) ? "cota" : undefined,
    info: { username },
  };
}

// ------------------------------------------------------------------ lotes (recuperar todos / apagar intervalo)

export async function loteContagem(dados: Registro, ctx: Contexto): Promise<Saida> {
  const tipo = tipoLote(dados.tipo);
  // Remontar o plano com o lote andando jogaria o envio para outra lista no meio do caminho.
  const vista = await verLote(tipo);
  if (vista && vista.estado.rodando) return falha("lote_rodando", 409, { rodando: true });
  if (tipo === "mensagem") return contagemDeMensagem(dados);
  return tipo === "apagar" ? apagarContagem(dados, ctx) : recuperarContagem(dados, ctx);
}

async function recuperarContagem(dados: Registro, ctx: Contexto): Promise<Saida> {
  const busca = txt(dados.q);
  const pular = new Set(lista(dados.pular));
  const conf = await obterConfig();
  if (!conf) return falha("banco", 500);
  const telefones = await telefonesPorUsuario();
  const recentes = new Set(
    (await consultar(`select username from public.renovacao_avisos where updated_at > now() - interval '3 hours'`))
      .rows.map((r: Record<string, unknown>) => String(r.username)),
  );
  // Quem nunca teve linha no painel MC (importado por CSV) só existe no espelho da aba Clientes.
  if (txt(dados.fonte) === "espelho") return contagemDoEspelho(busca, pular, telefones, recentes, conf);

  const info = await tokenDoPainel(ctx.ip);
  if (!info.ok) return falha("mc_login", 502);

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
    fonte: "mc",
    vencidos: varrida.escolhidas.length,
    marcados: pular.size,
    so_no_espelho: foraDoMc.length,
    fora_do_mc: foraDoMc.slice(0, 8),
    com_linha_mc: varrida.escolhidas.length,
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

/** A lista vem do espelho que a aba Clientes mantém no banco, sem consultar o painel MC:
 *  é por onde os clientes importados por CSV (que nunca tiveram linha no MC) recebem. */
async function contagemDoEspelho(
  busca: string,
  pular: Set<string>,
  telefones: Record<string, string>,
  recentes: Set<string>,
  conf: Conf,
): Promise<Saida> {
  const r = await consultar(
    `select username, telefone, exp_date, linha_id from public.mc_linhas
      where exp_date is not null and exp_date <= now()
        and ($1 = '' or username ilike '%' || $1 || '%')
      order by username`,
    [busca],
  );
  const alvos: Item[] = [];
  let semTelefone = 0, pulados = 0, esperando = 0, semLinha = 0;
  for (const linha of r.rows as Record<string, unknown>[]) {
    const username = String(linha.username || "");
    if (!String(linha.linha_id || "")) semLinha++;
    if (pular.has(username)) pulados++;
    else {
      const telefone = telefones[username] || String(linha.telefone || "");
      if (!telefone) semTelefone++;
      else if (recentes.has(username)) esperando++;
      else alvos.push({ username, telefone, exp_iso: String(linha.exp_date || ""), busca, fonte: "espelho" });
    }
  }
  await gravarPlano("recuperar", alvos, "");

  return ok({
    fonte: "espelho",
    vencidos: r.rows.length,
    marcados: pular.size,
    so_no_espelho: 0,
    fora_do_mc: [],
    com_linha_mc: r.rows.length - semLinha,
    alvos: alvos.length,
    sem_telefone: semTelefone,
    pulados,
    esperando,
    busca,
    aviso: "",
    foto: Boolean(conf.recupera_send_photo && conf.recupera_photo_base64),
    primeiros: alvos.slice(0, 8).map((a) => a.username),
  });
}

/** A lista vem do que a aba Clientes mostra — espelho do MC em cima e agenda de telefones embaixo
 *  — então o lote de mensagem alcança quem foi apagado do painel MC sem alcançar ninguém que não
 *  esteja na tela. O texto vai em cada item do plano porque `proximoItem` devolve só o item. */
async function contagemDeMensagem(dados: Registro): Promise<Saida> {
  const busca = txt(dados.q);
  const pular = new Set(lista(dados.pular));
  const texto = String(dados.texto || "").trim();
  if (!texto) return falha("sem_texto", 400);
  if (texto.length > MAX_TEXTO) return falha("texto_grande", 400, { maximo: MAX_TEXTO });
  // "fora" (o padrão) é quem não tem linha no painel MC; "todos" é a lista inteira com telefone.
  const quem = txt(dados.quem) === "todos" ? "todos" : "fora";
  const linhas = await listarClientes();
  const recentes = new Set(
    (await consultar(`select username from public.renovacao_avisos where updated_at > now() - interval '3 hours'`))
      .rows.map((r: Record<string, unknown>) => String(r.username)),
  );

  const alvos: Item[] = [];
  let semTelefone = 0, pulados = 0, esperando = 0, comLinha = 0, semLinha = 0;
  for (const linha of linhas) {
    if (busca && !linha.username.toLowerCase().includes(busca.toLowerCase())) continue;
    if (linha.linha_id) comLinha++;
    else semLinha++;
    if (quem === "fora" && linha.linha_id) continue;
    if (pular.has(linha.username)) pulados++;
    else if (!linha.telefone) semTelefone++;
    else if (recentes.has(linha.username)) esperando++;
    else alvos.push({ username: linha.username, telefone: linha.telefone, texto, quem, busca, expira: linha.exp_iso });
  }
  await gravarPlano("mensagem", alvos, "");

  return ok({
    quem,
    na_lista: linhas.length,
    sem_linha_mc: semLinha,
    com_linha_mc: comLinha,
    alvos: alvos.length,
    sem_telefone: semTelefone,
    pulados,
    esperando,
    marcados: pular.size,
    busca,
    caracteres: texto.length,
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
    event_type: eventoLote(tipo, "inicio"),
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
  if (proximo && "emEnvio" in proximo) {
    // Tem um item saindo em outro navegador: devolve o mesmo estado e manda esperar.
    return ok({ em_envio: true, esperar: 8, estado: await resumoLote(tipo), proximo: true });
  }
  if (!proximo) return ok({ terminado: true, estado: await resumoLote(tipo) });

  let resultado;
  if (tipo === "apagar") resultado = await itemApagar(proximo.item, ctx);
  else if (tipo === "mensagem") resultado = await itemMensagem(proximo.item, ctx);
  else resultado = await itemRecuperar(proximo.item, ctx);
  const estado = await registrarItem(tipo, {
    ok: resultado.ok,
    erro: resultado.erro,
    ...(resultado.parar ? { parar: resultado.parar } : { limiteSeguidas: PARADA_ERROS }),
  });
  const vaiContinuar = estado.rodando && estado.indice < estado.total;
  const saida: Registro = { item: resultado.info, estado, proximo: vaiContinuar };
  // A pausa é sorteada aqui, e não no navegador, para que o ritmo seja o mesmo em qualquer
  // tela (Acessos e Clientes) e sobreviva a um F5 no meio do lote. O lote de mensagem comum usa
  // a mesma regulagem: o que protege a instância do GreenAPI é o intervalo, não o texto.
  if (tipo !== "apagar" && vaiContinuar) saida.esperar = await pausaRecuperar();
  return ok(saida);
}

/** Quantos segundos esperar antes da próxima mensagem do "Não recuperados". Nunca o mesmo
 *  número duas vezes: o sorteio é o ponto da regulagem, para as mensagens não saírem em bloco. */
async function pausaRecuperar(): Promise<number> {
  const conf = await obterConfig();
  let de = Number(conf?.recupera_pausa_min ?? 4.5);
  let ate = Number(conf?.recupera_pausa_max ?? 105);
  if (!isFinite(de) || de < 0.5) de = 4.5;
  if (!isFinite(ate) || ate < de) ate = Math.max(de, 105);
  if (ate > 900) ate = 900;
  return Math.round((de + Math.random() * (ate - de)) * 10) / 10;
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
  await registrarLink(link.slug, username, telefone);
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
    request_payload: { username, telefone, dias, link: link.url, fonte_data: item.fonte ? "espelho" : "linha", exp_iso: String(item.exp_iso || "").slice(0, 40), via: "lote" },
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

/** O "há 1 mês e 4 dias" da linha congelada, calculado do mesmo jeito que o envio faz na hora. */
function textoDoItem(item: Item): string {
  const expira = parseExpDate(txt(item.exp_iso));
  if (!expira) return "";
  return textoVencido((expira.getTime() - Date.now()) / 3_600_000);
}

/** A fila congelada do lote, linha por linha, com o que aconteceu em cada uma. É a tela
 *  "Não recuperados": quem falhou continua visível mesmo depois que o envio acaba. */
export async function loteFila(dados: Registro): Promise<Saida> {
  const tipo = tipoLote(dados.tipo);
  const vista = await verLote(tipo);
  if (!vista || !vista.plano.length) {
    return ok({ vazia: true, itens: [], estado: estadoVazio(0), na_fila: 0, fora: 0, total: 0 });
  }
  const { plano, estado } = vista;
  const resultados = estado.resultados || {};
  const entregas = await entregasPorUsuario(plano.map((item) => txt(item.username) || txt(item.usuario)));
  let naFila = 0, fora = 0;
  const itens = plano.map((item, i) => {
    const marca = resultados[String(i)];
    const saiu = foraDaFila(item);
    const enviando = Boolean(estado.rodando) && estado.enviando === i;
    if (saiu) fora += 1;
    else if (!marca) naFila += 1;
    const nome = txt(item.username) || txt(item.usuario);
    return {
      i,
      usuario: nome,
      telefone: formatarTelefone(txt(item.telefone)),
      vencido: textoDoItem(item) || txt(item.intervalo),
      quem: txt(item.quem),
      situacao: marca ? (marca.ok ? "enviado" : "falhou") : saiu ? "fora" : enviando ? "enviando" : "fila",
      erro: marca && !marca.ok ? marca.erro : "",
      entrega: entregas[nome] || "",
    };
  });
  return ok({
    vazia: false,
    itens,
    estado,
    fonte: tipo === "mensagem"
      ? (plano.length && plano[0].quem === "todos" ? "todos" : "fora")
      : (plano.length && plano[0].fonte === "espelho" ? "espelho" : "mc"),
    na_fila: naFila,
    fora,
    total: plano.length,
    idade: Number.isFinite(vista.idade) ? Math.round(vista.idade) : null,
    fresco: vista.fresco,
    aviso: vista.aviso,
  });
}

/** Continua o mesmo plano de onde parou, sem recontar ninguém. */
export async function loteRetomar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const tipo = tipoLote(dados.tipo);
  const retomado = await retomarLote(tipo);
  if (!retomado.ok) return falha(retomado.erro || "lote_rodando", 409);
  await gravarEvento({
    event_type: eventoLote(tipo, "retoma"),
    status_code: 200,
    request_payload: { tipo, indice: retomado.estado ? retomado.estado.indice : null },
    response_payload: {},
    client_ip: ctx.ip,
  });
  return ok({ estado: retomado.estado });
}

/** Só tira da fila: nada é apagado no painel MC e nada do que já saiu muda de lugar. */
export async function loteTirar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const tipo = tipoLote(dados.tipo);
  const indices = lista(dados.indices).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 0);
  if (!indices.length) return falha("sem_marca");
  if (indices.length > 2000) return falha("muita_marca");
  const saida = await tirarDaFila(tipo, indices);
  if (!saida.ok) return falha(saida.erro || "lote_rodando", 409);
  await gravarEvento({
    event_type: eventoLote(tipo, "tirar"),
    status_code: 200,
    request_payload: { tipo, indices: indices.length },
    response_payload: { fora: saida.fora },
    client_ip: ctx.ip,
  });
  return ok({ fora: saida.fora, estado: await resumoLote(tipo) });
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
  return ok({
    base: baseEncurtador(),
    logado: encurtadorLogado(),
    padrao: await destinoPadrao(),
    itens: await listarLinks(),
  });
}

const URL_BOM = /^https?:\/\/[^\s<>"']+$/i;

/** O endereço que abre quando o link não tem destino próprio. Vazio = volta para o painel. */
export async function linksPadraoSalvar(dados: Registro): Promise<Saida> {
  const destino = txt(dados.destino).trim();
  if (destino && !URL_BOM.test(destino)) return falha("url");
  if (!(await salvarPadrao(destino))) return falha("banco", 500);
  return ok({ destino });
}

/** Destino individual, para quando um cliente precisa cair em outra página. */
export async function linksDestinoSalvar(dados: Registro): Promise<Saida> {
  const slug = limparSlug(txt(dados.slug));
  const destino = txt(dados.destino).trim();
  if (!slug) return falha("sem_slug");
  if (destino && !URL_BOM.test(destino)) return falha("url");
  if (!(await salvarDestino(slug, destino))) return falha("banco", 500);
  return ok({ slug, destino });
}

/** A página r/ do Pages chama isto no clique do cliente. Sem login e sem chave: o único dado
 *  que entra é o final do link, e o que sai é só o endereço para onde ele já mandava.
 *  O telefone do próprio link vai no endereço de saída: quem chegou pelo WhatsApp do cliente
 *  já chega no site com o número dele preenchido, e o site tranca o campo. */
export async function linksDestino(dados: Registro): Promise<Saida> {
  const bruto = txt(dados.slug) || txt(dados.d);
  const slug = txt(dados.slug) ? limparSlug(bruto) : slugDoPayload(bruto);
  if (!slug) return falha("sem_slug", 400);
  const destino = (await destinoNoClique(slug)) || `${painelBase()}/painel/`;
  const telefone = await telefoneNoClique(slug, bruto);
  return ok({ slug, telefone, destino: destinoComTelefone(destino, telefone) });
}

export async function linksEncurtar(dados: Registro): Promise<Saida> {
  const resultado = await encurtar(txt(dados.url), txt(dados.slug), txt(dados.titulo));
  return { status: resultado.ok ? 200 : 400, dados: { ...resultado } };
}

export async function linksResolver(dados: Registro): Promise<Saida> {
  const resultado = await resolver(txt(dados.slug));
  return { status: resultado.ok ? 200 : 400, dados: { ...resultado } };
}

// ------------------------------------------------------------------ chat (o robô do WhatsApp)

/** O webhook do GreenAPI entra aqui sem sessão. A chave vai na URL, e não no corpo, porque o
 *  corpo é a mensagem do cliente — não há onde encaixar o nosso token ali. */
export async function chatWebhook(dados: Registro, ctx: Contexto): Promise<Saida> {
  const saida = await receberWebhook(dados, ctx.query.token || txt(dados.token));
  return { status: saida.status, dados: saida.dados };
}

export async function chatVer(dados: Registro, ctx: Contexto): Promise<Saida> {
  const resumo = await resumoChat(ctx.url);
  const conf = await obterConfig();
  const conversas = await telefonesConversados(Number(resumo.dias || 90));
  const armada = Boolean(conf?.api_url && conf?.id_instance && conf?.api_token);
  const infos = armada ? await infosInstancia(conf as Conf) : { ok: false, error: "sem configuracao" };
  const numero = String(infos.numero || "");
  const webhook = String(resumo.webhook || "");
  return ok({
    ...resumo,
    conversas,
    instancia: {
      ok: Boolean(infos.ok),
      numero,
      webhook_url: String(infos.webhook_url || ""),
      incoming_webhook: String(infos.incoming_webhook || ""),
      error: String(infos.error || ""),
    },
    webhook_ok: Boolean(infos.ok && String(infos.webhook_url || "") === webhook),
    telefone_diferente: Boolean(numero && conf && normalizarWhatsapp(conf.owner_phone) !== numero),
  });
}

/** Grava uma regra. O "criar outro chat" faz primeiro o chat_novo, que devolve o id vazio na
 *  lista para ele preencher gatilho e resposta. */
export async function chatSalvar(dados: Registro): Promise<Saida> {
  const id = Number(txt(dados.id) || 0);
  const gatilho = txt(dados.gatilho);
  const resposta = txt(dados.resposta);
  const brutoPrioridade = txt(dados.prioridade) || "10";
  const prioridade = Number(brutoPrioridade.replace(",", "."));
  if (!id) return falha("sem_regra");
  if (!gatilho) return falha("chat_gatilho");
  if (!resposta) return falha("chat_resposta");
  if (!Number.isFinite(prioridade)) return falha("numero");
  const ativo = "ativo" in dados ? booleano(dados.ativo) : true;
  if (!(await salvarRegra(id, { gatilho, resposta, prioridade, ativo }))) return falha("banco", 500);
  return ok({ regras: await listarRegras() });
}

export async function chatNovo(dados: Registro): Promise<Saida> {
  const prioridade = Number((txt(dados.prioridade) || "10").replace(",", "."));
  const criado = await novaRegra({
    gatilho: txt(dados.gatilho),
    resposta: txt(dados.resposta),
    prioridade: Number.isFinite(prioridade) ? prioridade : 10,
  });
  if (!criado.ok) return falha("banco", 500);
  return ok({ id: criado.id, regras: await listarRegras() });
}

export async function chatApagar(dados: Registro): Promise<Saida> {
  const id = Number(txt(dados.id) || 0);
  if (!id) return falha("sem_regra");
  if (!(await apagarRegra(id))) return falha("sem_regra");
  return ok({ regras: await listarRegras() });
}

/** Liga/desliga o robô, muda a retenção das conversas e decide se responde quem não é cliente. */
export async function chatLigar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const campos: { ativo?: boolean; dias?: number; desconhecido?: boolean } = {};
  if ("ativo" in dados) campos.ativo = booleano(dados.ativo);
  if ("desconhecido" in dados) campos.desconhecido = booleano(dados.desconhecido);
  if (txt(dados.dias)) {
    const dias = Number(txt(dados.dias).replace(",", "."));
    if (!Number.isFinite(dias)) return falha("numero");
    campos.dias = dias;
  }
  if (!Object.keys(campos).length) return falha("nada_gravar");
  const gravado = await ajustarChat(campos);
  if (!gravado.ok) return falha("banco", 500);
  return ok(await resumoChat(ctx.url));
}

/** A chave de cada chat, aplicada na hora. Ele usa isso para desligar uma resposta e continuar
 *  editando as outras com o robô ligado — por isso não passa por chatSalvar, que exige a regra
 *  inteira preenchida. */
export async function chatAtivar(dados: Registro): Promise<Saida> {
  const id = Number(txt(dados.id) || 0);
  if (!id) return falha("sem_regra");
  const ativo = booleano(dados.ativo);
  if (!(await ligarRegra(id, ativo))) return falha("sem_regra");
  return ok({ id, ativo, regras: await listarRegras() });
}

/** O refresco da tela enquanto o robô roda: só banco, sem bater no GreenAPI a cada 6 segundos. */
export async function chatFluxo(dados: Registro, ctx: Contexto): Promise<Saida> {
  const resumo = await resumoChat(ctx.url);
  const conversas = await telefonesConversados(Number(resumo.dias || 90));
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  const aberta = telefone.length >= 10 ? await mensagensDe(telefone) : [];
  return ok({ ...resumo, conversas, conversa: { telefone, mensagens: aberta } });
}

/** Aponta o webhook da instância para esta função: é o que faz o robô receber e o painel
 *  passar a ter prova de entrega em vez de confiar no "aceito" do GreenAPI. */
export async function chatInstalar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const resultado = await instalarWebhook(ctx.url);
  return { status: resultado.ok ? 200 : 502, dados: { ...resultado } };
}

export async function chatConversas(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  return ok({ telefone, mensagens: await mensagensDe(telefone) });
}

export async function chatTreino(): Promise<Saida> {
  const arquivo = await exportarTreino();
  return ok({ csv: arquivo.csv, nome: arquivo.nome, n: arquivo.n });
}
