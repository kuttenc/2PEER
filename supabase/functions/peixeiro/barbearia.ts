// O segundo robô da mesma instância de WhatsApp: o controle das barbearias.
//
// A regra que segura o ecossistema inteiro aqui é uma só: número que tem linha em
// `barber_contas` conversa com ESTE robô, e o do Peixeiro nem é chamado. Todo o resto cai em
// `receberWebhook`, que continua igual ao que era antes, linha por linha. As tabelas são
// separadas (`barber_*`, chaveada pelo telefone do barbeiro) e nenhuma consulta daqui lê
// `mc_linhas`, `cliente_pix` ou `painel_links`.
import { estaBloqueado, bloquear, MOTIVO_NAO } from "./bloqueados.ts";
import { type Conf, obterConfig } from "./banco.ts";
import { aleatorio, consultar, consultar1, igual } from "./db.ts";
import {
  clientePorTelefone,
  interpretar,
  interpretarStatus,
  receberWebhook,
  tokenChat,
  type StatusEntrega,
} from "./chat.ts";
import { escreverCsv } from "./csv.ts";
import { baixarMidia, enviarTexto, type ResultadoEnvio } from "./greenapi.ts";
import { diasConsecutivosEntregues } from "../_shared/barber-reminder-pause.mjs";
import { interpretarRetornoPagamento } from "../_shared/barber-payment-feedback.mjs";
import { parseComandoRenovacao } from "../_shared/barber-renewal.mjs";
import {
  baseDoSite,
  dadosDaPagina,
  htmlDaPagina,
  horarioNoAlmoco,
  publicarFoto,
  publicarPagina,
  publicarPainelBarbearia,
  redirecionarPaginaAntiga,
  slugDe,
  slugValido,
  vagasDoDia,
} from "./estabelecimento.ts";
import {
  BRAZIL_OFFSET_MS,
  formatarBrasilia,
  formatarTelefone,
  nomeAproveitavel,
  normalizarWhatsapp,
  preencherVariaveis,
  semAcento,
  telefoneValido,
  textoVencido,
  variaveisMensagem,
  type ClienteMensagem,
} from "./texto.ts";

type Bruto = Record<string, unknown>;

export const TRIAL_DIAS_PADRAO = 1;
const PAGINA_CONTAS = 900;

// ------------------------------------------------------------------- os textos do robô

export type Textos = {
  ativo: boolean;
  responder_controle: boolean;
  dias_retencao: number;
  trial_dias: number;
  lembrete_hora: number;
  menu: string;
  abordagem: string;
  boas_vindas: string;
  lembrete: string;
  aviso_cliente: string;
  msg_interesse: string;
  msg_vencido: string;
  // A página: o texto que explica os comandos quando o salão é criado, o aviso curto de
  // "está no ar" e o que o robô diz para o funcionário que corta lá.
  boas_vindas_site: string;
  aviso_novo_site: string;
  ajuda_funcionario: string;
  renovar_admin_telefone: string;
};

const COLUNAS_TEXTOS = `ativo, responder_controle, dias_retencao, trial_dias, lembrete_hora,
  menu, abordagem, boas_vindas, lembrete, aviso_cliente, msg_interesse, msg_vencido,
  boas_vindas_site, aviso_novo_site, ajuda_funcionario, renovar_admin_telefone`;

export async function obterTextos(): Promise<Textos> {
  const linha = await consultar1(`select ${COLUNAS_TEXTOS} from public.barber_config where id = 1`);
  if (!linha) {
    return {
      ativo: false, responder_controle: false, dias_retencao: 90, trial_dias: TRIAL_DIAS_PADRAO,
      lembrete_hora: 8, menu: "", abordagem: "", boas_vindas: "", lembrete: "",
      aviso_cliente: "", msg_interesse: "", msg_vencido: "",
      boas_vindas_site: "", aviso_novo_site: "", ajuda_funcionario: "",
      renovar_admin_telefone: "",
    };
  }
  return {
    ativo: Boolean(linha.ativo),
    responder_controle: Boolean(linha.responder_controle),
    dias_retencao: Number(linha.dias_retencao ?? 90),
    trial_dias: Number(linha.trial_dias ?? TRIAL_DIAS_PADRAO),
    lembrete_hora: Number(linha.lembrete_hora ?? 8),
    menu: String(linha.menu || ""),
    abordagem: String(linha.abordagem || ""),
    boas_vindas: String(linha.boas_vindas || ""),
    lembrete: String(linha.lembrete || ""),
    aviso_cliente: String(linha.aviso_cliente || ""),
    msg_interesse: String(linha.msg_interesse || ""),
    msg_vencido: String(linha.msg_vencido || ""),
    boas_vindas_site: String(linha.boas_vindas_site || ""),
    aviso_novo_site: String(linha.aviso_novo_site || ""),
    ajuda_funcionario: String(linha.ajuda_funcionario || ""),
    renovar_admin_telefone: String(linha.renovar_admin_telefone || ""),
  };
}

/** Um campo por vez: a tela salvando o menu não pode escrever vazio nos outros textos. */
export async function salvarTextos(campos: Bruto): Promise<{ ok: boolean; error?: string }> {
  const set: string[] = [];
  const valores: unknown[] = [];
  const proxima = () => `$${valores.length + 1}`;
  const booleano = (v: unknown) => v === true || v === "true" || v === "1";

  for (const chave of [
    "menu", "abordagem", "boas_vindas", "lembrete", "aviso_cliente", "msg_interesse", "msg_vencido",
    "boas_vindas_site", "aviso_novo_site", "ajuda_funcionario",
  ] as const) {
    if (!(chave in campos)) continue;
    set.push(`${chave} = ${proxima()}`);
    valores.push(String(campos[chave] ?? ""));
  }
  if ("renovar_admin_telefone" in campos) {
    const bruto = String(campos.renovar_admin_telefone ?? "").trim();
    const telefone = normalizarWhatsapp(bruto);
    if (bruto && !telefoneValido(telefone)) return { ok: false, error: "telefone_invalido" };
    set.push(`renovar_admin_telefone = ${proxima()}`);
    valores.push(telefone);
  }
  for (const chave of ["dias_retencao", "trial_dias", "lembrete_hora"] as const) {
    if (String(campos[chave] ?? "").trim() === "") continue;
    const n = Math.trunc(Number(campos[chave]));
    if (!Number.isFinite(n)) return { ok: false, error: "numero" };
    set.push(`${chave} = ${proxima()}`);
    valores.push(Math.max(1, Math.min(365, n)));
  }
  if ("ativo" in campos) { set.push(`ativo = ${proxima()}`); valores.push(booleano(campos.ativo)); }
  if ("responder_controle" in campos) { set.push(`responder_controle = ${proxima()}`); valores.push(booleano(campos.responder_controle)); }

  if (!set.length) return { ok: false, error: "nada para gravar" };
  set.push("atualizado_em = now()");
  await consultar(`update public.barber_config set ${set.join(", ")} where id = 1`, valores);
  return { ok: true };
}

// ------------------------------------------------------------------------- a conta

export type Conta = {
  telefone: string;
  nome: string;
  nota: string;
  ativo: boolean;
  expira: Date | null;
  criado_em: Date | null;
  // O que a página pública mostra. O `slug` é o final do endereço; `mostra_barbeiro` é o
  // "mostre quem corta antes de agendar" que ele liga e desliga pelo robô.
  slug: string;
  endereco: string;
  cidade: string;
  uf: string;
  cep: string;
  telefone_publico: string;
  mostra_barbeiro: boolean;
  aceita_agendamento: boolean;
  aviso_publico: string;
  publicado_em: Date | null;
  modelo_equipe: string;
  divide_lucro: boolean | null;
};

const COLUNAS_CONTA = `telefone, nome, nota, ativo, expira_em, criado_em, slug, endereco, cidade, uf,
  cep, telefone_publico, mostra_barbeiro, aceita_agendamento, aviso_publico,
  site_publicado_em, modelo_equipe, divide_lucro`;

function linhaParaConta(linha: Bruto): Conta {
  return {
    telefone: String(linha.telefone || ""),
    nome: String(linha.nome || ""),
    nota: String(linha.nota || ""),
    ativo: Boolean(linha.ativo),
    expira: linha.expira_em ? new Date(String(linha.expira_em)) : null,
    criado_em: linha.criado_em ? new Date(String(linha.criado_em)) : null,
    slug: String(linha.slug || ""),
    endereco: String(linha.endereco || ""),
    cidade: String(linha.cidade || ""),
    uf: String(linha.uf || ""),
    cep: String(linha.cep || ""),
    telefone_publico: String(linha.telefone_publico || ""),
    mostra_barbeiro: Boolean(linha.mostra_barbeiro),
    aceita_agendamento: linha.aceita_agendamento !== false,
    aviso_publico: String(linha.aviso_publico || ""),
    publicado_em: linha.site_publicado_em ? new Date(String(linha.site_publicado_em)) : null,
    modelo_equipe: String(linha.modelo_equipe || ""),
    divide_lucro: linha.divide_lucro === null || linha.divide_lucro === undefined
      ? null : Boolean(linha.divide_lucro),
  };
}

export async function contaDeTelefone(digitos: string): Promise<Conta | null> {
  if (digitos.length < 10) return null;
  const linha = await consultar1(
    `select ${COLUNAS_CONTA} from public.barber_contas where telefone = $1`,
    [digitos],
  );
  return linha ? linhaParaConta(linha) : null;
}

/** O que a aba faz quando ele digita telefone + nome. Não existe cadastro de senha, de plano
 *  nem de cartão: o telefone é a conta inteira, e o teste começa agora, nesta chamada. */
