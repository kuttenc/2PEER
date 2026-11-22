// A página pública de cada estabelecimento.
//
// O desenho é o que ele escolheu: HTML de verdade no GitHub Pages (a banda é de lá, não do
// Supabase) e a agenda do salão funcionando de verdade na página — o cliente escolhe o dia, o
// horário livre e quem vai cortar, e o horário entra no banco na hora, com o dono avisado no
// WhatsApp.
//
// O robô escreve `<slug>/index.html` pela Contents API com o token que está nos secrets da
// função. Nada de chave no navegador: a página só conversa com as rotas públicas `estab_*`.
import { obterConfig } from "./banco.ts";
import { aleatorio, consultar, consultar1 } from "./db.ts";
import { enviarTexto } from "./greenapi.ts";
import { modoTeste } from "./mcapi.ts";
import { hashCodigoCancelamento, instanteDoAgendamento, novoCodigoCancelamento } from "./cancelamento.mjs";
import {
  mensagemPerfilWhatsApp,
  paginaProntaParaAgendamento,
} from "../_shared/barber-site-onboarding.mjs";
import {
  BRAZIL_OFFSET_MS,
  bytesParaB64,
  formatarTelefone,
  normalizarWhatsapp,
  semAcento,
  telefoneValido,
} from "./texto.ts";

type Bruto = Record<string, unknown>;

const REPO_PADRAO = "kuttenc/estabelecimento";
const BASE_PADRAO = "https://kuttenc.github.io/estabelecimento";
const RAMOS = 14;
const TAMANHO_MAX_FOTO = 900_000;

// ---------------------------------------------------------------------------- endereços

export function baseDoSite(): string {
  return String(Deno.env.get("ESTAB_BASE_URL") || BASE_PADRAO).trim().replace(/\/+$/, "");
}

function repositorio(): string {
  return String(Deno.env.get("ESTAB_REPO") || REPO_PADRAO).trim().replace(/^\/+|\/+$/g, "");
}

/** Pasta dentro do repositório. O padrão continua vazio para o repositório separado.
 *  A raiz kuttenc.github.io usa "estabelecimentos" para não misturar com o Urtador. */
