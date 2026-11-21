// As ações do painel sem Render: é rota por rota do painel_web.py, mas devolvendo JSON
// para o Pages. As frases em português ficam no front; daqui só saem os códigos.
import {
  chaveAvisadas,
  dadosDoCliente,
  espelharLinhas,
  listarClientes,
  listarClientesPagina,
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
  desbloquear,
  estaBloqueado,
  listarBloqueados,
  telefonesBloqueados,
} from "./bloqueados.ts";
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
  novaRegra, renderizar, resumoChat, salvarRegra, telefonesConversados, tokenChat,
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
  pularEnvios,
  proximoItem,
  registrarItem,
  resumoLote,
  retomarLote,
  tirarDaFila,
  verLote,
  type Item,
  type TipoLote,
} from "./lote.ts";
import { avisarRenovacao, avisarVencimentos, fichaPara } from "./varredura.ts";
import {
  adicionarBarbeiro, agendamentosDe, agendamentosParaTela, apagarBarbeiro, catalogo, clientesDoBarbeiro,
  contaDeTelefone, conversasBarbearia, exportarBarbeiros, exportarConversasBarbearia, fecharBarbeiro,
  filaTreinoBarbearia, importarBarbeiros, importarPaginaAppBarber, lancamentosDe, lembretesDoDia, ligarBarbeiro, listarBarbeiros,
  listarInteressados, mensagensDoBarbeiro, montarFila, obterTextos, proximoDaFila, resumoBarbearia,
  rotearWebhook, salvarTextos, statusFila, enviarParaBarbeiro, bomDiaTodos,
  limparFila as barbLimparFila,
  tirarDaFila as barbTirarDaFila,
  TRIAL_DIAS_PADRAO,
} from "./barbearia.ts";
import { publicarFoto, publicarPagina, publicarPainelBarbearia } from "./estabelecimento.ts";
import { escreverCsv, lerCsv } from "./csv.ts";
import { gravarPix, parsearPix } from "./pix.ts";
import {
  b64ParaBytes,
  bytesParaB64,
  BRAZIL_OFFSET_MS,
  type ClienteMensagem,
  formatarBrasilia,
  formatarTelefone,
  legendaAviso,
  legendaRecuperar,
  normalizarWhatsapp,
  parseDataBr,
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

/** Quem está na aba Bloqueados não recebe nada nem pelo botão de um só: a resposta dele foi um
 *  "não", e insistir é o que leva a instância do WhatsApp a bloqueio. */
async function travaBloqueado(telefone: string): Promise<Saida | null> {
  if (telefone && (await estaBloqueado(telefone))) {
    return falha("bloqueado", 409, { telefone: formatarTelefone(telefone) });
  }
  return null;
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
  // A prévia é do primeiro da lista, para ele ver o nome que realmente sairia.
  const prever = itens.length
    ? await fichaPara(String(itens[0].username), String(itens[0].exp_date), String(itens[0].telefone || ""))
    : {};
  return ok({
    itens,
    limite,
    mostrar_todos: mostrarTodos,
    previa_dias: textoDias,
    previa: await previaAvisoEmB64(conf, textoDias),
    // A legenda já sai montada daqui: a tela mostra exatamente o texto que o envio usaria,
    // sem precisar conhecer aviso_legenda e aviso_pix_key por fora.
    previa_legenda: legendaAviso(conf, textoDias, prever),
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
    ultimo = await enviarArquivo(conf, telefone, imagem, "aviso-vencimento.png",
      legendaAviso(conf, linha.texto_dias, await fichaPara(linha.username, linha.exp_date, telefone)));
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
  // Com termo de busca a régua é o espelho da aba Clientes: só ele tem nome, CPF e telefone —
  // a busca do painel MC alcança no máximo o usuário. Sem termo, a página vem do MC, como sempre.
  if (busca) {
    const espelho = await listarClientesPagina(pagina, busca);
    return ok({
      linhas: espelho.linhas.map((l) => ({
        ...l,
        id: l.linha_id,
        senha: "",
      })),
      telefones,
      pagina: espelho.info.pagina,
      info: {
        pagina: espelho.info.pagina,
        paginas: espelho.info.paginas,
        total: espelho.info.encontrados,
        exato: true,
      },
      sem_token: false,
      fonte: "espelho",
      na_base: espelho.info.na_base,
      lines_status: "espelho",
    });
  }
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

export async function clientesVer(dados: Registro): Promise<Saida> {
  return ok(await listarClientesPagina(Number(dados.pagina || 1), txt(dados.q)));
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

/** A lista colada com o CPF de cada um. O CPF não mora em mc_linhas porque a varredura do MC
 *  reescreve aquela tabela; ele fica em cliente_pix, só nosso. Linha com erro é devolvida no
 *  modal e não entra. */
export async function clientesImportarPix(dados: Registro, ctx: Contexto): Promise<Saida> {
  const { linhas, erros } = parsearPix(String(dados.texto || ""));
  if (!linhas.length && !erros.length) return falha("csv_vazio");
  const importados = await gravarPix(linhas);
  await gravarEvento({
    event_type: "painel_clientes_pix",
    status_code: 200,
    // Sem o texto colado no log: CPF e telefone não vão para mcapi_events.
    request_payload: { coladas: linhas.length + erros.length },
    response_payload: { importados, erros: erros.length },
    client_ip: ctx.ip,
  });
  return ok({ importados, erros });
}

function parseStatus(texto: string): number {
  return ["1", "ativo", "true", "on"].includes(semAcento(texto).toLowerCase()) ? 1 : 0;
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
  // O cliente do exemplo é de mentira de propósito: é ele que mostra o {nome}, o {vence} e o
  // {link} trocados sem depender de existir alguém vencido na base. O {link} também é falso —
  // criar link de verdade a cada abertura da aba loteria o encurtador. No envio, quem põe o
  // link real é linkRecuperacao().
  const exemplo = {
    usuario: "r7000000007",
    nome: "Maria da Silva",
    telefone: "11999998888",
    status: 0,
    expira: new Date(Date.now() - 34 * 86_400_000),
  };
  return ok({
    conf: resumoConfig(conf),
    exemplo: legendaRecuperar(conf, exemplo,
      `${baseEncurtador()}/${slugRecuperacao(exemplo.usuario, exemplo.telefone)}`),
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
  const travado = await travaBloqueado(telefone);
  if (travado) return travado;

  let expira = parseExpDate(txt(dados.exp_iso));
  let fonte = txt(dados.destino) === "clientes" ? "espelho" : "linha";
  if (!expira) {
    expira = await expiraDoEspelho(username);
    fonte = expira ? "espelho" : "nenhuma";
  }
  const horas = expira ? (expira.getTime() - Date.now()) / 3_600_000 : 0;
  const dias = textoVencido(horas);
  // O número continua sendo o da agenda (é dele que o botão sempre dependeu); a ficha só entra
  // para dar nome, situação e a data gravada ao texto.
  const ficha = await dadosDoCliente(username);
  const cliente: ClienteMensagem = {
    usuario: username,
    nome: ficha.nome || "",
    telefone,
    status: ficha.status ?? null,
    expira: expira || ficha.expira || null,
  };
  const link = await linkRecuperacao(username, telefone);
  await registrarLink(link.slug, username, telefone);
  const resultado = await enviarRecuperacao(conf, telefone, legendaRecuperar(conf, cliente, link.url));
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
 *  sistema" de propósito: é melhor o texto honesto do que uma data velha passando por verdade.
 *  O nome vem da ficha (é a mesma régua das outras abas), porque sem ele o texto mandado em massa
 *  não teria como dizer "Oi {{primeiro}}". */
async function corpoMensagem(
  texto: string,
  username: string,
  telefone: string,
  conf: Conf,
  expira: Date | null,
): Promise<string> {
  const ficha = username ? await dadosDoCliente(username) : null;
  const cliente = { usuario: username, telefone, nota: ficha?.nome || "", status: Number(ficha?.status ?? 0), expira };
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
  const travado = await travaBloqueado(telefone);
  if (travado) return travado;

  // A data que a linha tinha na tela: sem ela {{vence}} mentiria para quem ainda tem linha no MC.
  const resultado = await enviarTexto(
    conf, telefone, await corpoMensagem(texto, username, telefone, conf, parseExpDate(txt(dados.exp_iso))),
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
): Promise<{ ok: boolean; erro?: string; parar?: string; marca?: string; info: Registro }> {
  const conf = await obterConfig();
  const username = String(item.username || ""), telefone = String(item.telefone || "");
  if (!conf) return { ok: false, erro: `${username}: config ausente`, info: { username } };
  const texto = String(item.texto || "").trim();
  if (!texto) return { ok: false, erro: `${username}: a mensagem sumiu do plano`, parar: "sem_texto", info: { username } };
  if (!telefone) return { ok: false, erro: `${username}: sem telefone`, info: { username } };
  // A fila é congelada quando ele aperta, e um "não" no meio do caminho também bloqueia.
  if (await estaBloqueado(telefone)) return { ok: true, marca: "bloqueado", info: { username, bloqueado: true } };

  let resultado: ResultadoEnvio;
  try {
    resultado = await enviarTexto(
      conf, telefone, await corpoMensagem(texto, username, telefone, conf, parseExpDate(txt(item.expira))),
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
  const bloqueados = await telefonesBloqueados();
  const recentes = new Set(
    (await consultar(`select username from public.renovacao_avisos where updated_at > now() - interval '3 hours'`))
      .rows.map((r: Record<string, unknown>) => String(r.username)),
  );
  // Quem nunca teve linha no painel MC (importado por CSV) só existe no espelho da aba Clientes.
  if (txt(dados.fonte) === "espelho") return contagemDoEspelho(busca, pular, telefones, recentes, conf, bloqueados);

  const info = await tokenDoPainel(ctx.ip);
  if (!info.ok) return falha("mc_login", 502);

  const vencidasNoEspelho = new Set(
    (await consultar(`select username from public.mc_linhas where exp_date is not null and exp_date <= now()`))
      .rows.map((r: Record<string, unknown>) => String(r.username)),
  );

  const varrida = await varrerMc(info.token || "", busca, (l) => l.vencido);
  const alvos: Item[] = [];
  let semTelefone = 0, pulados = 0, esperando = 0, foraDaBase = 0;
  for (const linha of varrida.escolhidas) {
    const telefone = telefones[linha.username] || "";
    if (pular.has(linha.username)) pulados++;
    else if (!telefone) semTelefone++;
    else if (bloqueados.has(normalizarWhatsapp(telefone))) foraDaBase++;
    else if (recentes.has(linha.username)) esperando++;
    else alvos.push({ username: linha.username, telefone, exp_iso: linha.exp_iso, busca });
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
    bloqueados: foraDaBase,
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
  bloqueados: Set<string>,
): Promise<Saida> {
  const r = await consultar(
    `select username, telefone, exp_date, linha_id from public.mc_linhas
      where exp_date is not null and exp_date <= now()
        and ($1 = '' or username ilike '%' || $1 || '%')
      order by username`,
    [busca],
  );
  const alvos: Item[] = [];
  let semTelefone = 0, pulados = 0, esperando = 0, semLinha = 0, foraDaBase = 0;
  for (const linha of r.rows as Record<string, unknown>[]) {
    const username = String(linha.username || "");
    if (!String(linha.linha_id || "")) semLinha++;
    if (pular.has(username)) pulados++;
    else {
      const telefone = telefones[username] || String(linha.telefone || "");
      if (!telefone) semTelefone++;
      else if (bloqueados.has(normalizarWhatsapp(telefone))) foraDaBase++;
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
    bloqueados: foraDaBase,
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
  const bloqueados = await telefonesBloqueados();
  const recentes = new Set(
    (await consultar(`select username from public.renovacao_avisos where updated_at > now() - interval '3 hours'`))
      .rows.map((r: Record<string, unknown>) => String(r.username)),
  );

  const alvos: Item[] = [];
  let semTelefone = 0, pulados = 0, esperando = 0, comLinha = 0, semLinha = 0, foraDaBase = 0;
  for (const linha of linhas) {
    if (busca && !linha.username.toLowerCase().includes(busca.toLowerCase())) continue;
    if (linha.linha_id) comLinha++;
    else semLinha++;
    if (quem === "fora" && linha.linha_id) continue;
    if (pular.has(linha.username)) pulados++;
    else if (!linha.telefone) semTelefone++;
    else if (bloqueados.has(normalizarWhatsapp(linha.telefone))) foraDaBase++;
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
    bloqueados: foraDaBase,
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

  let resultado: { ok: boolean; erro?: string; parar?: string; marca?: string; info: Registro };
  if (tipo === "apagar") resultado = await itemApagar(proximo.item, ctx);
  else if (tipo === "mensagem") resultado = await itemMensagem(proximo.item, ctx);
  else resultado = await itemRecuperar(proximo.item, ctx);
  const estado = await registrarItem(tipo, {
    ok: resultado.ok,
    erro: resultado.erro,
    ...(resultado.marca ? { marca: resultado.marca } : {}),
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
): Promise<{ ok: boolean; erro?: string; parar?: string; marca?: string; info: Registro }> {
  const conf = await obterConfig();
  const username = String(item.username || ""), telefone = String(item.telefone || "");
  if (!conf) return { ok: false, erro: `${username}: config ausente`, info: { username } };

  // Quem pediu para não receber também está fora da fila que já foi congelada: o "não" dele
  // pode ter chegado depois de o lote começar.
  if (telefone && await estaBloqueado(telefone)) {
    return { ok: true, marca: "bloqueado", info: { username, bloqueado: true } };
  }

  const expira = parseExpDate(String(item.exp_iso || ""));
  const horas = expira ? (expira.getTime() - Date.now()) / 3_600_000 : 0;
  const dias = textoVencido(horas);
  const ficha = await dadosDoCliente(username);
  const cliente: ClienteMensagem = {
    usuario: username,
    nome: ficha.nome || "",
    telefone,
    status: ficha.status ?? null,
    expira: expira || ficha.expira || null,
  };
  const link = await linkRecuperacao(username, telefone);
  await registrarLink(link.slug, username, telefone);
  let resultado: ResultadoEnvio;
  try {
    resultado = await enviarRecuperacao(conf, telefone, legendaRecuperar(conf, cliente, link.url));
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
 *  "Não recuperados": quem falhou continua visível mesmo depois que o envio acaba.
 *
 *  Vem uma JANELA, não o plano inteiro. Com 17.286 linhas na fila a lista inteira pesava 2,45 MB e
 *  a tela pedia isso a cada 4 segundos enquanto o lote corria — sozinho, isso estourou os 5 GB de
 *  banda do plano grátis do Supabase. As contagens continuam sendo do plano todo. */
const JANELA_PADRAO = 150;
const JANELA_MAXIMA = 400;

export async function loteFila(dados: Registro): Promise<Saida> {
  const tipo = tipoLote(dados.tipo);
  const vista = await verLote(tipo);
  if (!vista || !vista.plano.length) {
    return ok({
      vazia: true, itens: [], estado: estadoVazio(0), na_fila: 0, fora: 0, pulados: 0,
      bloqueados: 0, total: 0, mostraveis: 0, desde: 0, ate: 0,
    });
  }
  const { plano, estado } = vista;
  const resultados = estado.resultados || {};
  const soErro = dados.so_erro === true || dados.so_erro === "true";
  const janela = Math.min(JANELA_MAXIMA, Math.max(JANELA_PADRAO, Math.trunc(Number(dados.janela) || JANELA_PADRAO)));
  const noAr = typeof estado.enviando === "number" ? estado.enviando : estado.indice;
  let naFila = 0, fora = 0, foraDaBase = 0, pulados = 0;
  // Primeira passada: só a situação de cada linha, sem montar texto nenhum. É ela que conta o
  // plano inteiro; o que sai para o navegador é só o recorte de baixo.
  const linhas = plano.map((item, i) => {
    const marca = resultados[String(i)];
    const saiu = foraDaFila(item);
    const pulou = saiu && item.pulado === true;
    if (pulou) pulados += 1;
    else if (saiu) fora += 1;
    else if (!marca) naFila += 1;
    const bloqueado = marca?.marca === "bloqueado";
    if (bloqueado) foraDaBase += 1;
    return {
      i,
      situacao: marca ? (bloqueado ? "bloqueado" : marca.ok ? "enviado" : "falhou")
        : pulou ? "pulou" : saiu ? "fora" : (estado.rodando && noAr === i) ? "enviando" : "fila",
      erro: marca && !marca.ok && !bloqueado ? String(marca.erro || "") : "",
    };
  });
  const candidatas = soErro ? linhas.filter((l) => l.situacao === "falhou") : linhas;
  // A janela anda com o envio: um terço de histórico para trás e o resto à frente, para ele ver o
  // que acabou de sair e o que vem. Nos erros a lista já é curta e começa do mesmo jeito de antes.
  const inicio = soErro || candidatas.length <= janela
    ? 0
    : Math.max(0, Math.min(noAr - Math.floor(janela / 3), candidatas.length - janela));
  const recorte = candidatas.slice(inicio, inicio + janela);
  const nomes = recorte.map((l) => txt(plano[l.i].username) || txt(plano[l.i].usuario));
  const entregas = await entregasPorUsuario(nomes);
  const itens = recorte.map((l, pos) => {
    const item = plano[l.i];
    return {
      i: l.i,
      usuario: nomes[pos],
      telefone: formatarTelefone(txt(item.telefone)),
      vencido: textoDoItem(item) || txt(item.intervalo),
      quem: txt(item.quem),
      situacao: l.situacao,
      erro: l.erro,
      entrega: entregas[nomes[pos]] || "",
    };
  });
  return ok({
    vazia: false,
    itens,
    // O `resultados` fica em casa: com o lote todo percorrido ele é 17.000 marcas, e a tela já
    // recebeu o que aconteceu de cada linha dentro de `itens`.
    estado: {
      rodando: estado.rodando,
      enviados: estado.enviados,
      falhas: estado.falhas,
      erros: estado.erros,
      indice: estado.indice,
      total: estado.total,
      seguidas: estado.seguidas,
      enviando: estado.enviando,
      motivo: estado.motivo,
    },
    fonte: tipo === "mensagem"
      ? (plano.length && plano[0].quem === "todos" ? "todos" : "fora")
      : (plano.length && plano[0].fonte === "espelho" ? "espelho" : "mc"),
    na_fila: naFila,
    fora,
    pulados,
    bloqueados: foraDaBase,
    total: plano.length,
    mostraveis: candidatas.length,
    desde: recorte.length ? recorte[0].i : 0,
    ate: recorte.length ? recorte[recorte.length - 1].i + 1 : 0,
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

/** O campo "pular envios" da tela da fila. Funciona com o lote rodando — é justamente para
 *  agora: os próximos N que ainda não saíram são pulados de uma vez, sem enviar, sem apagar
 *  e sem parar o que está no ar. */
export async function lotePular(dados: Registro, ctx: Contexto): Promise<Saida> {
  const tipo = tipoLote(dados.tipo);
  const quantos = Math.trunc(Number(dados.quantos));
  if (!Number.isFinite(quantos) || quantos < 1) return falha("quantidade_invalida");
  if (quantos > 2000) return falha("muita_marca");
  const pulo = await pularEnvios(tipo, quantos);
  if (!pulo.ok) return falha(pulo.erro || "plano_vazio", 409);
  await gravarEvento({
    event_type: eventoLote(tipo, "pular"),
    status_code: 200,
    request_payload: { tipo, pediu: quantos },
    response_payload: { pulados: pulo.pulados },
    client_ip: ctx.ip,
  });
  return ok({ pulados: pulo.pulados, pediu: quantos, estado: await resumoLote(tipo) });
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
 *  corpo é a mensagem do cliente — não há onde encaixar o nosso token ali.
 *
 *  É também a única porta das duas bases: `rotearWebhook` olha o número e decide se a conversa
 *  é do robô das barbearias ou do do Peixeiro. Quem não é barbearia segue exatamente o
 *  caminho de sempre, linha por linha. */
export async function chatWebhook(dados: Registro, ctx: Contexto): Promise<Saida> {
  const saida = await rotearWebhook(dados, ctx.query.token || txt(dados.token));
  return { status: saida.status, dados: saida.dados as Registro };
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

/** Liga/desliga o robô, muda a retenção das conversas, decide se responde quem não é cliente e
 *  grava a resposta de quem diz "não" (texto vazio é o recurso desligado). */
export async function chatLigar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const campos: { ativo?: boolean; dias?: number; desconhecido?: boolean; nao?: string } = {};
  if ("ativo" in dados) campos.ativo = booleano(dados.ativo);
  if ("desconhecido" in dados) campos.desconhecido = booleano(dados.desconhecido);
  if ("nao" in dados) campos.nao = txt(dados.nao);
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

// ------------------------------------------------------------------ bloqueados

/** A lista da aba Bloqueados. `q` é a mesma régua da aba Clientes: letra procura nome/usuário/
 *  motivo, número procura telefone com ponto, traço ou sem o 55. */
export async function bloqueadosVer(dados: Registro): Promise<Saida> {
  return ok(await listarBloqueados(txt(dados.q)));
}

/** Devolve o número para as filas: o robô volta a responder e o lote "Não recuperados" volta a
 *  alcançar. Só um DELETE nesta linha, sem tocar em nada do painel MC. */
export async function bloqueadosDesbloquear(dados: Registro, ctx: Contexto): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  if (!(await desbloquear(telefone))) return falha("nao_esta_bloqueado", 409, { telefone: formatarTelefone(telefone) });
  await gravarEvento({
    event_type: "cliente_desbloqueado",
    status_code: 200,
    request_payload: { telefone },
    response_payload: {},
    client_ip: ctx.ip,
  });
  return ok({ telefone: formatarTelefone(telefone), ...await listarBloqueados("") });
}

// ------------------------------------------------------------------ barbearias
// As rotas da segunda base. Nada daqui lê as tabelas do painel MC: o que entra e o que sai
// é `barber_*`, e a chave de tudo é o telefone da barbearia.

/** A abordagem e o menu das barbearias passam de 1200 letras; o teto delas é o do WhatsApp. */
const BARB_MAX_TEXTO = 4000;

function barbTexto(valor: unknown): string {
  return String(valor ?? "").slice(0, BARB_MAX_TEXTO);
}

async function barbContaParaTela(telefone: string): Promise<Registro> {
  const conta = await contaDeTelefone(telefone);
  if (!conta) return {};
  return {
    telefone: conta.telefone,
    nome: conta.nome,
    nota: conta.nota,
    ativo: conta.ativo,
    expira: conta.expira ? formatarBrasilia(conta.expira) : "",
    criado: conta.criado_em ? formatarBrasilia(conta.criado_em) : "",
    slug: conta.slug,
    endereco: conta.endereco,
    cidade: conta.cidade,
    uf: conta.uf,
    cep: conta.cep,
    telefone_publico: conta.telefone_publico,
    mostra_barbeiro: conta.mostra_barbeiro,
    publicado: conta.publicado_em ? formatarBrasilia(conta.publicado_em) : "",
  };
}

export async function barbVer(_dados: Registro, _ctx: Contexto): Promise<Saida> {
  return ok(await resumoBarbearia());
}

/** Um campo por vez: a tela que grava o menu não escreve vazio na abordagem. */
export async function barbSalvar(dados: Registro, _ctx: Contexto): Promise<Saida> {
  const campos: Registro = {};
  for (const chave of [
    "menu", "abordagem", "boas_vindas", "lembrete", "aviso_cliente", "msg_interesse", "msg_vencido",
    "boas_vindas_site", "aviso_novo_site", "ajuda_funcionario",
  ]) {
    if (chave in dados) campos[chave] = barbTexto(dados[chave]);
  }
  for (const chave of ["dias_retencao", "trial_dias", "lembrete_hora"]) {
    if (chave in dados) campos[chave] = dados[chave];
  }
  for (const chave of ["ativo", "responder_controle"]) {
    if (chave in dados) campos[chave] = booleano(dados[chave]);
  }
  const gravado = await salvarTextos(campos);
  if (!gravado.ok) return falha(gravado.error === "numero" ? "numero" : "nada_gravar");
  return ok(await resumoBarbearia());
}

export async function barbContas(dados: Registro): Promise<Saida> {
  const pagina = Math.max(1, Number(txt(dados.pagina) || 1));
  return ok(await listarBarbeiros(pagina, txt(dados.q)));
}

/** Telefone e nome bastam: o teste de um dia começa nesta chamada, e readicionar não apaga o
 *  histórico de quem já era barbearia. */
export async function barbContaAdicionar(dados: Registro, ctx: Contexto): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  const dias = Number(txt(dados.dias) || 0);
  const criado = await adicionarBarbeiro(telefone, txt(dados.nome), txt(dados.nota), dias || TRIAL_DIAS_PADRAO);
  if (!criado.ok) return falha("telefone_invalido");
  await gravarEvento({
    event_type: criado.novo ? "barbearia_criada" : "barbearia_readicionada",
    status_code: 200,
    request_payload: { telefone, nome: txt(dados.nome) },
    response_payload: {},
    client_ip: ctx.ip,
  });
  const aviso = booleano(dados.avisar ?? true) && criado.novo;
  const boas = aviso ? await enviarParaBarbeiro(telefone, (await obterTextos()).boas_vindas) : null;
  return ok({
    ...await listarBarbeiros(1, ""),
    conta: await barbContaParaTela(telefone),
    novo: criado.novo,
    boas_vindas: boas ? { ok: boas.ok, simulado: boas.simulado, erro: boas.error || "" } : null,
  });
}

export async function barbContaLigar(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  if (!(await ligarBarbeiro(telefone, booleano(dados.ativo)))) return falha("sem_barbearia", 404);
  return ok({ conta: await barbContaParaTela(telefone) });
}

/** Fim do teste: o vencimento passa a valer os dias do plano que ele fechou. */
export async function barbContaFechar(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  const dias = Number(txt(dados.dias) || 30);
  if (!Number.isFinite(dias)) return falha("numero");
  if (!(await fecharBarbeiro(telefone, dias))) return falha("sem_barbearia", 404);
  return ok({ conta: await barbContaParaTela(telefone) });
}

/** A única rota desta aba que destrói alguma coisa: leva a conta e as tabelas dela, e só
 *  dela. Pediu a palavra escrita, como o painel já faz com as linhas do MC. */
export async function barbContaApagar(dados: Registro, ctx: Contexto): Promise<Saida> {
  if (txt(dados.confirmar).toLowerCase() !== "apagar") return falha("confirme_apagar", 409);
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  const feito = await apagarBarbeiro(telefone);
  await gravarEvento({
    event_type: "barbearia_apagada",
    status_code: 200,
    request_payload: { telefone },
    response_payload: feito,
    client_ip: ctx.ip,
  });
  return ok({ apagado: feito, ...await listarBarbeiros(1, "") });
}

export async function barbContaExportar(): Promise<Saida> {
  return ok(await exportarBarbeiros());
}

export async function barbContaImportar(dados: Registro): Promise<Saida> {
  const dias = Number(txt(dados.dias) || 0);
  const feito = await importarBarbeiros(barbTexto(dados.texto), dias || TRIAL_DIAS_PADRAO);
  return ok({ ...feito, ...await listarBarbeiros(1, "") });
}

export async function barbPaginaImportar(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  const feito = await importarPaginaAppBarber(
    telefone,
    txt(dados.url),
    typeof dados.conteudo === "string" ? dados.conteudo : "",
    Array.isArray(dados.fotos) ? dados.fotos : [],
    Array.isArray(dados.imagens) ? dados.imagens : [],
  );
  if (!feito.ok) {
    const erro = feito.erro === "url_appbarber" ? "url_appbarber"
      : feito.erro?.startsWith("pagina_http") ? "pagina_inacessivel"
      : "banco";
    return falha(erro, 502);
  }
  return ok({
    importado: true,
    ...feito,
    ...await listarBarbeiros(1, ""),
  });
}

export async function barbPaginaPublicar(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  const feito = await publicarPagina(telefone);
  if (!feito.ok) return falha(String(feito.erro || "banco"), 502);
  return ok(feito);
}

async function barbPainelValidar(dados: Registro): Promise<{ telefone: string; slug: string } | null> {
  const chave = txt(dados.chave).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const slug = txt(dados.slug).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  if (chave.length < 20 || !slug) return null;
  const linha = await consultar1(
    `select p.telefone, c.slug
       from public.barber_painel p
       join public.barber_contas c on c.telefone = p.telefone
      where p.chave = $1 and p.ativo and c.slug = $2 limit 1`,
    [chave, slug],
  );
  if (!linha) return null;
  return { telefone: String(linha.telefone || ""), slug };
}

export async function barbPainelGerar(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  const conta = await contaDeTelefone(telefone);
  if (!conta) return falha("sem_barbearia", 404);
  const chave = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  await consultar(
    `insert into public.barber_painel (telefone, chave, ativo, criado_em, atualizado_em)
     values ($1, $2, true, now(), now())
     on conflict (telefone) do update set chave = excluded.chave, ativo = true,
       atualizado_em = now()`,
    [telefone, chave],
  );
  const publicado = await publicarPainelBarbearia(telefone, chave);
  if (!publicado.ok) return falha(publicado.erro || "banco", 502);
  await publicarPagina(telefone);
  return ok({ chave, url: publicado.url });
}

export async function barbPainelVer(dados: Registro): Promise<Saida> {
  const acesso = await barbPainelValidar(dados);
  if (!acesso) return falha("acesso_painel_invalido", 403);
  const conta = await contaDeTelefone(acesso.telefone);
  if (!conta) return falha("sem_barbearia", 404);
  const cat = await catalogo(acesso.telefone);
  const horarios = await consultar(
    `select dia, to_char(abre, 'HH24:MI') as abre, to_char(fecha, 'HH24:MI') as fecha
       from public.barber_horario where telefone = $1 order by dia`,
    [acesso.telefone],
  );
  const pagamentos = await consultar(
    `select id, nome, detalhe, ordem from public.barber_pagamento
      where telefone = $1 order by ordem, nome`,
    [acesso.telefone],
  );
  const fotos = await consultar(
    `select id, arquivo, legenda, ordem from public.barber_foto
      where telefone = $1 order by ordem, id`,
    [acesso.telefone],
  );
  return ok({
    conta: await barbContaParaTela(acesso.telefone),
    servicos: cat.servicos,
    produtos: cat.produtos,
    horarios: horarios.rows,
    pagamentos: pagamentos.rows,
    fotos: fotos.rows,
  });
}

export async function barbPainelSalvar(dados: Registro): Promise<Saida> {
  const acesso = await barbPainelValidar(dados);
  if (!acesso) return falha("acesso_painel_invalido", 403);
  const telefone = acesso.telefone;
  if ("nome" in dados || "telefone_publico" in dados || "endereco" in dados) {
    const nome = txt(dados.nome).trim().slice(0, 120);
    const telefonePublico = txt(dados.telefone_publico).trim();
    const endereco = txt(dados.endereco).trim().slice(0, 200);
    await consultar(
      `update public.barber_contas
          set nome = coalesce(nullif($2, ''), nome),
              telefone_publico = coalesce(nullif($3, ''), telefone_publico),
              endereco = coalesce(nullif($4, ''), endereco),
              atualizado_em = now()
        where telefone = $1`,
      [telefone, nome, telefonePublico, endereco],
    );
  }
  if (txt(dados.acao) === "servico" && txt(dados.nome)) {
    const preco = Number(txt(dados.preco) || 0);
    const duracao = Math.max(10, Math.min(600, Number(txt(dados.duracao_min) || 30)));
    await consultar(
      `insert into public.barber_servico (telefone, nome, preco, duracao_min, ativo)
       values ($1, $2, $3, $4, true)
       on conflict (telefone, lower(nome)) do update
         set preco = excluded.preco, duracao_min = excluded.duracao_min,
             ativo = true, atualizado_em = now()`,
      [telefone, txt(dados.nome).trim().slice(0, 120), preco, duracao],
    );
  }
  if (txt(dados.acao) === "produto" && txt(dados.nome)) {
    const preco = Number(txt(dados.preco) || 0);
    await consultar(
      `insert into public.barber_produto (telefone, nome, preco, ativo)
       values ($1, $2, $3, true)
       on conflict (telefone, lower(nome)) do update
         set preco = excluded.preco, ativo = true, atualizado_em = now()`,
      [telefone, txt(dados.nome).trim().slice(0, 120), preco],
    );
  }
  if (txt(dados.acao) === "servico_editar") {
    const id = Number(txt(dados.id) || 0);
    if (id) {
      await consultar(
        `update public.barber_servico
            set nome = $3, preco = $4, duracao_min = $5, ativo = $6, atualizado_em = now()
          where id = $1 and telefone = $2`,
        [id, telefone, txt(dados.nome).trim().slice(0, 120),
         Number(txt(dados.preco) || 0),
         Math.max(10, Math.min(600, Number(txt(dados.duracao_min) || 30))),
         !booleano(dados.ativo) ? true : true],
      );
    }
  }
  if (txt(dados.acao) === "servico_apagar") {
    const id = Number(txt(dados.id) || 0);
    if (id) await consultar(`delete from public.barber_servico where id = $1 and telefone = $2`, [id, telefone]);
  }
  if (txt(dados.acao) === "produto_editar") {
    const id = Number(txt(dados.id) || 0);
    if (id) {
      await consultar(
        `update public.barber_produto
            set nome = $3, preco = $4, ativo = true, atualizado_em = now()
          where id = $1 and telefone = $2`,
        [id, telefone, txt(dados.nome).trim().slice(0, 120), Number(txt(dados.preco) || 0)],
      );
    }
  }
  if (txt(dados.acao) === "produto_apagar") {
    const id = Number(txt(dados.id) || 0);
    if (id) await consultar(`delete from public.barber_produto where id = $1 and telefone = $2`, [id, telefone]);
  }
  if (Array.isArray(dados.horarios)) {
    await consultar(`delete from public.barber_horario where telefone = $1`, [telefone]);
    for (const item of dados.horarios as Registro[]) {
      const dia = Number(item.dia);
      const abre = txt(item.abre);
      const fecha = txt(item.fecha);
      if (dia < 0 || dia > 6 || !/^\d{2}:\d{2}$/.test(abre) || !/^\d{2}:\d{2}$/.test(fecha)) continue;
      await consultar(
        `insert into public.barber_horario (telefone, dia, abre, fecha, intervalo)
         values ($1, $2, $3, $4, 30)
         on conflict (telefone, dia) do update set abre = excluded.abre, fecha = excluded.fecha`,
        [telefone, dia, abre, fecha],
      );
    }
  }
  if (Array.isArray(dados.pagamentos)) {
    await consultar(`delete from public.barber_pagamento where telefone = $1`, [telefone]);
    for (let i = 0; i < dados.pagamentos.length; i++) {
      const nome = String(dados.pagamentos[i] ?? "").trim().slice(0, 60);
      if (!nome) continue;
      await consultar(
        `insert into public.barber_pagamento (telefone, nome, detalhe, ordem)
         values ($1, $2, '', $3)`,
        [telefone, nome, i],
      );
    }
  }
  await publicarPagina(telefone);
  return ok({ salvo: true });
}

export async function barbPainelFoto(dados: Registro): Promise<Saida> {
  const acesso = await barbPainelValidar(dados);
  if (!acesso) return falha("acesso_painel_invalido", 403);
  const bruto = txt(dados.b64).replace(/^data:[^;]+;base64,/i, "");
  if (!bruto) return falha("sem_foto");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(bruto), (c) => c.charCodeAt(0));
  } catch {
    return falha("sem_foto");
  }
  if (!bytes.length || bytes.length > 900_000) return falha("foto_grande");
  const gravada = await publicarFoto(acesso.telefone, `foto-${Date.now()}.jpg`, bytes);
  if (!gravada.ok || !gravada.caminho) return falha("banco", 502);
  await consultar(
    `insert into public.barber_foto (telefone, arquivo, legenda, ordem)
     values ($1, $2, '', coalesce((select max(ordem) from public.barber_foto where telefone = $1), 0) + 1)`,
    [acesso.telefone, gravada.caminho],
  );
  await publicarPagina(acesso.telefone);
  return ok({ arquivo: gravada.caminho });
}

export async function barbPainelFotoApagar(dados: Registro): Promise<Saida> {
  const acesso = await barbPainelValidar(dados);
  if (!acesso) return falha("acesso_painel_invalido", 403);
  const id = Number(txt(dados.id) || 0);
  if (!id) return falha("sem_foto");
  await consultar(`delete from public.barber_foto where id = $1 and telefone = $2`, [id, acesso.telefone]);
  await publicarPagina(acesso.telefone);
  return ok({ apagado: true });
}

export async function barbInteressados(): Promise<Saida> {
  return ok({ interessados: await listarInteressados() });
}

/** Tudo de uma barbearia em uma chamada: cada tabela da tela tem o seu botão, e o painel só
 *  precisa de um pedido para montar os sete. */
export async function barbDetalhe(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  const conta = await contaDeTelefone(telefone);
  if (!conta) return falha("sem_barbearia", 404);
  const cat = await catalogo(telefone);
  const desde = new Date(Date.now() - 30 * 86_400_000);
  const ate = new Date(Date.now() + 90 * 86_400_000);
  const [agenda, funcionarios, horarios, pagamentos, fotos, lancamentos, clientes, mensagens] = await Promise.all([
    agendamentosDe(telefone, desde, ate, "", 300),
    consultar(
      `select telefone, nome, cargo, cor, foto_arquivo, na_pagina, ativo, criado_em
         from public.barber_funcionario where barbearia = $1 order by nome, telefone`,
      [telefone],
    ),
    consultar(
      `select dia, to_char(abre, 'HH24:MI') as abre, to_char(fecha, 'HH24:MI') as fecha,
              coalesce(to_char(primeiro, 'HH24:MI'), '') as primeiro, intervalo
         from public.barber_horario where telefone = $1 order by dia`,
      [telefone],
    ),
    consultar(
      `select id, nome, detalhe, ordem from public.barber_pagamento where telefone = $1 order by ordem, nome`,
      [telefone],
    ),
    consultar(
      `select id, arquivo, legenda, ordem, criado_em from public.barber_foto where telefone = $1 order by ordem, id`,
      [telefone],
    ),
    lancamentosDe(telefone, 200),
    clientesDoBarbeiro(telefone, 300),
    mensagensDoBarbeiro(telefone, 200),
  ]);
  return ok({
    conta: await barbContaParaTela(telefone),
    servicos: cat.servicos,
    produtos: cat.produtos,
    pacotes: cat.pacotes,
    lancamentos,
    agendamentos: agendamentosParaTela(agenda),
    clientes,
    mensagens,
    funcionarios: funcionarios.rows,
    horarios: horarios.rows,
    pagamentos: pagamentos.rows,
    fotos: fotos.rows,
  });
}

export async function barbConversas(dados: Registro): Promise<Saida> {
  const dias = Number(txt(dados.dias) || 90);
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  const conversa = telefone.length >= 10 ? await mensagensDoBarbeiro(telefone, 200) : [];
  return ok({
    conversas: await conversasBarbearia(Number.isFinite(dias) ? dias : 90),
    conversa: { telefone, mensagens: conversa },
  });
}

export async function barbConversasExportar(dados: Registro): Promise<Saida> {
  const dias = Number(txt(dados.dias) || 90);
  return ok(await exportarConversasBarbearia(Number.isFinite(dias) ? dias : 90));
}

export async function barbTreino(): Promise<Saida> {
  return ok({ frases: await filaTreinoBarbearia() });
}

/** O "mensagem" da linha: texto dele, variáveis da barbearia, sem link e sem foto. */
export async function barbMensagem(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  const modelo = barbTexto(dados.texto);
  if (!modelo) return falha("sem_texto");
  const envio = await enviarParaBarbeiro(telefone, modelo);
  if (!envio.ok) return falha(envio.error === "bloqueado" ? "bloqueado" : "envio", 502, { detalhe: envio.error || "" });
  return ok({ telefone: formatarTelefone(telefone), simulado: envio.simulado });
}

export async function barbBoasVindas(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (telefone.length < 10) return falha("telefone_invalido");
  const modelo = (await obterTextos()).boas_vindas;
  if (!modelo) return falha("sem_texto");
  const envio = await enviarParaBarbeiro(telefone, modelo);
  if (!envio.ok) return falha(envio.error === "bloqueado" ? "bloqueado" : "envio", 502, { detalhe: envio.error || "" });
  return ok({ telefone: formatarTelefone(telefone), simulado: envio.simulado, texto: envio.texto });
}

// ---------------------------------------------------------------- a fila do disparo

/** Ou ele cola os números, ou manda pegar todas as barbearias guardadas de uma vez. */
export async function barbFilaMontar(dados: Registro): Promise<Saida> {
  const modelo = barbTexto(dados.texto);
  if (!modelo) return falha("sem_texto");
  let telefones = lista(dados.telefones);
  if (booleano(dados.todos) || !telefones.length) {
    const base = await listarBarbeiros(1, "");
    telefones = (base.linhas as Registro[]).map((l) => String(l.telefone || ""));
  }
  const feito = await montarFila(telefones, modelo);
  if (!feito.ok) return falha(String(feito.error || "sem_texto"));
  return ok({ ...feito, ...await statusFila() });
}

export async function barbFilaStatus(): Promise<Saida> {
  return ok(await statusFila());
}

export async function barbFilaProximo(): Promise<Saida> {
  return ok(await proximoDaFila());
}

export async function barbFilaTirar(dados: Registro): Promise<Saida> {
  const telefone = normalizarWhatsapp(txt(dados.telefone));
  if (!(await barbTirarDaFila(telefone))) return falha("nao_esta_na_fila", 409);
  return ok(await statusFila());
}

export async function barbFilaLimpar(): Promise<Saida> {
  return ok({ removidos: await barbLimparFila(), ...await statusFila() });
}

// ----------------------------------------------------------------- o lembrete do dia

/** O botão da tela: roda agora, para toda barbearia com horário marcado hoje. */
export async function barbLembrete(dados: Registro, ctx: Contexto): Promise<Saida> {
  const forcar = booleano(dados.forcar);
  const feito = await lembretesDoDia(forcar);
  await gravarEvento({
    event_type: "barbearia_lembrete",
    status_code: 200,
    request_payload: { forcar },
    response_payload: feito,
    client_ip: ctx.ip,
  });
  return { status: Number(feito.ok) ? 200 : 500, dados: { ...feito } };
}

export async function barbBomDia(dados: Registro, ctx: Contexto): Promise<Saida> {
  const feito = await bomDiaTodos(booleano(dados.forcar));
  await gravarEvento({
    event_type: "barbearia_bom_dia_manual",
    status_code: 200,
    request_payload: { forcar: booleano(dados.forcar) },
    response_payload: feito,
    client_ip: ctx.ip,
  });
  return ok(feito);
}

/** A chamada do cron: a chave é o `aviso_token` do banco, o mesmo do aviso de vencimento,
 *  porque é a mesma pessoa agendando as duas coisas. */
export async function barbCron(dados: Registro, ctx: Contexto): Promise<Saida> {
  const conf = await obterConfig();
  const esperado = String(conf?.aviso_token || "").trim();
  if (!esperado) return falha("sem_token", 503);
  if (txt(dados.token) !== esperado) return falha("token", 401);
  const hora = new Date(Date.now() - BRAZIL_OFFSET_MS).getUTCHours();
  const textos = await obterTextos();
  const forcar = booleano(dados.reenviar);
  if (!forcar && hora < Number(textos.lembrete_hora || 8)) {
    return ok({ ok: true, ignorado: "antes da hora do lembrete", hora_brasilia: hora });
  }
  const bomDia = await bomDiaTodos(forcar);
  const feito = await lembretesDoDia(forcar);
  await gravarEvento({
    event_type: "barbearia_cron_lembrete",
    status_code: 200,
    request_payload: { forcar },
    response_payload: { bom_dia: bomDia, lembrete_agenda: feito, hora_brasilia: hora },
    client_ip: ctx.ip,
  });
  return ok({ bom_dia: bomDia, lembrete_agenda: feito, hora_brasilia: hora });
}