export async function adicionarBarbeiro(
  bruto: string,
  nome = "",
  nota = "",
  trialDias = TRIAL_DIAS_PADRAO,
): Promise<{ ok: boolean; error?: string; conta?: Conta; novo: boolean }> {
  const telefone = normalizarWhatsapp(bruto);
  if (!telefoneValido(telefone)) return { ok: false, error: "telefone_invalido", novo: false };
  const existente = await contaDeTelefone(telefone);
  const dias = Math.max(1, Math.min(365, Math.trunc(Number(trialDias) || TRIAL_DIAS_PADRAO)));
  const nomeLimpo = String(nome || "").trim().slice(0, 120);

  if (existente) {
    // Readicionar um número que já é barbearia não apaga nada: só atualiza o nome que ele
    // digitou e reabre o teste, que é o que "ele quer testar de novo" significa.
    await consultar(
      `update public.barber_contas
          set nome = coalesce(nullif($2, ''), nome), nota = coalesce(nullif($3, ''), nota),
              ativo = true, expira_em = now() + ($4 || ' days')::interval, atualizado_em = now()
        where telefone = $1`,
      [telefone, nomeLimpo, String(nota || "").trim(), String(dias)],
    );
    return { ok: true, conta: await contaDeTelefone(telefone) || existente, novo: false };
  }

  await consultar(
    `insert into public.barber_contas (telefone, nome, nota, expira_em)
     values ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [telefone, nomeLimpo, String(nota || "").trim(), String(dias)],
  );
  await consultar(
    `update public.barber_interessados set telefone_conta = $1, atualizado_em = now() where telefone = $2`,
    [telefone, telefone],
  );
  return { ok: true, conta: (await contaDeTelefone(telefone)) || undefined, novo: true };
}

export async function ligarBarbeiro(telefone: string, ativo: boolean): Promise<boolean> {
  const r = await consultar(
    `update public.barber_contas set ativo = $2, atualizado_em = now() where telefone = $1`,
    [telefone, ativo],
  );
  return (r.rowCount || 0) > 0;
}

/** Fecha o teste: o vencimento vai um ano à frente e as variáveis passam a dizer a verdade. */
export async function fecharBarbeiro(telefone: string, dias = 30): Promise<boolean> {
  const r = await consultar(
    `update public.barber_contas
        set expira_em = now() + ($2 || ' days')::interval, ativo = true, atualizado_em = now()
      where telefone = $1`,
    [telefone, Math.max(1, Math.min(3650, Math.trunc(Number(dias) || 30)))],
  );
  return (r.rowCount || 0) > 0;
}

/** Apagar é a única coisa que destrói histórico, então ele leva junto as tabelas da conta e
 *  nada das outras: cada DELETE abaixo filtra pelo telefone daquele barbeiro. */
export async function apagarBarbeiro(telefone: string): Promise<Bruto> {
  const tabelas = [
    "barber_lancamento", "barber_agendamento", "barber_servico", "barber_produto",
    "barber_pacote", "barber_mensagens", "barber_treino", "barber_pendencias", "barber_fila",
    "barber_horario", "barber_pagamento", "barber_foto", "barber_entrada",
  ];
  const contagem: Bruto = {};
  for (const tabela of tabelas) {
    const r = await consultar(`delete from public.${tabela} where telefone = $1`, [telefone]);
    contagem[tabela] = r.rowCount || 0;
  }
  const funcionarios = await consultar(`delete from public.barber_funcionario where barbearia = $1`, [telefone]);
  contagem.barber_funcionario = funcionarios.rowCount || 0;
  const conta = await consultar(`delete from public.barber_contas where telefone = $1`, [telefone]);
  return { ...contagem, conta: (conta.rowCount || 0) > 0 };
}

export async function listarBarbeiros(pagina = 1, termo = ""): Promise<Bruto> {
  const bruto = String(termo || "").trim();
  const temLetra = /\p{L}/u.test(bruto);
  const texto = temLetra ? bruto.replace(/[%_]/g, "") : "";
  const digitos = temLetra ? "" : bruto.replace(/\D/g, "");
  const filtro = `($1 = '' or coalesce(c.nome, '') ilike '%'||$1||'%' or coalesce(c.nota, '') ilike '%'||$1||'%')
                  and ($2 = '' or c.telefone like '%'||$2||'%')`;
  const numero = Math.max(1, Math.trunc(Number(pagina) || 1));
  const totais = await consultar(
    `select count(*)::int as na_base,
            count(*) filter (where c.expira_em is not null and c.expira_em <= now())::int as vencidos,
            count(*) filter (where c.ativo)::int as ativos,
            count(*) filter (where ${filtro})::int as encontrados
       from public.barber_contas c`,
    [texto, digitos],
  );
  const r = await consultar(
    `select c.telefone, c.nome, c.nota, c.ativo, c.expira_em, c.criado_em, c.slug, c.endereco,
            c.cidade, c.uf, c.cep, c.telefone_publico, c.mostra_barbeiro, c.site_publicado_em,
            (select count(*) from public.barber_lancamento l where l.telefone = c.telefone)::int as lancamentos,
            (select count(*) from public.barber_servico s where s.telefone = c.telefone)::int as servicos,
            (select count(*) from public.barber_produto p where p.telefone = c.telefone)::int as produtos,
            (select count(*) from public.barber_agendamento a
              where a.telefone = c.telefone and a.status = 'marcado' and a.data_hora >= now())::int as agendados,
            (select count(*) from public.barber_agendamento a
              where a.telefone = c.telefone and coalesce(a.cliente_telefone, '') <> '')::int as clientes,
            (select count(*) from public.barber_mensagens m where m.telefone = c.telefone)::int as mensagens
       from public.barber_contas c
      where ${filtro}
      order by c.criado_em desc
      limit ${PAGINA_CONTAS} offset $3`,
    [texto, digitos, (numero - 1) * PAGINA_CONTAS],
  );
  const t = totais.rows[0] || {};
  return {
    linhas: r.rows.map((l) => ({ ...linhaParaConta(l), ...contagemDaLinha(l) })),
    info: {
      pagina: numero,
      paginas: Math.max(1, Math.ceil(Number(t.encontrados || 0) / PAGINA_CONTAS)),
      por_pagina: PAGINA_CONTAS,
      encontrados: Number(t.encontrados || 0),
      na_base: Number(t.na_base || 0),
      vencidos: Number(t.vencidos || 0),
      ativos: Number(t.ativos || 0),
    },
  };
}

function contagemDaLinha(l: Bruto): Bruto {
  return {
    lancamentos: Number(l.lancamentos || 0),
    servicos: Number(l.servicos || 0),
    produtos: Number(l.produtos || 0),
    agendados: Number(l.agendados || 0),
    clientes: Number(l.clientes || 0),
    mensagens: Number(l.mensagens || 0),
    expira: l.expira_em ? formatarBrasilia(new Date(String(l.expira_em))) : "",
    criado: l.criado_em ? formatarBrasilia(new Date(String(l.criado_em))) : "",
  };
}

export async function exportarBarbeiros(): Promise<{ csv: string; nome: string; n: number }> {
  const r = await consultar(
    `select telefone, nome, nota, ativo,
            to_char(expira_em, 'DD/MM/YYYY HH24:MI') as expira,
            to_char(criado_em, 'DD/MM/YYYY HH24:MI') as criado
       from public.barber_contas order by criado_em desc limit 20000`,
  );
  const linhas: string[][] = [["Telefone", "Nome", "Nota", "Ativo", "Expira", "Cadastrado"]];
  for (const l of r.rows) {
    linhas.push([
      formatarTelefone(String(l.telefone || "")), String(l.nome || ""), String(l.nota || ""),
      Boolean(l.ativo) ? "sim" : "não", String(l.expira || ""), String(l.criado || ""),
    ]);
  }
  return { csv: "﻿" + escreverCsv(linhas), nome: "barbearias.csv", n: r.rows.length };
}

/** Colar a lista dos barbeiros: uma linha por número, com o nome depois do ponto e vírgula.
 *  Quem já é barbearia não perde nada — a contagem de teste recomeça e o histórico fica. */
export async function importarBarbeiros(texto: string, trialDias = TRIAL_DIAS_PADRAO): Promise<Bruto> {
  const linhas = String(texto || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const erros: { linha: number; motivo: string; texto: string }[] = [];
  let novos = 0, atualizados = 0;
  for (let i = 0; i < linhas.length; i++) {
    const bruto = linhas[i];
    const partes = bruto.split(/[;,\t]/).map((p) => p.trim());
    const telefone = normalizarWhatsapp(partes[0] || "");
    if (!telefoneValido(telefone)) {
      erros.push({ linha: i + 1, motivo: "telefone não é um número brasileiro de 10 ou 11 dígitos", texto: bruto.slice(0, 90) });
      continue;
    }
    const r = await adicionarBarbeiro(telefone, partes[1] || "", partes[2] || "", trialDias);
    if (!r.ok) { erros.push({ linha: i + 1, motivo: r.error || "banco", texto: bruto.slice(0, 90) }); continue; }
    if (r.novo) novos++;
    else atualizados++;
  }
  return { novos, atualizados, erros, total: linhas.length };
}

// ------------------------------------------------------------------------ variáveis

/** As mesmas chaves das mensagens do Peixeiro, com a ficha da barbearia no lugar do cliente do
 *  painel MC: {nome}, {primeiro}, {vence}, {expira}, {dias}, {status} valem nos dois robôs. */
export function variaveisDaConta(
  conf: Conf,
  conta: Conta,
  extras: Bruto = {},
  agora: Date = new Date(),
): Record<string, string> {
  const ficha: ClienteMensagem = {
    nome: conta.nome,
    usuario: conta.telefone,
    telefone: conta.telefone,
    status: conta.ativo ? 1 : 0,
    expira: conta.expira,
  };
  const v = variaveisMensagem(conf as unknown as Bruto, ficha, {}, agora);
  const nomeDaBarbearia = nomeAproveitavel(conta.nome) || "sua barbearia";
  return {
    ...v,
    nome: nomeDaBarbearia,
    primeiro: nomeDaBarbearia,
    barbearia: nomeDaBarbearia,
    ...(extras as Record<string, string>),
  };
}

/** A chave do painel é trocada toda vez que ele pede MENU. Assim o link antigo para de servir
 *  e a próxima resposta mostra somente o endereço atual do estabelecimento. */
async function textoComPainel(
  conta: Conta,
  texto: string,
): Promise<{ texto: string; texto2: string }> {
  const chave = crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  await consultar(
    `insert into public.barber_painel (telefone, chave, ativo, criado_em, atualizado_em)
     values ($1, $2, true, now(), now())
     on conflict (telefone) do update set chave = excluded.chave, ativo = true,
       atualizado_em = now()`,
    [conta.telefone, chave],
  );
  const publicado = await publicarPainelBarbearia(conta.telefone, chave);
  if (!publicado.ok || !publicado.url) {
    return {
      texto,
      texto2: "Painel privado ainda não ficou disponível. Digite /menu novamente para tentar atualizar o endereço.",
    };
  }
  return {
    texto,
    texto2: `Para editar o site e o atendimento em um painel simples, clique aqui:\n${publicado.url}\n\nEste endereço é novo e substitui o anterior.`,
  };
}

// ------------------------------------------------------------------ relógio de Brasília

type Relogio = { ano: number; mes: number; dia: number; hora: number; minuto: number; semana: number };

function relogio(instant: Date): Relogio {
  const local = new Date(instant.getTime() - BRAZIL_OFFSET_MS);
  return {
    ano: local.getUTCFullYear(), mes: local.getUTCMonth() + 1, dia: local.getUTCDate(),
    hora: local.getUTCHours(), minuto: local.getUTCMinutes(), semana: local.getUTCDay(),
  };
}

/** Parede → instante: o que ele escreve ("terça 9h") é hora de Brasília, e o banco guarda UTC. */
function instanteDe(rel: Relogio): Date {
  return new Date(Date.UTC(rel.ano, rel.mes - 1, rel.dia, rel.hora, rel.minuto) + BRAZIL_OFFSET_MS);
}

const NOMES_DIA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function diaSemanaDe(rel: Relogio): string {
  return NOMES_DIA[rel.semana];
}

function rotuloDoDia(alvo: Date, agora: Date): string {
  const a = relogio(alvo), h = relogio(agora);
  const mesmoDia = a.ano === h.ano && a.mes === h.mes && a.dia === h.dia;
  const amanha = instanteDe({ ...h, dia: h.dia }).getTime();
  if (mesmoDia) return "hoje";
  if (alvo.getTime() - amanha <= 86_400_000 && alvo.getTime() - amanha > 0) return "amanhã";
  return `${diaSemanaDe(a)}, ${String(a.dia).padStart(2, "0")}/${String(a.mes).padStart(2, "0")}`;
}

function horaDe(alvo: Date): string {
  const r = relogio(alvo);
  return `${String(r.hora).padStart(2, "0")}:${String(r.minuto).padStart(2, "0")}`;
}

function dataDe(alvo: Date): string {
  const r = relogio(alvo);
  return `${String(r.dia).padStart(2, "0")}/${String(r.mes).padStart(2, "0")}/${r.ano}`;
}

// ----------------------------------------------------------------------- o dinheiro

const MOEDA = /^\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$|^\d+(?:[.,]\d{1,2})?$/;

/** "30,00", "R$ 30", "1.234,56". Telefone disfarçado de preço não entra: 10 dígitos seguidos
 *  é número de WhatsApp, não valor de corte. */
function valorDe(token: string): number | null {
  const limpo = String(token || "").toLowerCase().replace(/^r\s*\$?\s*/, "").replace(/\s/g, "");
  if (!limpo || !MOEDA.test(limpo)) return null;
  const digitos = limpo.replace(/[.,]/g, "");
  if (digitos.length >= 10) return null;
  let normal = limpo;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(limpo)) normal = limpo.replace(/\./g, "").replace(",", ".");
  else if (limpo.includes(",")) normal = limpo.replace(",", ".");
  const n = Number(normal);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function formatarValor(valor: number): string {
  return valor.toFixed(2).replace(".", ",");
}

/** O último número com cara de preço da frase, e o que sobra vira a descrição. */
function separarValor(frase: string): { valor: number | null; descricao: string } {
  const tokens = String(frase || "").split(/\s+/).filter(Boolean);
  let indice = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (valorDe(tokens[i]) !== null) { indice = i; break; }
  }
  if (indice < 0) return { valor: null, descricao: tokens.join(" ") };
  const valor = valorDe(tokens[indice]);
  const descricao = [...tokens.slice(0, indice), ...tokens.slice(indice + 1)].join(" ").trim();
  return { valor, descricao };
}

// ------------------------------------------------------------------- dia e hora

export type Quando = {
  instant: Date | null;
  /** O que a frase ainda não disse: "hora", "dia" ou "" quando está completo. */
  faltando: string;
  /** A sobra da frase, sem o dia e a hora: é onde mora o nome do cliente. */
  sobra: string;
  rotulo: string;
};

// "9h30" é o jeito que ele digita: o minuto colado no h. A barra depois (15h 22/11) é data,
// não minuto, por isso o lookahead não deixa número nem "/" logo após o minuto.
const HORA_H_MIN = /(?:^|[^\d])(\d{1,2})h\s*[:.]?\s*(\d{2})(?![\d/])/i;
const HORA_H = /(?:^|[^\d])(\d{1,2})\s*(?:hs\b|horas\b|h\b)/i;
const HORA_DOIS = /(?:^|[^\d:.])(\d{1,2})[:.](\d{2})(?!\d)/;
const HORA_E = /(?:^|[^\d])(\d{1,2})\s+e\s+(\d{2})(?![\d])/;
const HORA_COLADA = /(?:^|[^\d])(\d{1,2})e(\d{2})(?![\d])/;

/** "amanhã 14h", "terça 9h30", "quarta 9e20", "25/12 às 14:00", "hoje 16".
 *  Se ele só diz a hora, vale hoje; se a hora já passou, cai para amanhã e o robô avisa isso
 *  na confirmação — marcar para trás é o erro que ninguém percebe. */
export function lerQuando(bruto: string, agora: Date = new Date()): Quando {
  const t = semAcento(String(bruto || "").toLowerCase());
  let sobra = t;
  let hora: number | null = null;
  let minuto = 0;

  for (const padrao of [HORA_H_MIN, HORA_H, HORA_DOIS, HORA_E, HORA_COLADA]) {
    const m = padrao.exec(sobra);
    if (!m) continue;
    const h = Number(m[1]);
    const mi = m[2] === undefined ? 0 : Number(m[2]);
    if (h > 23 || mi > 59) return { instant: null, faltando: "invalido", sobra: t, rotulo: "" };
    hora = h;
    minuto = mi;
    sobra = (sobra.slice(0, m.index + 1) + " " + sobra.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    break;
  }

  const hoje = relogio(agora);
  let alvo = { ...hoje, hora: hora ?? 0, minuto };
  let achouDia = false;
  let invalido = false;

  const depois = /(?:^|\s)depois de amanha(?:\s|$)/.exec(sobra);
  const amanha = /(?:^|\s)amanha(?:\s|$)/.exec(sobra);
  const hojeM = /(?:^|\s)(?:hoje|hoje a noite|a noite)(?:\s|$)/.exec(sobra);
  const qualifier = depois || amanha || hojeM;
  if (qualifier) {
    const mais = depois ? 2 : amanha ? 1 : 0;
    alvo = proximoDia({ ...alvo }, agora, mais);
    sobra = (sobra.slice(0, qualifier.index + 1) + " " + sobra.slice(qualifier.index + qualifier[0].length)).replace(/\s+/g, " ").trim();
    achouDia = true;
  } else {
    const semana = /(?:^|\s)(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?: feira)?(?:\s|$)/.exec(sobra);
    if (semana) {
      const alvoSemana = NOMES_DIA.findIndex((n) => semAcento(n) === semana[1]);
      let frente = (alvoSemana - hoje.semana + 7) % 7;
      if (frente === 0) frente = 7;
      alvo = proximoDia({ ...alvo }, agora, frente);
      sobra = (sobra.slice(0, semana.index + 1) + " " + sobra.slice(semana.index + semana[0].length)).replace(/\s+/g, " ").trim();
      achouDia = true;
    } else {
      const explicita = /(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s|$)/.exec(sobra);
      if (explicita) {
        const dia = Number(explicita[1]), mes = Number(explicita[2]);
        const ano = explicita[3] ? (explicita[3].length === 2 ? 2000 + Number(explicita[3]) : Number(explicita[3])) : hoje.ano;
        if (dia < 1 || dia > 31 || mes < 1 || mes > 12) invalido = true;
        alvo = { ano, mes, dia, hora: hora ?? 0, minuto, semana: 0 };
        sobra = (sobra.slice(0, explicita.index + 1) + " " + sobra.slice(explicita.index + explicita[0].length)).replace(/\s+/g, " ").trim();
        achouDia = true;
      }
    }
  }

  if (invalido) return { instant: null, faltando: "invalido", sobra, rotulo: "" };
  if (hora === null) {
    return achouDia
      ? { instant: null, faltando: "hora", sobra, rotulo: "" }
      : { instant: null, faltando: "dia", sobra, rotulo: "" };
  }

  const comHora = { ...alvo, hora, minuto };
  let instante = instanteDe(comHora);
  if (!achouDia && instante.getTime() <= agora.getTime() + 5 * 60_000) {
    instante = instanteDe(proximoDia(comHora, agora, 1));
  }
  if (instante.getTime() < agora.getTime() - 60 * 60_000) {
    return { instant: null, faltando: "passado", sobra, rotulo: "" };
  }
  return { instant: instante, faltando: "", sobra: sobra.replace(/\s+/g, " ").trim(), rotulo: `${rotuloDoDia(instante, agora)} às ${horaDe(instante)}` };
}

/** Some dias na parede de Brasília, sem atravessar o mês pelo fuso. */
function proximoDia(rel: Relogio, _agora: Date, frente: number): Relogio {
  const base = new Date(Date.UTC(rel.ano, rel.mes - 1, rel.dia + frente, 12));
  return { ano: base.getUTCFullYear(), mes: base.getUTCMonth() + 1, dia: base.getUTCDate(), hora: rel.hora, minuto: rel.minuto, semana: base.getUTCDay() };
}

// -------------------------------------------------------------------------- catálogo

export type ItemCatalogo = { id: number; nome: string; preco: number; duracao_min?: number };
type TabelaCatalogo = "barber_servico" | "barber_produto";

async function lerCatalogo(tabela: TabelaCatalogo, telefone: string): Promise<ItemCatalogo[]> {
  const colunas = tabela === "barber_servico"
    ? "id, nome, preco, duracao_min"
    : "id, nome, preco";
  const r = await consultar(
    `select ${colunas} from public.${tabela} where telefone = $1 order by lower(nome) limit 200`,
    [telefone],
  );
  return r.rows.map((l) => ({
    id: Number(l.id),
    nome: String(l.nome || ""),
    preco: Number(l.preco || 0),
    ...(tabela === "barber_servico" ? { duracao_min: Number(l.duracao_min || 30) } : {}),
  }));
}

export async function catalogo(telefone: string): Promise<{ servicos: ItemCatalogo[]; produtos: ItemCatalogo[]; pacotes: Bruto[] }> {
  const pacotes = await consultar(
    `select nome, servico, quantidade, preco, valido_dias from public.barber_pacote
      where telefone = $1 order by lower(nome) limit 100`,
    [telefone],
  );
  return {
    servicos: await lerCatalogo("barber_servico", telefone),
    produtos: await lerCatalogo("barber_produto", telefone),
    pacotes: pacotes.rows.map((l) => ({
      nome: String(l.nome || ""), servico: String(l.servico || ""),
      quantidade: Number(l.quantidade || 1), preco: Number(l.preco || 0), valido_dias: Number(l.valido_dias || 90),
    })),
  };
}

export async function gravarPreco(telefone: string, tipo: "servico" | "produto", nome: string, preco: number): Promise<boolean> {
  const tabela = tipo === "servico" ? "barber_servico" : "barber_produto";
  const limpo = String(nome || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!limpo) return false;
  const r = await consultar(
    `insert into public.${tabela} (telefone, nome, preco, atualizado_em)
     values ($1, $2, $3, now())
     on conflict (telefone, lower(nome))
       do update set preco = excluded.preco, atualizado_em = now()`,
    [telefone, limpo, preco],
  );
  return (r.rowCount || 0) > 0;
}

export async function gravarPacote(telefone: string, nome: string, servico: string, quantidade: number, preco: number): Promise<boolean> {
  const limpo = String(nome || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!limpo) return false;
  const r = await consultar(
    `insert into public.barber_pacote (telefone, nome, servico, quantidade, preco, atualizado_em)
     values ($1, $2, $3, $4, $5, now())
     on conflict (telefone, lower(nome))
       do update set servico = excluded.servico, quantidade = excluded.quantidade,
                     preco = excluded.preco, atualizado_em = now()`,
    [telefone, limpo, String(servico || "").trim().slice(0, 60), Math.max(1, Math.trunc(quantidade || 1)), preco],
  );
  return (r.rowCount || 0) > 0;
}

export function textoCatalogo(c: { servicos: ItemCatalogo[]; produtos: ItemCatalogo[] }): string {
  const partes: string[] = [];
  partes.push(c.servicos.length
    ? "Serviços:\n" + c.servicos.map((s) => `  · ${s.nome} — R$ ${formatarValor(s.preco)}`).join("\n")
    : "Você ainda não cadastrou serviço. Exemplo: PRECO SERVICO corte 30,00");
  partes.push(c.produtos.length
    ? "Produtos:\n" + c.produtos.map((p) => `  · ${p.nome} — R$ ${formatarValor(p.preco)}`).join("\n")
    : "Nenhum produto ainda. Exemplo: PRECO PRODUTO pomada 25,00");
  return partes.join("\n\n");
}

export function textoPacotes(pacotes: Bruto[]): string {
  if (!pacotes.length) return "Nenhum pacote ainda. Exemplo: PACOTE 10 cortes 250,00";
  return "Seus pacotes:\n" + pacotes.map((p) =>
    `  · ${p.nome} — ${p.quantidade}x ${p.servico || "serviço"} por R$ ${formatarValor(Number(p.preco))} (vale ${p.valido_dias} dias)`
  ).join("\n");
}

/** O serviço que a frase cita, no nome que ele cadastrou. É isso que o lembrete das 8h repete. */
export function servirDaFrase(frase: string, itens: ItemCatalogo[]): { nome: string; preco: number } | null {
  const t = semAcento(String(frase || "").toLowerCase());
  let melhor: { nome: string; preco: number; tamanho: number } | null = null;
  for (const item of itens) {
    const chave = semAcento(item.nome.toLowerCase());
    if (chave.length < 3) continue;
    if (new RegExp(`(?:^|\\s)${chave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?(?:\\s|$)`).test(t)) {
      if (!melhor || chave.length > melhor.tamanho) melhor = { nome: item.nome, preco: item.preco, tamanho: chave.length };
    }
  }
  return melhor ? { nome: melhor.nome, preco: melhor.preco } : null;
}

// ------------------------------------------------------------------ lançamentos

export async function lancar(
  telefone: string, tipo: "entrada" | "saida", descricao: string, valor: number, quando = new Date(),
): Promise<number | null> {
  const r = await consultar(
    `insert into public.barber_lancamento (telefone, tipo, descricao, valor, quando)
     values ($1, $2, $3, $4, $5) returning id`,
    [telefone, tipo, String(descricao || "").trim().slice(0, 120), valor, quando.toISOString()],
  );
  const linha = r.rows[0] || {};
  return linha.id ? Number(linha.id) : null;
}

export type Resumo = { entradas: number; saidas: number; saldo: number; n_entradas: number; n_saidas: number };

export async function resumoDe(telefone: string, desde: Date, ate: Date): Promise<Resumo> {
  const r = await consultar(
    `select coalesce(sum(valor) filter (where tipo = 'entrada'), 0)::numeric as entradas,
            coalesce(sum(valor) filter (where tipo = 'saida'), 0)::numeric as saidas,
            count(*) filter (where tipo = 'entrada')::int as n_entradas,
            count(*) filter (where tipo = 'saida')::int as n_saidas
       from public.barber_lancamento
      where telefone = $1 and quando >= $2 and quando < $3`,
    [telefone, desde.toISOString(), ate.toISOString()],
  );
  const l = r.rows[0] || {};
  const entradas = Number(l.entradas || 0), saidas = Number(l.saidas || 0);
  return { entradas, saidas, saldo: Math.round((entradas - saidas) * 100) / 100, n_entradas: Number(l.n_entradas || 0), n_saidas: Number(l.n_saidas || 0) };
}

/** Os dias do período, no calendário de Brasília: mês, semana (começa na segunda), hoje, tudo. */
export function periodoDe(texto: string, agora: Date = new Date()): { desde: Date; ate: Date; rotulo: string } {
  const t = semAcento(String(texto || "").toLowerCase());
  const h = relogio(agora);
  if (/(^|\s)hoje(\s|$)/.test(t)) {
    const desde = instanteDe({ ...h, hora: 0, minuto: 0 });
    return { desde, ate: new Date(desde.getTime() + 86_400_000), rotulo: `hoje (${dataDe(desde)})` };
  }
  if (t.includes("semana")) {
    const paraTras = (h.semana === 0 ? 6 : h.semana - 1);
    const desde = instanteDe(proximoDia({ ...h, hora: 0, minuto: 0 }, agora, -paraTras));
    return { desde, ate: new Date(desde.getTime() + 7 * 86_400_000), rotulo: "esta semana" };
  }
  if (t.includes("tudo") || t.includes("sempre") || t.includes("todo")) {
    return { desde: new Date(0), ate: new Date(agora.getTime() + 365 * 86_400_000), rotulo: "tudo que está guardado" };
  }
  const desde = instanteDe({ ...h, dia: 1, hora: 0, minuto: 0 });
  const proximo = new Date(Date.UTC(h.ano, h.mes, 1, 12));
  const ate = new Date(Date.UTC(proximo.getUTCFullYear(), proximo.getUTCMonth(), 1) + BRAZIL_OFFSET_MS);
  return { desde, ate, rotulo: `este mês (${String(h.mes).padStart(2, "0")}/${h.ano})` };
}

export function textoResumo(resumo: Resumo, rotulo: string, extras = ""): string {
  return `Resumo de ${rotulo}:

  Entradas: R$ ${formatarValor(resumo.entradas)} (${resumo.n_entradas} lançamento${resumo.n_entradas === 1 ? "" : "s"})
  Saídas:   R$ ${formatarValor(resumo.saidas)} (${resumo.n_saidas} lançamento${resumo.n_saidas === 1 ? "" : "s"})
  Saldo:    R$ ${formatarValor(resumo.saldo)}${extras}`;
}

// -------------------------------------------------------------------- agendamentos

export type Agendamento = {
  id: number; numero: number; cliente_telefone: string; cliente_nome: string;
  servico: string; data_hora: Date; status: string; lembrete: boolean;
  duracao_min: number; forma_pagamento: "pix" | "cartao" | "";
  compareceu: boolean | null;
  funcionario_id: number | null; funcionario_nome: string;
};

function linhaAgendamento(l: Bruto): Agendamento {
  return {
    id: Number(l.id || 0), numero: Number(l.numero || 0),
    cliente_telefone: String(l.cliente_telefone || ""), cliente_nome: String(l.cliente_nome || ""),
    servico: String(l.servico || ""), data_hora: new Date(String(l.data_hora)), status: String(l.status || "marcado"),
    lembrete: Boolean(l.lembrete_enviado_em),
    duracao_min: Math.max(10, Math.min(600, Number(l.duracao_min || 30))),
    forma_pagamento: l.forma_pagamento === "pix" || l.forma_pagamento === "cartao"
      ? l.forma_pagamento
      : "",
    compareceu: l.compareceu === null || l.compareceu === undefined ? null : Boolean(l.compareceu),
    funcionario_id: Number(l.funcionario_id || 0) || null,
    funcionario_nome: String(l.funcionario_nome || ""),
  };
}

const COLUNAS_AGENDA = `id, numero, cliente_telefone, cliente_nome, servico, data_hora, status,
                         lembrete_enviado_em, duracao_min, forma_pagamento, compareceu,
                         funcionario_id, funcionario_telefone`;

export async function criarAgendamento(
  telefone: string, dados: { cliente_telefone: string; cliente_nome: string; servico: string; data_hora: Date },
): Promise<Agendamento | null> {
  const r = await consultar(
    `insert into public.barber_agendamento (telefone, numero, cliente_telefone, cliente_nome, servico, data_hora)
     values ($1, coalesce((select max(numero) from public.barber_agendamento where telefone = $1), 0) + 1, $2, $3, $4, $5)
     returning ${COLUNAS_AGENDA}`,
    [telefone, dados.cliente_telefone, dados.cliente_nome, dados.servico, dados.data_hora.toISOString()],
  );
  const l = r.rows[0];
  return l ? linhaAgendamento(l) : null;
}

export async function agendamentosDe(
  telefone: string, desde: Date, ate: Date, status = "", limite = 50,
): Promise<Agendamento[]> {
  const r = await consultar(
    `select a.id, a.numero, a.cliente_telefone, a.cliente_nome, a.servico, a.data_hora,
            a.status, a.lembrete_enviado_em, a.duracao_min, a.forma_pagamento, a.compareceu,
            a.funcionario_id, a.funcionario_telefone,
            coalesce(f.nome, '') as funcionario_nome
       from public.barber_agendamento a
       left join public.barber_funcionario f on f.id = a.funcionario_id
      where a.telefone = $1 and a.data_hora >= $2 and a.data_hora < $3
        and ($4 = '' or a.status = $4)
      order by a.data_hora limit $5`,
    [telefone, desde.toISOString(), ate.toISOString(), status, limite],
  );
  return r.rows.map(linhaAgendamento);
}

async function agendamentoPorNumero(telefone: string, numero: number): Promise<Agendamento | null> {
  const l = await consultar1(
    `select a.id, a.numero, a.cliente_telefone, a.cliente_nome, a.servico, a.data_hora,
            a.status, a.lembrete_enviado_em, a.duracao_min, a.forma_pagamento, a.compareceu,
            a.funcionario_id, a.funcionario_telefone,
            coalesce(f.nome, '') as funcionario_nome
       from public.barber_agendamento a
       left join public.barber_funcionario f on f.id = a.funcionario_id
      where a.telefone = $1 and a.numero = $2`,
    [telefone, numero],
  );
  return l ? linhaAgendamento(l) : null;
}

export async function remarcarAgendamento(id: number, telefone: string, dataHora: Date): Promise<boolean> {
  const r = await consultar(
    `update public.barber_agendamento
        set data_hora = $3, status = 'marcado', lembrete_enviado_em = null, atualizado_em = now()
      where id = $1 and telefone = $2`,
    [id, telefone, dataHora.toISOString()],
  );
  return (r.rowCount || 0) > 0;
}

export async function mudarStatus(id: number, telefone: string, status: string): Promise<boolean> {
  const r = await consultar(
    `update public.barber_agendamento set status = $3, atualizado_em = now()
      where id = $1 and telefone = $2`,
    [id, telefone, status],
  );
  return (r.rowCount || 0) > 0;
}

/** A lista que ele vê no WhatsApp e no painel: o número curto é o que ele digita depois. */
export function textoAgenda(lista: Agendamento[], agora: Date, titulo: string): string {
  if (!lista.length) return `${titulo}: nada marcado. Para marcar, mande\n  AGENDA João 11999998888 sábado 15h`;
  const linhas = lista.map((a) => {
    const dia = rotuloDoDia(a.data_hora, agora);
    const situacao = a.status === "feito"
      ? " · FEITO"
      : a.status === "cancelado"
        ? " · CANCELADO"
        : a.status === "remarcado"
          ? " · REMARCADO"
          : "";
    const retorno = a.compareceu === false
      ? " · NÃO VEIO"
      : a.forma_pagamento
        ? ` · PAGOU ${a.forma_pagamento === "pix" ? "PIX" : "CARTÃO"}`
        : "";
    return `  ${a.numero} · ${dia === "hoje" ? "hoje" : `${dia}, `}${horaDe(a.data_hora)} · ${a.cliente_nome || "sem nome"}` +
      `${a.funcionario_nome ? ` · ${a.funcionario_nome}` : ""}${a.servico ? ` (${a.servico})` : ""}` +
      `${situacao}${retorno}`;
  });
  return `${titulo}:\n${linhas.join("\n")}\n\nSe você não puder atender um deles, responda com o número da linha.`;
}

/** Os clientes que saíram da agenda dele: é a lista de "clientes desse barbeiro" da aba. */
export async function clientesDoBarbeiro(telefone: string, limite = 200): Promise<Bruto[]> {
  const r = await consultar(
    `select g.cliente_telefone, g.cliente_nome, g.visitas, g.ultimo,
            (select s.preco::numeric from public.barber_servico s
              where s.telefone = $1 and lower(s.nome) = lower(g.servico) limit 1) as preco
       from (
        select cliente_telefone, cliente_nome, count(*)::int as visitas,
               max(data_hora) as ultimo,
               (array_agg(servico order by data_hora desc))[1] as servico
          from public.barber_agendamento
         where telefone = $1 and (coalesce(cliente_telefone, '') <> '' or coalesce(cliente_nome, '') <> '')
         group by cliente_telefone, cliente_nome
       ) g
      order by g.ultimo desc limit $2`,
    [telefone, limite],
  );
  return r.rows.map((l) => ({
    telefone: String(l.cliente_telefone || ""),
    nome: String(l.cliente_nome || ""),
    visitas: Number(l.visitas || 0),
    ultimo: l.ultimo ? formatarBrasilia(new Date(String(l.ultimo))) : "",
    preco: l.preco === null || l.preco === undefined ? null : Number(l.preco),
  }));
}

export async function lancamentosDe(telefone: string, limite = 100): Promise<Bruto[]> {
  const r = await consultar(
    `select id, tipo, descricao, valor, origem, to_char(quando, 'DD/MM/YYYY HH24:MI') as quando
       from public.barber_lancamento where telefone = $1 order by quando desc limit $2`,
    [telefone, limite],
  );
  return r.rows.map((l) => ({
    id: Number(l.id || 0), tipo: String(l.tipo || ""), descricao: String(l.descricao || ""),
    valor: Number(l.valor || 0), origem: String(l.origem || ""), quando: String(l.quando || ""),
  }));
}

// ----------------------------------------------------------------------- pendências

type Pendencia = { acao: string; dados: Bruto };

export async function gravarPendencia(telefone: string, acao: string, dados: Bruto): Promise<void> {
  await consultar(
    `insert into public.barber_pendencias (telefone, acao, dados, criado_em)
     values ($1, $2, $3::jsonb, now())
     on conflict (telefone) do update set acao = excluded.acao, dados = excluded.dados, criado_em = now()`,
    [telefone, acao, JSON.stringify(dados)],
  );
}

export async function apagarPendencia(telefone: string): Promise<void> {
  await consultar(`delete from public.barber_pendencias where telefone = $1`, [telefone]);
}

/** Ninguém fica preso numa pergunta antiga: dez minutos e a confirmação morre sozinha. A foto
 *  vale mais — ele tira a foto, manda para o grupo, volta — e é o webhook que a responde. */
const VIDA_PENDENCIA_MS = 10 * 60_000;
const VIDA_FOTO_MS = 30 * 60_000;

async function pendenciaViva(telefone: string): Promise<Pendencia | null> {
  const l = await consultar1(
    `select acao, dados from public.barber_pendencias
      where telefone = $1
        and criado_em > now() - (case when acao = 'foto' then $3 else $2 end || ' milliseconds')::interval`,
    [telefone, String(VIDA_PENDENCIA_MS), String(VIDA_FOTO_MS)],
  );
  if (!l) { await apagarPendencia(telefone); return null; }
  return { acao: String(l.acao || ""), dados: (l.dados || {}) as Bruto };
}

// ------------------------------------------------------------------ a conversa

export type Resposta = { texto: string; texto2?: string; tipo: string };

const SIM = ["sim", "s", "confirmo", "confirmar", "pode", "isso", "ok"];
const NAO = ["nao", "n", "cancela", "cancelar", "deixa"];

/** O cérebro do robô. Recebe a frase do barbeiro e devolve o que responder; as gravações só
 *  acontecem depois do "sim", exceto catálogo e pacote, que são cadastro e não dinheiro. */
export async function responder(
  conta: Conta,
  bruto: string,
  textos: Textos,
  conf: Conf,
  agora: Date = new Date(),
): Promise<Resposta> {
  const t = semAcento(String(bruto || "").toLowerCase())
    .replace(/^\s*\/+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const telefone = conta.telefone;
  const catalogoConta = await catalogo(telefone);

  if (!t) return { texto: "", tipo: "vazio" };

  const retornoPagamento = await responderRetornoPagamento(telefone, bruto);
  if (retornoPagamento) return retornoPagamento;

  // 1) Resposta de uma pergunta que o robô fez. A foto é a única pergunta que não se responde
  //    com texto — quem responde é o webhook quando a imagem chega, e a espera continua viva.
  const pendencia = await pendenciaViva(telefone);
  if (pendencia && pendencia.acao !== "foto") {
    // "Quanto foi?" e "Qual é o preço?" esperam um número, não um SIM — e um número solto
    // não é comando novo.
    if (pendencia.acao === "valor" || pendencia.acao === "valor_preco") {
      const valor = valorDe(t.replace(/\s+/g, ""));
      if (valor !== null) {
        await apagarPendencia(telefone);
        if (pendencia.acao === "valor_preco") {
          return await aplicarPreco(telefone, String(pendencia.dados.tipo || "servico") === "produto" ? "produto" : "servico",
            String(pendencia.dados.nome || ""), valor);
        }
        return await confirmarLancamento(telefone, {
          tipo: String(pendencia.dados.tipo || "entrada"),
          descricao: String(pendencia.dados.descricao || ""),
          valor,
        }, agora);
      }
    }
    // A página pergunta o valor de um campo: a resposta é a frase inteira, escrita como ele digitou.
    if (pendencia.acao === "editar") {
      const campo = campoDe(String(pendencia.dados.campo || "")) || "nome";
      await apagarPendencia(telefone);
      return await aplicarEdicaoDePagina(conta, campo, String(bruto || ""), textos, agora);
    }
    if (pendencia.acao === "nome_site") {
      await apagarPendencia(telefone);
      return await trocarSlug(conta, String(bruto || ""));
    }
    if (SIM.includes(t)) {
      const aplicado = await aplicarPendencia(telefone, pendencia, agora);
      await apagarPendencia(telefone);
      return aplicado;
    }
    if (NAO.includes(t) || t.startsWith("cancela")) {
      await apagarPendencia(telefone);
      return { texto: "Deixei para lá. Manda MENU quando quiser ver o que ele entende.", tipo: "cancelado" };
    }
    // Ele mudou de ideia no meio: segue para o comando novo, e a pergunta morre.
    await apagarPendencia(telefone);
  }

  // 2) A página do salão: o que ele troca no site e a foto que ele manda. Vem antes do MENU
  //    porque "SITE" e "EDITAR <campo>" são comandos da página, não do dinheiro.
  const pagina = await comandoPagina(conta, String(bruto || ""), t, textos);
  if (pagina) return pagina;

  // 3) Comandos de uma palavra e os atalhos com barra.
  const menuPedido = /^menu(?:\s+(contabilidade|pagina|site|agenda|funcionario))?$/.exec(t);
  if (menuPedido) {
    const sub = menuPedido[1] || "";
    if (sub === "contabilidade") {
      const texto = `Menu de contabilidade:\n${MENU_CONTROLE_PADRAO}\n\n` +
        `Para voltar ao menu geral, digite /menu.\nPara editar a página, digite /menu pagina.`;
      const duas = await textoComPainel(conta, texto);
      return { texto: duas.texto, texto2: duas.texto2, tipo: "menu_contabilidade" };
    }
    if (sub === "pagina" || sub === "site") {
      const texto = await guiaDaPagina(conta, textos);
      const duas = await textoComPainel(conta, texto);
      return { texto: duas.texto, texto2: duas.texto2, tipo: "guia_pagina" };
    }
    if (sub === "agenda") {
      const texto = `Menu da agenda:\n  AGENDA — lista os próximos horários\n` +
          `  AGENDA hoje — lista os horários de hoje\n` +
          `  VER AGENDAMENTOS — lista os horários de hoje\n` +
          `  VER AGENDAMENTOS SEMANAL — lista os próximos sete dias\n` +
          `  AGENDA João 11999998888 sábado 15h — marca um horário\n` +
          `  AVISA 1 — avisa o cliente\n  REMARCAR 1 sexta 16h — muda o horário\n` +
          `  FEITO 1 — registra o atendimento\n  CANCELAR 1 — cancela o horário\n\n` +
          `Para voltar ao menu geral, digite /menu.\nPara ver contabilidade, digite /menu contabilidade.`;
      const duas = await textoComPainel(conta, texto);
      return { texto: duas.texto, texto2: duas.texto2, tipo: "menu_agenda" };
    }
    if (sub === "funcionario") {
      const texto = textos.ajuda_funcionario ||
          `Menu do funcionário:\n  MINHA AGENDA — seus horários\n` +
          `  LIVRE amanhã — horários disponíveis\n` +
          `  AGENDAR João 11999998888 sábado 15h — marca no seu nome\n\n` +
          `Para voltar ao menu geral, digite /menu.`;
      const duas = await textoComPainel(conta, texto);
      return { texto: duas.texto, texto2: duas.texto2, tipo: "menu_funcionario" };
    }
    const baseMenu = textos.menu || MENU_CONTROLE_PADRAO;
    const jaTemAtalhos = baseMenu.includes("/menu contabilidade") ||
      baseMenu.includes("/menu pagina");
    const texto = jaTemAtalhos
      ? baseMenu
      : `${baseMenu}\n\nAtalhos rápidos:\n  /menu contabilidade — lançamentos, preços e relatórios\n` +
        `  /menu pagina — nome, endereço, horários e dados da página\n` +
        `  /menu agenda — marcar e cuidar dos horários\n  /menu funcionario — menu do profissional`;
    const duas = await textoComPainel(conta, texto);
    return { texto: duas.texto, texto2: duas.texto2, tipo: "menu" };
  }
  if (t === "ajuda" || t === "controle" || t === "oi" || t === "ola") {
    const texto = `${textos.menu || MENU_CONTROLE_PADRAO}\n\n` +
      `Atalhos rápidos:\n  /menu contabilidade\n  /menu pagina\n  /menu agenda\n  /menu funcionario`;
    const duas = await textoComPainel(conta, texto);
    return { texto: duas.texto, texto2: duas.texto2, tipo: "menu" };
  }
  if (t === "catalogo" || t.startsWith("catalogo ")) {
    return { texto: textoCatalogo(catalogoConta), tipo: "catalogo" };
  }
  if (t === "pacotes" || t === "pacote") {
    return { texto: textoPacotes(catalogoConta.pacotes), tipo: "pacotes" };
  }
  if (t.startsWith("resumo") || t === "saldo" || t.startsWith("quanto ")) {
    const p = periodoDe(t, agora);
    const r = await resumoDe(telefone, p.desde, p.ate);
    return { texto: textoResumo(r, p.rotulo) + `\n\nSe quiser o recibo em PDF, é só dizer PDF SEMANA ou PDF MES.`, tipo: "resumo" };
  }
  if (t.startsWith("pdf")) {
    const p = periodoDe(t.includes("semana") ? "semana" : "mes", agora);
    const r = await resumoDe(telefone, p.desde, p.ate);
    return {
      texto: textoResumo(r, p.rotulo, "\n\nO PDF com o seu nome em cima sai quando você fechar o plano — " +
        "os lançamentos já estão todos guardados e nada se perde."),
      tipo: "pdf",
    };
  }

  // 4) Lançamento de dinheiro: NOVO / ENTRADA / SAIDA / DESPESA.
  const tipoLancamento = /^(novo|entrada|venda)\b/.test(t) ? "entrada"
    : /^(saida|saidas|despesa|gasto)\b/.test(t) ? "saida" : "";
  if (tipoLancamento) {
    const resto = t.replace(/^(novo|entrada|venda|saida|saidas|despesa|gasto)\b/, "").trim();
    const { valor, descricao } = separarValor(resto);
    const limpa = letrasOriginais(bruto, String(descricao || "").trim()) || String(descricao || "").trim();
    if (!limpa) return { texto: "O que você lançou? Exemplo: NOVO corte 30,00", tipo: "pergunta" };
    if (valor === null) {
      await gravarPendencia(telefone, "valor", { tipo: tipoLancamento, descricao: limpa });
      return { texto: `Anotei ${tipoLancamento === "entrada" ? "a entrada" : "a saída"} de ${limpa}. Quanto foi?`, tipo: "pergunta" };
    }
    return await confirmarLancamento(telefone, { tipo: tipoLancamento, descricao: limpa, valor }, agora);
  }

  // 5) Cadastro de preço e de pacote.
  const preco = /^(preco|preço)\s+(servico|produto)\s+/i.test(t + " ");
  if (preco) {
    const m = /^preco\s+(servico|produto)\s+(.*)$/.exec(t.replace(/preço/g, "preco")) || [];
    const tipo = m[1] === "servico" ? "servico" : "produto";
    const { valor, descricao } = separarValor(String(m[2] || ""));
    const nome = letrasOriginais(bruto, String(descricao || "").trim()) || String(descricao || "").trim();
    if (!nome) return { texto: "Falta o nome. Exemplo: PRECO SERVICO corte 30,00", tipo: "pergunta" };
    if (valor === null) {
      await gravarPendencia(telefone, "valor_preco", { tipo, nome });
      return { texto: `Vou cadastrar ${nome}. Qual é o preço?`, tipo: "pergunta" };
    }
    return await aplicarPreco(telefone, tipo, nome, valor);
  }
  if (t.startsWith("pacote ")) {
    const { valor, descricao: semPreco } = separarValor(t.replace(/^pacote\s+/, ""));
    const quantidade = /(?:^|\s)(\d{1,3})(?:\s|$)/.exec(" " + semPreco + " ");
    const nome = letrasOriginais(bruto, semPreco.replace(/\s+/g, " ").trim()) || semPreco.replace(/\s+/g, " ").trim();
    if (!nome) return { texto: "Falta o nome. Exemplo: PACOTE 10 cortes 250,00", tipo: "pergunta" };
    if (valor === null) return { texto: "Quanto custa o pacote? Exemplo: PACOTE 10 cortes 250,00", tipo: "pergunta" };
    const servico = servirDaFrase(nome, catalogoConta.servicos);
    await gravarPacote(telefone, quantidade ? nome.replace(String(quantidade[1]), "").trim() : nome,
      servico ? servico.nome : nome, Number(quantidade ? quantidade[1] : 1), valor);
    return { texto: `Salvei o pacote: ${nome} por R$ ${formatarValor(valor)}. Veja em PACOTES.`, tipo: "pacote" };
  }

  if (t === "ver agendamentos" || t === "ver agendamentos semanal") {
    const hojeLocal = relogio(agora);
    const hoje = instanteDe({ ...hojeLocal, hora: 0, minuto: 0 });
    const semanal = t === "ver agendamentos semanal";
    const periodo = semanal
      ? {
        desde: hoje,
        ate: instanteDe({ ...hojeLocal, dia: hojeLocal.dia + 7, hora: 0, minuto: 0 }),
        rotulo: "Próximos sete dias",
      }
      : { desde: hoje, ate: new Date(hoje.getTime() + 86_400_000), rotulo: "Hoje" };
    const lista = await agendamentosDe(telefone, periodo.desde, periodo.ate, "", 500);
    return { texto: textoAgenda(lista, agora, periodo.rotulo), tipo: "agenda" };
  }

  // 6) A lista dele primeiro: "AGENDA", "LISTA" e "AGENDA hoje" mostram, não marcam.
  if (t === "agenda" || /^(lista|proximos|proximos dias)\b/.test(t) || /^agenda\s+(hoje|semana)\b/.test(t)) {
    const hoje = instanteDe({ ...relogio(agora), hora: 0, minuto: 0 });
    const hojeMesmo = /^agenda\s+hoje\b/.test(t) || t.startsWith("lista");
    // "Sete dias" é a semana inteira, não 168 horas: o horário das 23h do sétimo dia também entra.
    const setima = relogio(agora);
    const p = hojeMesmo
      ? { desde: hoje, ate: new Date(hoje.getTime() + 86_400_000), rotulo: "Hoje" }
      : { desde: agora, ate: instanteDe({ ...setima, dia: setima.dia + 7, hora: 23, minuto: 59 }), rotulo: "Próximos sete dias" };
    const lista = await agendamentosDe(telefone, p.desde, p.ate, "marcado");
    return { texto: textoAgenda(lista, agora, p.rotulo), tipo: "agenda" };
  }
  if (/^(agenda|agendar|marcar|marca)\b/.test(t)) {
    // A frase original, sem a palavra do comando: é dela que sai o nome do cliente com as
    // letras que ele digitou, e o telefone com a máscara que ele usou.
    return await montarAgendamento(conta, String(bruto || "").replace(/^\s*(?:agenda|agendar|marcar|marca)\b/i, "").trim(), catalogoConta, agora);
  }

  // 7) O que ele faz com um horário da lista: AVISA / REMARCAR / FEITO / CANCELAR + número.
  const numero = /^(avisa|avisar|remarcar|remarca|feito|fiz|cancelar|cancela)\s+(\d{1,4})\b/.exec(t);
  if (numero) {
    const comando = numero[1];
    const agendamento = await agendamentoPorNumero(telefone, Number(numero[2]));
    if (!agendamento) return { texto: `Não achei o horário ${numero[2]}. Manda LISTA para ver os números de hoje.`, tipo: "pergunta" };
    return await tratarHorario(agendamento, comando, t, conta, textos, conf, catalogoConta, agora);
  }

  // 8) Não entendeu: é a fila de treino dele, igual ao robô do Peixeiro.
  await consultar(`insert into public.barber_treino (telefone, texto) values ($1, $2)`, [telefone, String(bruto || "").slice(0, 600)]);
  return {
    texto: "Não te entendi. Manda MENU que eu te mostro o que ele faz.\n\nExemplos que funcionam:\n" +
      "  NOVO corte 30,00\n  SAIDA energia 220\n  AGENDA João 11999998888 sábado 15h\n  RESUMO",
    tipo: "sem_regra",
  };
}

async function responderRetornoPagamento(telefone: string, frase: string): Promise<Resposta | null> {
  const resposta = interpretarRetornoPagamento(frase);
  if (!resposta) return null;

  const pendente = await consultar1(
    `select id, cliente_nome, servico
       from public.barber_agendamento
      where telefone = $1
        and feedback_solicitado_em is not null
        and feedback_registrado_em is null
        and compareceu is null
        and forma_pagamento is null
      order by feedback_solicitado_em desc, id desc
      limit 1`,
    [telefone],
  );
  if (!pendente) return null;

  const forma = resposta === "nao_veio" ? null : resposta;
  const compareceu = resposta !== "nao_veio";
  const salvo = await consultar1(
    `update public.barber_agendamento
        set forma_pagamento = $2, compareceu = $3, feedback_registrado_em = now(),
            atualizado_em = now()
      where id = $1
        and telefone = $4
        and feedback_registrado_em is null
      returning cliente_nome, servico`,
    [Number(pendente.id), forma, compareceu, telefone],
  );
  if (!salvo) return { texto: "Esse retorno já foi registrado.", tipo: "feedback_duplicado" };

  const cliente = String(salvo.cliente_nome || "cliente");
  const servico = String(salvo.servico || "serviço");
  const texto = resposta === "nao_veio"
    ? `Anotado: ${cliente} não veio para ${servico}.`
    : `Anotado: ${cliente} pagou ${servico} com ${resposta === "pix" ? "PIX" : "cartão"}.`;
  return { texto, tipo: "feedback_pagamento" };
}

async function confirmarLancamento(
  telefone: string, dados: { tipo: string; descricao: string; valor: number }, agora: Date,
): Promise<Resposta> {
  await gravarPendencia(telefone, "lancar", dados);
  const rotulo = dados.tipo === "entrada" ? "ENTROU" : "SAIU";
  return {
    texto: `Confere?\n\n  ${rotulo} ${dados.descricao}\n  R$ ${formatarValor(dados.valor)}\n  ${formatarBrasilia(agora)}\n\nResponda SIM para gravar, NÃO para descartar.`,
    tipo: "confirma",
  };
}

async function aplicarPreco(telefone: string, tipo: "servico" | "produto", nome: string, valor: number): Promise<Resposta> {
  await gravarPreco(telefone, tipo, nome, valor);
  return {
    texto: `Salvei: ${nome} — R$ ${formatarValor(valor)} (${tipo === "servico" ? "serviço" : "produto"}).\n` +
      `Agora, quando você mandar NOVO ${nome.toLowerCase()} 30,00, eu já sei o nome certo do serviço.`,
    tipo: "preco",
  };
}

async function aplicarPendencia(
  telefone: string, pendencia: Pendencia, agora: Date,
): Promise<Resposta> {
  const d = pendencia.dados;
  if (pendencia.acao === "lancar") {
    const id = await lancar(telefone, String(d.tipo || "entrada") === "saida" ? "saida" : "entrada",
      String(d.descricao || ""), Number(d.valor || 0), agora);
    if (!id) return { texto: "Não consegui gravar. Tenta de novo.", tipo: "erro" };
    const p = periodoDe("mes", agora);
    const r = await resumoDe(telefone, p.desde, p.ate);
    return { texto: `Gravado.\n\n${textoResumo(r, p.rotulo)}`, tipo: "gravado" };
  }
  if (pendencia.acao === "agenda") {
    const conta = await contaDeTelefone(telefone);
    if (!conta?.aceita_agendamento) {
      return { texto: "Este estabelecimento não aceita agendamentos online.", tipo: "agenda_desativada" };
    }
    const quando = new Date(String(d.data_hora || ""));
    if (!Number.isFinite(quando.getTime()) || quando.getTime() <= agora.getTime()) {
      return { texto: "Esse horário já passou ou é inválido. Manda o dia e a hora novamente.", tipo: "erro" };
    }
    const rel = relogio(quando);
    const diaIso = `${rel.ano}-${String(rel.mes).padStart(2, "0")}-${String(rel.dia).padStart(2, "0")}`;
    if (await horarioNoAlmoco(telefone, diaIso, horaDe(quando), 30)) {
      return { texto: "Esse horário fica dentro do intervalo de almoço e não pode ser marcado.", tipo: "agenda_almoco" };
    }
    const criado = await criarAgendamento(telefone, {
      cliente_telefone: String(d.cliente_telefone || ""),
      cliente_nome: String(d.cliente_nome || ""),
      servico: String(d.servico || ""),
      data_hora: new Date(String(d.data_hora)),
    });
    if (!criado) return { texto: "Não consegui anotar. Manda de novo.", tipo: "erro" };
    return {
      texto: `Anotado: horário ${criado.numero}.\n\n  ${rotuloDoDia(criado.data_hora, agora)}, ${horaDe(criado.data_hora)} — ` +
        `${criado.cliente_nome || "cliente"}${criado.servico ? ` (${criado.servico})` : ""}\n\n` +
        `De manhã eu te mando a lista com esse número. Se você não puder atender, responde AVISA ${criado.numero}.`,
      tipo: "agenda",
    };
  }
  if (pendencia.acao === "remarcar") {
    const conta = await contaDeTelefone(telefone);
    if (!conta?.aceita_agendamento) {
      return { texto: "Este estabelecimento não aceita agendamentos online.", tipo: "agenda_desativada" };
    }
    const quando = new Date(String(d.data_hora || ""));
    if (!Number.isFinite(quando.getTime()) || quando.getTime() <= agora.getTime()) {
      return { texto: "Esse horário já passou ou é inválido. Manda o dia e a hora novamente.", tipo: "erro" };
    }
    const rel = relogio(quando);
    const diaIso = `${rel.ano}-${String(rel.mes).padStart(2, "0")}-${String(rel.dia).padStart(2, "0")}`;
    if (await horarioNoAlmoco(telefone, diaIso, horaDe(quando), 30)) {
      return { texto: "Esse horário fica dentro do intervalo de almoço e não pode ser marcado.", tipo: "agenda_almoco" };
    }
    const agendamento = await agendamentoPorNumero(telefone, Number(d.numero));
    if (!agendamento) return { texto: "Aquele horário não existe mais.", tipo: "erro" };
    if (!await remarcarAgendamento(agendamento.id, telefone, quando)) {
      return { texto: "Não consegui remarcar esse horário. Confira a agenda e tente de novo.", tipo: "erro" };
    }
    return {
      texto: `Remarcado: horário ${agendamento.numero} para ${rotuloDoDia(quando, agora)}, ` +
        `${horaDe(quando)}.\n\nManda AVISA ${agendamento.numero} que eu aviso o ${agendamento.cliente_nome || "cliente"}.`,
      tipo: "remarcado",
    };
  }
  return { texto: "Não entendi o que confirmar. Manda o comando de novo.", tipo: "erro" };
}

/** AVISA, REMARCAR, FEITO e CANCELAR em cima de um horário já marcado. */
async function tratarHorario(
  agendamento: Agendamento, comando: string, frase: string, conta: Conta, textos: Textos,
  conf: Conf, itensCatalogo: { servicos: ItemCatalogo[]; produtos: ItemCatalogo[] }, agora: Date,
): Promise<Resposta> {
  const telefone = conta.telefone;

  if (comando === "feito" || comando === "fiz") {
    if (agendamento.status === "feito") return { texto: `O horário ${agendamento.numero} já está lançado.`, tipo: "pergunta" };
    const servico = servirDaFrase(agendamento.servico, itensCatalogo.servicos);
    await mudarStatus(agendamento.id, telefone, "feito");
    const valor = servico ? servico.preco : 0;
    const descricao = `${agendamento.servico || "serviço"} ${agendamento.cliente_nome}`.trim();
    if (valor > 0) {
      await lancar(telefone, "entrada", descricao, valor, agora);
      const p = periodoDe("mes", agora);
      const r = await resumoDe(telefone, p.desde, p.ate);
      return {
        texto: `Serviço feito e lançado:\n  ${descricao} — R$ ${formatarValor(valor)}\n\n${textoResumo(r, p.rotulo)}`,
        tipo: "feito",
      };
    }
    await gravarPendencia(telefone, "valor", { tipo: "entrada", descricao });
    return { texto: `Marquei como feito. Quanto foi ${agendamento.servico || "o serviço"}?`, tipo: "pergunta" };
  }

  if (comando === "cancelar" || comando === "cancela") {
    await mudarStatus(agendamento.id, telefone, "cancelado");
    return { texto: `Horário ${agendamento.numero} cancelado. Manda AVISA ${agendamento.numero} se você quiser que eu avise o cliente.`, tipo: "cancelado" };
  }

  if (comando === "avisa" || comando === "avisar") {
    if (!agendamento.cliente_telefone) {
      return {
        texto: `Não tenho o telefone do ${agendamento.cliente_nome || "cliente"} nesse horário. Avisa você mesmo, ou remarca com o número dele:\n` +
          `  AGENDA 11999998888 ${agendamento.cliente_nome || "João"} ${dataDe(agendamento.data_hora)} ${horaDe(agendamento.data_hora)}`,
        tipo: "pergunta",
      };
    }
    return await avisarCliente(agendamento, conta, textos, conf, agora, "remarcado", null);
  }

  // remarcar: precisa de um novo dia e hora na mesma frase
  const resto = frase.replace(/^avisa|remarcar|remarca|feito|fiz|cancelar|cancela|\s*\d{1,4}/, "").trim();
  const quando = lerQuando(resto, agora);
  if (!quando.instant) {
    return {
      texto: quando.faltando === "hora"
        ? `Faltou a hora nova. Exemplo: REMARCAR ${agendamento.numero} sexta 16h`
        : `Para remarcar, me diga o dia novo e a hora:\n  REMARCAR ${agendamento.numero} sexta 16h`,
      tipo: "pergunta",
    };
  }
  if (!conta.aceita_agendamento) {
    return { texto: "Este estabelecimento não aceita agendamentos online.", tipo: "agenda_desativada" };
  }
  const relHorario = relogio(quando.instant);
  const diaIsoHorario = `${relHorario.ano}-${String(relHorario.mes).padStart(2, "0")}-${String(relHorario.dia).padStart(2, "0")}`;
  if (await horarioNoAlmoco(conta.telefone, diaIsoHorario, horaDe(quando.instant), 30)) {
    return { texto: "Esse horário fica dentro do intervalo de almoço. Escolha outro horário.", tipo: "agenda_almoco" };
  }
  await gravarPendencia(telefone, "remarcar", { numero: agendamento.numero, data_hora: quando.instant.toISOString() });
  return {
    texto: `Horário ${agendamento.numero} (${agendamento.cliente_nome || "cliente"}${agendamento.servico ? `, ${agendamento.servico}` : ""}) ` +
      `vai para ${quando.rotulo}.\n\nResponda SIM para confirmar.`,
    tipo: "confirma",
  };
}

/** A mensagem que sai do bot para o CLIENTE do barbeiro, montada com o serviço do catálogo. */
async function avisarCliente(
  agendamento: Agendamento, conta: Conta, textos: Textos, conf: Conf, agora: Date,
  situacao: string, novoHora: Date | null,
): Promise<Resposta> {
  const modelo = textos.aviso_cliente;
  if (!modelo) return { texto: "O aviso ao cliente está desligado (sem texto na aba Chat Barbearia).", tipo: "erro" };
  if (await estaBloqueado(agendamento.cliente_telefone)) {
    return { texto: "Este cliente pediu para não receber mensagem nossa, então não mandei. Avisa você mesmo.", tipo: "bloqueado" };
  }
  const v = variaveisDaConta(conf, conta, {
    nome_cliente: nomeAproveitavel(agendamento.cliente_nome) || primeiroDoTelefone(agendamento.cliente_telefone),
    barbearia: nomeAproveitavel(conta.nome) || "nossa barbearia",
    servico: agendamento.servico || "seu horário",
    situacao,
    dia: rotuloDoDia(agendamento.data_hora, agora),
    data: dataDe(agendamento.data_hora),
    hora_agendada: horaDe(agendamento.data_hora),
    novo: novoHora ? `O novo horário é ${rotuloDoDia(novoHora, agora)}, ${horaDe(novoHora)}.` : "",
  }, agora);
  const corpo = preencherVariaveis(modelo, v);
  const envio = await enviarTexto(conf, agendamento.cliente_telefone, corpo);
  if (!envio.ok) return { texto: `Não consegui mandar para ${formatarTelefone(agendamento.cliente_telefone)}: ${envio.error || "sem resposta"}`, tipo: "erro" };
  await registrarMensagem(agendamento.cliente_telefone, "saida", corpo, `${agendamento.cliente_telefone}-aviso-${Date.now()}`, textos.dias_retencao);
  return {
    texto: `Avisado: ${agendamento.cliente_nome || "cliente"} recebeu a mensagem no ${formatarTelefone(agendamento.cliente_telefone)}.`,
    tipo: "avisado",
  };
}

function primeiroDoTelefone(telefone: string): string {
  return formatarTelefone(telefone);
}

/** Monta a pergunta de confirmação do agendamento a partir da frase, sem gravar nada ainda. */
async function montarAgendamento(
  conta: Conta, frase: string, itensCatalogo: { servicos: ItemCatalogo[]; produtos: ItemCatalogo[] },
  agora: Date,
): Promise<Resposta> {
  const bruto = String(frase || "").trim();
  if (!bruto) {
    return {
      texto: "Como marcar:\n  AGENDA João 11999998888 sábado 15h\n  AGENDA Maria amanhã 14h\n  AGENDA José terça 9h30\n  AGENDA Ana quarta 9e20",
      tipo: "pergunta",
    };
  }

  // Telefone do cliente: aceita puro, com espaços e com máscara. O DDD junto com os dois
  // blocos de quatro ou cinco dígitos é o que separa o número de uma data ou de um preço.
  const mascara = /(?:\+?55[\s().-]*)?(?:1[1-9]|2[1-9]|3[1-5]|4[1-4]|5[1-5]|6[1-9]|7[1-9]|8[1-9]|9[1-9])[\s().-]*\d{4,5}[\s().-]*\d{4}(?!\d)/.exec(bruto);
  const clienteTelefone = mascara ? normalizarWhatsapp(mascara[0]) : "";
  const semTelefone = mascara ? bruto.replace(mascara[0], " ").replace(/\s+/g, " ").trim() : bruto;

  const quando = lerQuando(semTelefone, agora);
  if (quando.faltando === "invalido" || quando.faltando === "passado") {
    return { texto: "Essa data não bate. Exemplo: AGENDA João sábado 15h", tipo: "pergunta" };
  }
  if (!quando.instant) {
    return {
      texto: quando.faltando === "hora"
        ? `Anotei o dia, faltou a hora. Exemplo: AGENDA ${quando.sobra || "João"} ${dataDe(instanteDoDia(agora))} 15h`
        : "Falta o dia. Exemplo: AGENDA João sábado 15h · AGENDA João amanhã 14h",
      tipo: "pergunta",
    };
  }

  const servico = servirDaFrase(quando.sobra, itensCatalogo.servicos);
  const clienteNome = nomeOriginal(semTelefone, quando.sobra, servico ? servico.nome : "");
  const precoDe = servico ? servico.preco : null;

  await gravarPendencia(conta.telefone, "agenda", {
    cliente_telefone: clienteTelefone,
    cliente_nome: clienteNome,
    servico: servico ? servico.nome : "",
    data_hora: quando.instant.toISOString(),
  });

  const linhas = [
    `Confirma o horário?\n\n  ${quando.rotulo}${servico ? ` · ${servico.nome}` : ""}`,
    clienteNome ? `  Cliente: ${clienteNome}` : "  Cliente: sem nome (manda de novo com o nome se quiser)",
    clienteTelefone ? `  Telefone: ${formatarTelefone(clienteTelefone)}` : "  Telefone: sem número, então só você recebe a lista",
    precoDe !== null ? `  Valor: R$ ${formatarValor(precoDe)}` : "",
    "",
    "Responda SIM para gravar. Se trocou alguma coisa, reescreva a linha do AGENDA.",
  ].filter((l) => l !== "");
  return { texto: linhas.join("\n"), tipo: "confirma" };
}

function instanteDoDia(agora: Date): Date {
  return instanteDe({ ...relogio(agora), hora: 0, minuto: 0 });
}

/** O parser trabalha em minúscula sem acento, mas o que vai para o WhatsApp e para o banco são
 *  as letras que o barbeiro digitou: "José", e não "jose". Os tokens que sobraram da data e da
 *  hora são pareados com a frase original, na ordem. */
function letrasOriginais(frase: string, sobra: string): string {
  const originais = String(frase || "").split(/\s+/).filter(Boolean);
  const normais = String(sobra || "").split(/\s+/).filter(Boolean);
  const achados: string[] = [];
  let p = 0;
  for (const token of originais) {
    if (p >= normais.length) break;
    if (semAcento(token.toLowerCase()) !== normais[p]) continue;
    achados.push(token);
    p++;
  }
  return achados.join(" ");
}

function nomeOriginal(frase: string, sobra: string, servico: string): string {
  const palavras = semAcento(String(servico || "").toLowerCase()).split(/\s+/).filter((w) => w.length >= 3);
  return letrasOriginais(frase, sobra)
    .split(/\s+/).filter(Boolean)
    .filter((n) => !palavras.includes(semAcento(n.toLowerCase())))
    .slice(0, 2).join(" ");
}

// ------------------------------------------------------------------ as conversas

/** O que a tela vê de um agendamento: data e hora já no formato de Brasília, porque o painel
 *  não tem fuso nenhum no navegador. */
export function agendamentosParaTela(lista: Agendamento[]): Bruto[] {
  return lista.map((a) => ({
    numero: a.numero,
    nome: a.cliente_nome,
    telefone: a.cliente_telefone ? formatarTelefone(a.cliente_telefone) : "",
    servico: a.servico,
    dia: dataDe(a.data_hora),
    hora: horaDe(a.data_hora),
    profissional: a.funcionario_nome,
    status: a.status,
    lembrete: a.lembrete ? "sim" : "",
  }));
}

/** Manda agora, sem fila, com as variáveis da barbearia e a conversa guardada. É o mesmo
 *  caminho do disparo em lote — o que muda é só não passar pela `barber_fila`. */
export async function enviarParaBarbeiro(
  telefone: string, modelo: string,
): Promise<{ ok: boolean; error?: string; simulado: boolean; texto: string }> {
  const conta = await contaDeTelefone(telefone);
  if (!conta) return { ok: false, error: "sem_barbearia", simulado: false, texto: "" };
  const conf = await obterConfig();
  if (!conf) return { ok: false, error: "sem_banco", simulado: false, texto: "" };
  if (await estaBloqueado(conta.telefone)) return { ok: false, error: "bloqueado", simulado: false, texto: "" };
  const corpo = preencherVariaveis(String(modelo || ""), variaveisDaConta(conf, conta));
  const envio = await enviarTexto(conf, conta.telefone, corpo);
  const textos = await obterTextos();
  if (envio.ok) {
    await registrarMensagem(conta.telefone, "saida", corpo, `painel-${conta.telefone}-${Date.now()}`, textos.dias_retencao);
  }
  return {
    ok: Boolean(envio.ok),
    error: envio.ok ? undefined : String(envio.error || "sem_resposta"),
    simulado: Boolean(envio.simulado),
    texto: corpo,
  };
}

// ---------------------------------------------------------------------------

async function registrarMensagem(
  telefone: string, direcao: string, texto: string, chave: string, dias: number,
): Promise<boolean> {
  const expira = new Date(Date.now() + Math.max(1, dias) * 86_400_000).toISOString();
  const r = await consultar(
    `insert into public.barber_mensagens (chave, telefone, direcao, texto, expira_em)
     values ($1, $2, $3, $4, $5) on conflict (chave) do nothing`,
    [chave || null, telefone, direcao, texto, expira],
  );
  return (r.rowCount || 0) > 0;
}

async function responderAdminRenovacao(
  conf: Conf,
  telefone: string,
  texto: string,
): Promise<{ status: number; dados: Bruto }> {
  const envio = await enviarTexto(conf, telefone, texto);
  return {
    status: 200,
    dados: { ok: Boolean(envio.ok), tipo: "renovacao", simulado: Boolean(envio.simulado) },
  };
}

async function processarComandoRenovacao(
  comando: { telefone: string },
  m: NonNullable<ReturnType<typeof interpretar>["mensagem"]>,
  conf: Conf,
  textos: Textos,
): Promise<{ status: number; dados: Bruto }> {
  const responder = (texto: string) => responderAdminRenovacao(conf, m.telefone, texto);
  if (!comando.telefone) return await responder("Use: renovar seguido do telefone com DDD e código do país.");
  const telefone = normalizarWhatsapp(comando.telefone);
  if (!telefoneValido(telefone)) return await responder("Telefone inválido. Nenhuma renovação foi feita.");
  if (!m.chave) {
    return await responder("Não consegui confirmar esta mensagem com segurança. Envie o comando novamente.");
  }

  const renovacao = await consultar1(
    `select * from public.barber_renovar_um_mes($1, $2)`,
    [m.chave, telefone],
  );
  const resultado = String(renovacao?.resultado || "");
  const vencimento = renovacao?.expira_nova ? new Date(String(renovacao.expira_nova)) : null;
  const vencimentoTexto = vencimento && Number.isFinite(vencimento.getTime())
    ? formatarBrasilia(vencimento) : "";

  if (resultado === "duplicado") {
    return await responder(vencimentoTexto
      ? `Este comando já foi processado; não renovei de novo. Vencimento registrado: ${vencimentoTexto}.`
      : "Este comando já foi processado e não gerou outra renovação.");
  }
  if (resultado === "nao_encontrado") {
    return await responder("Não encontrei esse estabelecimento. Nenhuma renovação foi feita.");
  }
  if (resultado !== "renovado" || !vencimentoTexto) {
    throw new Error("resultado inesperado ao renovar a conta da barbearia");
  }

  const notificacao = `Olá! Sua renovação de 1 mês já foi computada. ` +
    `Seu plano vence em ${vencimentoTexto} (horário de Brasília).`;
  const envio = await enviarTexto(conf, telefone, notificacao);
  if (envio.ok && !envio.simulado) {
    await registrarMensagem(
      telefone, "saida", notificacao, `renovacao-${m.chave}`, textos.dias_retencao,
    );
  }

  const nome = nomeAproveitavel(String(renovacao?.nome || ""));
  const aviso = envio.ok && !envio.simulado
    ? "Aviso enviado ao barbeiro."
    : envio.simulado
    ? "O modo de teste está ativo; a mensagem não foi enviada ao WhatsApp."
    : "O vencimento foi atualizado, mas o aviso não saiu. Confira o bloqueio e a Green API.";
  return await responder(
    `Renovação aplicada${nome ? ` para ${nome}` : ""}. Vencimento: ${vencimentoTexto}. ${aviso}`,
  );
}

export async function conversasBarbearia(dias: number, limite = 50): Promise<Bruto[]> {
  const r = await consultar(
    `select m.telefone,
            coalesce(c.nome, '') as nome,
            count(*)::int as quantidade,
            to_char(max(m.criado_em), 'DD/MM/YYYY "às" HH24:MI') as ultima
       from public.barber_mensagens m
       left join public.barber_contas c on c.telefone = m.telefone
      where m.direcao = 'entrada' and m.criado_em > now() - ($1 * interval '1 day')
      group by m.telefone, c.nome
      order by max(m.criado_em) desc
      limit $2`,
    [Math.max(1, dias), limite],
  );
  return r.rows.map((l) => ({
    telefone: String(l.telefone || ""), nome: String(l.nome || ""),
    quantidade: Number(l.quantidade || 0), ultima: String(l.ultima || ""),
  }));
}

export async function mensagensDoBarbeiro(telefone: string, limite = 200): Promise<Bruto[]> {
  const r = await consultar(
    `select direcao, texto, to_char(criado_em, 'DD/MM/YYYY "às" HH24:MI') as criado_em
       from public.barber_mensagens where telefone = $1 order by id desc limit $2`,
    [telefone, limite],
  );
  return r.rows.map((l) => ({
    direcao: String(l.direcao || ""), texto: String(l.texto || ""), criado_em: String(l.criado_em || ""),
  })).reverse();
}

export async function exportarConversasBarbearia(dias: number): Promise<{ csv: string; nome: string; n: number }> {
  const r = await consultar(
    `select m.telefone, coalesce(c.nome, '') as nome, m.direcao, m.texto,
            to_char(m.criado_em, 'DD/MM/YYYY HH24:MI') as quando
       from public.barber_mensagens m
       left join public.barber_contas c on c.telefone = m.telefone
      where m.criado_em > now() - ($1 * interval '1 day')
      order by m.id limit 20000`,
    [Math.max(1, dias)],
  );
  const linhas: string[][] = [["Telefone", "Barbearia", "Direção", "Quando", "Mensagem"]];
  for (const l of r.rows) {
    linhas.push([formatarTelefone(String(l.telefone || "")), String(l.nome || ""),
      String(l.direcao || ""), String(l.quando || ""), String(l.texto || "")]);
  }
  return { csv: "﻿" + escreverCsv(linhas), nome: "conversas-barbearia.csv", n: r.rows.length };
}

export async function filaTreinoBarbearia(limite = 200): Promise<Bruto[]> {
  const r = await consultar(
    `select telefone, texto, to_char(criado_em, 'DD/MM/YYYY HH24:MI') as quando
       from public.barber_treino order by id desc limit $1`,
    [limite],
  );
  return r.rows.map((l) => ({
    telefone: String(l.telefone || ""), texto: String(l.texto || ""), quando: String(l.quando || ""),
  }));
}

// ------------------------------------------------------------------ interessados

/** O "CONTROLE" de quem ainda não é barbearia: a ficha dele na aba Adicionar Barbeiros.
 *  Não entra ninguém que já é cliente do O Peixeiro — esses continuam só com o robô velho. */
export async function registrarInteresse(
  telefone: string, texto: string,
): Promise<{ gravado: boolean; resposta: string } | null> {
  const t = semAcento(String(texto || "").toLowerCase());
  if (!/(^|\s)controle(\s|$)/.test(t)) return null;
  if (await contaDeTelefone(telefone)) return null;
  if (await clientePorTelefone(telefone)) return null;
  const primeiro = await consultar(
    `insert into public.barber_interessados (telefone, texto, criado_em)
     values ($1, $2, now()) on conflict (telefone) do nothing returning telefone`,
    [telefone, String(texto || "").slice(0, 200)],
  );
  const textos = await obterTextos();
  if (!(primeiro.rowCount || 0)) return { gravado: false, resposta: "" };
  return { gravado: true, resposta: textos.msg_interesse };
}

type EstadoEntrada = { estado: string; dados: Bruto };

const MENU_ENTRADA =
  "Oi! Ainda não reconheço este número. Quer conhecer as funções? Digite MENU.\n" +
  "Ou escolha uma opção:\n" +
  "1 — Tenho um estabelecimento e quero cadastrar\n" +
  "2 — Trabalho em um estabelecimento e quero pedir acesso\n" +
  "3 — Sou cliente e quero consultar ou mudar meu horário\n" +
  "4 — Quero conhecer o menu de controle\n\n" +
  "Se precisar de atendimento, digite FALAR COM SUPORTE.";

const MENU_CONTROLE_PADRAO =
  "NOVO — registrar um serviço prestado ou uma venda\n" +
  "SAIDA — registrar uma despesa\n" +
  "PRECO SERVICO corte 30,00 — cadastrar ou atualizar um serviço\n" +
  "PRECO PRODUTO pomada 25,00 — cadastrar ou atualizar um produto\n" +
  "CATALOGO — consultar serviços e produtos\n" +
  "PACOTES — consultar pacotes\n" +
  "RESUMO — entradas, saídas e saldo do mês\n" +
  "PDF SEMANA / PDF MES — gerar relatório\n" +
  "AJUDA — mostrar este menu novamente";

async function obterEstadoEntrada(telefone: string): Promise<EstadoEntrada | null> {
  const linha = await consultar1(
    `select estado, dados from public.barber_entrada where telefone = $1 and expira_em > now()`,
    [telefone],
  );
  if (!linha) return null;
  const dados = linha.dados && typeof linha.dados === "object" && !Array.isArray(linha.dados)
    ? linha.dados as Bruto : {};
  return { estado: String(linha.estado || "menu"), dados };
}

async function salvarEstadoEntrada(telefone: string, estado: string, dados: Bruto = {}): Promise<void> {
  await consultar(
    `insert into public.barber_entrada (telefone, estado, dados, atualizado_em, expira_em)
     values ($1, $2, $3::jsonb, now(), now() + interval '7 days')
     on conflict (telefone) do update
       set estado = excluded.estado, dados = excluded.dados,
           atualizado_em = now(), expira_em = excluded.expira_em`,
    [telefone, estado, JSON.stringify(dados)],
  );
}

async function apagarEstadoEntrada(telefone: string): Promise<void> {
  await consultar(`delete from public.barber_entrada where telefone = $1`, [telefone]);
}

async function responderEntrada(
  telefone: string, resposta: string, conf: Conf, textos: Textos, tipo: string,
): Promise<{ status: number; dados: Bruto }> {
  const envio = await enviarTexto(conf, telefone, resposta);
  if (envio.ok) {
    await registrarMensagem(telefone, "saida", resposta,
      `entrada-${telefone}-${Date.now()}-${aleatorio(4)}`, textos.dias_retencao);
  }
  return {
    status: 200,
    dados: { ok: Boolean(envio.ok), tipo, simulado: Boolean(envio.simulado),
      error: envio.ok ? undefined : String(envio.error || "") },
  };
}

async function salvarSolicitacao(telefone: string, texto: string): Promise<void> {
  await consultar(
    `insert into public.barber_interessados (telefone, texto, criado_em, atualizado_em)
     values ($1, $2, now(), now())
     on conflict (telefone) do update
       set texto = excluded.texto, criado_em = now(), atualizado_em = now()`,
    [telefone, texto.slice(0, 500)],
  );
}

async function agendamentosDoCliente(telefone: string): Promise<Bruto[]> {
  const r = await consultar(
    `select a.id, a.numero, a.telefone as barbearia, c.nome as estabelecimento,
            a.servico, a.data_hora, a.duracao_min, a.funcionario_id, a.funcionario_telefone,
            coalesce(f.nome, '') as funcionario_nome
       from public.barber_agendamento a
       join public.barber_contas c on c.telefone = a.telefone
       left join public.barber_funcionario f on f.id = a.funcionario_id
      where a.cliente_telefone = $1 and a.status = 'marcado' and a.data_hora >= now()
      order by a.data_hora limit 10`,
    [telefone],
  );
  return r.rows.map((linha) => ({
    id: Number(linha.id || 0),
    numero: Number(linha.numero || 0),
    barbearia: String(linha.barbearia || ""),
    estabelecimento: String(linha.estabelecimento || ""),
    servico: String(linha.servico || ""),
    data_hora: String(linha.data_hora || ""),
    duracao_min: Number(linha.duracao_min || 30),
    funcionario_id: Number(linha.funcionario_id || 0) || null,
    funcionario_telefone: String(linha.funcionario_telefone || ""),
    funcionario_nome: String(linha.funcionario_nome || ""),
  }));
}

async function estabelecimentosDoCliente(telefone: string): Promise<string[]> {
  const r = await consultar(
    `select c.telefone, c.nome, max(a.data_hora) as ultimo
       from public.barber_agendamento a
       join public.barber_contas c on c.telefone = a.telefone
      where a.cliente_telefone = $1
      group by c.telefone, c.nome
      order by max(a.data_hora) desc limit 3`,
    [telefone],
  );
  return r.rows.map((linha) => String(linha.nome || "estabelecimento"));
}

function itemAgendaEntrada(item: Bruto, indice: number): string {
  const quando = item.data_hora ? formatarBrasilia(new Date(String(item.data_hora))) : "";
  return `${indice + 1} — ${item.estabelecimento || "Estabelecimento"}: ${item.servico || "horário"} em ${quando}`;
}

async function confirmarAcaoCliente(
  telefone: string, estado: EstadoEntrada, conf: Conf, textos: Textos, agora: Date,
): Promise<{ status: number; dados: Bruto }> {
  const id = Number(estado.dados.id || 0);
  const barbearia = String(estado.dados.barbearia || "");
  const agendamento = await consultar1(
    `select id, numero, cliente_nome, cliente_telefone, servico, data_hora,
            duracao_min, funcionario_id, funcionario_telefone
       from public.barber_agendamento
      where id = $1 and telefone = $2 and cliente_telefone = $3 and status = 'marcado'
        and data_hora >= now()`,
    [id, barbearia, telefone],
  );
  if (!agendamento) {
    await apagarEstadoEntrada(telefone);
    return await responderEntrada(telefone,
      "Esse horário já não está disponível para alteração. Digite MENU para consultar novamente.",
      conf, textos, "cliente_agenda_atualizada");
  }
  if (await estaBloqueado(barbearia)) {
    await apagarEstadoEntrada(telefone);
    return await responderEntrada(telefone,
      "Não consegui confirmar com o estabelecimento. Entre em contato diretamente com ele para concluir a alteração.",
      conf, textos, "cliente_contato_estabelecimento");
  }

  const tipo = String(estado.dados.acao || "");
  if (tipo === "cancelar") {
    const atualizado = await consultar1(
      `update public.barber_agendamento
          set status = 'cancelado', atualizado_em = now()
        where id = $1 and telefone = $2 and cliente_telefone = $3
          and status = 'marcado' and data_hora >= now()
      returning numero, servico, data_hora`,
      [id, barbearia, telefone],
    );
    if (!atualizado) {
      await apagarEstadoEntrada(telefone);
      return await responderEntrada(telefone,
        "Esse horário mudou antes de eu concluir. Digite MENU para consultar novamente.",
        conf, textos, "cliente_agenda_atualizada");
    }
    const aviso = `Cancelamento solicitado pelo cliente ${formatarTelefone(telefone)}: horário ${Number(atualizado.numero || 0)} (${String(atualizado.servico || "serviço")}).`;
    const notificado = await enviarTexto(conf, barbearia, aviso);
    if (notificado.ok) {
      await registrarMensagem(barbearia, "saida", aviso,
        `cliente-cancelamento-${barbearia}-${Date.now()}-${aleatorio(4)}`, textos.dias_retencao);
    }
    await apagarEstadoEntrada(telefone);
    return await responderEntrada(telefone,
      notificado.ok
        ? "Seu horário foi cancelado. Se precisar, digite MENU para voltar às opções."
        : "Seu horário foi cancelado, mas não consegui avisar o estabelecimento. Entre em contato com ele para confirmar.",
      conf, textos, "cliente_cancelado");
  }

  const novoIso = String(estado.dados.novo_horario || "");
  const novoHorario = new Date(novoIso);
  if (!Number.isFinite(novoHorario.getTime()) || novoHorario <= agora) {
    await apagarEstadoEntrada(telefone);
    return await responderEntrada(telefone,
      "Esse horário não é válido. Digite MENU e tente novamente.",
      conf, textos, "cliente_remarcacao_invalida");
  }
  const rel = relogio(novoHorario);
  const diaIso = `${rel.ano}-${String(rel.mes).padStart(2, "0")}-${String(rel.dia).padStart(2, "0")}`;
  const funcionario = String(agendamento.funcionario_telefone || "");
  const funcionarioId = Number(agendamento.funcionario_id || 0) || null;
  const duracao = Math.max(10, Math.min(600, Number(agendamento.duracao_min || 30)));
  const disponibilidade = await vagasDoDia(barbearia, diaIso, duracao, funcionarioId || funcionario, agora);
  if (disponibilidade.fechado || !disponibilidade.vagas.includes(horaDe(novoHorario))) {
    await apagarEstadoEntrada(telefone);
    return await responderEntrada(telefone,
      "Esse horário acabou de ficar indisponível. Digite MENU para consultar as opções novamente.",
      conf, textos, "cliente_horario_indisponivel");
  }

  const atualizado = await consultar1(
    `update public.barber_agendamento a
        set data_hora = $4, lembrete_enviado_em = null, atualizado_em = now()
      where a.id = $1 and a.telefone = $2 and a.cliente_telefone = $3
        and a.status = 'marcado' and a.data_hora >= now()
        and not exists (
          select 1 from public.barber_agendamento ocupado
           where ocupado.telefone = a.telefone and ocupado.id <> a.id
             and ocupado.status = 'marcado'
             and (
               ($5::integer is null and ($6 = '' or ocupado.funcionario_telefone = $6))
               or ocupado.funcionario_id = $5
               or ($5::integer is not null and ocupado.funcionario_id is null
                   and ocupado.funcionario_telefone = $6)
               or ($5::integer is not null and ocupado.funcionario_id is null
                   and ocupado.funcionario_telefone = '')
             )
             and ocupado.data_hora < ($4 + make_interval(mins => $7))
             and ocupado.data_hora + make_interval(mins => greatest(10, ocupado.duracao_min)) > $4
        )
      returning a.numero, a.servico`,
    [id, barbearia, telefone, novoHorario.toISOString(), funcionarioId, funcionario, duracao],
  );
  if (!atualizado) {
    await apagarEstadoEntrada(telefone);
    return await responderEntrada(telefone,
      "Esse horário acabou de ficar indisponível. Digite MENU para consultar as opções novamente.",
      conf, textos, "cliente_horario_indisponivel");
  }
  const aviso = `Remarcação solicitada pelo cliente ${formatarTelefone(telefone)}: horário ${Number(atualizado.numero || 0)} ` +
    `(${String(atualizado.servico || "serviço")}) para ${dataDe(novoHorario)} às ${horaDe(novoHorario)}.`;
  const notificado = await enviarTexto(conf, barbearia, aviso);
  if (notificado.ok) {
    await registrarMensagem(barbearia, "saida", aviso,
      `cliente-remarcacao-${barbearia}-${Date.now()}-${aleatorio(4)}`, textos.dias_retencao);
  }
  await apagarEstadoEntrada(telefone);
  return await responderEntrada(telefone,
    notificado.ok
      ? `Pronto, seu horário foi remarcado para ${dataDe(novoHorario)} às ${horaDe(novoHorario)}.`
      : `Seu horário foi remarcado para ${dataDe(novoHorario)} às ${horaDe(novoHorario)}, mas não consegui avisar o estabelecimento. Entre em contato com ele para confirmar.`,
    conf, textos, "cliente_remarcado");
}

async function processarEntrada(
  telefone: string, bruto: string, conf: Conf, textos: Textos, estadoAtual: EstadoEntrada | null,
): Promise<{ status: number; dados: Bruto }> {
  const entrada = semAcento(String(bruto || "").toLowerCase())
    .replace(/^\s*\/+/, "")
    .replace(/[.!?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let estado = estadoAtual || { estado: "menu", dados: {} };

  if (entrada === "menu" || entrada === "voltar") {
    await salvarEstadoEntrada(telefone, "menu");
    return await responderEntrada(telefone, MENU_ENTRADA, conf, textos, "menu_entrada");
  }
  if (/^falar com suporte$/.test(entrada)) {
    await salvarSolicitacao(telefone, `SUPORTE: ${String(bruto || "").trim()}`);
    await apagarEstadoEntrada(telefone);
    return await responderEntrada(telefone,
      "Registrei seu pedido para a equipe. Não há um atendente conectado a esta conversa agora; o responsável poderá ver a solicitação no painel.",
      conf, textos, "suporte_solicitado");
  }
  if ((entrada === "nao" || entrada === "n") && estado.estado === "menu") {
    await apagarEstadoEntrada(telefone);
    await bloquear(telefone, telefone, "", MOTIVO_NAO);
    return { status: 200, dados: { ok: true, bloqueado: true, tipo: "entrada_recusada" } };
  }
  if (entrada === "controle" && estado.estado === "menu" && textos.responder_controle) {
    const interesse = await registrarInteresse(telefone, bruto);
    if (interesse?.gravado && interesse.resposta) {
      return await responderEntrada(telefone, interesse.resposta, conf, textos, "interesse");
    }
  }

  if (estado.estado === "cliente_confirmar_cancelamento" || estado.estado === "cliente_confirmar_remarcacao") {
    if (entrada === "sim" || entrada === "s") {
      return await confirmarAcaoCliente(telefone, estado, conf, textos, new Date());
    }
    if (entrada === "nao" || entrada === "n") {
      await apagarEstadoEntrada(telefone);
      return await responderEntrada(telefone, "Tudo bem, não alterei seu horário. Digite MENU para ver as opções.",
        conf, textos, "cliente_alteracao_cancelada");
    }
    return await responderEntrada(telefone, "Responda SIM para confirmar ou NÃO para desistir.",
      conf, textos, "cliente_confirmacao");
  }

  if (estado.estado === "menu") {
    if (entrada === "1" || entrada.startsWith("1 ") ||
      entrada === "quero testar" || entrada.startsWith("quero testar ") ||
      entrada === "teste gratis" || entrada === "testar") {
      await salvarEstadoEntrada(telefone, "novo_estabelecimento_nome");
      return await responderEntrada(telefone, "Qual é o nome do seu estabelecimento?", conf, textos, "cadastro_estabelecimento");
    }
    if (entrada === "2" || entrada.startsWith("2 ")) {
      await salvarEstadoEntrada(telefone, "funcionario_nome");
      return await responderEntrada(telefone, "Qual é o seu nome?", conf, textos, "pedido_funcionario");
    }
    if (entrada === "3" || entrada.startsWith("3 ")) {
      if (!(await tabelasDeEstabelecimento())) {
        return await responderEntrada(telefone,
          "A consulta de horários ainda não está ativada. Digite FALAR COM SUPORTE para pedir ajuda.",
          conf, textos, "cliente_agenda_indisponivel");
      }
      const agenda = await agendamentosDoCliente(telefone);
      if (!agenda.length) {
        return await responderEntrada(telefone,
          "Não encontrei horário futuro marcado com este número. Confira se usou o mesmo WhatsApp do agendamento ou digite FALAR COM SUPORTE.",
          conf, textos, "cliente_sem_agenda");
      }
      await salvarEstadoEntrada(telefone, "cliente_agenda", { agenda });
      return await responderEntrada(telefone,
        "Encontrei estes horários:\n" + agenda.map(itemAgendaEntrada).join("\n") +
        "\n\nPara mudar: REMARCAR número dia e hora (ex.: REMARCAR 1 amanhã 14h).\n" +
        "Para cancelar: CANCELAR número. Digite MENU para voltar.",
        conf, textos, "cliente_agenda");
    }
    if (entrada === "4" || entrada.startsWith("4 ")) {
      return await responderEntrada(telefone,
        `Menu de controle do estabelecimento:\n${MENU_CONTROLE_PADRAO}\n\n` +
        "Para começar o cadastro, digite 1. Para pedir ajuda, digite FALAR COM SUPORTE.",
        conf, textos, "menu_controle");
    }
    await salvarEstadoEntrada(telefone, "menu");
    return await responderEntrada(telefone, MENU_ENTRADA, conf, textos, "menu_entrada");
  }

  if (estado.estado === "novo_estabelecimento_nome") {
    const nome = String(bruto || "").trim().slice(0, 120);
    if (nome.length < 2) {
      return await responderEntrada(telefone, "Mande o nome do estabelecimento com pelo menos duas letras.",
        conf, textos, "cadastro_estabelecimento_nome");
    }
    const criado = await adicionarBarbeiro(telefone, nome, "", textos.trial_dias);
    if (!criado.ok || !criado.conta) {
      return await responderEntrada(telefone, "Não consegui concluir o cadastro. Confira o número e tente novamente.",
        conf, textos, "cadastro_estabelecimento_erro");
    }
    await salvarEstadoEntrada(telefone, "novo_estabelecimento_equipe", {
      nome,
      telefone_conta: telefone,
    });
    return await responderEntrada(telefone,
      `Cadastro iniciado para ${nome}. Seu teste já começou.\n\n` +
      "Agora me diga como funciona a equipe:\n" +
      "1 — Eu trabalho sozinho\n" +
      "2 — Eu sou o dono e divido o lucro com funcionários\n" +
      "3 — Trabalha uma equipe, mas eu mesmo cuido da contabilidade",
      conf, textos, "onboarding_equipe");
  }

  if (estado.estado === "novo_estabelecimento_equipe") {
    let modelo = "";
    let divide = false;
    if (entrada === "1" || entrada.startsWith("1 ")) modelo = "sozinho";
    else if (entrada === "2" || entrada.startsWith("2 ")) {
      modelo = "equipe_divide_lucro";
      divide = true;
    } else if (entrada === "3" || entrada.startsWith("3 ")) modelo = "equipe_dono_contabilidade";
    else {
      return await responderEntrada(telefone,
        "Responda 1, 2 ou 3:\n1 — Trabalho sozinho\n2 — Divido lucro com funcionários\n3 — Tenho equipe e cuido da contabilidade",
        conf, textos, "onboarding_equipe");
    }
    await consultar(
      `update public.barber_contas
          set modelo_equipe = $2, divide_lucro = $3, atualizado_em = now()
        where telefone = $1`,
      [telefone, modelo, divide],
    );
    await salvarEstadoEntrada(telefone, "novo_estabelecimento_fotos", {
      nome: String(estado.dados.nome || ""),
      modelo,
      divide_lucro: divide,
    });
    return await responderEntrada(telefone,
      "Como você quer a página pública?\n" +
      "1 — Mostrar somente fotos da barbearia\n" +
      "2 — Mostrar fotos da barbearia e dos barbeiros\n" +
      "3 — Criar a página sem fotos por enquanto",
      conf, textos, "onboarding_fotos");
  }

  if (estado.estado === "novo_estabelecimento_fotos") {
    if (entrada === "1" || entrada.startsWith("1 ")) {
      await consultar(`update public.barber_contas set mostra_barbeiro = false, atualizado_em = now() where telefone = $1`, [telefone]);
      await salvarEstadoEntrada(telefone, "novo_estabelecimento_foto_salao");
      await gravarPendencia(telefone, "foto", { destino: "salao" });
      return await responderEntrada(telefone,
        "Tudo bem. Agora mande uma foto da fachada ou do salão. Eu publico no endereço da página.\n\nDepois pode enviar mais fotos, uma por vez.",
        conf, textos, "onboarding_solicita_foto");
    }
    if (entrada === "2" || entrada.startsWith("2 ")) {
      await consultar(`update public.barber_contas set mostra_barbeiro = true, atualizado_em = now() where telefone = $1`, [telefone]);
      await salvarEstadoEntrada(telefone, "novo_estabelecimento_foto_salao");
      await gravarPendencia(telefone, "foto", { destino: "salao" });
      return await responderEntrada(telefone,
        "Ótimo. Primeiro mande uma foto da fachada ou do salão.\nDepois cadastre cada barbeiro assim:\n" +
        "  FUNCIONARIO Fabio 11989346164\n" +
        "  FOTO DO Fabio\n" +
        "Mande a foto do profissional logo depois desse comando.\n\nDigite /menu pagina para ver todas as opções.",
        conf, textos, "onboarding_fotos_profissionais");
    }
    if (entrada === "3" || entrada.startsWith("3 ")) {
      await consultar(`update public.barber_contas set mostra_barbeiro = true, atualizado_em = now() where telefone = $1`, [telefone]);
      await apagarEstadoEntrada(telefone);
      const menu = textos.menu || MENU_CONTROLE_PADRAO;
      return await responderEntrada(telefone,
        `Certo. Você pode adicionar fotos depois:\n  FOTO — envia uma foto da barbearia\n` +
        `  FUNCIONARIO Nome telefone — cadastra um profissional\n  FOTO DO Nome — envia a foto do profissional\n\n${menu}`,
        conf, textos, "estabelecimento_cadastrado");
    }
    return await responderEntrada(telefone,
      "Responda 1 para fotos só da barbearia, 2 para profissionais ou 3 para começar sem fotos.",
      conf, textos, "onboarding_fotos");
  }

  if (estado.estado === "funcionario_nome") {
    const nome = String(bruto || "").trim().slice(0, 80);
    if (nome.length < 2) {
      return await responderEntrada(telefone, "Mande seu nome com pelo menos duas letras.",
        conf, textos, "pedido_funcionario_nome");
    }
    await salvarEstadoEntrada(telefone, "funcionario_estabelecimento", { nome });
    return await responderEntrada(telefone,
      "Qual é o nome do estabelecimento? Se souber, inclua também o telefone do responsável.",
      conf, textos, "pedido_funcionario_estabelecimento");
  }

  if (estado.estado === "funcionario_estabelecimento") {
    const nome = String(estado.dados.nome || "").slice(0, 80);
    const detalhe = String(bruto || "").trim().slice(0, 200);
    const telefoneDono = normalizarWhatsapp((detalhe.match(/\+?\d[\d\s().-]{8,}\d/) || [""])[0]);
    const dados = `SOLICITAÇÃO DE VÍNCULO DE FUNCIONÁRIO | Nome: ${nome} | Estabelecimento informado: ${detalhe}` +
      (telefoneDono.length >= 10 ? ` | Telefone informado: ${telefoneDono}` : "");
    await salvarSolicitacao(telefone, dados);
    await apagarEstadoEntrada(telefone);
    return await responderEntrada(telefone,
      "Pedido registrado. Por segurança, seu número não ganhou acesso automaticamente. Peça ao responsável pelo estabelecimento para aprovar seu vínculo.",
      conf, textos, "pedido_funcionario_registrado");
  }

  if (estado.estado === "cliente_agenda") {
    const agenda = Array.isArray(estado.dados.agenda) ? estado.dados.agenda as Bruto[] : [];
    const cancelar = /^cancelar\s+(\d+)$/.exec(entrada);
    if (cancelar) {
      const item = agenda[Number(cancelar[1]) - 1];
      if (!item) return await responderEntrada(telefone, "Número não encontrado. Digite MENU para consultar de novo.",
        conf, textos, "cliente_numero_invalido");
      await salvarEstadoEntrada(telefone, "cliente_confirmar_cancelamento",
        { id: Number(item.id), barbearia: String(item.barbearia), acao: "cancelar" });
      return await responderEntrada(telefone,
        `Confirma cancelar ${item.estabelecimento || "o estabelecimento"} em ${formatarBrasilia(new Date(String(item.data_hora)))}? Responda SIM ou NÃO.`,
        conf, textos, "cliente_confirmar_cancelamento");
    }
    const remarcar = /^remarcar\s+(\d+)\s+(.+)$/.exec(entrada);
    if (remarcar) {
      const item = agenda[Number(remarcar[1]) - 1];
      if (!item) return await responderEntrada(telefone, "Número não encontrado. Digite MENU para consultar de novo.",
        conf, textos, "cliente_numero_invalido");
      const quando = lerQuando(remarcar[2], new Date());
      if (!quando.instant || quando.instant <= new Date()) {
        return await responderEntrada(telefone, "Não entendi o novo dia e horário. Exemplo: REMARCAR 1 amanhã 14h.",
          conf, textos, "cliente_horario_invalido");
      }
      const rel = relogio(quando.instant);
      const diaIso = `${rel.ano}-${String(rel.mes).padStart(2, "0")}-${String(rel.dia).padStart(2, "0")}`;
      const disponibilidade = await vagasDoDia(
        String(item.barbearia), diaIso, Number(item.duracao_min || 30),
        Number(item.funcionario_id || 0) || String(item.funcionario_telefone || ""), new Date(),
      );
      if (disponibilidade.fechado || !disponibilidade.vagas.includes(horaDe(quando.instant))) {
        return await responderEntrada(telefone,
          "Esse horário não está livre. Escolha um horário disponível no estabelecimento e tente novamente.",
          conf, textos, "cliente_horario_indisponivel");
      }
      await salvarEstadoEntrada(telefone, "cliente_confirmar_remarcacao", {
        id: Number(item.id), barbearia: String(item.barbearia), novo_horario: quando.instant.toISOString(),
        acao: "remarcar",
      });
      return await responderEntrada(telefone,
        `Confirma mudar para ${item.estabelecimento || "o estabelecimento"} em ${dataDe(quando.instant)} às ${horaDe(quando.instant)}? Responda SIM ou NÃO.`,
        conf, textos, "cliente_confirmar_remarcacao");
    }
    return await responderEntrada(telefone,
      "Use REMARCAR número dia e hora (ex.: REMARCAR 1 amanhã 14h) ou CANCELAR número. Digite MENU para voltar.",
      conf, textos, "cliente_agenda_ajuda");
  }

  await salvarEstadoEntrada(telefone, "menu");
  return await responderEntrada(telefone, MENU_ENTRADA, conf, textos, "menu_entrada");
}

export async function listarInteressados(limite = 300): Promise<Bruto[]> {
  const r = await consultar(
    `select i.telefone, i.texto, i.telefone_conta,
            to_char(i.criado_em, 'DD/MM/YYYY "às" HH24:MI') as criado_em,
            (select count(*) from public.barber_contas c where c.telefone = i.telefone)::int as virou
       from public.barber_interessados i
      order by i.criado_em desc limit $1`,
    [limite],
  );
  return r.rows.map((l) => ({
    telefone: String(l.telefone || ""), texto: String(l.texto || ""),
    criado_em: String(l.criado_em || ""), conta: String(l.telefone_conta || ""), virou: Number(l.virou || 0) > 0,
  }));
}

// ------------------------------------------------------- a página pelo WhatsApp

// A partir daqui tudo é a página pública do salão: o que ele troca pelo robô, a foto que ele
// manda e o funcionário que conversa com o bot pelo próprio número. Nada aqui escreve em
// `barber_contas` de outra barbearia, e nada escreve no robô do Peixeiro.

type Campo = "nome" | "site" | "endereco" | "telefone" | "horario" | "pagamento" | "barbeiro" |
  "agendamento";

const PERGUNTA: Record<Campo, string> = {
  nome: "Como o salão se chama na página? Manda só o nome, por exemplo: Barbearia do Oleiro.",
  site: "Qual nome você quer no final do endereço? Manda tudo junto, sem espaço: NOMESITE barbeariadooleiro",
  endereco: "Qual é o endereço completo? Manda rua, número, bairro, cidade/UF e o CEP.",
  telefone: "Qual telefone aparece para o cliente na página? Manda só o número com DDD.",
  horario: "Como funciona o horário? Manda no formato: segunda a quinta 10 as 19, sexta e sábado 10 as 20, domingo fechado.",
  pagamento: "Quais formas de pagamento você aceita? Manda separado por vírgula: dinheiro, pix, cartão.",
  barbeiro: "Mostrar a foto de quem vai cortar antes do cliente agendar? Responda SIM ou NÃO.",
  agendamento: "Aceita agendamento online? Responda SIM ou NÃO. O site continuará mostrando o endereço e os horários.",
};

const ROTULO_CAMPO: Record<Campo, string> = {
  nome: "NOME", site: "SITE", endereco: "ENDERECO", telefone: "TELEFONE",
  horario: "HORARIO", pagamento: "PAGAMENTO", barbeiro: "BARBEIRO", agendamento: "AGENDAMENTO",
};

function urlDaPagina(conta: Conta): string {
  return `${baseDoSite()}/${conta.slug || slugDe(conta.nome, conta.telefone)}`;
}

/** O fecho de toda resposta da página: o link para ele conferir e a saída para não voltar ao
 *  começo da conversa quando não gostou. É o que ele pediu, e é o que segura o cliente. */
function rodapeDaPagina(url: string, campo: Campo): string {
  return `\n\nSua página: ${url}\nNão gostou? Manda EDITAR ${ROTULO_CAMPO[campo]} que eu troco agora.`;
}

/** O guia que abre a conversa: é o texto dele na tela do painel, com o que ele pode trocar. */
export async function guiaDaPagina(conta: Conta, textos: Textos): Promise<string> {
  const publicado = await publicarPagina(conta.telefone);
  const url = publicado.ok ? publicado.url || urlDaPagina(conta) : urlDaPagina(conta);
  const avisoInstrucoes = publicado.instrucoes_whatsapp === "falha"
    ? "\n\nA página foi publicada, mas não consegui enviar as instruções do WhatsApp Business. Salve a página novamente para tentar outra vez."
    : "";
  const base = (textos.boas_vindas_site || "").trim() ||
    `Olá, sou seu novo chatbot do estabelecimento {nome}!\n\n` +
      `Sua página já está no ar: {site}\n\n` +
      `Nela o cliente escolhe o dia, o horário livre e vê quem corta. Tudo que muda na página você muda por aqui:`;
  const corpo = base
    .replace(/\{nome\}/g, conta.nome || "sua barbearia")
    .replace(/\{site\}/g, url)
    .replace(/\{telefone\}/g, formatarTelefone(conta.telefone));
  const comandos = [
    "SITE — abre o link da sua página",
    "SOMENTE BARBEARIA — mostra só fotos da barbearia na página",
    "COM BARBEIROS — mostra fotos da barbearia e dos profissionais",
    "SEM FOTOS — cria a página sem fotos por enquanto",
    "EDITAR NOME — troca o nome no topo da página",
    "EDITAR SITE — troca o final do endereço (NOMESITE barbeariadooleiro, tudo junto)",
    "EDITAR ENDERECO — muda a rua e o mapa",
    "EDITAR HORARIO — segunda 10 as 19, domingo fechado",
    "ALMOCO segunda a sexta 12 as 13 — bloqueia esse intervalo na agenda",
    "EDITAR AGENDAMENTO — SIM ou NÃO",
    "EDITAR PAGAMENTO — dinheiro, pix, cartão",
    "EDITAR TELEFONE — o número que o cliente vê na página",
    "FOTO — manda uma foto da barbearia para a página",
    "FOTO DO 11989346164 — a foto de quem corta, no lugar dele",
    "FUNCIONARIO Fabio 11989346164 — cadastra quem atende aqui",
    "BARBEIRO SIM — mostra a foto de quem vai cortar antes de agendar",
  ];
  return publicado.ok
    ? `${corpo}\n\n${comandos.map((c) => `  ${c}`).join("\n")}${url ? `\n\nDá uma olhada: ${url}` : ""}${avisoInstrucoes}`
    : `${corpo}\n\n${comandos.map((c) => `  ${c}`).join("\n")}\n\n` +
      `A página ainda não subiu (${publicado.erro || "sem resposta"}). Manda SITE de novo que eu tento outra vez.`;
}

// ------------------------------------------------------------------ os formatos

const UFS = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB",
  "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"];

/** O endereço como ele escreve: "Rua X, 71, Mooca - São Paulo/SP - 03164-110". O CEP e a UF
 *  saem cada um para a sua coluna, porque a página usa os dois (o mapa e o texto). */
export function parseEndereco(texto: string): { endereco: string; cidade: string; uf: string; cep: string } {
  const bruto = String(texto || "").replace(/\s+/g, " ").trim();
  const achaCep = /\b\d{5}[-.\s]?\d{3}\b/.exec(bruto);
  const cep = achaCep ? achaCep[0].replace(/\D/g, "").replace(/^(\d{5})(\d{3})$/, "$1-$2") : "";
  const semCep = bruto.replace(/\b\d{5}[-.\s]?\d{3}\b/, " ").replace(/[,;-]\s*[,;-]/g, ",")
    .replace(/\s{2,}/g, " ").trim();
  const partes = semCep.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const CIDADE_UF = /^(.*?)[\s/\-]+([A-Za-z]{2})$/;
  for (let i = partes.length - 1; i >= 0; i--) {
    const m = CIDADE_UF.exec(partes[i]);
    if (!m || !UFS.includes(m[2].toUpperCase())) continue;
    const uf = m[2].toUpperCase();
    const pedaco = m[1].trim().replace(/[-,]\s*$/, "");
    const comTraco = /(.+?)\s+-\s+(.+)$/.exec(pedaco);
    const cidade = comTraco ? comTraco[2].trim() : pedaco;
    const antes = comTraco ? [comTraco[1].trim()] : [];
    return { endereco: [...partes.slice(0, i), ...antes].join(", ").replace(/[,;-]\s*$/, "").trim(), cidade, uf, cep };
  }
  return { endereco: semCep.replace(/[,;-]\s*$/, "").trim(), cidade: "", uf: "", cep };
}

const DIAS_ORDEM = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];

/** Duas horas no pedaço (ou uma, com o fecho às 19h) é o que abre e o que fecha. */
function horasDoPedinho(texto: string): { abre: string; fecha: string } | null {
  const achadas = texto.match(/\d{1,2}(?:[:.]\d{2}|\s*e\s*\d{2}|\s*h(?:oras)?\s*\d{2})?/g) || [];
  const norm = (bruto: string) => {
    const m = /(\d{1,2})(?:[:.]\s*(\d{2}))?/.exec(bruto);
    if (!m) return "";
    const h = Math.min(23, Number(m[1]));
    const mi = Math.min(59, Number(m[2] || 0));
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  };
  const primeira = norm(achadas[0] || "");
  const segunda = norm(achadas[1] || "");
  if (!primeira) return null;
  return { abre: primeira, fecha: segunda && segunda !== primeira ? segunda : "19:00" };
}

/** "segunda a quinta 10 as 19, sábado 10 as 20, domingo fechado" vira uma linha por dia.
 *  O dia que não aparece na lista não é apagado: só o que ele citou muda. */
export function parseHorarios(texto: string): { dia: number; abre: string; fecha: string; fechado: boolean }[] {
  const saida: { dia: number; abre: string; fecha: string; fechado: boolean }[] = [];
  for (const brutoPedinho of String(texto || "").split(/[,;\n]+/)) {
    const pedinho = semAcento(brutoPedinho).toLowerCase().replace(/\s+/g, " ").trim();
    if (!pedinho) continue;
    const dias = new Set<number>();
    DIAS_ORDEM.forEach((nome, indice) => {
      if (new RegExp(`(^|\\s)${nome}s?(\\s|$)`).test(pedinho)) dias.add(indice);
    });
    const alcance = new RegExp(`(${DIAS_ORDEM.join("|")})s?\\s+(?:a|ate|-)\\s+(${DIAS_ORDEM.join("|")})s?`)
      .exec(pedinho);
    if (alcance) {
      const desde = DIAS_ORDEM.indexOf(alcance[1]);
      const ate = DIAS_ORDEM.indexOf(alcance[2]);
      for (let i = 0; i < 7; i++) dias.add((desde + i) % 7);
      if (ate < desde) for (let i = desde; i < 7; i++) dias.delete(i);
      else for (let i = 0; i <= ate; i++) dias.delete(i);
      for (let i = desde; i <= ate; i++) dias.add(i);
    }
    if (!dias.size) continue;
    const fechado = /(fechad|folga|nao atende)/.test(pedinho);
    const hora = fechado ? { abre: "09:00", fecha: "18:00" } : horasDoPedinho(pedinho);
    if (!hora) continue;
    for (const dia of dias) saida.push({ dia, ...hora, fechado });
  }
  return saida;
}

export function parseAlmocos(texto: string): {
  dia: number; inicio: string | null; fim: string | null;
}[] {
  const saida: { dia: number; inicio: string | null; fim: string | null }[] = [];
  for (const linha of String(texto || "").split(/[,;\n]+/)) {
    const pedaco = semAcento(linha).toLowerCase().replace(/-?feira\b/g, "").replace(/\s+/g, " ").trim();
    if (!pedaco) continue;
    const dias = new Set<number>();
    DIAS_ORDEM.forEach((dia, i) => {
      if (new RegExp(`(^|\\s)${dia}s?(\\s|$)`).test(pedaco)) dias.add(i);
    });
    const alcance = new RegExp(`(${DIAS_ORDEM.join("|")})s?\\s+(?:a|ate|-)\\s+(${DIAS_ORDEM.join("|")})s?`)
      .exec(pedaco);
    if (alcance) {
      const inicio = DIAS_ORDEM.indexOf(alcance[1]);
      const fim = DIAS_ORDEM.indexOf(alcance[2]);
      for (let i = inicio; ; i = (i + 1) % DIAS_ORDEM.length) {
        dias.add(i);
        if (i === fim) break;
      }
    }
    if (!dias.size) continue;
    const remover = /\b(remover|sem\s+pausa|limpar)\b/.test(pedaco);
    if (remover) {
      for (const dia of [...dias].sort((a, b) => a - b)) saida.push({ dia, inicio: null, fim: null });
      continue;
    }
    const horas = [...pedaco.matchAll(/\b(\d{1,2})(?:(?:\s*(?::|\.|h|e)\s*(\d{1,2}))|(?:\s*h))?\b/g)]
      .map((m) => ({ hora: Number(m[1]), minuto: Number(m[2] || 0) }));
    if (horas.length < 2) continue;
    const [a, b] = horas;
    if (
      a.hora > 23 || b.hora > 23 || a.minuto > 59 || b.minuto > 59 ||
      a.hora * 60 + a.minuto >= b.hora * 60 + b.minuto
    ) continue;
    const formatar = (x: { hora: number; minuto: number }) =>
      `${String(x.hora).padStart(2, "0")}:${String(x.minuto).padStart(2, "0")}`;
    for (const dia of [...dias].sort((x, y) => x - y)) {
      saida.push({ dia, inicio: formatar(a), fim: formatar(b) });
    }
  }
  return saida;
}

export async function gravarAlmocos(
  telefone: string,
  lista: { dia: number; inicio: string | null; fim: string | null }[],
): Promise<{ atualizados: number; semHorario: number[] }> {
  const dias = [...new Set(lista.map((x) => x.dia))];
  const diasComPausa = [...new Set(lista.filter((x) => x.inicio && x.fim).map((x) => x.dia))];
  const horariosAbertos = await consultar(
    `select dia from public.barber_horario where telefone = $1 and dia = any($2::int[])`,
    [telefone, diasComPausa],
  );
  const comHorario = new Set(horariosAbertos.rows.map((x) => Number(x.dia)));
  const semHorario = diasComPausa.filter((dia) => !comHorario.has(dia));
  if (semHorario.length) return { atualizados: 0, semHorario };

  let alterados = 0;
  for (const almoco of lista) {
    const atualizado = await consultar1(
      `update public.barber_horario
          set almoco_inicio = $3::time, almoco_fim = $4::time
        where telefone = $1 and dia = $2
        returning dia`,
      [telefone, almoco.dia, almoco.inicio, almoco.fim],
    );
    if (atualizado) alterados++;
  }
  return { atualizados: alterados, semHorario: [] };
}

export async function gravarHorarios(
  telefone: string, lista: { dia: number; abre: string; fecha: string; fechado: boolean }[],
): Promise<number> {
  let n = 0;
  for (const h of lista) {
    if (h.fechado) {
      const r = await consultar(`delete from public.barber_horario where telefone = $1 and dia = $2`, [telefone, h.dia]);
      n += r.rowCount || 0;
      continue;
    }
    await consultar(
      `insert into public.barber_horario (telefone, dia, abre, fecha, primeiro, intervalo)
       values ($1, $2, $3::time, $4::time, $3::time, 30)
       on conflict (telefone, dia) do update set abre = excluded.abre, fecha = excluded.fecha`,
      [telefone, h.dia, h.abre, h.fecha],
    );
    n++;
  }
  return n;
}

export async function gravarPagamentos(telefone: string, nomes: string[]): Promise<number> {
  await consultar(`delete from public.barber_pagamento where telefone = $1`, [telefone]);
  let n = 0;
  for (const nome of nomes) {
    const limpo = nome.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!limpo) continue;
    await consultar(
      `insert into public.barber_pagamento (telefone, nome, ordem) values ($1, $2, $3)
       on conflict do nothing`,
      [telefone, limpo, n],
    );
    n++;
  }
  return n;
}

export async function upsertFuncionario(
  barbearia: string, telefoneBruto: string, nome: string, cargo = "barbeiro",
): Promise<{ ok: boolean; telefone: string; erro?: string }> {
  const telefone = normalizarWhatsapp(telefoneBruto);
  if (!telefoneValido(telefone)) return { ok: false, telefone, erro: "telefone_invalido" };
  await consultar(
    `insert into public.barber_funcionario (barbearia, telefone, nome, cargo)
     values ($1, $2, $3, $4)
     on conflict (lower(barbearia), lower(telefone))
     do update set nome = excluded.nome, cargo = excluded.cargo, ativo = true, atualizado_em = now()`,
    [barbearia, telefone, String(nome || "").replace(/\s+/g, " ").trim().slice(0, 60) || "barbeiro",
     String(cargo || "barbeiro").trim().slice(0, 40)],
  );
  return { ok: true, telefone };
}

export async function funcionariosDaBarbearia(barbearia: string): Promise<Bruto[]> {
  const r = await consultar(
    `select telefone, nome, cargo, foto_arquivo, na_pagina from public.barber_funcionario
      where barbearia = $1 and ativo order by lower(nome)`,
    [barbearia],
  );
  return r.rows;
}

/** Quem é o funcionário pelo número OU pelo nome que ele escreveu. É a mesma busca que o
 *  comando FOTO DO usa, porque ninguém decorava telefone de funcionário. */
async function procurarFuncionario(barbearia: string, texto: string): Promise<Bruto | null> {
  const digitos = normalizarWhatsapp(texto);
  if (digitos.length >= 10) {
    const porTelefone = await consultar1(
      `select telefone, nome, cargo from public.barber_funcionario where barbearia = $1 and telefone = $2`,
      [barbearia, digitos],
    );
    if (porTelefone) return porTelefone;
  }
  const nome = semAcento(String(texto || "")).toLowerCase().replace(/\d/g, "").replace(/\s+/g, " ").trim();
  if (!nome) return null;
  const r = await consultar(
    `select telefone, nome, cargo from public.barber_funcionario
      where barbearia = $1 and lower(nome) = $2 limit 1`,
    [barbearia, nome],
  );
  if (r.rows[0]) return r.rows[0];
  const parecido = await consultar(
    `select telefone, nome, cargo from public.barber_funcionario
      where barbearia = $1 and lower(nome) like '%' || $2 || '%' limit 1`,
    [barbearia, nome],
  );
  return parecido.rows[0] || null;
}

// ------------------------------------------------------------------ os comandos

/** O texto dele vira a pendência "esperando o valor de <campo>"; a próxima mensagem responde. */
export async function paginaPergunta(conta: Conta, campo: Campo): Promise<Resposta> {
  await gravarPendencia(conta.telefone, "editar", { campo });
  return { texto: PERGUNTA[campo], tipo: "pergunta_pagina" };
}

/** Resposta à pergunta que a página fez: é o valor, escrito como ele digitou. */
export async function aplicarEdicaoDePagina(
  conta: Conta, campo: Campo, valorBruto: string, textos: Textos, agora: Date,
): Promise<Resposta> {
  const valor = String(valorBruto || "").replace(/\s+/g, " ").trim();
  void agora;
  void textos;
  const telefone = conta.telefone;
  if (!valor) return { texto: PERGUNTA[campo], tipo: "pergunta_pagina" };

  if (campo === "site") return await trocarSlug(conta, valor);
  if (campo === "nome") {
    const atual = await contaDeTelefone(telefone);
    const novoSlug = slugDe(valor, telefone);
    const slugAntigo = atual?.slug || conta.slug;
    await consultar(
      `update public.barber_contas
          set nome = $2, slug = $3, atualizado_em = now()
        where telefone = $1`,
      [telefone, valor.slice(0, 120), novoSlug],
    );
    if (slugAntigo && slugAntigo !== novoSlug) {
      await redirecionarPaginaAntiga(slugAntigo, novoSlug);
    }
    const atualizada = await contaDeTelefone(telefone);
    return await respostaComPagina(atualizada || { ...conta, nome: valor, slug: novoSlug },
      `Anotado: o nome na página agora é ${valor}.`, "nome");
  }
  if (campo === "telefone") {
    const digitos = normalizarWhatsapp(valor);
    if (!telefoneValido(digitos)) {
      return { texto: "Esse número não serve. Manda com DDD: 11977433163.", tipo: "pergunta_pagina" };
    }
    await consultar(`update public.barber_contas set telefone_publico = $2, atualizado_em = now() where telefone = $1`,
      [telefone, digitos]);
    return await respostaComPagina(conta, `Na página o cliente vai ver ${formatarTelefone(digitos)}.`, "telefone");
  }
  if (campo === "endereco") {
    const e = parseEndereco(valor);
    await consultar(
      `update public.barber_contas set endereco = $2, cidade = $3, uf = $4, cep = $5, atualizado_em = now()
        where telefone = $1`,
      [telefone, e.endereco, e.cidade, e.uf, e.cep],
    );
    return await respostaComPagina(conta,
      `Endereço atualizado${e.cep ? ` (CEP ${e.cep})` : ""}. O mapa da página já aponta para lá.`, "endereco");
  }
  if (campo === "horario") {
    const lista = parseHorarios(valor);
    if (!lista.length) {
      return { texto: "Não achei o dia da semana. " + PERGUNTA.horario, tipo: "pergunta_pagina" };
    }
    await gravarHorarios(telefone, lista);
    return await respostaComPagina(conta, `Horários gravados: ${lista.length} dia(s) na página.`, "horario");
  }
  if (campo === "agendamento") {
    const resposta = semAcento(valor.toLowerCase());
    if (!/^(sim|s|nao|n)$/.test(resposta)) return { texto: PERGUNTA.agendamento, tipo: "pergunta_pagina" };
    const aceita = resposta === "sim" || resposta === "s";
    await consultar(
      `update public.barber_contas set aceita_agendamento = $2, atualizado_em = now() where telefone = $1`,
      [telefone, aceita],
    );
    return await respostaComPagina(
      conta,
      aceita ? "A página agora aceita agendamento online." : "A página agora informa que não aceita agendamento online.",
      "agendamento",
    );
  }
  if (campo === "pagamento") {
    const nomes = valor.split(/[,;]|\se\s|\se\b/i).map((x) => x.trim()).filter(Boolean);
    if (!nomes.length) return { texto: PERGUNTA.pagamento, tipo: "pergunta_pagina" };
    await gravarPagamentos(telefone, nomes);
    return await respostaComPagina(conta, `Na página aparece: ${nomes.join(", ")}.`, "pagamento");
  }
  if (campo === "barbeiro") {
    const liga = /^(sim|s|liga|mostra|quero)\b/.test(semAcento(valor.toLowerCase()));
    await consultar(`update public.barber_contas set mostra_barbeiro = $2, atualizado_em = now() where telefone = $1`,
      [telefone, liga]);
    return await respostaComPagina(conta,
      liga
        ? "Pronto: antes de agendar o cliente vê a foto de quem corta."
        : "Pronto: a página não mostra mais quem vai cortar, só o horário.",
      "barbeiro");
  }
  return { texto: PERGUNTA[campo], tipo: "pergunta_pagina" };
}

async function respostaComPagina(conta: Conta, texto: string, campo: Campo): Promise<Resposta> {
  const recarregada = await contaDeTelefone(conta.telefone);
  const atual = recarregada || conta;
  const publicado = await publicarPagina(atual.telefone);
  const url = publicado.ok ? publicado.url || urlDaPagina(atual) : urlDaPagina(atual);
  if (!publicado.ok) {
    return {
      texto: `${texto}\n\nA página não subiu agora (${publicado.erro || "sem resposta"}). ` +
        `Manda SITE que eu tento de novo.`,
      tipo: "pagina",
    };
  }
  const avisoInstrucoes = publicado.instrucoes_whatsapp === "falha"
    ? "\n\nA página foi publicada, mas não consegui enviar as instruções do WhatsApp Business. Salve a página novamente para tentar outra vez."
    : "";
  return { texto: `${texto}${rodapeDaPagina(url, campo)}${avisoInstrucoes}`, tipo: "pagina" };
}

/** NOMESITE barbeariadooleiro — o único lugar em que o espaço não é permitido, porque a URL
 *  não aceita. O slug é sempre maiúsculo e sem acento. */
async function trocarSlug(conta: Conta, valorBruto: string): Promise<Resposta> {
  const bruto = String(valorBruto || "").trim();
  const novo = slugDe(bruto || conta.nome, conta.telefone);
  if (!slugValido(novo)) {
    return { texto: "Esse nome não virou endereço. Manda junto, sem espaço: NOMESITE barbeariadooleiro", tipo: "pergunta_pagina" };
  }
  const antigo = conta.slug;
  await consultar(`update public.barber_contas set slug = $2, atualizado_em = now() where telefone = $1`,
    [conta.telefone, novo]);
  const atualizada = { ...conta, slug: novo };
  if (antigo && antigo !== novo) await redirecionarPaginaAntiga(antigo, novo);
  return await respostaComPagina(atualizada, `Seu endereço agora é esse:`, "site");
}

/** O comando que abre tudo: SITE mostra o link e o guia, e sobe a página se ela caiu. */
async function mostrarSite(conta: Conta, textos: Textos): Promise<Resposta> {
  const publicado = await publicarPagina(conta.telefone);
  const url = publicado.ok ? publicado.url || urlDaPagina(conta) : urlDaPagina(conta);
  if (!publicado.ok) {
    return {
      texto: `Ainda não consegui subir sua página (${publicado.erro || "sem resposta"}). ` +
        `Tente de novo em um minuto: SITE`,
      tipo: "site",
    };
  }
  void textos;
  const avisoInstrucoes = publicado.instrucoes_whatsapp === "falha"
    ? "\n\nA página foi publicada, mas não consegui enviar as instruções do WhatsApp Business. Salve a página novamente para tentar outra vez."
    : "";
  return {
    texto: `Sua página: ${url}\n` +
      `É só mandar o link para o cliente: ele escolhe o dia, a hora livre e quem corta.\n\n` +
      `Para mudar qualquer coisa: ${Object.values(ROTULO_CAMPO).join(", ")}.${avisoInstrucoes}`,
    tipo: "site",
  };
}

/** Importa dados públicos de uma página AppBarber já existente e atualiza apenas o
 *  estabelecimento escolhido. A página de destino é criada do mesmo jeito que o comando SITE. */
export async function importarPaginaAppBarber(
  telefoneBruto: string,
  urlBruto: string,
  conteudoBruto = "",
  fotosBruto: unknown[] = [],
  imagensBruto: unknown[] = [],
): Promise<{ ok: boolean; telefone: string; nome: string; slug: string; servicos: number;
  horarios: number; pagamentos: number; publicado: boolean; url: string;
  instrucoes_whatsapp?: string; erro?: string }> {
  const telefone = normalizarWhatsapp(telefoneBruto);
  const conta = await contaDeTelefone(telefone);
  if (!conta) return { ok: false, telefone, nome: "", slug: "", servicos: 0, horarios: 0,
    pagamentos: 0, publicado: false, url: "", erro: "sem_barbearia" };
  let url = String(urlBruto || "").trim();
  if (!/^https:\/\/sites\.appbarber\.com\.br\/[a-z0-9-]+\/?$/i.test(url)) {
    return { ok: false, telefone, nome: "", slug: "", servicos: 0, horarios: 0,
      pagamentos: 0, publicado: false, url: "", erro: "url_appbarber" };
  }
  url = url.replace(/\/+$/, "");

  let texto = String(conteudoBruto || "").trim();
  let nome = conta.nome || "Estabelecimento";

  if (!texto) {
    if (fotosBruto.length || imagensBruto.length) {
      nome = conta.nome || "Estabelecimento";
    } else {
    let html = "";
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; OPeixeiro/1.0)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        return { ok: false, telefone, nome: conta.nome, slug: conta.slug, servicos: 0, horarios: 0,
          pagamentos: 0, publicado: false, url: "", erro: `pagina_http_${response.status}` };
      }
      html = await response.text();
    } catch (exc) {
      return { ok: false, telefone, nome: conta.nome, slug: conta.slug, servicos: 0, horarios: 0,
        pagamentos: 0, publicado: false, url: "", erro: "pagina_inacessivel" };
    }

    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/<[^>]+>/g, "").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
    nome = (title.split(/\s+-\s+/)[0] || conta.nome || "Estabelecimento").trim().slice(0, 120);
    texto = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&#039;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
    }
  }

  if (conteudoBruto) {
    const nomeLinha = texto.match(/(?:^|\n)\s*([A-ZÀ-Ý][A-ZÀ-Ý0-9 &.'()-]{4,100})\s*\n\s*Serviços(?:\n|$)/i)?.[1]?.trim();
    if (nomeLinha) nome = nomeLinha.slice(0, 120);
  }

  const telefonePublicado = texto.match(/(?:\(\d{2}\)\s*)?[\s]?\d{4,5}-?\d{4}/)?.[0] || "";
  const telefonePublico = telefonePublicado
    ? normalizarWhatsapp(telefonePublicado.replace(/\D/g, ""))
    : conta.telefone_publico;

  const localizacao = texto.match(/(?:Localização|Conselheiro|Rua|Av\.|Avenida)[^\n]{8,160}/i)?.[0]?.trim() || "";
  const endereco = localizacao.replace(/^Localização\s*/i, "").slice(0, 200);

  const mapaDia: Record<string, number> = {
    domingo: 0, segunda: 1, tercafeira: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
  };
  const horarios: Array<{ dia: number; abre: string; fecha: string }> = [];
  for (const match of texto.matchAll(/(Domingo|Segunda(?:-Feira)?|Terça(?:-Feira)?|Terca(?:-Feira)?|Quarta(?:-Feira)?|Quinta(?:-Feira)?|Sexta(?:-Feira)?|Sábado|Sabado)[\s\S]{0,45}(\d{2}:\d{2})\s*[-–a]\s*(\d{2}:\d{2})/gi)) {
    const chave = semAcento(String(match[1] || "").toLowerCase())
      .replace(/[- ]feira/g, "")
      .replace(/-/g, "")
      .replace(/\s/g, "");
    const dia = mapaDia[chave] ?? (
      chave.startsWith("domingo") ? 0 :
      chave.startsWith("segunda") ? 1 :
      chave.startsWith("terca") ? 2 :
      chave.startsWith("quarta") ? 3 :
      chave.startsWith("quinta") ? 4 :
      chave.startsWith("sexta") ? 5 :
      chave.startsWith("sabado") ? 6 : -1
    );
    if (dia >= 0 && !horarios.some((h) => h.dia === dia)) {
      horarios.push({ dia, abre: match[2], fecha: match[3] });
    }
  }

  const pagamentos: string[] = [];
  for (const pagamento of ["Dinheiro", "Cartão de Crédito", "Cartao de Credito", "Cartão de Débito", "Cartao de Debito", "PIX"]) {
    if (semAcento(texto).toLowerCase().includes(semAcento(pagamento).toLowerCase()) &&
      !pagamentos.includes(pagamento)) pagamentos.push(pagamento);
  }

  const servicos: Array<{ nome: string; preco: number; duracao_min: number }> = [];
  for (const match of texto.matchAll(/(?:^|\n)\s*([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 +.&/'()-]{1,100})\s*\n+\s*R\$\s*([0-9.]+(?:,[0-9]{1,2})?)\s*\n+\s*(\d{1,3})\s*min/gi)) {
    const nomeServico = String(match[1] || "").replace(/\n/g, " ").replace(/\s+/g, " ").trim()
      .replace(/^(?:serviços|servicos|detalhes do estabelecimento)\s*/i, "")
      .slice(0, 120);
    const preco = Number(String(match[2]).replace(/\./g, "").replace(",", "."));
    const duracao = Number(match[3]);
    if (nomeServico && nomeServico.length >= 2 && preco >= 0 && duracao >= 10 &&
      !servicos.some((s) => semAcento(s.nome).toLowerCase() === semAcento(nomeServico).toLowerCase())) {
      servicos.push({ nome: nomeServico, preco, duracao_min: duracao });
    }
  }

  const slug = (fotosBruto.length || imagensBruto.length)
    ? (conta.slug || slugDe(nome, telefone))
    : slugDe(nome, telefone);
  await consultar(
    `update public.barber_contas
        set nome = $2, slug = $3, endereco = coalesce(nullif($4, ''), endereco),
            telefone_publico = coalesce(nullif($5, ''), telefone_publico),
            atualizado_em = now()
      where telefone = $1`,
    [telefone, nome, slug, endereco, telefonePublico],
  );

  if (horarios.length) {
    await consultar(`delete from public.barber_horario where telefone = $1`, [telefone]);
    for (const horario of horarios) {
      await consultar(
        `insert into public.barber_horario (telefone, dia, abre, fecha, intervalo)
         values ($1, $2, $3, $4, 30)`,
        [telefone, horario.dia, horario.abre, horario.fecha],
      );
    }
  }
  if (pagamentos.length) {
    await consultar(`delete from public.barber_pagamento where telefone = $1`, [telefone]);
    for (let i = 0; i < pagamentos.length; i++) {
      await consultar(
        `insert into public.barber_pagamento (telefone, nome, ordem)
         values ($1, $2, $3)`,
        [telefone, pagamentos[i], i],
      );
    }
  }
  if (servicos.length) {
    await consultar(`delete from public.barber_servico where telefone = $1`, [telefone]);
    for (const servico of servicos) {
      await consultar(
        `insert into public.barber_servico (telefone, nome, preco, duracao_min, ativo)
         values ($1, $2, $3, $4, true)`,
        [telefone, servico.nome, servico.preco, servico.duracao_min],
      );
    }
  }

  if (fotosBruto.length) {
    await consultar(`delete from public.barber_foto where telefone = $1`, [telefone]);
    for (let i = 0; i < fotosBruto.length; i++) {
      const item = fotosBruto[i] && typeof fotosBruto[i] === "object"
        ? fotosBruto[i] as Bruto : {};
      const brutoFoto = String(item.b64 || "").replace(/^data:[^;]+;base64,/i, "");
      if (!brutoFoto) continue;
      try {
        const bytes = Uint8Array.from(atob(brutoFoto), (c) => c.charCodeAt(0));
        if (!bytes.length || bytes.length > TAMANHO_MAX_FOTO) continue;
        const nomeFoto = `foto-${i + 1}-${Date.now()}.jpg`;
        const gravada = await publicarFoto(telefone, nomeFoto, bytes);
        if (!gravada.ok || !gravada.caminho) continue;
        await consultar(
          `insert into public.barber_foto (telefone, arquivo, legenda, ordem)
           values ($1, $2, $3, $4)`,
          [telefone, gravada.caminho, String(item.legenda || "Foto do estabelecimento").slice(0, 120), i],
        );
      } catch {
        // Foto inválida não impede a importação dos dados textuais.
      }
    }
  }

  if (imagensBruto.length) {
    await consultar(`delete from public.barber_foto where telefone = $1`, [telefone]);
    for (let i = 0; i < imagensBruto.length; i++) {
      const imagemUrl = String(imagensBruto[i] || "").trim();
      if (!/^https:\/\//i.test(imagemUrl)) continue;
      try {
        const resposta = await fetch(imagemUrl, { signal: AbortSignal.timeout(30_000) });
        if (!resposta.ok) continue;
        const bytes = new Uint8Array(await resposta.arrayBuffer());
        if (!bytes.length || bytes.length > TAMANHO_MAX_FOTO) continue;
        const nomeFoto = `foto-${i + 1}-${Date.now()}.jpg`;
        const gravada = await publicarFoto(telefone, nomeFoto, bytes);
        if (!gravada.ok || !gravada.caminho) continue;
        await consultar(
          `insert into public.barber_foto (telefone, arquivo, legenda, ordem)
           values ($1, $2, $3, $4)`,
          [telefone, gravada.caminho, "Foto do estabelecimento", i],
        );
      } catch {
        // URL privada ou temporária não impede os dados já importados.
      }
    }
  }

  const atualizada = await contaDeTelefone(telefone);
  const publicado = atualizada
    ? await publicarPagina(telefone)
    : { ok: false, url: "", instrucoes_whatsapp: "incompleta" as const };
  const destino = publicado.ok ? publicado.url || urlDaPagina(atualizada || conta) : urlDaPagina(atualizada || conta);
  return {
    ok: true,
    telefone,
    nome,
    slug,
    servicos: servicos.length,
    horarios: horarios.length,
    pagamentos: pagamentos.length,
    publicado: Boolean(publicado.ok),
    url: destino,
    instrucoes_whatsapp: publicado.instrucoes_whatsapp,
  };
}

/** O dispatcher da página: devolve nulo quando a frase é de outro assunto, para a conversa
 *  seguir o caminho de sempre (dinheiro, agenda, catálogo). */
export async function comandoPagina(
  conta: Conta, bruto: string, t: string, textos: Textos,
): Promise<Resposta | null> {
  const original = String(bruto || "").trim();

  if (/^(meu\s+)?(site|pagina|link)(\s+da\s+(barbearia|loja))?/.test(t) && t.length <= 32) {
    return await mostrarSite(conta, textos);
  }
  if (t === "somente barbearia" || t === "apenas barbearia" || t === "fotos da barbearia") {
    await consultar(`update public.barber_contas set mostra_barbeiro = false, atualizado_em = now() where telefone = $1`, [conta.telefone]);
    await gravarPendencia(conta.telefone, "foto", { destino: "salao" });
    return {
      texto: "Entendi: a página vai mostrar somente fotos da barbearia. Agora mande uma foto da fachada ou do salão.",
      tipo: "onboarding_foto_salao",
    };
  }
  if (t === "com barbeiros" || t === "barbearia e barbeiros" || t === "fotos dos barbeiros") {
    await consultar(`update public.barber_contas set mostra_barbeiro = true, atualizado_em = now() where telefone = $1`, [conta.telefone]);
    await gravarPendencia(conta.telefone, "foto", { destino: "salao" });
    return {
      texto: "Entendi: a página pode mostrar a barbearia e os profissionais.\n" +
        "Mande primeiro uma foto da fachada ou do salão.\n" +
        "Depois cadastre assim:\n  FUNCIONARIO Fabio 11989346164\n" +
        "  FOTO DO Fabio",
      tipo: "onboarding_fotos_profissionais",
    };
  }
  if (t === "sem fotos" || t === "pagina sem fotos") {
    await consultar(`update public.barber_contas set mostra_barbeiro = false, atualizado_em = now() where telefone = $1`, [conta.telefone]);
    return {
      texto: "A página ficou sem fotos por enquanto. Você pode mandar FOTO a qualquer hora ou cadastrar profissionais com FUNCIONARIO Nome telefone.",
      tipo: "onboarding_sem_fotos",
    };
  }
  if (t === "editar" || t === "comandos da pagina" || t === "menu site" || t === "ajuda site") {
    return { texto: await guiaDaPagina(conta, textos), tipo: "guia_pagina" };
  }
  if (/^nomesite\b/.test(t)) {
    const valor = original.replace(/^\s*(?:nomesite|nome\s+do\s+site)\b/i, "").trim();
    if (!valor) {
      await gravarPendencia(conta.telefone, "nome_site", {});
      return { texto: PERGUNTA.site, tipo: "pergunta_pagina" };
    }
    return await trocarSlug(conta, valor);
  }

  if (/^editar\b/.test(t)) {
    // O campo pode ter mais de uma palavra ("formas de pagamento"), então é o pedacinho que
    // casa com a lista; o resto da frase — com as letras dele, não minúsculo — é o valor novo.
    const palavras = t.replace(/^editar\s+/, "").split(/\s+/).filter(Boolean);
    const originais = original.replace(/^\s*editar\s+/i, "").split(/\s+/).filter(Boolean);
    let campo: Campo | "" = "";
    let usadas = 0;
    for (let qtd = 1; qtd <= Math.min(3, palavras.length); qtd++) {
      const candidato = campoDe(palavras.slice(0, qtd).join(" "));
      if (!candidato) continue;
      campo = candidato;
      usadas = qtd;
      break;
    }
    if (!campo) {
      return {
        texto: "O que na página? Pode trocar: " + Object.values(ROTULO_CAMPO).join(", ") + ".",
        tipo: "pergunta_pagina",
      };
    }
    const valor = originais.slice(usadas).join(" ").trim();
    if (!valor) return await paginaPergunta(conta, campo);
    return await aplicarEdicaoDePagina(conta, campo, valor, textos, new Date());
  }

  if (/^endereco\b/.test(t)) {
    return await aplicarEdicaoDePagina(conta, "endereco", original.replace(/^\s*endereco\b/i, ""), textos, new Date());
  }
  if (/^horario\s+/.test(t)) {
    return await aplicarEdicaoDePagina(conta, "horario", original.replace(/^\s*horarios?\b/i, ""), textos, new Date());
  }
  if (/^(pagamentos?|formas?\s+de\s+pagamento)\s+/.test(t)) {
    return await aplicarEdicaoDePagina(conta, "pagamento", original.replace(/^\s*(?:pagamentos?|formas?\s+de\s+pagamento)\b/i, ""), textos, new Date());
  }
  if (/^almoco(?:\s|$)/.test(t)) {
    const valor = original.replace(/^\s*almoco\b/i, "").trim();
    if (!valor) {
      return {
        texto: "Para bloquear o almoço: ALMOCO segunda a sexta 12:00 as 13:00. " +
          "Para liberar: ALMOCO REMOVER segunda.",
        tipo: "pergunta_pagina",
      };
    }
    const lista = parseAlmocos(valor);
    if (!lista.length) {
      return {
        texto: "Não entendi os dias e o intervalo. Exemplo: ALMOCO segunda a sexta 12:00 as 13:00. " +
          "Para remover: ALMOCO REMOVER segunda.",
        tipo: "pergunta_pagina",
      };
    }
    const resultado = await gravarAlmocos(conta.telefone, lista);
    if (resultado.semHorario.length) {
      const dias = resultado.semHorario.map((dia) => DIAS_ORDEM[dia]).join(", ");
      return {
        texto: `Não alterei nada: primeiro cadastre o horário de atendimento de ${dias} com EDITAR HORARIO.`,
        tipo: "pergunta_pagina",
      };
    }
    return await respostaComPagina(
      conta,
      `Intervalo de almoço atualizado para ${resultado.atualizados} dia(s); ele fica bloqueado na página e nas marcações pelo chatbot.`,
      "horario",
    );
  }
  if (/^(aceita\s+)?agendamento(?:\s+online)?\s+(sim|s|nao|n)\b/.test(t)) {
    const resposta = /\b(sim|s)$/.test(t) || /\b(sim|s)\s*$/.test(t);
    return await aplicarEdicaoDePagina(conta, "agendamento", resposta ? "sim" : "nao", textos, new Date());
  }
  if (/^aceita\s+agendamento$/.test(t) || t === "agendamento online") {
    return await paginaPergunta(conta, "agendamento");
  }
  if (/^barbeiro\s+(sim|nao)\b/.test(t) || /^foto\s+(do\s+)?barbeiro\s+(sim|nao)\b/.test(t)) {
    const sim = /\bsim\b/.test(t);
    return await aplicarEdicaoDePagina(conta, "barbeiro", sim ? "sim" : "nao", textos, new Date());
  }

  if (/^(funcionarios|equipe|barbeiros)$/.test(t)) {
    const lista = await funcionariosDaBarbearia(conta.telefone);
    if (!lista.length) {
      return {
        texto: "Nenhum funcionário ainda. Cadastre assim: FUNCIONARIO Fabio 11989346164",
        tipo: "funcionarios",
      };
    }
    return {
      texto: "Quem atende aqui:\n" + lista.map((f) =>
        `  ${String(f.nome || "")} — ${formatarTelefone(String(f.telefone || ""))}${f.foto_arquivo ? " (com foto)" : " (sem foto)"}`,
      ).join("\n") + `\n\nPara pôr a foto: FOTO DO ${String(lista[0].nome || "nome")}`,
      tipo: "funcionarios",
    };
  }
  if (/^funcionario\b|^barbeiro\s+\D/.test(t)) {
    const resto = original.replace(/^\s*(?:funcionario|barbeiro)\b/i, "").trim();
    const digitos = (resto.match(/\d{10,13}/) || resto.match(/\d{5,6}/g) || []).join("");
    const nome = resto.replace(/[\d\s()+-]+$/, "").replace(/^\s*[\d\s()+-]+/, "").trim();
    if (digitos.length < 10) {
      return { texto: "Falta o número com DDD. Exemplo: FUNCIONARIO Fabio 11989346164", tipo: "pergunta_pagina" };
    }
    const gravado = await upsertFuncionario(conta.telefone, digitos, nome);
    if (!gravado.ok) return { texto: "Esse número não parece um telefone do WhatsApp.", tipo: "pergunta_pagina" };
    return await respostaComPagina(conta,
      `Cadastrei ${nome || "o funcionário"} (${formatarTelefone(digitos)}). Ele fala comigo pelo número dele e a página já mostra ele.`,
      "barbeiro");
  }

  const fotoDo = /^adicionar?\s*foto\s+do\s+(.+)$/.exec(t);
  if (fotoDo) {
    const alvo = original.replace(/^\s*(?:adicionar\s+)?foto\s+do\s+/i, "").trim();
    const comNome = /\s+nome\s+/i.exec(alvo);
    const quemBruto = comNome ? alvo.slice(0, comNome.index) : alvo;
    const nomeQuem = comNome ? alvo.slice(comNome.index + comNome[0].length) : "";
    const digitos = normalizarWhatsapp(quemBruto);
    let funcionario = digitos.length >= 10
      ? await consultar1(`select telefone, nome from public.barber_funcionario where barbearia = $1 and telefone = $2`,
        [conta.telefone, digitos])
      : await procurarFuncionario(conta.telefone, quemBruto);
    if (!funcionario && digitos.length >= 10) {
      const criado = await upsertFuncionario(conta.telefone, digitos, nomeQuem || quemBruto.replace(/\D/g, ""));
      funcionario = criado.ok ? { telefone: criado.telefone, nome: nomeQuem || quemBruto } : null;
    }
    if (!funcionario) {
      return {
        texto: "Não achei esse funcionário. Manda FUNCIONARIO Fabio 11989346164 primeiro.",
        tipo: "pergunta_pagina",
      };
    }
    await gravarPendencia(conta.telefone, "foto", {
      destino: String(funcionario.telefone || ""),
      nome: String(funcionario.nome || nomeQuem || ""),
    });
    return {
      texto: `Certo. Manda agora a foto de ${String(funcionario.nome || nomeQuem || "ele")} — pode ser a imagem do celular.`,
      tipo: "pede_foto",
    };
  }
  if (/^(adicionar\s+)?foto(s)?\s+(da\s+)?(barbearia|loja|salao|pagina)?$/.test(t) || t === "foto") {
    await gravarPendencia(conta.telefone, "foto", { destino: "salao" });
    return { texto: "Pode mandar a foto da barbearia que eu coloco na página.", tipo: "pede_foto" };
  }

  return null;
}

function campoDe(alvo: string): Campo | "" {
  const x = semAcento(String(alvo || "")).toLowerCase().trim();
  if (/^(site|endereco do site|nome do site|final do site|url)$/.test(x)) return "site";
  if (/^(nome|nome da pagina|nome da barbearia)$/.test(x)) return "nome";
  if (/^(endereco|endereço|local|rua)$/.test(x)) return "endereco";
  if (/^(telefone|numero|whatsapp|contato)$/.test(x)) return "telefone";
  if (/^(horario|horarios|horario de atendimento|funcionamento)$/.test(x)) return "horario";
  if (/^(pagamento|pagamentos|forma de pagamento|formas de pagamento)$/.test(x)) return "pagamento";
  if (/^(barbeiro|quem corta|foto do barbeiro|quem vai cortar)$/.test(x)) return "barbeiro";
  if (/^(agendamento|agenda online|aceita agendamento)$/.test(x)) return "agendamento";
  return "";
}

// ------------------------------------------------------------------ a foto recebida

/** A foto que ele manda não tem texto: é o `imageMessage` do GreenAPI, e o id da mensagem é o
 *  que devolve o arquivo. */
export type FotoChegada = {
  mensagemId: string;
  chatId: string;
  legenda: string;
  minha: boolean;
  grupo: boolean;
};

function caminhoEm(bruto: Bruto, trilha: string[]): unknown {
  let atual: unknown = bruto;
  for (const chave of trilha) {
    if (!atual || typeof atual !== "object") return undefined;
    atual = (atual as Bruto)[chave];
  }
  return atual;
}

const TRILHAS_ID = [
  ["message", "messageId", "id"], ["message", "id"], ["data", "idMessage"], ["data", "id"],
  ["idMessage"], ["messageId"],
];
const TRILHAS_CHAT = [["message", "chatId"], ["data", "chatId"], ["chatId"]];

export function fotoRecebida(bruto: Bruto): FotoChegada | null {
  const tipo = [
    String(caminhoEm(bruto, ["message", "type"]) || ""),
    String(bruto.type || ""), String(bruto.event || ""),
  ].join(" ").toLowerCase();
  if (!/(image|img|photo|foto)/.test(tipo)) return null;
  const pegue = (trilhas: string[][]): string => {
    for (const t of trilhas) {
      const v = caminhoEm(bruto, t);
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const legenda = [
    caminhoEm(bruto, ["message", "caption"]), caminhoEm(bruto, ["message", "captionText"]),
    caminhoEm(bruto, ["data", "caption"]), bruto.caption,
  ].find((v) => typeof v === "string" && v) || "";
  const mensagemId = pegue(TRILHAS_ID);
  const chatId = pegue(TRILHAS_CHAT);
  if (!mensagemId || !chatId) return null;
  const minha = [
    caminhoEm(bruto, ["message", "isFromMe"]), caminhoEm(bruto, ["data", "isFromMe"]),
    caminhoEm(bruto, ["message", "messageId", "fromMe"]), bruto.isFromMe,
  ].some((v) => v === true);
  return { mensagemId, chatId, legenda: String(legenda), minha, grupo: chatId.includes("@g.us") };
}

/** A pendência da foto é a mesma do robô — o que muda é o tempo, porque a foto chega depois. */
async function pendenciaDeFoto(telefone: string): Promise<Pendencia | null> {
  const viva = await pendenciaViva(telefone);
  return viva && viva.acao === "foto" ? viva : null;
}

/** O único caminho que escreve no repositório de fotos: a imagem vem do GreenAPI, vai para o
 *  GitHub e a página é refeita apontando para ela. */
export async function tratarFotoRecebida(
  conta: Conta, foto: FotoChegada, conf: Conf,
): Promise<Resposta | null> {
  const pendencia = await pendenciaDeFoto(conta.telefone);
  if (!pendencia) return null;

  const baixada = await baixarMidia(conf, foto.chatId, foto.mensagemId);
  if (!baixada.ok || !baixada.bytes?.length) {
    return {
      texto: `Não consegui baixar a foto (${baixada.erro || "sem resposta"}). Manda de novo que eu coloco na página.`,
      tipo: "erro",
    };
  }
  const nome = `${pendencia.dados.destino === "salao" ? "salao" : "barbeiro"}-${Date.now()}${baixada.nome?.endsWith(".png") ? ".png" : ".jpg"}`;
  const gravada = await publicarFoto(conta.telefone, nome, baixada.bytes);
  if (!gravada.ok) {
    return {
      texto: gravada.erro?.startsWith("foto_grande")
        ? "A foto está grande demais para a página. Manda uma menor (a do WhatsApp já serve)."
        : `Não consegui subir a foto (${gravada.erro || "sem resposta"}). Tenta de novo.`,
      tipo: "erro",
    };
  }

  await apagarPendencia(conta.telefone);
  const destino = String(pendencia.dados.destino || "salao");
  if (destino === "salao") {
    await consultar(
      `insert into public.barber_foto (telefone, arquivo, legenda, ordem)
       values ($1, $2, $3, coalesce((select max(ordem) from public.barber_foto where telefone = $1), 0) + 1)`,
      [conta.telefone, gravada.caminho, String(foto.legenda || "").slice(0, 120)],
    );
    return await respostaComPagina(conta, "Foto da barbearia na página.", "barbeiro");
  }

  await consultar(
    `update public.barber_funcionario set foto_arquivo = $3, atualizado_em = now()
      where barbearia = $1 and telefone = $2`,
    [conta.telefone, destino, gravada.caminho],
  );
  const quem = await consultar1(`select nome from public.barber_funcionario where barbearia = $1 and telefone = $2`,
    [conta.telefone, destino]);
  return await respostaComPagina(conta,
    `Pronto: a foto de ${String(quem?.nome || pendencia.dados.nome || "ele")} já aparece para quem for agendar.`, "barbeiro");
}

// ------------------------------------------------------------- o funcionário no WhatsApp

/** O funcionário não é o dono: ele não vê dinheiro nenhum e não mexe no catálogo. Vê a agenda
 *  dele e marca o cliente dele, e é por isso que a resposta é montada aqui e não em `responder`. */
export async function responderFuncionario(
  barbearia: Conta, funcionario: Bruto, bruto: string, textos: Textos, agora: Date,
): Promise<Resposta> {
  const t = semAcento(String(bruto || "").toLowerCase())
    .replace(/^\s*\/+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const meuTelefone = String(funcionario.telefone || "");
  const meuNome = String(funcionario.nome || "");
  if (!t) return { texto: "", tipo: "vazio" };

  if (t === "menu" || t === "oi" || t === "ola" || t === "ajuda") {
    return {
      texto: textos.ajuda_funcionario ||
        `Oi, ${meuNome || "tudo bem"}! Você está falando com o robô da ${barbearia.nome}.\n` +
        "  MINHA AGENDA — seus horários\n  LIVRE amanhã — horários que ainda dá para marcar\n" +
        "  AGENDAR João 11999998888 sábado 15h — marca no seu nome",
      tipo: "menu_funcionario",
    };
  }

  if (/^(minha\s+)?(agenda|horarios)(\s+(hoje|amanha|semana))?$/.test(t) || t.startsWith("minha agenda")) {
    const desde = instanteDe({ ...relogio(agora), hora: 0, minuto: 0 });
    const ate = t.includes("semana")
      ? new Date(desde.getTime() + 7 * 86_400_000)
      : new Date(desde.getTime() + 86_400_000);
    const r = await consultar(
      `select id, numero, cliente_telefone, cliente_nome, servico, data_hora, status, duracao_min
         from public.barber_agendamento
        where telefone = $1 and funcionario_telefone = $2 and status = 'marcado'
          and data_hora >= $3 and data_hora < $4 order by data_hora limit 40`,
      [barbearia.telefone, meuTelefone, desde.toISOString(), ate.toISOString()],
    );
    const lista = r.rows.map(linhaAgendamento);
    if (!lista.length) {
      return { texto: `${t.includes("semana") ? "Nesta semana" : "Amanhã"} você está livre. Manda LIVRE que eu te mostro os horários.`, tipo: "agenda_funcionario" };
    }
    return { texto: textoAgenda(lista, agora, `Sua agenda na ${barbearia.nome}`), tipo: "agenda_funcionario" };
  }

  if (/^(livre|vagas|pode)\b/.test(t)) {
    const quando = lerQuando(t, agora);
    const dia = quando.instant || instanteDe({ ...relogio(agora), hora: 0, minuto: 0 });
    const rel = relogio(dia);
    const diaIso = `${rel.ano}-${String(rel.mes + 1).padStart(2, "0")}-${String(rel.dia).padStart(2, "0")}`;
    const livre = await vagasDoDia(barbearia.telefone, diaIso, 30, meuTelefone, agora);
    const quandoFoi = rotuloDoDia(dia, agora);
    if (livre.fechado) {
      return {
        texto: `No ${quandoFoi} a ${barbearia.nome} não abre para você. Manda LIVRE segunda que eu olho outro dia.`,
        tipo: "agenda_funcionario",
      };
    }
    if (!livre.vagas.length) {
      return {
        texto: `No ${quandoFoi} você já está cheio. Manda LIVRE em outro dia que eu olho de novo.`,
        tipo: "agenda_funcionario",
      };
    }
    return {
      texto: `Você tem espaço ${quandoFoi === "hoje" ? "hoje" : `no ${quandoFoi}`}:\n  ${livre.vagas.join(" · ")}` +
        `\n\nPara marcar: AGENDAR João 11999998888 ${livre.vagas[0]}`,
      tipo: "agenda_funcionario",
    };
  }

  if (/^(agendar|marcar|agenda)\s/.test(t)) {
    const quando = lerQuando(String(bruto || ""), agora);
    const cliente = (String(bruto || "").match(/\d{10,13}/) || [""])[0];
    const digitos = normalizarWhatsapp(cliente);
    const nome = letrasOriginais(String(bruto || ""), "").replace(/\d/g, "").replace(/\s+/g, " ").trim();
    if (!telefoneValido(digitos)) {
      return {
        texto: "Falta o telefone do cliente com DDD. Exemplo: AGENDAR João 11999998888 sábado 15h",
        tipo: "pergunta",
      };
    }
    if (!quando.instant) {
      return {
        texto: quando.faltando === "passado"
          ? "Esse horário já passou. Manda o dia e a hora à frente: AGENDAR João 11999998888 amanhã 15h"
          : "Para marcar preciso do dia e da hora. Exemplo: AGENDAR João 11999998888 sábado 15h",
        tipo: "pergunta",
      };
    }
    const rel = relogio(quando.instant);
    const diaIso = `${rel.ano}-${String(rel.mes + 1).padStart(2, "0")}-${String(rel.dia).padStart(2, "0")}`;
    const dia = await vagasDoDia(barbearia.telefone, diaIso, 30, meuTelefone, agora);
    if (dia.fechado) {
      return {
        texto: `A ${barbearia.nome} não abre no dia ${dataDe(quando.instant)}. Confirma com o dono ou marca em outro dia.`,
        tipo: "pergunta",
      };
    }
    if (await horarioNoAlmoco(barbearia.telefone, diaIso, horaDe(quando.instant), 30)) {
      return {
        texto: "Esse horário fica dentro do intervalo de almoço da barbearia. Escolha outro horário.",
        tipo: "pergunta",
      };
    }
    const emCima = await consultar1(
      `select numero from public.barber_agendamento
        where telefone = $1 and funcionario_telefone = $2 and status = 'marcado'
          and data_hora < $4
          and data_hora + make_interval(mins => duracao_min) > $3
        limit 1`,
      [barbearia.telefone, meuTelefone, quando.instant.toISOString(),
       new Date(quando.instant.getTime() + 30 * 60_000).toISOString()],
    );
    if (emCima) {
      return {
        texto: `Você já tem alguém nesse horário (${horaDe(quando.instant)}, horário ${Number(emCima.numero)}). ` +
          "Manda LIVRE que eu te mostro o que está livre.",
        tipo: "pergunta",
      };
    }
    const criado = await consultar1(
      `insert into public.barber_agendamento
         (telefone, numero, cliente_telefone, cliente_nome, servico, data_hora, duracao_min, funcionario_telefone, origem)
       values ($1, coalesce((select max(numero) from public.barber_agendamento where telefone = $1), 0) + 1,
               $2, $3, $4, $5, 30, $6, 'bot')
       returning numero`,
      [barbearia.telefone, digitos, nome.slice(0, 80), "", quando.instant.toISOString(), meuTelefone],
    );
    return {
      texto: `Anotado na sua agenda: ${rotuloDoDia(quando.instant, agora)} às ${horaDe(quando.instant)} — ` +
        `${nome || "cliente"} (horário ${Number(criado?.numero || 0)}).`,
      tipo: "agenda_funcionario",
    };
  }

  if (/^(nao fui|faltei|desmarquei|cancelar)\b/.test(t)) {
    return { texto: "Isso quem cancela é o dono da barbearia. Manda o recado para ele.", tipo: "sem_regra" };
  }

  return {
    texto: textos.ajuda_funcionario ||
      `Não entendi. Você fala com o robô da ${barbearia.nome} pelo seu número.\n` +
      "  MINHA AGENDA\n  AGENDAR João 11999998888 sábado 15h",
    tipo: "sem_regra",
  };
}

// ------------------------------------------------------------------------- o webhook

/** O resultado positivo fica na memória do container; o negativo é conferido de novo, porque a
 *  migration das tabelas `barber_` pode rodar enquanto esta função continua no ar. */
let barbeariaNoAr = false;
async function tabelasDeBarbearia(): Promise<boolean> {
  if (barbeariaNoAr) return true;
  try {
    await consultar1(`select 1 from public.barber_contas limit 1`);
    await consultar1(`select 1 from public.barber_entrada limit 1`);
    barbeariaNoAr = true;
  } catch {
    return false;
  }
  return true;
}

let estabelecimentoNoAr = false;
async function tabelasDeEstabelecimento(): Promise<boolean> {
  if (estabelecimentoNoAr) return true;
  try {
    await consultar1(`select 1 from public.barber_horario limit 1`);
    await consultar1(`select 1 from public.barber_funcionario limit 1`);
    await consultar1(`select duracao_min, funcionario_telefone from public.barber_agendamento limit 1`);
    estabelecimentoNoAr = true;
  } catch {
    return false;
  }
  return true;
}

/** Quem é o dono pelo número do funcionário: ele não tem conta própria, tem barbearia. */
async function barbeariaDoFuncionario(telefone: string): Promise<{ conta: Conta; funcionario: Bruto } | null> {
  const l = await consultar1(
    `select barbearia, telefone, nome, cargo from public.barber_funcionario where telefone = $1 and ativo limit 1`,
    [telefone],
  );
  if (!l) return null;
  const conta = await contaDeTelefone(String(l.barbearia || ""));
  return conta ? { conta, funcionario: l } : null;
}

/** Manda a resposta e guarda na conversa — é o mesmo caminho do dono, do funcionário e da foto
 *  que acabou de subir para a página. */
async function devolver(
  conta: Conta, para: string, resposta: Resposta, conf: Conf, textos: Textos, carimbo: string,
): Promise<{ status: number; dados: Bruto }> {
  if (!resposta.texto) {
    return { status: 200, dados: { ok: true, ignorado: resposta.tipo, barbearia: conta.telefone } };
  }
  const corpo = preencherVariaveis(resposta.texto, variaveisDaConta(conf, conta));
  const envio = await enviarTexto(conf, para, corpo);
  if (envio.ok) {
    await registrarMensagem(para, "saida", corpo, `${carimbo}-${para}-${Date.now()}-${aleatorio(4)}`, textos.dias_retencao);
  }
  if (resposta.texto2) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const segunda = preencherVariaveis(resposta.texto2, variaveisDaConta(conf, conta));
    const envio2 = await enviarTexto(conf, para, segunda);
    if (envio2.ok) {
      await registrarMensagem(para, "saida", segunda,
        `${carimbo}-painel-${para}-${Date.now()}-${aleatorio(4)}`, textos.dias_retencao);
    }
  }
  return {
    status: 200,
    dados: {
      ok: Boolean(envio.ok), barbearia: conta.telefone, tipo: resposta.tipo,
      simulado: Boolean(envio.simulado), error: envio.ok ? undefined : String(envio.error || ""),
    },
  };
}

/** A única porta das duas bases. Barbearia atendida aqui; tudo o mais segue o caminho velho. */
export async function rotearWebhook(bruto: Bruto, chave: string): Promise<{ status: number; dados: Bruto }> {
  const esperado = await tokenChat();
  if (!igual(String(chave || ""), esperado)) return { status: 401, dados: { ok: false, error: "token invalido" } };

  // Entrega de mensagem é assunto do chat_mensagens do Peixeiro; nada aqui decide por telefone.
  const statusEntrega = interpretarStatus(bruto);
  if (statusEntrega) {
    await registrarStatusLembrete(statusEntrega);
    return receberWebhook(bruto, chave);
  }

  const lida = interpretar(bruto);
  const foto = fotoRecebida(bruto);
  if (!lida.mensagem && !foto) return receberWebhook(bruto, chave);

  // A foto não tem texto: o número é o do próprio chatId da imagem, que é de quem mandou.
  const telefone = lida.mensagem
    ? lida.mensagem.telefone
    : normalizarWhatsapp(String(foto?.chatId || "").split("@")[0]);
  if (telefone.length < 10) return receberWebhook(bruto, chave);
  const m = lida.mensagem;
  if (m?.minha || m?.grupo || foto?.minha || foto?.grupo) return receberWebhook(bruto, chave);

  // Sem as tabelas do segundo robô no ar, o webhook continua sendo só do Peixeiro: um bot não
  // pode calar o outro porque a migration ainda não rodou neste banco.
  if (!(await tabelasDeBarbearia())) return receberWebhook(bruto, chave);

  const textos = await obterTextos();
  const conf = await obterConfig();
  if (!conf) return { status: 200, dados: { ok: true, ignorado: "sem banco" } };

  if (m) {
    const comando = parseComandoRenovacao(m.texto);
    if (comando) {
      const telefoneAdmin = normalizarWhatsapp(textos.renovar_admin_telefone);
      if (!telefoneAdmin || m.telefone !== telefoneAdmin) {
        return { status: 200, dados: { ok: true, ignorado: "comando reservado" } };
      }
      return await processarComandoRenovacao(comando, m, conf, textos);
    }
  }

  const conta = await contaDeTelefone(telefone);

  // A foto que ele mandou depois de "FOTO DO ..." é a única mensagem sem texto atendida aqui.
  if (conta && foto) {
    const novaFoto = await registrarMensagem(
      conta.telefone, "entrada", "[imagem]", foto.mensagemId, textos.dias_retencao,
    );
    if (novaFoto && !(await estaBloqueado(conta.telefone))) {
      await reiniciarLembretesAposResposta(conta.telefone);
    }
    if (!textos.ativo) return receberWebhook(bruto, chave);
    const resposta = await tratarFotoRecebida(conta, foto, conf);
    if (!resposta) return receberWebhook(bruto, chave);
    return await devolver(conta, conta.telefone, resposta, conf, textos, "foto");
  }

  if (!m) return receberWebhook(bruto, chave);

  if (!conta) {
    // O funcionário fala pelo número dele e não tem conta: a barbearia dele é a chave, e nada do
    // que ele diz encosta no dinheiro ou no catálogo do dono.
    const temTabelasEstabelecimento = await tabelasDeEstabelecimento();
    const dono = temTabelasEstabelecimento ? await barbeariaDoFuncionario(m.telefone) : null;
    if (dono) {
      if (!textos.ativo) return receberWebhook(bruto, chave);
      await registrarMensagem(m.telefone, "entrada", m.texto, m.chave || `ent-${m.telefone}-${Date.now()}`, textos.dias_retencao);
      const resposta = await responderFuncionario(dono.conta, dono.funcionario, m.texto, textos, new Date());
      return await devolver(dono.conta, m.telefone, resposta, conf, textos, "funcionario");
    }
    if (!textos.ativo) return receberWebhook(bruto, chave);
    if (await clientePorTelefone(m.telefone)) return receberWebhook(bruto, chave);
    if (await estaBloqueado(m.telefone)) {
      return { status: 200, dados: { ok: true, ignorado: "bloqueado", tipo: "entrada" } };
    }
    const estabelecimentosCliente = await estabelecimentosDoCliente(m.telefone);

    await registrarMensagem(m.telefone, "entrada", m.texto,
      m.chave || `entrada-${m.telefone}-${Date.now()}`, textos.dias_retencao);
    await consultar(`delete from public.barber_mensagens where expira_em < now()`);
    await consultar(`delete from public.barber_entrada where expira_em <= now()`);
    let estado = await obterEstadoEntrada(m.telefone);
    if (!estado) {
      await salvarEstadoEntrada(m.telefone, "menu");
      estado = { estado: "menu", dados: {} };
      const entrada = semAcento(m.texto.toLowerCase())
        .replace(/^\s*\/+/, "")
        .replace(/[.!?]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (entrada === "quero testar" || entrada === "testar" || entrada.startsWith("quero testar ")) {
        await salvarEstadoEntrada(m.telefone, "novo_estabelecimento_nome");
        return await responderEntrada(m.telefone,
          "Perfeito. Qual é o nome do seu estabelecimento?",
          conf, textos, "cadastro_estabelecimento");
      }
      if (estabelecimentosCliente.length && entrada !== "menu" && entrada !== "falar com suporte" &&
        entrada !== "nao" && entrada !== "n") {
        return await responderEntrada(m.telefone,
          `Encontrei um cadastro de cliente associado a ${estabelecimentosCliente.join(", ")}. ` +
          "Digite 3 para consultar um horário futuro, cancelar ou pedir remarcação. Digite MENU para ver as outras opções.",
          conf, textos, "cliente_reconhecido");
      }
      if (entrada !== "controle" && entrada !== "falar com suporte" && entrada !== "menu" &&
        entrada !== "nao" && entrada !== "n") {
        return await responderEntrada(m.telefone, MENU_ENTRADA, conf, textos, "menu_entrada");
      }
    }
    return await processarEntrada(m.telefone, m.texto, conf, textos, estado);
  }

  const novaEntrada = await registrarMensagem(
    conta.telefone, "entrada", m.texto,
    m.chave || `ent-${conta.telefone}-${Date.now()}`, textos.dias_retencao,
  );
  await consultar(`delete from public.barber_mensagens where expira_em < now()`);

  if (await estaBloqueado(conta.telefone)) {
    return { status: 200, dados: { ok: true, ignorado: "bloqueado", barbearia: conta.telefone } };
  }

  // O "não" de um barbeiro tira o número dele de toda fila, igual ao do Peixeiro.
  const dito = semAcento(m.texto.toLowerCase()).replace(/\s+/g, " ").trim();
  if (dito === "nao" || dito === "n") {
    const primeiro = await bloquear(conta.telefone, conta.telefone, conta.nome, MOTIVO_NAO);
    if (primeiro) await consultar(`update public.barber_contas set ativo = false, atualizado_em = now() where telefone = $1`, [conta.telefone]);
    return { status: 200, dados: { ok: true, bloqueado: Boolean(primeiro), barbearia: conta.telefone } };
  }

  if (novaEntrada) await reiniciarLembretesAposResposta(conta.telefone);

  if (!textos.ativo) return { status: 200, dados: { ok: true, ignorado: "robô desligado", barbearia: conta.telefone } };

  return await devolver(conta, conta.telefone, await responder(conta, m.texto, textos, conf), conf, textos, "saida");
}

// ---------------------------------------------------------------------------- a tela

export async function resumoBarbearia(): Promise<Bruto> {
  const textos = await obterTextos();
  const { renovar_admin_telefone, ...textosPublicos } = textos;
  const conf = await obterConfig();
  const token = await tokenChat();
  const contagem = await consultar1(
    `select (select count(*) from public.barber_contas)::int as contas,
            (select count(*) from public.barber_contas where ativo)::int as ativos,
            (select count(*) from public.barber_contas where expira_em is not null and expira_em <= now())::int as vencidos,
            (select count(*) from public.barber_mensagens)::int as mensagens,
            (select count(*) from public.barber_lancamento)::int as lancamentos,
            (select count(*) from public.barber_agendamento where status = 'marcado' and data_hora >= now())::int as agendados,
            (select count(*) from public.barber_interessados)::int as interessados,
            (select count(*) from public.barber_fila where estado = 'pendente')::int as fila,
            (select count(*) from public.barber_contas c
              where exists (select 1 from public.mc_linhas m where m.telefone = c.telefone)
                 or exists (select 1 from public.usuarios_criados_ip u where u.telefone = c.telefone))::int as sobrepostos`,
  );
  const soma = await consultar1(
    `select coalesce(sum(valor) filter (where tipo = 'entrada'), 0)::numeric as entradas,
            coalesce(sum(valor) filter (where tipo = 'saida'), 0)::numeric as saidas from public.barber_lancamento`,
  );
  return {
    ...textosPublicos,
    renovar_admin_configurado: Boolean(renovar_admin_telefone),
    renovar_admin_final: renovar_admin_telefone.slice(-4),
    contas: Number(contagem?.contas || 0),
    ativos: Number(contagem?.ativos || 0),
    vencidos: Number(contagem?.vencidos || 0),
    mensagens: Number(contagem?.mensagens || 0),
    lancamentos: Number(contagem?.lancamentos || 0),
    agendados: Number(contagem?.agendados || 0),
    interessados: Number(contagem?.interessados || 0),
    fila_pendente: Number(contagem?.fila || 0),
    sobrepostos: Number(contagem?.sobrepostos || 0),
    entradas_geral: Number(soma?.entradas || 0),
    saidas_geral: Number(soma?.saidas || 0),
    webhook: Boolean(token),
    armado: Boolean(conf?.api_url && conf?.id_instance && conf?.api_token),
  };
}

// -------------------------------------------------------------------- o envio em lote

export type ItemFila = { telefone: string; estado: string; detalhe: string; nome: string };

export async function montarFila(telefones: string[], texto: string): Promise<Bruto> {
  const corpo = String(texto || "").trim();
  if (!corpo) return { ok: false, error: "sem texto" };
  let n = 0;
  for (const bruto of telefones) {
    const telefone = normalizarWhatsapp(String(bruto || ""));
    if (!telefoneValido(telefone)) continue;
    await consultar(
      `insert into public.barber_fila (telefone, texto, estado, criado_em)
       values ($1, $2, 'pendente', now())
       on conflict (telefone) do update set texto = excluded.texto, estado = 'pendente',
                                            detalhe = '', enviado_em = null, criado_em = now()`,
      [telefone, corpo.slice(0, 3000)],
    );
    n++;
  }
  return { ok: true, na_fila: n };
}

export async function statusFila(): Promise<Bruto> {
  const r = await consultar1(
    `select count(*) filter (where estado = 'pendente')::int as pendentes,
            count(*) filter (where estado = 'enviado')::int as enviados,
            count(*) filter (where estado = 'falha')::int as falhas,
            count(*) filter (where estado = 'pulado')::int as pulados from public.barber_fila`,
  );
  return { pendentes: Number(r?.pendentes || 0), enviados: Number(r?.enviados || 0), falhas: Number(r?.falhas || 0), pulados: Number(r?.pulados || 0) };
}

export async function proximoDaFila(): Promise<Bruto> {
  const l = await consultar1(
    `select f.telefone, f.texto, coalesce(c.nome, '') as nome
       from public.barber_fila f left join public.barber_contas c on c.telefone = f.telefone
      where f.estado = 'pendente' order by f.criado_em limit 1`,
  );
  if (!l) return { ok: true, vazio: true, ...await statusFila() };
  const telefone = String(l.telefone || "");
  const conf = await obterConfig();
  if (!conf) return { ok: false, error: "sem banco" };
  if (await estaBloqueado(telefone)) {
    await consultar(`update public.barber_fila set estado = 'pulado', detalhe = 'bloqueado' where telefone = $1`, [telefone]);
    return { ok: true, pulado: telefone, ...await statusFila() };
  }
  // As variáveis da mensagem são as da barbearia: {primeiro} é o nome que ele cadastrou.
  const conta = await contaDeTelefone(telefone);
  const corpo = conta ? preencherVariaveis(String(l.texto || ""), variaveisDaConta(conf, conta)) : String(l.texto || "");
  const envio: ResultadoEnvio = await enviarTexto(conf, telefone, corpo);
  await consultar(
    `update public.barber_fila set estado = $2, detalhe = $3, enviado_em = now(), id_message = $4 where telefone = $1`,
    [telefone, envio.ok ? "enviado" : "falha", String(envio.error || (envio.simulado ? "simulado" : "")), String((envio.response || {}).idMessage || "")],
  );
  if (envio.ok) await registrarMensagem(telefone, "saida", corpo, `fila-${telefone}-${Date.now()}`, 90);
  return { ok: Boolean(envio.ok), telefone, nome: String(l.nome || ""), simulado: Boolean(envio.simulado), ...await statusFila() };
}

export async function tirarDaFila(telefone: string): Promise<boolean> {
  const r = await consultar(`delete from public.barber_fila where telefone = $1`, [normalizarWhatsapp(telefone)]);
  return (r.rowCount || 0) > 0;
}

export async function limparFila(): Promise<number> {
  const r = await consultar(`delete from public.barber_fila`);
  return r.rowCount || 0;
}

// ------------------------------------------------------------- o lembrete das 8 horas

type TipoLembreteAutomatico = "bom_dia" | "agenda";

function idMensagemGreenApi(envio: ResultadoEnvio): string {
  return String(envio.response?.idMessage || "").trim();
}

async function lembreteAutomaticoPausado(telefone: string): Promise<boolean> {
  const r = await consultar(
    `select distinct (entregue_em at time zone 'America/Sao_Paulo')::date::text as dia
       from public.barber_reminder_deliveries
      where telefone = $1 and entregue_em is not null`,
    [telefone],
  );
  return diasConsecutivosEntregues(r.rows.map((linha) => String(linha.dia || "")));
}

async function registrarLembreteEnviado(
  idMessage: string,
  telefone: string,
  tipo: TipoLembreteAutomatico,
  enviadoEm: Date,
): Promise<void> {
  await consultar(
    `insert into public.barber_reminder_deliveries
       (id_message, telefone, categoria, enviado_em, entregue_em)
     select $1, $2, $3, $4::timestamptz,
       (select case
                 when upper(status) = 'DELIVERED' then atualizado_em
                 when upper(status) = 'READ' then $4::timestamptz
               end
          from public.whatsapp_status where id_message = $1)
      where not exists (
        select 1 from public.barber_mensagens
         where telefone = $2 and direcao = 'entrada' and criado_em > $4::timestamptz
      )
     on conflict (id_message) do nothing`,
    [idMessage, telefone, tipo, enviadoEm.toISOString()],
  );
}

async function registrarStatusLembrete(status: StatusEntrega): Promise<void> {
  if (status.status !== "DELIVERED" && status.status !== "READ") return;
  await consultar(
    `update public.barber_reminder_deliveries d
        set entregue_em = coalesce(
          entregue_em,
          case when $3 = 'READ' then d.enviado_em else to_timestamp($2) end
        )
      where d.id_message = $1
        and not exists (
          select 1 from public.barber_mensagens m
           where m.telefone = d.telefone
             and m.direcao = 'entrada'
             and m.criado_em > d.enviado_em
        )`,
    [status.idMessage, status.timestamp, status.status],
  );
}

async function reiniciarLembretesAposResposta(telefone: string): Promise<void> {
  await consultar(
    `delete from public.barber_reminder_deliveries where telefone = $1`,
    [telefone],
  );
}

async function registrarRastreamentoLembrete(
  envio: ResultadoEnvio,
  telefone: string,
  tipo: TipoLembreteAutomatico,
  enviadoEm: Date,
): Promise<boolean> {
  const idMessage = idMensagemGreenApi(envio);
  if (!idMessage) return false;
  await registrarLembreteEnviado(idMessage, telefone, tipo, enviadoEm);
  return true;
}

/** Bom-dia diário às 8h: não depende de agendamento marcado. Uma mensagem por
 *  estabelecimento por dia, com página pública e painel privado atualizados. */
export async function bomDiaTodos(
  forcar = false,
  agora: Date = new Date(),
  automatico = false,
): Promise<Bruto> {
  const textos = await obterTextos();
  const conf = await obterConfig();
  if (!conf) return { ok: false, error: "sem banco" };
  if (!textos.ativo) return { ok: true, ativo: false, enviados: 0, avaliados: 0 };

  const inicioDia = instanteDe({ ...relogio(agora), hora: 0, minuto: 0 });
  const r = await consultar(
    `select ${COLUNAS_CONTA}, bom_dia_enviado_em
       from public.barber_contas
      where ativo order by telefone`,
  );
  let enviados = 0;
  let pausadosSemResposta = 0;
  let semIdMensagem = 0;
  const falhas: string[] = [];

  for (const linha of r.rows) {
    const conta = linhaParaConta(linha);
    if (await estaBloqueado(conta.telefone)) continue;
    if (automatico && await lembreteAutomaticoPausado(conta.telefone)) {
      pausadosSemResposta++;
      continue;
    }

    const ultimo = linha.bom_dia_enviado_em
      ? new Date(String(linha.bom_dia_enviado_em))
      : null;
    if (!forcar && ultimo && ultimo.getTime() >= inicioDia.getTime()) continue;

    const dadosPagina = await dadosDaPagina(conta.telefone);
    const paginaPublica = dadosPagina?.url ||
      (dadosPagina?.slug
        ? `${baseDoSite()}/${dadosPagina.slug}`
        : conta.slug
          ? `${baseDoSite()}/${conta.slug}`
          : "");

    const chave = crypto.randomUUID().replace(/-/g, "") +
      crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await consultar(
      `insert into public.barber_painel (telefone, chave, ativo, criado_em, atualizado_em)
       values ($1, $2, true, now(), now())
       on conflict (telefone) do update set chave = excluded.chave, ativo = true,
         atualizado_em = now()`,
      [conta.telefone, chave],
    );
    const painel = await publicarPainelBarbearia(conta.telefone, chave);

    const nome = nomeAproveitavel(conta.nome) || "Barbearia";
    const partes = [
      `Bom dia, ${nome}! ☀️`,
      "Que tal revisar hoje os serviços e produtos do seu salão?",
      paginaPublica
        ? `Página e agendamentos: ${paginaPublica}`
        : "",
      painel.ok && painel.url
        ? `Painel para editar tudo: ${painel.url}`
        : "",
      "No WhatsApp você pode cadastrar:",
      "  PRECO SERVICO corte 30,00",
      "  PRECO PRODUTO gel 15,00",
      "  NOVO corte 30,00",
      "  SAIDA energia 220",
      "/menu mostra todas as opções",
    ].filter(Boolean);
    const corpo = partes.join("\n");
    const enviadoEm = new Date();
    const envio = await enviarTexto(conf, conta.telefone, corpo);
    if (envio.ok) {
      enviados++;
      await consultar(
        `update public.barber_contas set bom_dia_enviado_em = now(), atualizado_em = now()
          where telefone = $1`,
        [conta.telefone],
      );
      await registrarMensagem(conta.telefone, "saida", corpo,
        `bom-dia-${conta.telefone}-${Math.round(inicioDia.getTime() / 1000)}`,
        textos.dias_retencao);
      if (automatico && !await registrarRastreamentoLembrete(envio, conta.telefone, "bom_dia", enviadoEm)) {
        semIdMensagem++;
      }
    } else {
      falhas.push(`${conta.telefone}: ${envio.error || "sem resposta"}`);
    }
  }

  return {
    ok: true,
    ativo: true,
    enviados,
    pausados_sem_resposta: pausadosSemResposta,
    sem_id_para_confirmacao: semIdMensagem,
    avaliados: r.rows.length,
    falhas: falhas.slice(0, 10),
  };
}

/** Um aviso por barbearia, com a agenda do dia. O `lembrete_enviado_em` no agendamento é o que
 *  faz o cron poder ser chamado duas vezes no mesmo dia sem duplicar mensagem. */
export async function lembretesDoDia(
  forcar = false, agora: Date = new Date(), automatico = false,
): Promise<Bruto> {
  const textos = await obterTextos();
  const conf = await obterConfig();
  if (!conf) return { ok: false, error: "sem banco" };
  if (!textos.ativo) return { ok: true, ativo: false, enviados: 0, avaliados: 0 };

  const inicioDia = instanteDe({ ...relogio(agora), hora: 0, minuto: 0 });
  const fimDia = new Date(inicioDia.getTime() + 86_400_000);
  const contas = await consultar(
    `select ${COLUNAS_CONTA} from public.barber_contas where ativo order by telefone`,
  );
  let enviados = 0, semAgenda = 0, pausadosSemResposta = 0, semIdMensagem = 0;
  const falhas: string[] = [];

  for (const linha of contas.rows) {
    const conta = linhaParaConta(linha);
    if (await estaBloqueado(conta.telefone)) { semAgenda++; continue; }
    if (automatico && await lembreteAutomaticoPausado(conta.telefone)) {
      pausadosSemResposta++;
      continue;
    }
    const todos = await agendamentosDe(conta.telefone, inicioDia, fimDia, "marcado", 40);
    // O `lembrete_enviado_em` é o que permite o cron rodar duas vezes no mesmo dia sem o
    // barbeiro receber a lista repetida. `forcar` é o botão "mandar agora" da tela.
    const lista = todos.filter((a) => forcar || !a.lembrete);
    if (!lista.length) { semAgenda++; continue; }

    const corpo = preencherVariaveis(textos.lembrete || "Sua agenda de {data}:\n{agenda}", variaveisDaConta(conf, conta, {
      agenda: lista.map((a) => `  ${a.numero} · ${horaDe(a.data_hora)} — ${a.cliente_nome || "cliente"}` +
        `${a.servico ? ` (${a.servico})` : ""}${a.cliente_telefone ? ` · ${formatarTelefone(a.cliente_telefone)}` : ""}`).join("\n"),
      dia: "hoje",
    }, agora));

    const enviadoEm = new Date();
    const envio = await enviarTexto(conf, conta.telefone, corpo);
    if (envio.ok) {
      enviados++;
      await consultar(
        `update public.barber_agendamento set lembrete_enviado_em = now()
          where telefone = $1 and data_hora >= $2 and data_hora < $3 and status = 'marcado'`,
        [conta.telefone, inicioDia.toISOString(), fimDia.toISOString()],
      );
      await registrarMensagem(conta.telefone, "saida", corpo, `lembrete-${conta.telefone}-${Math.round(agora.getTime() / 1000)}`, textos.dias_retencao);
      if (automatico && !await registrarRastreamentoLembrete(envio, conta.telefone, "agenda", enviadoEm)) {
        semIdMensagem++;
      }
    } else {
      falhas.push(`${conta.telefone}: ${envio.error || "sem resposta"}`);
    }
  }

  return {
    ok: true, ativo: true, enviados, avaliados: contas.rows.length, sem_agenda: semAgenda,
    pausados_sem_resposta: pausadosSemResposta, sem_id_para_confirmacao: semIdMensagem,
    falhas: falhas.slice(0, 10),
  };
}

export async function perguntarPagamentoPosServico(agora: Date = new Date()): Promise<Bruto> {
  const textos = await obterTextos();
  const conf = await obterConfig();
  if (!conf) return { ok: false, error: "sem banco" };
  if (!textos.ativo) return { ok: true, ativo: false, enviados: 0 };

  const contas = await consultar(
    `select ${COLUNAS_CONTA} from public.barber_contas where ativo order by telefone`,
  );
  let enviados = 0, semPendencia = 0;
  const falhas: Bruto[] = [];

  for (const linha of contas.rows) {
    const conta = linhaParaConta(linha);
    if (await estaBloqueado(conta.telefone)) { semPendencia++; continue; }

    const agendamento = await consultar1(
      `with candidato as (
         select a.id
           from public.barber_agendamento a
           join public.barber_contas c on c.telefone = a.telefone and c.ativo
          where a.telefone = $1
            and a.data_hora >= c.feedback_inicio_em
            and a.status in ('marcado', 'feito')
            and a.forma_pagamento is null
            and a.compareceu is null
            and a.feedback_solicitado_em is null
            and a.feedback_registrado_em is null
            and (a.feedback_claim_em is null
              or a.feedback_claim_em < $2::timestamptz - interval '2 minutes')
            and a.data_hora + make_interval(
              mins => greatest(10, least(coalesce(a.duracao_min, 30), 600)) + 40
            ) <= $2::timestamptz
            and not exists (
              select 1 from public.barber_agendamento_pagamento p
               where p.agendamento_id = a.id and p.telefone = a.telefone
            )
            and not exists (
              select 1 from public.barber_agendamento pendente
               where pendente.telefone = a.telefone
                 and pendente.feedback_solicitado_em is not null
                 and pendente.feedback_registrado_em is null
                 and pendente.compareceu is null
                 and pendente.forma_pagamento is null
            )
          order by a.data_hora, a.id
          limit 1
          for update of a skip locked
       )
       update public.barber_agendamento a
          set feedback_claim_em = $2::timestamptz, atualizado_em = now()
         from candidato
        where a.id = candidato.id
       returning a.id, a.cliente_nome, a.servico`,
      [conta.telefone, agora.toISOString()],
    );
    if (!agendamento) { semPendencia++; continue; }

    const cliente = String(agendamento.cliente_nome || "cliente");
    const servico = String(agendamento.servico || "serviço");
    const corpo = `O cliente ${cliente} fez ${servico}.\n` +
      "Como foi o pagamento? Responda PIX, CARTÃO ou NÃO VEIO.";
    const envio = await enviarTexto(conf, conta.telefone, corpo);
    if (envio.ok) {
      const registrado = await consultar1(
        `update public.barber_agendamento
            set feedback_solicitado_em = now(), feedback_claim_em = null, atualizado_em = now()
          where id = $1 and telefone = $3 and feedback_claim_em = $2::timestamptz
          returning id`,
        [Number(agendamento.id), agora.toISOString(), conta.telefone],
      );
      if (!registrado) throw new Error("feedback_enviado_sem_registro");
      enviados++;
      await registrarMensagem(
        conta.telefone,
        "saida",
        corpo,
        `feedback-pagamento-${String(agendamento.id)}`,
        textos.dias_retencao,
      );
    } else {
      await consultar(
        `update public.barber_agendamento
            set feedback_claim_em = null, atualizado_em = now()
          where id = $1 and telefone = $2 and feedback_solicitado_em is null`,
        [Number(agendamento.id), conta.telefone],
      );
      falhas.push({ agendamento: Number(agendamento.id), erro: String(envio.error || "sem_resposta") });
    }
  }

  return {
    ok: true,
    ativo: true,
    enviados,
    sem_pendencia: semPendencia,
    avaliados: contas.rows.length,
    falhas: falhas.slice(0, 10),
  };
}