function caminhoRepositorio(): string {
  return String(Deno.env.get("ESTAB_REPO_PATH") || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function caminhoPagina(slug: string, arquivo = "index.html"): string {
  const prefixo = caminhoRepositorio();
  return prefixo ? `${prefixo}/${slug}/${arquivo}` : `${slug}/${arquivo}`;
}

function caminhoIndice(): string {
  const prefixo = caminhoRepositorio();
  return prefixo ? `${prefixo}/index.html` : "index.html";
}

function tokenGitHub(): string {
  return String(Deno.env.get("ESTAB_GITHUB_TOKEN") || "").trim();
}

/** A URL da própria função, para a página buscar os horários livres. Nos projetos onde
 *  `PAINEL_FUNCAO_URL` não existe, o ref do Supabase sai do usuário da conexão. */
export function urlDaApi(): string {
  const direto = String(Deno.env.get("ESTAB_API_URL") || Deno.env.get("PAINEL_FUNCAO_URL") || "").trim();
  if (direto) return direto.replace(/\/+$/, "");
  const url = String(Deno.env.get("DATABASE_URL") || "");
  const ref = /[.:]([a-z]{20})(?:[.@]|$)/.exec(url)?.[1] || "";
  return ref ? `https://${ref}.functions.supabase.co/peixeiro` : "";
}

/** O final do endereço: tudo junto, sem espaço, sem acento — é o que a URL aceita. */
export function slugDe(nome: string, telefone = ""): string {
  const bruto = semAcento(String(nome || ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 60);
  if (bruto.length >= 2) return bruto;
  return normalizarWhatsapp(telefone).replace(/\D/g, "").slice(-11);
}

export function slugValido(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,59}$/.test(String(slug || ""));
}

// -------------------------------------------------------------------------- o GitHub

type RespostaGithub = { status: number; corpo: Bruto };

async function github(caminho: string, init: RequestInit = {}): Promise<RespostaGithub> {
  // No modo teste nada vai ao repositório: a prova do robô confere os comandos e os textos,
  // não o arquivo publicado. Assim dá para testar sem mexer no Pages.
  if (modoTeste()) {
    const simulado: Bruto = (init.method || "GET") === "PUT"
      ? { content: { sha: `simulado-${caminho.length}` }, commit: { sha: "simulado" } }
      : { sha: "simulado", name: caminho.split("/").pop() || "" };
    return { status: 200, corpo: simulado };
  }
  const token = tokenGitHub();
  if (!token || !repositorio()) return { status: 0, corpo: { message: "sem token do github" } };
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
    ...((init.headers || {}) as Record<string, string>),
  };
  try {
    const resp = await fetch(`https://api.github.com/repos/${repositorio()}/${caminho}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const bruto = await resp.text();
    let corpo: Bruto = {};
    try {
      corpo = JSON.parse(bruto);
    } catch {
      corpo = { message: bruto.slice(0, 200) };
    }
    return { status: resp.status, corpo };
  } catch (exc) {
    return { status: 0, corpo: { message: String(exc).slice(0, 160) } };
  }
}

/** O `sha` é o número de chamada do arquivo: sem ele o GitHub recusa a sobrescrita. */
async function shaDoArquivo(caminho: string): Promise<string | null> {
  const r = await github(`contents/${caminho}`);
  if (r.status === 404) return "";
  if (r.status >= 400) return null;
  return String(r.corpo.sha || "");
}

export type Escrita = { ok: boolean; sha?: string; erro?: string };

async function escrever(
  caminho: string,
  base64: string,
  mensagem: string,
  shaAtual: string,
): Promise<Escrita> {
  const corpo: Bruto = { message: mensagem, content: base64, branch: "main" };
  if (shaAtual) corpo.sha = shaAtual;
  const r = await github(`contents/${caminho}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  if (r.status >= 400) {
    return { ok: false, erro: `${r.status} ${String(r.corpo.message || "").slice(0, 140)}` };
  }
  const conteudo = (r.corpo.content || {}) as Bruto;
  const submissao = (r.corpo.commit || {}) as Bruto;
  return { ok: true, sha: String(conteudo.sha || submissao.sha || "") };
}

/** A lista de arquivos de uma pasta do repositório; hoje serve para conferir o que já foi
 *  publicado antes de sobrescrever. */
async function listar(caminho: string): Promise<Bruto[]> {
  const r = await github(`contents/${caminho}`);
  if (r.status >= 400 || !Array.isArray(r.corpo)) return [];
  return r.corpo as Bruto[];
}

// ------------------------------------------------------------------------ os dados

export type Servico = { nome: string; preco: number; duracao_min: number; descricao: string };
export type Horario = {
  dia: number;
  abre: string;
  fecha: string;
  almoco_inicio: string;
  almoco_fim: string;
  intervalo: number;
  primeiro: string;
};
export type Funcionario = { id: number; telefone: string; nome: string; cargo: string; foto: string };
export type DadosPagina = {
  telefone: string;
  nome: string;
  slug: string;
  url: string;
  endereco: string;
  cidade: string;
  uf: string;
  cep: string;
  telefone_publico: string;
  mostra_barbeiro: boolean;
  aceita_agendamento: boolean;
  aviso_publico: string;
  servicos: Servico[];
  produtos: { nome: string; preco: number }[];
  horarios: Horario[];
  pagamentos: string[];
  funcionarios: Funcionario[];
  fotos: { arquivo: string; legenda: string }[];
  atualizado_em: string;
};

const NOMES_DIA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export function mapearHorarios(rows: Bruto[]): Horario[] {
  return rows.map((h) => ({
    dia: Number(h.dia),
    abre: String(h.abre || ""),
    fecha: String(h.fecha || ""),
    almoco_inicio: String(h.almoco_inicio || ""),
    almoco_fim: String(h.almoco_fim || ""),
    intervalo: Math.max(10, Math.min(120, Number(h.intervalo || 30))),
    primeiro: String(h.primeiro || ""),
  }));
}

export async function dadosDaPagina(telefone: string): Promise<DadosPagina | null> {
  const conta = await consultar1(
    `select telefone, nome, slug, endereco, cidade, uf, cep, telefone_publico, mostra_barbeiro,
            aceita_agendamento, aviso_publico,
            to_char(atualizado_em at time zone 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI') as atualizado_em
       from public.barber_contas where telefone = $1`,
    [telefone],
  );
  if (!conta) return null;

  const servicos = await consultar(
    `select nome, preco::numeric as preco, duracao_min, descricao from public.barber_servico
      where telefone = $1 and ativo order by lower(nome)`,
    [telefone],
  );
  const produtos = await consultar(
    `select nome, preco::numeric as preco from public.barber_produto
      where telefone = $1 and ativo order by lower(nome)`,
    [telefone],
  );
  const horarios = await consultar(
    `select dia, to_char(abre, 'HH24:MI') as abre, to_char(fecha, 'HH24:MI') as fecha,
            coalesce(to_char(almoco_inicio, 'HH24:MI'), '') as almoco_inicio,
            coalesce(to_char(almoco_fim, 'HH24:MI'), '') as almoco_fim,
            intervalo, coalesce(to_char(primeiro, 'HH24:MI'), '') as primeiro
       from public.barber_horario where telefone = $1 order by dia`,
    [telefone],
  );
  const pagamentos = await consultar(
    `select nome from public.barber_pagamento where telefone = $1 order by ordem, nome`,
    [telefone],
  );
  const funcionarios = await consultar(
    `select id, telefone, nome, cargo, foto_arquivo from public.barber_funcionario
      where barbearia = $1 and ativo and na_pagina order by lower(nome)`,
    [telefone],
  );
  const fotos = await consultar(
    `select arquivo, legenda from public.barber_foto where telefone = $1 and arquivo <> '' order by ordem, id`,
    [telefone],
  );

  const slug = String(conta.slug || "") || slugDe(String(conta.nome || ""), telefone);
  const base = baseDoSite();
  return {
    telefone,
    nome: String(conta.nome || ""),
    slug,
    url: `${base}/${slug}`,
    endereco: String(conta.endereco || ""),
    cidade: String(conta.cidade || ""),
    uf: String(conta.uf || ""),
    cep: String(conta.cep || ""),
    telefone_publico: String(conta.telefone_publico || "") || telefone,
    mostra_barbeiro: Boolean(conta.mostra_barbeiro),
    aceita_agendamento: conta.aceita_agendamento !== false,
    aviso_publico: String(conta.aviso_publico || ""),
    servicos: servicos.rows.map((s) => ({
      nome: String(s.nome || ""),
      preco: Number(s.preco || 0),
      duracao_min: Math.max(10, Math.min(600, Number(s.duracao_min || 30))),
      descricao: String(s.descricao || ""),
    })),
    produtos: produtos.rows.map((p) => ({ nome: String(p.nome || ""), preco: Number(p.preco || 0) })),
    horarios: mapearHorarios(horarios.rows),
    pagamentos: pagamentos.rows.map((p) => String(p.nome || "")),
    funcionarios: funcionarios.rows.map((f) => ({
      id: Number(f.id || 0),
      telefone: String(f.telefone || ""),
      nome: String(f.nome || ""),
      cargo: String(f.cargo || "barbeiro"),
      foto: String(f.foto_arquivo || ""),
    })),
    fotos: fotos.rows.map((f) => ({ arquivo: String(f.arquivo || ""), legenda: String(f.legenda || "") })),
    atualizado_em: String(conta.atualizado_em || ""),
  };
}

/** O slug é o endereço: só entra quem passou pela validação, nunca o texto do navegador. */
export async function contaPorSlug(slug: string): Promise<Bruto | null> {
  if (!slugValido(slug)) return null;
  return await consultar1(
    `select telefone, nome, slug, mostra_barbeiro, telefone_publico, endereco, cidade, uf, cep
       from public.barber_contas where lower(slug) = lower($1) limit 1`,
    [String(slug || "").trim()],
  );
}

// ----------------------------------------------------------------------- as vagas

function emBrasilia(instant: Date): { ano: number; mes: number; dia: number; hora: number; minuto: number; semana: number } {
  const deslocado = new Date(instant.getTime() + BRAZIL_OFFSET_MS);
  return {
    ano: deslocado.getUTCFullYear(),
    mes: deslocado.getUTCMonth(),
    dia: deslocado.getUTCDate(),
    hora: deslocado.getUTCHours(),
    minuto: deslocado.getUTCMinutes(),
    semana: deslocado.getUTCDay(),
  };
}

/** "2026-11-21" vira o meio-dia de Brasília daquele dia, e o número do dia da semana. */
function diaDaGrava(diaIso: string): { base: Date; semana: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(diaIso || "").trim());
  if (!m) return null;
  const [, a, me, d] = m;
  const base = new Date(Date.UTC(Number(a), Number(me) - 1, Number(d), 12, 0, 0) - BRAZIL_OFFSET_MS);
  return { base, semana: emBrasilia(base).semana };
}

function minutosDaHora(hora: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

function horaDeMinutos(total: number): string {
  const h = Math.floor(total / 60) % 24;
  const mi = total % 60;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** O instante (em UTC) de um horário de Brasília daquele dia. */
function instanteDeBrasilia(base: Date, minuto: number): Date {
  return new Date(base.getTime() + (minuto - emBrasilia(base).hora * 60 - emBrasilia(base).minuto) * 60_000);
}

export function conflitaComAlmoco(
  hora: string,
  duracaoMin: number,
  almocoInicio: string,
  almocoFim: string,
): boolean {
  const inicio = minutosDaHora(hora);
  const pausaInicio = minutosDaHora(almocoInicio);
  const pausaFim = minutosDaHora(almocoFim);
  if (inicio < 0 || pausaInicio < 0 || pausaFim <= pausaInicio) return false;
  const fim = inicio + Math.max(10, Math.min(600, Math.trunc(Number(duracaoMin) || 30)));
  return inicio < pausaFim && fim > pausaInicio;
}

export async function horarioNoAlmoco(
  telefone: string,
  diaIso: string,
  hora: string,
  duracaoMin: number,
): Promise<boolean> {
  const dia = diaDaGrava(diaIso);
  const inicio = minutosDaHora(hora);
  if (!dia || inicio < 0) return false;
  const linha = await consultar1(
    `select to_char(almoco_inicio, 'HH24:MI') as almoco_inicio,
            to_char(almoco_fim, 'HH24:MI') as almoco_fim
       from public.barber_horario where telefone = $1 and dia = $2`,
    [telefone, dia.semana],
  );
  return conflitaComAlmoco(
    hora, duracaoMin, String(linha?.almoco_inicio || ""), String(linha?.almoco_fim || ""),
  );
}

/** Os horários livres de um dia: o que a agenda do salão ainda aceita, com a duração do
 *  serviço e a reserva de quem vai cortar. É a única conta que importa — e é por isso que a
 *  página pede, ela não inventa vaga. */
export function calcularVagasDoExpediente(
  h: Horario,
  base: Date,
  duracaoMin: number,
  blocos: { desde: number; duracao_min: number }[],
  agora: Date = new Date(),
): string[] {
  const abre = minutosDaHora(h.abre);
  const fecha = minutosDaHora(h.fecha);
  const passo = Math.max(10, Math.min(120, Number(h.intervalo || 30)));
  const primeiro = minutosDaHora(h.primeiro || "") >= 0 ? minutosDaHora(h.primeiro || "") : abre;
  const duracao = Math.max(10, Math.min(600, Math.trunc(Number(duracaoMin) || 30)));
  const agoraRel = emBrasilia(agora);
  const diaRel = emBrasilia(base);
  const hojeMesmo = agoraRel.ano === diaRel.ano && agoraRel.mes === diaRel.mes && agoraRel.dia === diaRel.dia;
  const agoraMinuto = agoraRel.hora * 60 + agoraRel.minuto;
  const vagas: string[] = [];

  for (let m = primeiro; m + duracao <= fecha; m += passo) {
    if (hojeMesmo && m < agoraMinuto + 30) continue;
    if (conflitaComAlmoco(horaDeMinutos(m), duracao, h.almoco_inicio, h.almoco_fim)) continue;
    if (blocos.some((b) =>
      m < b.desde + Math.max(10, Number(b.duracao_min || 30)) && m + duracao > b.desde
    )) continue;
    vagas.push(horaDeMinutos(m));
  }
  return vagas;
}

async function vagasDeFuncionario(
  telefone: string,
  dia: { base: Date; semana: number },
  duracaoMin: number,
  funcionarioId: number | null,
  funcionarioTelefone: string,
  agora: Date,
): Promise<{ vagas: string[]; fechado: boolean }> {
  let linha: Bruto | null = null;
  let horarioIndividual = false;

  if (funcionarioId !== null) {
    const individual = await consultar(
      `select dia, to_char(abre, 'HH24:MI') as abre, to_char(fecha, 'HH24:MI') as fecha,
              coalesce(to_char(almoco_inicio, 'HH24:MI'), '') as almoco_inicio,
              coalesce(to_char(almoco_fim, 'HH24:MI'), '') as almoco_fim,
              intervalo, coalesce(to_char(primeiro, 'HH24:MI'), '') as primeiro
         from public.barber_funcionario_horario where funcionario_id = $1`,
      [funcionarioId],
    );
    horarioIndividual = individual.rows.length > 0;
    linha = individual.rows.find((h) => Number(h.dia) === dia.semana) || null;
    if (horarioIndividual && (!linha || !linha.abre || !linha.fecha)) {
      return { vagas: [], fechado: true };
    }
  }

  if (!horarioIndividual) {
    linha = await consultar1(
      `select dia, to_char(abre, 'HH24:MI') as abre, to_char(fecha, 'HH24:MI') as fecha,
              coalesce(to_char(almoco_inicio, 'HH24:MI'), '') as almoco_inicio,
              coalesce(to_char(almoco_fim, 'HH24:MI'), '') as almoco_fim,
              intervalo, coalesce(to_char(primeiro, 'HH24:MI'), '') as primeiro
         from public.barber_horario where telefone = $1 and dia = $2`,
      [telefone, dia.semana],
    );
  }
  if (!linha || !linha.abre || !linha.fecha) return { vagas: [], fechado: true };

  const ocupado = await consultar(
    `select extract(epoch from data_hora)::bigint as seg, duracao_min
       from public.barber_agendamento
      where telefone = $1 and status = 'marcado'
        and data_hora >= $2 and data_hora < $3
        and (
          ($4::integer is null and ($5 = '' or funcionario_telefone = $5))
          or funcionario_id = $4
          or ($4::integer is not null and funcionario_id is null and funcionario_telefone = $5)
          or ($4::integer is not null and funcionario_id is null and funcionario_telefone = '')
        )`,
    [
      telefone,
      dia.base.toISOString(),
      new Date(dia.base.getTime() + 86_400_000).toISOString(),
      funcionarioId,
      funcionarioTelefone,
    ],
  );
  const blocos = ocupado.rows.map((o) => {
    const rel = emBrasilia(new Date(Number(o.seg) * 1000));
    return { desde: rel.hora * 60 + rel.minuto, duracao_min: Number(o.duracao_min || 30) };
  });
  const horario = mapearHorarios([linha])[0];
  return {
    vagas: calcularVagasDoExpediente(horario, dia.base, duracaoMin, blocos, agora),
    fechado: false,
  };
}

export async function vagasDoDia(
  telefone: string,
  diaIso: string,
  duracaoMin: number,
  funcionario: string | number | null,
  agora: Date = new Date(),
): Promise<{ vagas: string[]; fechado: boolean; dia: string; rotulo: string }> {
  const dia = diaDaGrava(diaIso);
  if (!dia) return { vagas: [], fechado: true, dia: diaIso, rotulo: "" };
  const conta = await consultar1(
    `select aceita_agendamento from public.barber_contas where telefone = $1`,
    [telefone],
  );
  if (!conta || conta.aceita_agendamento === false) {
    return { vagas: [], fechado: true, dia: diaIso, rotulo: NOMES_DIA[dia.semana] };
  }
  const rotulo = NOMES_DIA[dia.semana];
  let funcionarioId: number | null = null;
  let funcionarioTelefone = "";

  if (typeof funcionario === "number") {
    funcionarioId = Number.isSafeInteger(funcionario) && funcionario > 0 ? funcionario : null;
    if (funcionarioId === null) return { vagas: [], fechado: true, dia: diaIso, rotulo };
    const pessoa = await consultar1(
      `select telefone from public.barber_funcionario
        where id = $1 and barbearia = $2 and ativo`,
      [funcionarioId, telefone],
    );
    if (!pessoa) return { vagas: [], fechado: true, dia: diaIso, rotulo };
    funcionarioTelefone = String(pessoa.telefone || "");
  } else if (funcionario) {
    funcionarioTelefone = normalizarWhatsapp(funcionario);
    const pessoa = await consultar1(
      `select id from public.barber_funcionario where barbearia = $1 and telefone = $2 and ativo`,
      [telefone, funcionarioTelefone],
    );
    if (pessoa) funcionarioId = Number(pessoa.id || 0) || null;
  }

  if (funcionarioId !== null || funcionarioTelefone) {
    const resultado = await vagasDeFuncionario(
      telefone, dia, duracaoMin, funcionarioId, funcionarioTelefone, agora,
    );
    return { ...resultado, dia: diaIso, rotulo };
  }

  const equipe = await consultar(
    `select f.id, coalesce(f.telefone, '') as telefone,
            exists (select 1 from public.barber_funcionario_horario h where h.funcionario_id = f.id) as horario_individual
       from public.barber_funcionario f
      where f.barbearia = $1 and f.ativo and f.na_pagina`,
    [telefone],
  );
  if (equipe.rows.some((f) => Boolean(f.horario_individual))) {
    const resultados = await Promise.all(equipe.rows.map((f) =>
      vagasDeFuncionario(
        telefone, dia, duracaoMin, Number(f.id || 0), String(f.telefone || ""), agora,
      )
    ));
    const vagas = [...new Set(resultados.flatMap((r) => r.vagas))].sort();
    return { vagas, fechado: resultados.every((r) => r.fechado), dia: diaIso, rotulo };
  }

  const resultado = await vagasDeFuncionario(telefone, dia, duracaoMin, null, "", agora);
  return { ...resultado, dia: diaIso, rotulo };
}

/** Onde a vaga se encaixa na agenda: é o horário do cliente, não o do robô. */
export async function marcarDoSite(
  telefone: string,
  dados: {
    cliente_nome: string; cliente_telefone: string; servico: string;
    data_hora: Date; duracao_min: number; funcionario?: string; funcionario_id?: number;
  },
): Promise<{ id: number; numero: number } | null> {
  const r = await consultar1(
    `insert into public.barber_agendamento
       (telefone, numero, cliente_telefone, cliente_nome, servico, data_hora, duracao_min,
          funcionario_telefone, funcionario_id, origem)
     values ($1, coalesce((select max(numero) from public.barber_agendamento where telefone = $1), 0) + 1,
               $2, $3, $4, $5, $6, $7, $8, 'site')
     returning id, numero`,
    [
      telefone,
      normalizarWhatsapp(dados.cliente_telefone),
      String(dados.cliente_nome || "").trim().slice(0, 80),
      String(dados.servico || "").trim().slice(0, 120),
      dados.data_hora.toISOString(),
      Math.max(10, Math.min(600, Math.trunc(Number(dados.duracao_min) || 30))),
      dados.funcionario ? normalizarWhatsapp(dados.funcionario) : "",
      dados.funcionario_id || null,
    ],
  );
  if (!r) return null;
  return { id: Number(r.id || 0), numero: Number(r.numero || 0) };
}

// --------------------------------------------------------------------- o HTML da página

function esc(texto: unknown): string {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function moeda(valor: number): string {
  return valor > 0 ? `R$ ${valor.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}` : "combinar";
}

function mapaEndereco(d: DadosPagina): string {
  const bruto = [d.endereco, d.cidade, d.uf, d.cep].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(bruto)}`;
}

/** A foto morar no GitHub quer dizer caminho relativo: a página e as fotos são da mesma pasta. */
function urlFoto(d: DadosPagina, arquivo: string): string {
  const limpo = String(arquivo || "").replace(/^\/+/, "");
  return `${baseDoSite()}/${d.slug}/${limpo}`;
}

const CSS = `
:root{color-scheme:dark;--fundo:#101820;--card:#18232d;--linha:#2a3a47;--texto:#edf3f6;--apago:#9eafb9;--ouro:#efbd72;--botao:#c66c48;--verde:#327c67;--sombra:0 18px 48px #07101866}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse at 50% -18%,#284254 0,transparent 58%),var(--fundo);color:var(--texto);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.cabeca{padding:42px 18px 30px;background:linear-gradient(150deg,#1d303d,#15212a 72%);border-bottom:1px solid var(--linha);text-align:center}
.cabeca h1{max-width:900px;margin:0 auto 8px;font-size:clamp(25px,6vw,42px);line-height:1.15;letter-spacing:.2px;color:var(--ouro)}
.cabeca p{margin:0 auto;color:var(--apago);font-size:15px}
.acoes{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:20px}
.acoes a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 16px;border-radius:12px;background:#1a2934;border:1px solid var(--linha);color:var(--texto);text-decoration:none;font-size:14px;font-weight:650;transition:transform .15s,border-color .15s}
.acoes a:hover{transform:translateY(-1px);border-color:var(--ouro)}
.acoes a.zap{background:var(--verde);border-color:var(--verde);color:#fff}
main{max-width:960px;margin:0 auto;padding:4px 18px 64px}
section{margin-top:20px;background:linear-gradient(145deg,#1b2832,#17232c);border:1px solid var(--linha);border-radius:18px;padding:22px;box-shadow:var(--sombra)}
h2{margin:0 0 14px;font-size:20px;color:var(--ouro);letter-spacing:.1px}
.item{display:flex;justify-content:space-between;gap:12px;padding:13px 0;border-bottom:1px solid #ffffff12}
.item:last-child{border-bottom:0}
.item b{font-weight:600}
.item span{color:var(--apago);font-size:13px;white-space:nowrap}
.mini{color:var(--apago);font-size:13px;margin:6px 0 0}
.aviso-publico{white-space:pre-line}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:7px 12px;border:1px solid var(--linha);border-radius:999px;font-size:14px;background:#1b2b35}
grade{display:grid}
.dias{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.hora{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--linha);font-size:15px}
.hora:last-child{border-bottom:0}
.hora b{color:var(--apago);font-weight:500;text-transform:capitalize}
.opcoes{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.op{padding:10px 14px;border:1px solid var(--linha);border-radius:12px;background:#1a2933;color:var(--texto);font:inherit;cursor:pointer;transition:background .15s,border-color .15s}
.op:hover{border-color:#9c8060}
.op.ativo{border-color:var(--ouro);background:#3a3225;color:var(--ouro);font-weight:700}
.op:disabled{opacity:.35;cursor:not-allowed}
.pessoa{display:flex;align-items:center;gap:10px;padding:10px 13px;border:1px solid var(--linha);border-radius:14px;background:#1a2933;cursor:pointer;color:var(--texto);font:inherit}
.pessoa.ativo{border-color:var(--ouro);background:#3a3225}
.pessoa img{width:42px;height:42px;border-radius:50%;object-fit:cover;background:#0e0d0c}
.pessoa div{text-align:left}
.pessoa small{display:block;color:var(--apago);font-size:12px;text-transform:capitalize}
.galeria{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.galeria figure{margin:0}
.galeria img{width:100%;height:180px;object-fit:cover;border-radius:14px;display:block;background:#0e0d0c}
.galeria figcaption{font-size:12px;color:var(--apago);margin-top:5px}
.rotulo{display:block;font-size:12px;color:var(--apago);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
input,select{width:100%;min-height:46px;padding:11px 13px;border-radius:12px;border:1px solid var(--linha);background:#111c24;color:var(--texto);font:inherit}
input:focus,select:focus{outline:2px solid #efbd7280;border-color:var(--ouro)}
.gravar{width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:var(--botao);color:#fff;font-size:16px;font-weight:750;cursor:pointer;transition:filter .15s,transform .15s}
.gravar:hover:not(:disabled){filter:brightness(1.12);transform:translateY(-1px)}
.gravar.secundario{background:#263b48;border:1px solid #466072}
.codigo{max-width:250px;letter-spacing:.35em;font-size:22px;font-weight:750;text-align:center}
.gravar:disabled{opacity:.45;cursor:not-allowed}
.aviso{margin-top:12px;padding:12px 14px;border-radius:12px;font-size:14px;display:none}
.aviso.ok{display:block;background:#17342d;border:1px solid #327c67}
.aviso.erro{display:block;background:#3a2421;border:1px solid #85503f}
.pés{margin-top:26px;text-align:center;color:var(--apago);font-size:12px}
.pés a{color:var(--apago)}
@media (max-width:560px){.cabeca{padding:32px 16px 24px}main{padding:0 12px 44px}section{margin-top:14px;padding:17px;border-radius:15px}.acoes a{flex:1 1 130px;text-align:center}.item{align-items:flex-start}.galeria{grid-template-columns:repeat(auto-fill,minmax(125px,1fr))}}
`;

/** O JavaScript da página é escrito com concatenação e sem crases de propósito: dentro do
 *  template do Deno um `${}` do navegador seria comido pela interpolação do arquivo. */
function jsDaPagina(api: string): string {
  const dias = [];
  const hoje = new Date(Date.now() + BRAZIL_OFFSET_MS);
  for (let i = 0; i < RAMOS; i++) {
    const rel = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() + i));
    dias.push({
      iso: `${rel.getUTCFullYear()}-${String(rel.getUTCMonth() + 1).padStart(2, "0")}-${String(rel.getUTCDate()).padStart(2, "0")}`,
    });
  }
  return `
(function () {
  var d = JSON.parse(document.getElementById('dados').textContent);
  var api = ${JSON.stringify(api)};
  var dia = ${JSON.stringify(dias.map((x) => x.iso))};
  var semana = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  var aberto = {};
  (d.horarios || []).forEach(function (h) { aberto[h.dia] = h; });
  var escolha = { servico: null, pessoa: '', hora: '' };

  function el(id) { return document.getElementById(id); }
  function limpar(caixa) { while (caixa.firstChild) caixa.removeChild(caixa.firstChild); }
  function botao(texto, ativo) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'op' + (ativo ? ' ativo' : ''); b.textContent = texto; return b;
  }
  function aviso(classe, texto) {
    var a = el('aviso'); a.className = 'aviso ' + classe; a.textContent = texto;
  }
  function claro(texto) {
    if (!texto) return 'a combinar';
    var n = Number(texto);
    if (!isFinite(n)) return 'a combinar';
    return 'R$ ' + n.toFixed(2).replace('.', ',');
  }

  var caixaServico = el('servicos-escolha');
  (d.servicos || []).forEach(function (s, i) {
    var b = botao(s.nome + ' · ' + claro(s.preco), i === 0);
    if (i === 0) escolha.servico = s;
    b.onclick = function () {
      escolha.servico = s; escolha.hora = '';
      var todos = caixaServico.getElementsByClassName('op');
      for (var k = 0; k < todos.length; k++) todos[k].className = 'op';
      b.className = 'op ativo';
      montarDias();
    };
    caixaServico.appendChild(b);
  });

  var caixaPessoa = el('pessoas');
  if (d.mostra_barbeiro && (d.funcionarios || []).length) {
    el('pessoas-campo').style.display = 'block';
    var todos = botao('qualquer um', true);
    todos.onclick = function () {
      escolha.pessoa = ''; limpar(caixaPessoa); caixaPessoa.appendChild(todos); todos.className = 'op ativo';
      desenharPessoas(); montarHoras();
    };
    caixaPessoa.appendChild(todos);
    desenharPessoas();
  }
  function desenharPessoas() {
    (d.funcionarios || []).forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'pessoa';
      if (f.foto) {
        var img = document.createElement('img');
        img.src = f.foto; img.alt = f.nome; img.loading = 'lazy'; b.appendChild(img);
      }
      var txt = document.createElement('div');
      txt.textContent = f.nome || 'barbeiro';
      var cargo = document.createElement('small');
      cargo.textContent = f.cargo || 'barbeiro';
      txt.appendChild(cargo);
      b.appendChild(txt);
      b.onclick = function () {
        var lista = caixaPessoa.children;
        for (var k = 0; k < lista.length; k++) lista[k].className = lista[k].className.indexOf('pessoa') >= 0 ? 'pessoa' : 'op';
        b.className = 'pessoa ativo';
        escolha.pessoa = f.id; escolha.hora = '';
        montarHoras();
      };
      caixaPessoa.appendChild(b);
    });
  }

  var caixaDias = el('dias');
  var escolhido = null;
  function montarDias() {
    limpar(caixaDias); escolhido = null;
    var agendaPorProfissional = d.mostra_barbeiro && (d.funcionarios || []).length > 0;
    if (!(d.servicos || []).length) {
      var avisoServico = document.createElement('p'); avisoServico.className = 'mini';
      avisoServico.textContent = 'A agenda estará disponível assim que o salão cadastrar serviços.';
      caixaDias.appendChild(avisoServico);
      limpar(caixaHoras);
      el('gravar').disabled = true;
      return;
    }
    dia.forEach(function (iso, i) {
      var partes = iso.split('-');
      var data = new Date(Date.UTC(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2])));
      var n = data.getUTCDay();
      if (!aberto[n] && !agendaPorProfissional) return;
      var rotulo = i === 0 ? 'hoje' : (i === 1 ? 'amanhã' : semana[n]);
      var texto = rotulo + ' ' + partes[2] + '/' + partes[1];
      var b = botao(texto, i === 0);
      if (i === 0) { escolhido = iso; b.className = 'op ativo'; }
      b.onclick = function () {
        var todos = caixaDias.getElementsByClassName('op');
        for (var k = 0; k < todos.length; k++) todos[k].className = 'op';
        b.className = 'op ativo'; escolhido = iso; escolha.hora = ''; montarHoras();
      };
      caixaDias.appendChild(b);
    });
    if (!caixaDias.children.length) {
      var p = document.createElement('p'); p.className = 'mini';
      p.textContent = 'Este salão ainda não publicou os dias de atendimento.'; caixaDias.appendChild(p);
    }
    montarHoras();
  }

  var caixaHoras = el('horas');
  function montarHoras() {
    limpar(caixaHoras);
    var duracao = escolha.servico ? escolha.servico.duracao_min : 30;
    if (!escolhido) return;
    var p = document.createElement('p'); p.className = 'mini';
    p.textContent = 'Procurando horários livres...'; caixaHoras.appendChild(p);
    var url = api + '?action=estab_vagas&slug=' + encodeURIComponent(d.slug) + '&dia=' + escolhido +
      '&duracao=' + duracao + '&profissional=' + encodeURIComponent(escolha.pessoa);
    if (!api) { p.textContent = 'Agenda indisponível agora. Chame no WhatsApp.'; return; }
    fetch(url).then(function (r) { return r.json(); }).then(function (s) {
      limpar(caixaHoras);
      if (s.fechado) { var q = document.createElement('p'); q.className = 'mini';
        q.textContent = 'Neste dia o salão não atende.'; caixaHoras.appendChild(q); return; }
      if (!s.vagas || !s.vagas.length) { var w = document.createElement('p'); w.className = 'mini';
        w.textContent = 'Sem vaga livre neste dia. Tente o próximo.'; caixaHoras.appendChild(w); return; }
      s.vagas.forEach(function (h) {
        var b = botao(h, h === escolha.hora);
        b.onclick = function () {
          var todos = caixaHoras.getElementsByClassName('op');
          for (var k = 0; k < todos.length; k++) todos[k].className = 'op';
          b.className = 'op ativo'; escolha.hora = h; el('gravar').disabled = false;
        };
        caixaHoras.appendChild(b);
      });
    }).catch(function () {
      limpar(caixaHoras);
      var e = document.createElement('p'); e.className = 'mini';
      e.textContent = 'A agenda não respondeu agora. Tente de novo em instantes.'; caixaHoras.appendChild(e);
    });
  }

  var telefone = el('telefone');
  telefone.addEventListener('input', function () {
    var n = telefone.value.replace(/\D/g, '').slice(0, 11);
    if (n.length > 10) telefone.value = '(' + n.slice(0, 2) + ') ' + n.slice(2, 7) + '-' + n.slice(7);
    else if (n.length > 6) telefone.value = '(' + n.slice(0, 2) + ') ' + n.slice(2, 7) + '-' + n.slice(7);
    else if (n.length > 2) telefone.value = '(' + n.slice(0, 2) + ') ' + n.slice(2);
    else telefone.value = n;
  });

  el('gravar').onclick = function () {
    if (!escolha.servico || !escolhido || !escolha.hora) return;
    var nome = el('nome').value.trim();
    var fone = telefone.value.replace(/\D/g, '');
    if (nome.length < 2) { aviso('erro', 'Escreva o seu nome.'); return; }
    if (fone.length < 10) { aviso('erro', 'O telefone precisa ter o DDD.'); return; }
    if (!api) { aviso('erro', 'A agenda não está ligada neste endereço.'); return; }
    el('gravar').disabled = true;
    fetch(api + '?action=estab_marcar', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: d.slug, dia: escolhido, hora: escolha.hora, servico: escolha.servico.nome,
        duracao: escolha.servico.duracao_min, profissional: escolha.pessoa, nome: nome, telefone: fone
      })
    }).then(function (r) { return r.json(); }).then(function (s) {
      el('gravar').disabled = false;
      if (s.ok) {
        aviso('ok', (s.texto || 'Horário anotado!') + ' O salão recebe o recado na hora.');
        escolha.hora = ''; montarHoras();
      } else {
        aviso('erro', s.erro === 'ocupado' ? 'Alguém pegou este horário agora. Escolha outro.' :
          (s.erro === 'sem_horario' ? 'Este dia fechou. Escolha outro.' : 'Não consegui anotar. Chame no WhatsApp.'));
        montarHoras();
      }
    }).catch(function () { el('gravar').disabled = false; aviso('erro', 'Sem resposta da agenda. Tente de novo.'); });
  };

  var cancelarTelefone = el('cancelar-telefone');
  cancelarTelefone.addEventListener('input', function () {
    var n = cancelarTelefone.value.replace(/\D/g, '').slice(0, 11);
    if (n.length > 6) cancelarTelefone.value = '(' + n.slice(0, 2) + ') ' + n.slice(2, 7) + '-' + n.slice(7);
    else if (n.length > 2) cancelarTelefone.value = '(' + n.slice(0, 2) + ') ' + n.slice(2);
    else cancelarTelefone.value = n;
  });
  el('cancelar-codigo').addEventListener('input', function () {
    el('cancelar-codigo').value = el('cancelar-codigo').value.replace(/\D/g, '').slice(0, 6);
  });
  function enviarAcaoCancelamento(acao, dados) {
    return fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: acao, slug: d.slug }, dados))
    }).then(function (r) {
      return r.json().then(function (s) {
        if (!r.ok) throw new Error(s.erro || 'indisponivel');
        return s;
      });
    });
  }
  function dadosCancelamento() {
    return {
      telefone: cancelarTelefone.value.replace(/\D/g, ''),
      dia: el('cancelar-dia').value,
      hora: el('cancelar-hora').value
    };
  }
  el('cancelar-solicitar').onclick = function () {
    var dados = dadosCancelamento();
    if (dados.telefone.length < 10 || !dados.dia || !dados.hora) {
      el('cancelar-aviso').className = 'aviso erro';
      el('cancelar-aviso').textContent = 'Preencha o telefone usado no agendamento, a data e o horário.';
      return;
    }
    if (!api) {
      el('cancelar-aviso').className = 'aviso erro';
      el('cancelar-aviso').textContent = 'O cancelamento está indisponível agora. Tente novamente.';
      return;
    }
    el('cancelar-solicitar').disabled = true;
    el('cancelar-aviso').className = 'aviso';
    enviarAcaoCancelamento('estab_cancelar_solicitar', dados).then(function (s) {
      el('cancelar-aviso').className = 'aviso ok';
      el('cancelar-aviso').textContent = s.texto || 'Se encontramos seu horário, enviamos um código pelo WhatsApp.';
      el('cancelar-codigo-passo').hidden = false;
      el('cancelar-codigo').focus();
    }).catch(function () {
      el('cancelar-aviso').className = 'aviso erro';
      el('cancelar-aviso').textContent = 'Não foi possível solicitar agora. Tente novamente em instantes.';
    }).finally(function () { el('cancelar-solicitar').disabled = false; });
  };
  el('cancelar-confirmar').onclick = function () {
    var dados = dadosCancelamento();
    dados.codigo = el('cancelar-codigo').value;
    if (dados.codigo.length !== 6) {
      el('cancelar-aviso').className = 'aviso erro';
      el('cancelar-aviso').textContent = 'Digite o código de seis números recebido no WhatsApp.';
      return;
    }
    el('cancelar-confirmar').disabled = true;
    enviarAcaoCancelamento('estab_cancelar_confirmar', dados).then(function (s) {
      el('cancelar-aviso').className = 'aviso ok';
      el('cancelar-aviso').textContent = s.texto || 'Cancelamento confirmado.';
      el('cancelar-codigo-passo').hidden = true;
      el('cancelar-codigo').value = '';
    }).catch(function (e) {
      el('cancelar-aviso').className = 'aviso erro';
      el('cancelar-aviso').textContent = e.message === 'devagar'
        ? 'Muitas tentativas. Aguarde um minuto antes de tentar novamente.'
        : 'Código não validado. Confira os dados, solicite um novo código e tente novamente.';
    }).finally(function () { el('cancelar-confirmar').disabled = false; });
  };

  montarDias();
})();
`;
}

/** A página inteira, escrita num arquivo só: HTML, estilo e o JSON do salão. */
export function htmlDaPagina(d: DadosPagina, api: string): string {
  const snapshot = JSON.stringify(d).replace(/</g, "\\u003c");
  const linhaServico = d.servicos
    .map((s) => `<div class="item"><div><b>${esc(s.nome)}</b>${s.descricao ? `<p class="mini">${esc(s.descricao)}</p>` : ""}</div>` +
      `<span>${esc(s.preco ? moeda(s.preco) : "a combinar")}${s.duracao_min ? ` · ${s.duracao_min} min` : ""}</span></div>`)
    .join("\n");
  const linhaProduto = d.produtos
    .map((p) => `<div class="item"><b>${esc(p.nome)}</b><span>${esc(moeda(p.preco))}</span></div>`)
    .join("\n");
  const linhaHorario = [0, 1, 2, 3, 4, 5, 6]
    .map((n) => {
      const h = d.horarios.find((x) => x.dia === n);
      const expediente = h
        ? `${esc(h.abre)} às ${esc(h.fecha)}${h.almoco_inicio && h.almoco_fim
          ? ` · almoço ${esc(h.almoco_inicio)}–${esc(h.almoco_fim)}` : ""}`
        : "fechado";
      return `<div class="hora"><b>${NOMES_DIA[n]}</b><span>${expediente}</span></div>`;
    })
    .join("\n");
  const avisoPublico = String(d.aviso_publico || "").trim()
    ? `<section><h2>Informações</h2><p class="mini aviso-publico">${esc(d.aviso_publico)}</p></section>`
    : "";
  const linksAgenda = d.aceita_agendamento
    ? `<a href="#agendar">Agendar</a><a href="#cancelar">Cancelar horário</a>`
    : "";
  const agenda = d.aceita_agendamento
    ? `<section id="agendar">
    <h2>Agendar horário</h2>
    <span class="rotulo">Serviço</span>
    <div class="opcoes" id="servicos-escolha">${d.servicos.length ? "" : `<p class="mini">Cadastre os serviços pelo WhatsApp e a página se atualiza sozinha.</p>`}</div>
    <div id="pessoas-campo" style="display:none">
      <span class="rotulo">Quem vai atender</span>
      <div class="opcoes" id="pessoas"></div>
    </div>
    <span class="rotulo">Dia</span>
    <div class="opcoes" id="dias"></div>
    <span class="rotulo">Horário livre</span>
    <div class="opcoes" id="horas"></div>
    <span class="rotulo">Seus dados</span>
    <div class="opcoes" style="flex-direction:column;align-items:stretch">
      <input id="nome" type="text" maxlength="60" placeholder="Seu nome" autocomplete="name">
      <input id="telefone" type="tel" inputmode="numeric" maxlength="17" placeholder="(11) 99999-9999" autocomplete="tel">
    </div>
    <button class="gravar" id="gravar" type="button" disabled>Confirmar horário</button>
    <div class="aviso" id="aviso"></div>
    <p class="mini">O horário cai direto na agenda do salão e ele confirma com você.</p>
  </section>

  <section id="cancelar">
    <h2>Cancelar agendamento</h2>
    <p class="mini">Use o mesmo telefone informado ao marcar. Enviaremos um código de confirmação pelo WhatsApp desse número.</p>
    <div class="opcoes" style="align-items:flex-end">
      <label style="flex:1;min-width:180px"><span class="rotulo">Telefone do agendamento</span>
        <input id="cancelar-telefone" type="tel" inputmode="numeric" maxlength="17" placeholder="(11) 99999-9999" autocomplete="tel">
      </label>
      <label style="flex:1;min-width:150px"><span class="rotulo">Data</span>
        <input id="cancelar-dia" type="date">
      </label>
      <label style="flex:1;min-width:130px"><span class="rotulo">Horário</span>
        <input id="cancelar-hora" type="time">
      </label>
    </div>
    <button class="gravar secundario" id="cancelar-solicitar" type="button">Enviar código pelo WhatsApp</button>
    <div class="aviso" id="cancelar-aviso" aria-live="polite"></div>
    <div id="cancelar-codigo-passo" hidden>
      <label><span class="rotulo">Código de seis números</span>
        <input class="codigo" id="cancelar-codigo" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000">
      </label>
      <p class="mini">O código expira em 10 minutos. Após a confirmação, o horário será cancelado.</p>
      <button class="gravar" id="cancelar-confirmar" type="button">Confirmar cancelamento</button>
    </div>
  </section>`
    : `<section><h2>Atendimento</h2><p class="mini">Este estabelecimento não oferece agendamento online.</p></section>`;
  const chips = (lista: string[], vazio: string) =>
    lista.length
      ? `<div class="chips">${lista.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>`
      : `<p class="mini">${esc(vazio)}</p>`;
  const galeria = d.fotos.length
    ? `<div class="galeria">${d.fotos
      .map((f) => `<figure><img src="${esc(f.arquivo)}" alt="${esc(f.legenda || d.nome)}" loading="lazy">` +
        `${f.legenda ? `<figcaption>${esc(f.legenda)}</figcaption>` : ""}</figure>`)
      .join("")}</div>`
    : "";
  const endereco = [d.endereco, d.cidade && `${d.cidade}/${d.uf}`, d.cep].filter(Boolean).join(" — ");
  const zap = `https://wa.me/${d.telefone_publico.replace(/\D/g, "")}`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.nome || "Estabelecimento")} — ${d.aceita_agendamento ? "agende seu horário" : "informações"}</title>
<meta name="description" content="${esc(`${d.aceita_agendamento ? "Agende horário em" : "Informações de"} ${d.nome}${endereco ? ` (${endereco})` : ""}.`)}">
<style>${CSS}</style>
</head>
<body>
<header class="cabeca">
  <h1>${esc(d.nome || "Estabelecimento")}</h1>
  <p>${esc(endereco || "Endereço e ponto de referência no WhatsApp")}</p>
  <div class="acoes">
    ${linksAgenda}
    <a class="zap" href="${esc(zap)}" rel="noopener">Chamar no WhatsApp</a>
    ${endereco ? `<a href="${esc(mapaEndereco(d))}" rel="noopener nofollow">Como chegar</a>` : ""}
  </div>
</header>
<main>
  ${agenda}

  ${d.servicos.length ? `<section><h2>Serviços</h2>${linhaServico}</section>` : ""}
  ${d.produtos.length ? `<section><h2>Produtos</h2>${linhaProduto}</section>` : ""}
  <section><h2>Horários de atendimento</h2>${linhaHorario}</section>
  <section><h2>Formas de pagamento</h2>${chips(d.pagamentos, "Pergunte no balcão as formas aceitas.")}</section>
  ${d.funcionarios.length ? `<section><h2>Quem atende aqui</h2><div class="opcoes" id="equipe-lista">${d.funcionarios
    .map((f) => `<div class="item"><div>${f.foto ? `<img src="${esc(f.foto)}" alt="${esc(f.nome)}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:9px">` : ""}<b>${esc(f.nome || "barbeiro")}</b></div><span>${esc(f.cargo || "barbeiro")}</span></div>`)
    .join("")}</div></section>` : ""}
  ${galeria ? `<section><h2>Fotos</h2>${galeria}</section>` : ""}
  ${avisoPublico}

  <p class="pés">${esc(d.nome || "")}${d.atualizado_em ? ` · atualizado em ${esc(d.atualizado_em)}` : ""}</p>
</main>
<script id="dados" type="application/json">${snapshot}</script>
${d.aceita_agendamento ? `<script>${jsDaPagina(api)}</script>` : ""}
</body>
</html>
`;
}

/** A página-raiz: a lista do que já foi publicado. Serve de prova visual no navegador. */
export function htmlIndice(itens: { slug: string; nome: string }[]): string {
  const linhas = itens
    .map((i) => `<li><a href="${esc(i.slug)}/">${esc(i.nome || i.slug)}</a></li>`)
    .join("\n    ");
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Estabelecimentos atendidos pelo chatbot</title>
<style>:root{color-scheme:dark;--bg:#101820;--card:#18232d;--line:#2a3a47;--text:#edf3f6;--muted:#9eafb9;--gold:#efbd72}
*{box-sizing:border-box}body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:radial-gradient(ellipse at 50% -18%,#284254 0,transparent 58%),var(--bg);color:var(--text);max-width:820px;margin:0 auto;padding:34px 18px}
h1{color:var(--gold);font-size:clamp(25px,5vw,36px)}ul{padding:0;list-style:none}li{margin:10px 0}a{display:block;padding:13px 15px;border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--text);text-decoration:none;font-weight:650}a:hover{border-color:var(--gold)}</style>
</head>
<body>
<h1>Estabelecimentos</h1>
<ul>
    ${linhas || "<li>Nenhum publicado ainda.</li>"}
</ul>
</body>
</html>
`;
}

// ----------------------------------------------------------------------- publicar

/** A página é sempre o retrato do banco: quem muda texto, preço ou foto republica. */
export async function publicarPagina(
  telefoneBruto: string,
): Promise<{
  ok: boolean;
  url?: string;
  erro?: string;
  slug?: string;
  instrucoes_whatsapp?: "incompleta" | "ja_enviada" | "enviada" | "falha";
}> {
  const telefone = normalizarWhatsapp(telefoneBruto);
  if (!telefoneValido(telefone)) return { ok: false, erro: "telefone_invalido" };
  const d = await dadosDaPagina(telefone);
  if (!d) return { ok: false, erro: "sem_conta" };
  if (!slugValido(d.slug)) return { ok: false, erro: "slug_invalido" };

  const caminho = caminhoPagina(d.slug);
  const atual = await shaDoArquivo(caminho);
  if (atual === null) return { ok: false, erro: "github_indisponivel" };
  const gravado = await escrever(caminho, bytesParaB64(new TextEncoder().encode(htmlDaPagina(d, urlDaApi()))),
    `Pagina ${d.slug}`, atual);
  if (!gravado.ok) return { ok: false, erro: gravado.erro, slug: d.slug };

  await consultar(
    `update public.barber_contas set slug = $2, site_publicado_em = now(), site_sha = $3, atualizado_em = now()
      where telefone = $1`,
    [telefone, d.slug, gravado.sha || ""],
  );
  await publicarIndice();
  const instrucoes = await enviarOrientacaoWhatsApp(d);
  return { ok: true, url: d.url, slug: d.slug, instrucoes_whatsapp: instrucoes };
}

async function enviarOrientacaoWhatsApp(d: DadosPagina): Promise<"incompleta" | "ja_enviada" | "enviada" | "falha"> {
  if (!paginaProntaParaAgendamento(d)) return "incompleta";

  const reivindicada = await consultar1(
    `update public.barber_contas
        set site_instrucoes_whatsapp_tentativa_em = now()
      where telefone = $1
        and site_instrucoes_whatsapp_enviado_em is null
        and (site_instrucoes_whatsapp_tentativa_em is null
             or site_instrucoes_whatsapp_tentativa_em <= now() - interval '15 minutes')
      returning site_instrucoes_whatsapp_tentativa_em`,
    [d.telefone],
  );
  if (!reivindicada) return "ja_enviada";

  const tentativa = reivindicada.site_instrucoes_whatsapp_tentativa_em;
  const conf = await obterConfig();
  const envio = conf
    ? await enviarTexto(conf, d.telefone, mensagemPerfilWhatsApp(d.url))
    : { ok: false, simulado: false };

  if (envio.ok && !envio.simulado) {
    await consultar(
      `update public.barber_contas
          set site_instrucoes_whatsapp_enviado_em = now(),
              site_instrucoes_whatsapp_tentativa_em = null
        where telefone = $1 and site_instrucoes_whatsapp_tentativa_em = $2
          and site_instrucoes_whatsapp_enviado_em is null`,
      [d.telefone, tentativa],
    );
    return "enviada";
  }

  await consultar(
    `update public.barber_contas
        set site_instrucoes_whatsapp_tentativa_em = null
      where telefone = $1 and site_instrucoes_whatsapp_tentativa_em = $2
        and site_instrucoes_whatsapp_enviado_em is null`,
    [d.telefone, tentativa],
  );
  return "falha";
}

/** Página privada de edição, protegida por uma chave longa na própria URL.
 *  Não usa cookie nem senha do painel geral, e só chama actions que validam chave + slug. */
export async function publicarPainelBarbearia(
  telefoneBruto: string,
  chaveBruta: string,
): Promise<{ ok: boolean; url?: string; erro?: string }> {
  const telefone = normalizarWhatsapp(telefoneBruto);
  const chave = String(chaveBruta || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!telefoneValido(telefone) || chave.length < 20) return { ok: false, erro: "dados_incompletos" };
  const d = await dadosDaPagina(telefone);
  if (!d) return { ok: false, erro: "sem_conta" };
  if (!slugValido(d.slug)) return { ok: false, erro: "slug_invalido" };

  const api = urlDaApi();
  const nome = esc(d.nome || "Barbearia");
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel privado — ${nome}</title>
<style>
:root{color-scheme:dark;--bg:#101820;--card:#18232d;--line:#2a3a47;--text:#edf3f6;--muted:#9eafb9;--green:#327c67;--gold:#efbd72;--red:#bd674d}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% -18%,#284254 0,transparent 58%),var(--bg);color:var(--text);font:15px/1.6 system-ui,Segoe UI,Roboto,Arial,sans-serif;padding:24px 16px}
main{max-width:900px;margin:auto}h1{font-size:clamp(25px,5vw,36px);line-height:1.15;margin:6px 0;color:var(--gold)}h2{font-size:19px;margin:0 0 14px;color:var(--gold)}
.card{background:linear-gradient(145deg,#1b2832,#17232c);border:1px solid var(--line);border-radius:18px;padding:20px;margin:16px 0;box-shadow:0 18px 48px #07101866}
label{display:block;margin:12px 0 5px;color:var(--muted);font-size:13px;font-weight:650}
input,select,textarea{width:100%;min-height:44px;padding:11px 13px;border:1px solid var(--line);border-radius:12px;background:#111c24;color:var(--text);font:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid #efbd7280;border-color:var(--gold)}
button{min-height:42px;padding:10px 15px;border:1px solid var(--green);border-radius:12px;background:var(--green);color:white;font:inherit;font-weight:700;cursor:pointer;transition:filter .15s,transform .15s}
button:hover{filter:brightness(1.12);transform:translateY(-1px)}button:disabled{opacity:.5;cursor:not-allowed;transform:none}
.linha{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.linha>*{flex:1;min-width:180px}
.item{border:1px solid var(--line);border-radius:14px;padding:12px;margin:9px 0;background:#111c2466}.item img{width:84px;height:84px;object-fit:cover;border-radius:12px}
.muted{color:var(--muted)}.erro{color:#ffad98}.ok{color:#83d9b7}
@media(max-width:560px){body{padding:16px 12px}.card{padding:16px;border-radius:15px}.linha>*{min-width:100%}}
</style></head><body><main>
<h1>Painel privado — ${nome}</h1><p class="muted">Esta página altera somente este estabelecimento.</p>
<p id="status"></p>
<section class="card"><h2>Dados principais</h2>
<label>Nome</label><input id="nome" maxlength="120">
<label>Telefone público</label><input id="telefone_publico" inputmode="numeric">
<label>Endereço</label><input id="endereco" maxlength="200">
<label><input id="aceita_agendamento" type="checkbox"> Aceita agendamento online</label>
<label>Aviso exibido na página</label><textarea id="aviso_publico" maxlength="1500" rows="5"></textarea>
<button id="salvarDados">Salvar dados</button></section>
<section class="card"><h2>Serviços</h2><div id="servicos"></div>
<div class="linha"><input id="novoServico" placeholder="Nome do serviço"><input id="novoPreco" type="number" step="0.01" placeholder="Preço"><input id="novoDuracao" type="number" placeholder="Minutos"></div>
<button id="adicionarServico">Adicionar serviço</button></section>
<section class="card"><h2>Produtos</h2><div id="produtos"></div>
<div class="linha"><input id="novoProduto" placeholder="Nome do produto"><input id="novoProdutoPreco" type="number" step="0.01" placeholder="Preço"></div>
<button id="adicionarProduto">Adicionar produto</button></section>
<section class="card"><h2>Horários</h2><p class="muted">Informe abertura e fechamento. Para bloquear o almoço, preencha início e fim. Para marcar um dia como fechado, deixe todos os campos vazios.</p><div id="horarios"></div><button id="salvarHorarios">Salvar horários</button></section>
<section class="card"><h2>Pagamento</h2><textarea id="pagamentos" rows="4" placeholder="Dinheiro, PIX, Cartão"></textarea><button id="salvarPagamentos">Salvar formas de pagamento</button></section>
<section class="card"><h2>Fotos</h2><div id="fotos"></div><input id="foto" type="file" accept="image/jpeg,image/png,image/webp"><button id="enviarFoto">Enviar foto</button></section>
</main>
<script>
(function(){const API=${JSON.stringify(api)};const SLUG=${JSON.stringify(d.slug)};const CHAVE=${JSON.stringify(chave)};
async function call(action,data){const r=await fetch(API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,slug:SLUG,chave:CHAVE,...(data||{})})});return r.json()}
function status(t,erro){const el=document.getElementById('status');el.className=erro?'erro':'ok';el.textContent=t||''}
async function ver(){const d=await call('barb_painel_ver');if(!d.ok){status(d.erro||'Acesso inválido',true);return}const c=d.conta||{};document.getElementById('nome').value=c.nome||'';document.getElementById('telefone_publico').value=c.telefone_publico||'';document.getElementById('endereco').value=c.endereco||'';document.getElementById('aceita_agendamento').checked=c.aceita_agendamento!==false;document.getElementById('aviso_publico').value=c.aviso_publico||'';desenhar(d)}
function criar(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function desenhar(d){const serv=document.getElementById('servicos');serv.innerHTML='';(d.servicos||[]).forEach(s=>{const box=criar('div','item linha');const nome=document.createElement('input');nome.value=s.nome||'';const preco=document.createElement('input');preco.type='number';preco.value=s.preco||0;const duracao=document.createElement('input');duracao.type='number';duracao.value=s.duracao_min||30;const editar=criar('button','', 'Salvar');editar.onclick=async()=>{const r=await call('barb_painel_salvar',{acao:'servico_editar',id:s.id,nome:nome.value,preco:preco.value,duracao_min:duracao.value});status(r.ok?'Serviço atualizado':'Não consegui atualizar',!r.ok);if(r.ok)ver()};const apagar=criar('button','', 'Apagar');apagar.onclick=async()=>{if(!confirm('Apagar este serviço?'))return;const r=await call('barb_painel_salvar',{acao:'servico_apagar',id:s.id});status(r.ok?'Serviço apagado':'Não consegui apagar',!r.ok);if(r.ok)ver()};box.append(nome,preco,duracao,editar,apagar);serv.append(box)});const prod=document.getElementById('produtos');prod.innerHTML='';(d.produtos||[]).forEach(p=>{const box=criar('div','item linha');const nome=document.createElement('input');nome.value=p.nome||'';const preco=document.createElement('input');preco.type='number';preco.value=p.preco||0;const editar=criar('button','', 'Salvar');editar.onclick=async()=>{const r=await call('barb_painel_salvar',{acao:'produto_editar',id:p.id,nome:nome.value,preco:preco.value});status(r.ok?'Produto atualizado':'Não consegui atualizar',!r.ok);if(r.ok)ver()};const apagar=criar('button','', 'Apagar');apagar.onclick=async()=>{if(!confirm('Apagar este produto?'))return;const r=await call('barb_painel_salvar',{acao:'produto_apagar',id:p.id});status(r.ok?'Produto apagado':'Não consegui apagar',!r.ok);if(r.ok)ver()};box.append(nome,preco,editar,apagar);prod.append(box)});const h=document.getElementById('horarios');h.innerHTML='';const nomes=['domingo','segunda','terça','quarta','quinta','sexta','sábado'];const por={};(d.horarios||[]).forEach(x=>por[Number(x.dia)]=x);for(let i=0;i<7;i++){const x=por[i]||{};const row=criar('div','item linha');row.append(criar('b','',nomes[i]));const abre=document.createElement('input');abre.type='time';abre.className='abre';abre.dataset.dia=i;abre.value=x.abre||'';abre.setAttribute('aria-label','Abertura '+nomes[i]);const fecha=document.createElement('input');fecha.type='time';fecha.className='fecha';fecha.dataset.dia=i;fecha.value=x.fecha||'';fecha.setAttribute('aria-label','Fechamento '+nomes[i]);const almocoInicio=document.createElement('input');almocoInicio.type='time';almocoInicio.className='almoco-inicio';almocoInicio.dataset.dia=i;almocoInicio.value=x.almoco_inicio||'';almocoInicio.setAttribute('aria-label','Início do almoço '+nomes[i]);const almocoFim=document.createElement('input');almocoFim.type='time';almocoFim.className='almoco-fim';almocoFim.dataset.dia=i;almocoFim.value=x.almoco_fim||'';almocoFim.setAttribute('aria-label','Fim do almoço '+nomes[i]);row.append(abre,fecha,almocoInicio,almocoFim);h.append(row)}document.getElementById('pagamentos').value=(d.pagamentos||[]).map(p=>p.nome).join(', ');const fotos=document.getElementById('fotos');fotos.innerHTML='';(d.fotos||[]).forEach(f=>{const box=criar('div','item linha');if(f.arquivo){const img=document.createElement('img');img.src=${JSON.stringify(baseDoSite())}+'/'+SLUG+'/'+f.arquivo;box.append(img)}const remover=criar('button','', 'Remover');remover.onclick=async()=>{const r=await call('barb_painel_foto_apagar',{id:f.id});status(r.ok?'Foto removida':'Não consegui remover',!r.ok);if(r.ok)ver()};box.append(remover);fotos.append(box)})
}
document.getElementById('salvarDados').onclick=async()=>{const r=await call('barb_painel_salvar',{nome:document.getElementById('nome').value,telefone_publico:document.getElementById('telefone_publico').value,endereco:document.getElementById('endereco').value,aceita_agendamento:document.getElementById('aceita_agendamento').checked,aviso_publico:document.getElementById('aviso_publico').value});status(r.ok?'Dados salvos':'Não consegui salvar',!r.ok);if(r.ok)ver()}
document.getElementById('adicionarServico').onclick=async()=>{const nome=document.getElementById('novoServico').value.trim(),preco=Number(document.getElementById('novoPreco').value||0),duracao=Number(document.getElementById('novoDuracao').value||30);if(!nome)return status('Escreva o nome do serviço',true);const r=await call('barb_painel_salvar',{acao:'servico',nome,preco,duracao_min:duracao});status(r.ok?'Serviço salvo':'Não consegui salvar',!r.ok);if(r.ok)ver()}
document.getElementById('adicionarProduto').onclick=async()=>{const nome=document.getElementById('novoProduto').value.trim(),preco=Number(document.getElementById('novoProdutoPreco').value||0);if(!nome)return status('Escreva o nome do produto',true);const r=await call('barb_painel_salvar',{acao:'produto',nome,preco});status(r.ok?'Produto salvo':'Não consegui salvar',!r.ok);if(r.ok)ver()}
document.getElementById('salvarHorarios').onclick=async()=>{const horarios=[];let incompleto=false,almocoIncompleto=false,almocoFora=false;document.querySelectorAll('#horarios .item').forEach(row=>{const abre=row.querySelector('.abre'),fecha=row.querySelector('.fecha'),almocoInicio=row.querySelector('.almoco-inicio'),almocoFim=row.querySelector('.almoco-fim');if(!abre||!fecha||!almocoInicio||!almocoFim)return;if(Boolean(abre.value)!==Boolean(fecha.value)){incompleto=true;return}if(Boolean(almocoInicio.value)!==Boolean(almocoFim.value)){almocoIncompleto=true;return}if(almocoInicio.value&&(!abre.value||almocoInicio.value<abre.value||almocoFim.value>fecha.value||almocoInicio.value>=almocoFim.value)){almocoFora=true;return}if(abre.value&&fecha.value)horarios.push({dia:Number(abre.dataset.dia),abre:abre.value,fecha:fecha.value,almoco_inicio:almocoInicio.value,almoco_fim:almocoFim.value})});if(incompleto)return status('Preencha abertura e fechamento do mesmo dia',true);if(almocoIncompleto)return status('Preencha início e fim do almoço do mesmo dia',true);if(almocoFora)return status('O intervalo de almoço deve ficar dentro do horário de atendimento',true);if(!horarios.length&&!confirm('Salvar todos os dias como fechados e remover os horários atuais?'))return;const r=await call('barb_painel_salvar',{horarios});status(r.ok?'Horários salvos':'Não consegui salvar',!r.ok);if(r.ok)ver()}
document.getElementById('salvarPagamentos').onclick=async()=>{const pagamentos=document.getElementById('pagamentos').value.split(/[,;]/).map(x=>x.trim()).filter(Boolean);const r=await call('barb_painel_salvar',{pagamentos});status(r.ok?'Formas de pagamento salvas':'Não consegui salvar',!r.ok);if(r.ok)ver()}
document.getElementById('enviarFoto').onclick=async()=>{const file=document.getElementById('foto').files[0];if(!file)return status('Escolha uma foto',true);const b64=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(file)});const r=await call('barb_painel_foto',{b64:String(b64)});status(r.ok?'Foto enviada':'Não consegui enviar',!r.ok);if(r.ok)ver()}
ver();
})()</script></body></html>`;

  const caminho = caminhoPagina(d.slug, `painel-${chave}/index.html`);
  const atual = await shaDoArquivo(caminho);
  if (atual === null) return { ok: false, erro: "github_indisponivel" };
  const gravado = await escrever(caminho, bytesParaB64(new TextEncoder().encode(html)),
    `Painel privado ${d.slug}`, atual);
  if (!gravado.ok) return { ok: false, erro: gravado.erro };
  return { ok: true, url: `${baseDoSite()}/${d.slug}/painel-${chave}/` };
}

/** O índice do diretório: refeito a cada publicação, para o endereço raiz nunca ficar vazio. */
export async function publicarIndice(): Promise<void> {
  const linhas = await consultar(
    `select slug, nome from public.barber_contas
      where slug <> '' and site_publicado_em is not null order by nome`,
  );
  const itens = linhas.rows.map((l) => ({ slug: String(l.slug || ""), nome: String(l.nome || "") }));
  const atual = await shaDoArquivo(caminhoIndice());
  if (atual === null) return;
  await escrever(caminhoIndice(), bytesParaB64(new TextEncoder().encode(htmlIndice(itens))), "Indice de estabelecimentos", atual);
}

/**
 * A foto que ele mandou no WhatsApp vira arquivo do GitHub. `arquivo` é só o nome — o caminho
 * sempre fica dentro da pasta do salão, então não tem como escrever fora dela.
 */
export async function publicarFoto(
  telefone: string,
  arquivoBruto: string,
  bytes: Uint8Array,
): Promise<{ ok: boolean; caminho?: string; erro?: string }> {
  const d = await dadosDaPagina(telefone);
  if (!d) return { ok: false, erro: "sem_conta" };
  if (!bytes || !bytes.length) return { ok: false, erro: "foto_vazia" };
  if (bytes.length > TAMANHO_MAX_FOTO) return { ok: false, erro: `foto_grande (${Math.round(bytes.length / 1000)}kb)` };
  const seguro = String(arquivoBruto || "")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/_{2,}/g, "_")
    .slice(-56) || `foto-${Date.now()}.jpg`;
  const nome = /\.(jpe?g|png|webp)$/i.test(seguro) ? seguro : `${seguro}.jpg`;
  const caminho = caminhoPagina(d.slug, `fotos/${nome}`);
  const atual = await shaDoArquivo(caminho);
  if (atual === null) return { ok: false, erro: "github_indisponivel" };
  const gravado = await escrever(caminho, bytesParaB64(bytes), `Foto ${nome}`, atual);
  return gravado.ok ? { ok: true, caminho: `fotos/${nome}` } : { ok: false, erro: gravado.erro };
}

/** Trocar o nome do site não pode deixar a URL velha no vácuo: ela passa a apontar para a nova. */
export async function redirecionarPaginaAntiga(
  slugAntigo: string,
  slugNovo: string,
): Promise<boolean> {
  if (!slugValido(slugAntigo) || !slugValido(slugNovo) || slugAntigo === slugNovo) return false;
  const caminho = caminhoPagina(slugAntigo);
  const atual = await shaDoArquivo(caminho);
  if (atual === null) return false;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">` +
    `<meta http-equiv="refresh" content="0; url=../${esc(slugNovo)}/">` +
    `<link rel="canonical" href="../${esc(slugNovo)}/"></head>` +
    `<body><p>Esta página mudou de endereço: <a href="../${esc(slugNovo)}/">clique aqui</a>.</p></body></html>`;
  const gravado = await escrever(caminho, bytesParaB64(new TextEncoder().encode(html)), `Redireciona ${slugAntigo}`, atual);
  return gravado.ok;
}

/** Um salão que deixa de existir não pode continuar publicando horários. */
export async function retirarPagina(telefone: string): Promise<boolean> {
  const l = await consultar1(`select slug from public.barber_contas where telefone = $1`, [telefone]);
  const slug = String(l?.slug || "");
  if (!slugValido(slug)) return false;
  const caminho = caminhoPagina(slug);
  const atual = await shaDoArquivo(caminho);
  if (!atual) return false;
  const aviso = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Fora do ar</title></head>` +
    `<body style="font:16px system-ui;background:#12100e;color:#f3ece0;text-align:center;padding:40px">` +
    `<p>Esta página saiu do ar.</p></body></html>`;
  const r = await escrever(caminho, bytesParaB64(new TextEncoder().encode(aviso)), `Retira ${slug}`, atual);
  if (r.ok) await consultar(`update public.barber_contas set site_publicado_em = null where telefone = $1`, [telefone]);
  return r.ok;
}

// --------------------------------------------------------------- as rotas da própria página

export type Handler = (dados: Bruto, ctx: { ip: string; url: string }) => Promise<Bruto>;

/** O endereço da página é a única credencial do cliente na rua: sem sessão, mas com slug. */
export const estabDados: Handler = async (dados) => {
  const conta = await contaPorSlug(String(dados.slug || ""));
  if (!conta) return { ok: false, erro: "sem_pagina" };
  const d = await dadosDaPagina(String(conta.telefone || ""));
  if (!d) return { ok: false, erro: "sem_pagina" };
  return { ok: true, dados: { ...d, api: urlDaApi() } };
};

export const estabVagas: Handler = async (dados) => {
  const conta = await contaPorSlug(String(dados.slug || ""));
  if (!conta) return { ok: false, erro: "sem_pagina" };
  const telefone = String(conta.telefone || "");
  const duracao = Math.max(10, Math.min(600, Math.trunc(Number(dados.duracao || 30)) || 30));
  const funcionario = String(dados.funcionario || "").replace(/\D/g, "");
  const profissionalTexto = String(dados.profissional || "").trim();
  const profissional = profissionalTexto ? Number(profissionalTexto) : 0;
  if ((funcionario && profissionalTexto) ||
      (profissionalTexto && (!Number.isSafeInteger(profissional) || profissional < 1))) {
    return { ok: false, erro: "sem_funcionario" };
  }
  if (profissional) {
    const e = await consultar1(
      `select id from public.barber_funcionario
        where barbearia = $1 and id = $2 and ativo and na_pagina`,
      [telefone, profissional],
    );
    if (!e) return { ok: false, erro: "sem_funcionario" };
  } else if (funcionario) {
    const e = await consultar1(
      `select telefone from public.barber_funcionario where barbearia = $1 and telefone = $2 and ativo`,
      [telefone, funcionario],
    );
    if (!e) return { ok: false, erro: "sem_funcionario" };
  }
  const r = await vagasDoDia(
    telefone, String(dados.dia || ""), duracao, profissional || funcionario || null,
  );
  return { ok: true, ...r };
};

const REGISTROS_IP = new Map<string, number[]>();
const SOLICITACOES_CANCELAMENTO_IP = new Map<string, number[]>();
const MAX_POR_MINUTO = 8;
const MAX_CANCELAMENTO_POR_MINUTO = 5;

function muitasReservas(ip: string): boolean {
  const agora = Date.now();
  const recentes = (REGISTROS_IP.get(ip) || []).filter((t) => agora - t < 60_000);
  if (recentes.length >= MAX_POR_MINUTO) {
    REGISTROS_IP.set(ip, recentes);
    return true;
  }
  recentes.push(agora);
  REGISTROS_IP.set(ip, recentes);
  return false;
}

function muitasSolicitacoesCancelamento(ip: string, acao: string): boolean {
  const agora = Date.now();
  const chave = `${acao}:${ip || "0"}`;
  const recentes = (SOLICITACOES_CANCELAMENTO_IP.get(chave) || []).filter((t) => agora - t < 60_000);
  if (recentes.length >= MAX_CANCELAMENTO_POR_MINUTO) {
    SOLICITACOES_CANCELAMENTO_IP.set(chave, recentes);
    return true;
  }
  recentes.push(agora);
  SOLICITACOES_CANCELAMENTO_IP.set(chave, recentes);
  return false;
}

function respostaCancelamentoGenerica(): Bruto {
  return {
    ok: true,
    texto: "Se encontramos um horário futuro com esses dados, enviamos um código pelo WhatsApp. Confira também as mensagens arquivadas.",
  };
}

function segredoDeCancelamento(): string {
  const segredo = String(Deno.env.get("DATABASE_URL") || "").trim();
  if (!segredo) throw new Error("DATABASE_URL faltando para validar cancelamento.");
  return segredo;
}

function instanteInformado(dados: Bruto): string | null {
  return instanteDoAgendamento(String(dados.dia || ""), String(dados.hora || ""));
}

/** Envia um código de uso único apenas ao número já vinculado ao horário. */
export const estabCancelarSolicitar: Handler = async (dados, ctx) => {
  const conta = await contaPorSlug(String(dados.slug || ""));
  if (!conta) return { ok: false, erro: "sem_pagina" };
  if (muitasSolicitacoesCancelamento(ctx.ip, "solicitar")) return respostaCancelamentoGenerica();

  const cliente = normalizarWhatsapp(String(dados.telefone || ""));
  const instante = instanteInformado(dados);
  if (!telefoneValido(cliente) || !instante) return respostaCancelamentoGenerica();
  const conf = await obterConfig();
  if (!conf) return { ok: false, erro: "indisponivel" };

  const codigo = novoCodigoCancelamento();
  const salt = aleatorio(16);
  const codigoHash = await hashCodigoCancelamento(codigo, salt, segredoDeCancelamento());
  const salvo = await consultar1(
    `insert into public.barber_cancelamento_codigo
       (agendamento_id, telefone, cliente_telefone, codigo_hash, salt, expira_em,
        tentativas, solicitacoes, janela_inicio_em, ultima_solicitacao_em, usado_em, atualizado_em)
     select a.id, a.telefone, a.cliente_telefone, $4, $5, now() + interval '10 minutes',
            0, 1, now(), now(), null, now()
       from public.barber_agendamento a
      where a.telefone = $1 and a.cliente_telefone = $2 and a.data_hora = $3
        and a.data_hora > now() and a.status = 'marcado'
      order by a.id
      limit 1
     on conflict (agendamento_id) do update
       set cliente_telefone = excluded.cliente_telefone,
           codigo_hash = excluded.codigo_hash,
           salt = excluded.salt,
           expira_em = excluded.expira_em,
           tentativas = 0,
           solicitacoes = case
             when barber_cancelamento_codigo.janela_inicio_em <= now() - interval '15 minutes' then 1
             else barber_cancelamento_codigo.solicitacoes + 1
           end,
           janela_inicio_em = case
             when barber_cancelamento_codigo.janela_inicio_em <= now() - interval '15 minutes' then now()
             else barber_cancelamento_codigo.janela_inicio_em
           end,
           ultima_solicitacao_em = now(),
           usado_em = null,
           atualizado_em = now()
     where barber_cancelamento_codigo.ultima_solicitacao_em <= now() - interval '60 seconds'
       and (barber_cancelamento_codigo.janela_inicio_em <= now() - interval '15 minutes'
            or barber_cancelamento_codigo.solicitacoes < 3)
     returning agendamento_id`,
    [String(conta.telefone || ""), cliente, instante, codigoHash, salt],
  );
  if (!salvo) return respostaCancelamentoGenerica();

  const envio = await enviarTexto(
    conf,
    cliente,
    `Seu código para cancelar um horário em ${String(conta.nome || "seu salão")} é ${codigo}. Ele expira em 10 minutos. Se você não pediu o cancelamento, ignore esta mensagem.`,
  );
  if (!envio.ok) {
    await consultar(
      `update public.barber_cancelamento_codigo
          set usado_em = now(), atualizado_em = now()
        where agendamento_id = $1 and codigo_hash = $2`,
      [Number(salvo.agendamento_id), codigoHash],
    );
  }
  return respostaCancelamentoGenerica();
};

/** Valida o código uma única vez e cancela somente o horário correspondente ao telefone. */
export const estabCancelarConfirmar: Handler = async (dados, ctx) => {
  const conta = await contaPorSlug(String(dados.slug || ""));
  if (!conta) return { ok: false, erro: "sem_pagina" };
  if (muitasSolicitacoesCancelamento(ctx.ip, "confirmar")) {
    return { ok: false, erro: "devagar" };
  }

  const cliente = normalizarWhatsapp(String(dados.telefone || ""));
  const instante = instanteInformado(dados);
  const codigo = String(dados.codigo || "").trim();
  if (!telefoneValido(cliente) || !instante || !/^\d{6}$/.test(codigo)) {
    return { ok: false, erro: "codigo_ou_agendamento_invalido" };
  }

  const codigoAtivo = await consultar1(
    `select c.salt
       from public.barber_cancelamento_codigo c
       join public.barber_agendamento a on a.id = c.agendamento_id
      where c.telefone = $1 and c.cliente_telefone = $2
        and a.data_hora = $3 and a.data_hora > now() and a.status = 'marcado'
        and c.expira_em > now() and c.usado_em is null and c.tentativas < 5
      order by c.agendamento_id
      limit 1`,
    [String(conta.telefone || ""), cliente, instante],
  );
  if (!codigoAtivo) return { ok: false, erro: "codigo_ou_agendamento_invalido" };
  const codigoHash = await hashCodigoCancelamento(
    codigo,
    String(codigoAtivo.salt || ""),
    segredoDeCancelamento(),
  );
  const cancelado = await consultar1(
    `with alvo as materialized (
       select c.agendamento_id, c.codigo_hash
         from public.barber_cancelamento_codigo c
         join public.barber_agendamento a on a.id = c.agendamento_id
        where c.telefone = $1 and c.cliente_telefone = $2
          and a.data_hora = $3 and a.data_hora > now() and a.status = 'marcado'
          and c.expira_em > now() and c.usado_em is null and c.tentativas < 5
        order by c.agendamento_id
        limit 1
        for update of c
     ),
     tentativa as (
       update public.barber_cancelamento_codigo c
          set tentativas = c.tentativas + 1,
              usado_em = case when c.codigo_hash = $4 then now() else c.usado_em end,
              atualizado_em = now()
         from alvo
        where c.agendamento_id = alvo.agendamento_id
        returning c.agendamento_id, c.codigo_hash = $4 as codigo_correto
     )
     update public.barber_agendamento a
        set status = 'cancelado', atualizado_em = now()
       from tentativa t
      where t.codigo_correto and a.id = t.agendamento_id
        and a.status = 'marcado' and a.data_hora > now()
      returning a.id, a.telefone, a.cliente_nome, a.servico, a.data_hora, a.numero`,
    [String(conta.telefone || ""), cliente, instante, codigoHash],
  );
  if (!cancelado) return { ok: false, erro: "codigo_ou_agendamento_invalido" };

  const conf = await obterConfig();
  let avisadoSalao = false;
  if (conf) {
    const horario = new Date(String(cancelado.data_hora || ""));
    const relogio = emBrasilia(horario);
    const horaLocal = `${String(relogio.hora).padStart(2, "0")}:${String(relogio.minuto).padStart(2, "0")}`;
    const diaLocal = `${String(relogio.dia).padStart(2, "0")}/${String(relogio.mes + 1).padStart(2, "0")}/${relogio.ano}`;
    const texto = `Cancelamento confirmado pelo site:\n${diaLocal} às ${horaLocal}\n` +
      `${String(cancelado.cliente_nome || "Cliente")} — ${String(cancelado.servico || "horário")}\n` +
      `Telefone: ${formatarTelefone(cliente)}`;
    avisadoSalao = (await enviarTexto(conf, String(conta.telefone || ""), texto)).ok;
  }

  return {
    ok: true,
    avisado_salao: avisadoSalao,
    texto: avisadoSalao
      ? "Cancelamento confirmado. A barbearia foi avisada."
      : "Cancelamento confirmado. Avise a barbearia pelo WhatsApp para garantir que ela receba o recado.",
  };
};

/** Aqui é o contrário do painel: quem escreve é o cliente, pelo nome e pelo telefone dele.
 *  A vaga é conferida de novo — a página mostra o que estava livre segundos antes. */
export const estabMarcar: Handler = async (dados, ctx) => {
  const conta = await contaPorSlug(String(dados.slug || ""));
  if (!conta) return { ok: false, erro: "sem_pagina" };
  const telefone = String(conta.telefone || "");
  if (muitasReservas(String(ctx.ip || "0"))) return { ok: false, erro: "devagar" };

  const nome = String(dados.nome || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const cliente = normalizarWhatsapp(String(dados.telefone || ""));
  const dia = String(dados.dia || "");
  const hora = String(dados.hora || "");
  const duracao = Math.max(10, Math.min(600, Math.trunc(Number(dados.duracao || 30)) || 30));
  const funcionario = String(dados.funcionario || "").replace(/\D/g, "");
  const profissionalTexto = String(dados.profissional || "").trim();
  const profissional = profissionalTexto ? Number(profissionalTexto) : 0;
  const servico = String(dados.servico || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (nome.length < 2) return { ok: false, erro: "sem_nome" };
  if (!telefoneValido(cliente)) return { ok: false, erro: "sem_telefone" };
  if (!/^\d{1,2}:\d{2}$/.test(hora)) return { ok: false, erro: "sem_hora" };
  if ((funcionario && profissionalTexto) ||
      (profissionalTexto && (!Number.isSafeInteger(profissional) || profissional < 1))) {
    return { ok: false, erro: "sem_funcionario" };
  }

  const item = await consultar1(
    `select nome, duracao_min from public.barber_servico
      where telefone = $1 and ativo and lower(nome) = lower($2) limit 1`,
    [telefone, servico],
  );
  if (!item) return { ok: false, erro: "sem_servico" };
  let funcionarioId = 0;
  let profissionalNome = "";
  if (funcionario) {
    const e = await consultar1(
      `select id, nome from public.barber_funcionario
        where barbearia = $1 and telefone = $2 and ativo`,
      [telefone, funcionario],
    );
    if (!e) return { ok: false, erro: "sem_funcionario" };
    funcionarioId = Number(e.id || 0);
    profissionalNome = String(e.nome || "");
  } else if (profissional) {
    const e = await consultar1(
      `select id, nome from public.barber_funcionario
        where barbearia = $1 and id = $2 and ativo and na_pagina`,
      [telefone, profissional],
    );
    if (!e) return { ok: false, erro: "sem_funcionario" };
    funcionarioId = Number(e.id || 0);
    profissionalNome = String(e.nome || "");
  }

  const livre = await vagasDoDia(
    telefone, dia, duracao, funcionarioId || funcionario || null,
  );
  if (livre.fechado) return { ok: false, erro: "sem_horario" };
  const marca = /^\d{1,2}:\d{2}$/.test(hora) ? `${hora.padStart(5, "0")}` : "";
  if (!marca || !livre.vagas.includes(marca)) return { ok: false, erro: "ocupado" };

  const d = diaDaGrava(dia);
  if (!d) return { ok: false, erro: "sem_horario" };
  const instante = instanteDeBrasilia(d.base, minutosDaHora(marca));
  const servicoGravado = String(item.nome || servico);
  const criado = await marcarDoSite(telefone, {
    cliente_nome: nome,
    cliente_telefone: cliente,
    servico: servicoGravado,
    data_hora: instante,
    duracao_min: duracao,
    funcionario,
    funcionario_id: funcionarioId || undefined,
  });
  if (!criado) return { ok: false, erro: "banco" };

  await avisarDono(telefone, {
    nome, cliente, servico: servicoGravado, horario: marca, dia: livre.rotulo,
    numero: criado.numero, funcionario, funcionarioId: funcionarioId || undefined,
  });
  return {
    ok: true, numero: criado.numero,
    texto: `Pronto, ${nome.split(" ")[0]}! ${livre.rotulo} às ${marca}` +
      `${profissionalNome ? ` com ${profissionalNome}` : ""} — ${servicoGravado}.`,
  };
};

/** O dono precisa saber na hora: é o mesmo WhatsApp do robô, e o envio respeita o modo teste. */
async function avisarDono(
  telefone: string,
  reserva: {
    nome: string; cliente: string; servico: string; horario: string;
    dia: string; numero: number; funcionario: string; funcionarioId?: number;
  },
): Promise<void> {
  const conf = await obterConfig();
  if (!conf) return;
  const texto = await textoDoAviso(telefone, reserva);
  if (texto) await enviarTexto(conf, telefone, texto).catch(() => {});
}

async function textoDoAviso(
  telefone: string,
  reserva: {
    nome: string; cliente: string; servico: string; horario: string;
    dia: string; numero: number; funcionario: string; funcionarioId?: number;
  },
): Promise<string> {
  const quem = reserva.funcionarioId
    ? await consultar1(`select nome from public.barber_funcionario where barbearia = $1 and id = $2`,
      [telefone, reserva.funcionarioId])
    : reserva.funcionario
    ? await consultar1(`select nome from public.barber_funcionario where barbearia = $1 and telefone = $2`,
      [telefone, reserva.funcionario])
    : null;
  const conta = await consultar1(`select nome from public.barber_contas where telefone = $1`, [telefone]);
  return `${String(conta?.nome || "Seu salão")}: saiu um horário da sua página!\n\n` +
    `  ${reserva.numero} · ${reserva.dia} às ${reserva.horario}\n` +
    `  ${reserva.nome} — ${reserva.servico}\n` +
    `  Telefone: ${formatarTelefone(reserva.cliente)}\n` +
    `${quem && quem.nome ? `  Quem corta: ${String(quem.nome)}\n` : ""}\n` +
    `Se não puder atender, responde AVISA ${reserva.numero}.`;
}
