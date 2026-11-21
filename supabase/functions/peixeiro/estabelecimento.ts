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
import { consultar, consultar1 } from "./db.ts";
import { enviarTexto } from "./greenapi.ts";
import { modoTeste } from "./mcapi.ts";
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
export type Horario = { dia: number; abre: string; fecha: string; intervalo: number; primeiro: string };
export type Funcionario = { telefone: string; nome: string; cargo: string; foto: string };
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
  servicos: Servico[];
  produtos: { nome: string; preco: number }[];
  horarios: Horario[];
  pagamentos: string[];
  funcionarios: Funcionario[];
  fotos: { arquivo: string; legenda: string }[];
  atualizado_em: string;
};

const NOMES_DIA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** O horário padrão de um salão que ainda não disse nada: o que a maioria usa. */
const HORARIOS_PADRAO: Horario[] = [1, 2, 3, 4, 5, 6].map((dia) => ({
  dia,
  abre: "09:00",
  fecha: "19:00",
  intervalo: 30,
  primeiro: "09:00",
}));

export async function dadosDaPagina(telefone: string): Promise<DadosPagina | null> {
  const conta = await consultar1(
    `select telefone, nome, slug, endereco, cidade, uf, cep, telefone_publico, mostra_barbeiro,
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
            intervalo, coalesce(to_char(primeiro, 'HH24:MI'), '') as primeiro
       from public.barber_horario where telefone = $1 order by dia`,
    [telefone],
  );
  const pagamentos = await consultar(
    `select nome from public.barber_pagamento where telefone = $1 order by ordem, nome`,
    [telefone],
  );
  const funcionarios = await consultar(
    `select telefone, nome, cargo, foto_arquivo from public.barber_funcionario
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
    servicos: servicos.rows.map((s) => ({
      nome: String(s.nome || ""),
      preco: Number(s.preco || 0),
      duracao_min: Math.max(10, Math.min(600, Number(s.duracao_min || 30))),
      descricao: String(s.descricao || ""),
    })),
    produtos: produtos.rows.map((p) => ({ nome: String(p.nome || ""), preco: Number(p.preco || 0) })),
    horarios: (horarios.rows.length
      ? horarios.rows.map((h) => ({
        dia: Number(h.dia),
        abre: String(h.abre || "09:00"),
        fecha: String(h.fecha || "19:00"),
        intervalo: Math.max(10, Math.min(120, Number(h.intervalo || 30))),
        primeiro: String(h.primeiro || ""),
      }))
      : HORARIOS_PADRAO),
    pagamentos: pagamentos.rows.map((p) => String(p.nome || "")),
    funcionarios: funcionarios.rows.map((f) => ({
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

/** Os horários livres de um dia: o que a agenda do salão ainda aceita, com a duração do
 *  serviço e a reserva de quem vai cortar. É a única conta que importa — e é por isso que a
 *  página pede, ela não inventa vaga. */
export async function vagasDoDia(
  telefone: string,
  diaIso: string,
  duracaoMin: number,
  funcionario: string,
  agora: Date = new Date(),
): Promise<{ vagas: string[]; fechado: boolean; dia: string; rotulo: string }> {
  const dia = diaDaGrava(diaIso);
  if (!dia) return { vagas: [], fechado: true, dia: diaIso, rotulo: "" };
  const horarios = await consultar(
    `select dia, to_char(abre, 'HH24:MI') as abre, to_char(fecha, 'HH24:MI') as fecha,
            intervalo, coalesce(to_char(primeiro, 'HH24:MI'), '') as primeiro
       from public.barber_horario where telefone = $1 and dia = $2`,
    [telefone, dia.semana],
  );
  const rotulo = NOMES_DIA[dia.semana];
  if (!horarios.rows.length) return { vagas: [], fechado: true, dia: diaIso, rotulo };

  const h = horarios.rows[0];
  const abre = minutosDaHora(String(h.abre || "09:00"));
  const fecha = minutosDaHora(String(h.fecha || "19:00"));
  const passo = Math.max(10, Math.min(120, Number(h.intervalo || 30)));
  const primeiro = minutosDaHora(String(h.primeiro || "")) >= 0 ? minutosDaHora(String(h.primeiro || "")) : abre;
  const duracao = Math.max(10, Math.min(600, Math.trunc(Number(duracaoMin) || 30)));

  const ocupado = await consultar(
    `select extract(epoch from data_hora)::bigint as seg, duracao_min
       from public.barber_agendamento
      where telefone = $1 and status = 'marcado'
        and data_hora >= $2 and data_hora < $3
        and ($4 = '' or funcionario_telefone = $4)`,
    [telefone, dia.base.toISOString(), new Date(dia.base.getTime() + 86_400_000).toISOString(),
     funcionario ? normalizarWhatsapp(funcionario) : ""],
  );
  const blocos = ocupado.rows.map((o) => {
    const rel = emBrasilia(new Date(Number(o.seg) * 1000));
    return { desde: rel.hora * 60 + rel.minuto, ate: rel.hora * 60 + rel.minuto + Math.max(10, Number(o.duracao_min || 30)) };
  });

  const agoraRel = emBrasilia(agora);
  const hojeMesmo = agoraRel.ano === emBrasilia(dia.base).ano &&
    agoraRel.mes === emBrasilia(dia.base).mes && agoraRel.dia === emBrasilia(dia.base).dia;
  const agoraMinuto = agoraRel.hora * 60 + agoraRel.minuto;

  const vagas: string[] = [];
  for (let m = primeiro; m + duracao <= fecha; m += passo) {
    if (hojeMesmo && m < agoraMinuto + 30) continue;
    if (blocos.some((b) => m < b.ate && m + duracao > b.desde)) continue;
    vagas.push(horaDeMinutos(m));
  }
  return { vagas, fechado: false, dia: diaIso, rotulo };
}

/** Onde a vaga se encaixa na agenda: é o horário do cliente, não o do robô. */
export async function marcarDoSite(
  telefone: string,
  dados: {
    cliente_nome: string; cliente_telefone: string; servico: string;
    data_hora: Date; duracao_min: number; funcionario?: string;
  },
): Promise<{ id: number; numero: number } | null> {
  const r = await consultar1(
    `insert into public.barber_agendamento
       (telefone, numero, cliente_telefone, cliente_nome, servico, data_hora, duracao_min,
        funcionario_telefone, origem)
     values ($1, coalesce((select max(numero) from public.barber_agendamento where telefone = $1), 0) + 1,
             $2, $3, $4, $5, $6, $7, 'site')
     returning id, numero`,
    [
      telefone,
      normalizarWhatsapp(dados.cliente_telefone),
      String(dados.cliente_nome || "").trim().slice(0, 80),
      String(dados.servico || "").trim().slice(0, 120),
      dados.data_hora.toISOString(),
      Math.max(10, Math.min(600, Math.trunc(Number(dados.duracao_min) || 30))),
      dados.funcionario ? normalizarWhatsapp(dados.funcionario) : "",
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
:root{--fundo:#12100e;--card:#1b1815;--linha:#2c2723;--texto:#f3ece0;--apago:#a89b88;--ouro:#d8b26e;--botao:#c8442f}
*{box-sizing:border-box}
body{margin:0;background:var(--fundo);color:var(--texto);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.cabeca{padding:26px 18px 22px;background:linear-gradient(160deg,#1b1815,#12100e 70%);border-bottom:1px solid var(--linha);text-align:center}
.cabeca h1{margin:0 0 6px;font-size:clamp(23px,6vw,38px);letter-spacing:.5px;text-transform:uppercase;color:var(--ouro)}
.cabeca p{margin:0;color:var(--apago);font-size:14px}
.acoes{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px}
.acoes a{display:inline-block;padding:11px 16px;border-radius:10px;background:var(--card);border:1px solid var(--linha);color:var(--texto);text-decoration:none;font-size:15px}
.acoes a.zap{background:var(--botao);border-color:var(--botao);color:#fff;font-weight:600}
main{max-width:940px;margin:0 auto;padding:0 16px 60px}
section{margin-top:26px;background:var(--card);border:1px solid var(--linha);border-radius:14px;padding:18px}
h2{margin:0 0 14px;font-size:19px;color:var(--ouro);text-transform:uppercase;letter-spacing:1px}
.item{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px dashed var(--linha)}
.item:last-child{border-bottom:0}
.item b{font-weight:600}
.item span{color:var(--apago);font-size:13px;white-space:nowrap}
.mini{color:var(--apago);font-size:13px;margin:6px 0 0}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:7px 12px;border:1px solid var(--linha);border-radius:999px;font-size:14px;background:#151311}
grade{display:grid}
.dias{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.hora{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--linha);font-size:15px}
.hora:last-child{border-bottom:0}
.hora b{color:var(--apago);font-weight:500;text-transform:capitalize}
.opcoes{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.op{padding:10px 13px;border:1px solid var(--linha);border-radius:10px;background:#151311;color:var(--texto);font:inherit;cursor:pointer}
.op.ativo{border-color:var(--ouro);background:#241f18;color:var(--ouro);font-weight:600}
.op:disabled{opacity:.35;cursor:not-allowed}
.pessoa{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--linha);border-radius:12px;background:#151311;cursor:pointer;color:var(--texto);font:inherit}
.pessoa.ativo{border-color:var(--ouro);background:#241f18}
.pessoa img{width:42px;height:42px;border-radius:50%;object-fit:cover;background:#0e0d0c}
.pessoa div{text-align:left}
.pessoa small{display:block;color:var(--apago);font-size:12px;text-transform:capitalize}
.galeria{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.galeria figure{margin:0}
.galeria img{width:100%;height:140px;object-fit:cover;border-radius:10px;display:block;background:#0e0d0c}
.galeria figcaption{font-size:12px;color:var(--apago);margin-top:5px}
.rotulo{display:block;font-size:13px;color:var(--apago);margin:14px 0 6px;text-transform:uppercase;letter-spacing:1px}
input,select{width:100%;padding:12px;border-radius:10px;border:1px solid var(--linha);background:#151311;color:var(--texto);font:inherit}
.gravar{width:100%;margin-top:16px;padding:14px;border:0;border-radius:11px;background:var(--botao);color:#fff;font-size:17px;font-weight:700;cursor:pointer}
.gravar:disabled{opacity:.45;cursor:not-allowed}
.aviso{margin-top:12px;padding:12px;border-radius:10px;font-size:15px;display:none}
.aviso.ok{display:block;background:#162a1c;border:1px solid #2b5539}
.aviso.erro{display:block;background:#2c1512;border:1px solid #55272b}
.pés{margin-top:22px;text-align:center;color:var(--apago);font-size:12px}
.pés a{color:var(--apago)}
@media (max-width:560px){section{padding:15px}.acoes a{flex:1 1 auto;text-align:center}}
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
        escolha.pessoa = f.telefone; escolha.hora = '';
        montarHoras();
      };
      caixaPessoa.appendChild(b);
    });
  }

  var caixaDias = el('dias');
  var escolhido = null;
  function montarDias() {
    limpar(caixaDias); escolhido = null;
    var semVaga = (d.servicos || []).length === 0 ? 30 : (escolha.servico ? escolha.servico.duracao_min : 30);
    dia.forEach(function (iso, i) {
      var partes = iso.split('-');
      var data = new Date(Date.UTC(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2])));
      var n = data.getUTCDay();
      if (!aberto[n]) return;
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
      '&duracao=' + duracao + '&funcionario=' + encodeURIComponent(escolha.pessoa);
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
        duracao: escolha.servico.duracao_min, funcionario: escolha.pessoa, nome: nome, telefone: fone
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
      return `<div class="hora"><b>${NOMES_DIA[n]}</b><span>${h ? `${esc(h.abre)} às ${esc(h.fecha)}` : "fechado"}</span></div>`;
    })
    .join("\n");
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
<title>${esc(d.nome || "Estabelecimento")} — agende seu horário</title>
<meta name="description" content="${esc(`Agende horário em ${d.nome}${endereco ? ` (${endereco})` : ""}.`)}">
<style>${CSS}</style>
</head>
<body>
<header class="cabeca">
  <h1>${esc(d.nome || "Estabelecimento")}</h1>
  <p>${esc(endereco || "Endereço e ponto de referência no WhatsApp")}</p>
  <div class="acoes">
    <a class="zap" href="${esc(zap)}" rel="noopener">Chamar no WhatsApp</a>
    ${endereco ? `<a href="${esc(mapaEndereco(d))}" rel="noopener nofollow">Como chegar</a>` : ""}
  </div>
</header>
<main>
  <section id="agendar">
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

  ${d.servicos.length ? `<section><h2>Serviços</h2>${linhaServico}</section>` : ""}
  ${d.produtos.length ? `<section><h2>Produtos</h2>${linhaProduto}</section>` : ""}
  <section><h2>Horários de atendimento</h2>${linhaHorario}</section>
  <section><h2>Formas de pagamento</h2>${chips(d.pagamentos, "Pergunte no balcão as formas aceitas.")}</section>
  ${d.funcionarios.length ? `<section><h2>Quem atende aqui</h2><div class="opcoes" id="equipe-lista">${d.funcionarios
    .map((f) => `<div class="item"><div>${f.foto ? `<img src="${esc(f.foto)}" alt="${esc(f.nome)}" style="width:38px;height:38px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:9px">` : ""}<b>${esc(f.nome || "barbeiro")}</b></div><span>${esc(f.cargo || "barbeiro")}</span></div>`)
    .join("")}</div></section>` : ""}
  ${galeria ? `<section><h2>Fotos</h2>${galeria}</section>` : ""}

  <p class="pés">${esc(d.nome || "")}${d.atualizado_em ? ` · atualizado em ${esc(d.atualizado_em)}` : ""}</p>
</main>
<script id="dados" type="application/json">${snapshot}</script>
<script>${d.servicos.length ? jsDaPagina(api) : ""}</script>
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
<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#12100e;color:#f3ece0;max-width:720px;margin:0 auto;padding:34px 18px}
h1{color:#d8b26e;text-transform:uppercase;font-size:24px}a{color:#f3ece0}ul{padding-left:20px}li{margin:8px 0}</style>
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
): Promise<{ ok: boolean; url?: string; erro?: string; slug?: string }> {
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
  return { ok: true, url: d.url, slug: d.slug };
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
:root{color-scheme:dark;--bg:#0d1117;--card:#161b22;--line:#30363d;--text:#e6edf3;--muted:#9da7b3;--green:#238636;--gold:#d8b26e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px system-ui;padding:16px}main{max-width:820px;margin:auto}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:12px 0}h1,h2{color:var(--gold)}label{display:block;margin:10px 0 4px;color:var(--muted)}input,select,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:#0d1117;color:var(--text)}button{padding:10px 14px;border:0;border-radius:8px;background:var(--green);color:white;font-weight:700}.linha{display:flex;gap:8px;flex-wrap:wrap}.linha>*{flex:1;min-width:180px}.item{border:1px solid var(--line);border-radius:8px;padding:8px;margin:7px 0}.item img{width:84px;height:84px;object-fit:cover;border-radius:8px}.muted{color:var(--muted)}.erro{color:#ff8e8e}.ok{color:#7ee787}
</style></head><body><main>
<h1>Painel privado — ${nome}</h1><p class="muted">Esta página altera somente este estabelecimento.</p>
<p id="status"></p>
<section class="card"><h2>Dados principais</h2>
<label>Nome</label><input id="nome" maxlength="120">
<label>Telefone público</label><input id="telefone_publico" inputmode="numeric">
<label>Endereço</label><input id="endereco" maxlength="200">
<button id="salvarDados">Salvar dados</button></section>
<section class="card"><h2>Serviços</h2><div id="servicos"></div>
<div class="linha"><input id="novoServico" placeholder="Nome do serviço"><input id="novoPreco" type="number" step="0.01" placeholder="Preço"><input id="novoDuracao" type="number" placeholder="Minutos"></div>
<button id="adicionarServico">Adicionar serviço</button></section>
<section class="card"><h2>Produtos</h2><div id="produtos"></div>
<div class="linha"><input id="novoProduto" placeholder="Nome do produto"><input id="novoProdutoPreco" type="number" step="0.01" placeholder="Preço"></div>
<button id="adicionarProduto">Adicionar produto</button></section>
<section class="card"><h2>Horários</h2><div id="horarios"></div><button id="salvarHorarios">Salvar horários</button></section>
<section class="card"><h2>Pagamento</h2><textarea id="pagamentos" rows="4" placeholder="Dinheiro, PIX, Cartão"></textarea><button id="salvarPagamentos">Salvar formas de pagamento</button></section>
<section class="card"><h2>Fotos</h2><div id="fotos"></div><input id="foto" type="file" accept="image/jpeg,image/png,image/webp"><button id="enviarFoto">Enviar foto</button></section>
</main>
<script>
(function(){const API=${JSON.stringify(api)};const SLUG=${JSON.stringify(d.slug)};const CHAVE=${JSON.stringify(chave)};
async function call(action,data){const r=await fetch(API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,slug:SLUG,chave:CHAVE,...(data||{})})});return r.json()}
function status(t,erro){const el=document.getElementById('status');el.className=erro?'erro':'ok';el.textContent=t||''}
async function ver(){const d=await call('barb_painel_ver');if(!d.ok){status(d.erro||'Acesso inválido',true);return}const c=d.conta||{};document.getElementById('nome').value=c.nome||'';document.getElementById('telefone_publico').value=c.telefone_publico||'';document.getElementById('endereco').value=c.endereco||'';desenhar(d)}
function criar(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function desenhar(d){const serv=document.getElementById('servicos');serv.innerHTML='';(d.servicos||[]).forEach(s=>{const box=criar('div','item linha');const nome=document.createElement('input');nome.value=s.nome||'';const preco=document.createElement('input');preco.type='number';preco.value=s.preco||0;const duracao=document.createElement('input');duracao.type='number';duracao.value=s.duracao_min||30;const editar=criar('button','', 'Salvar');editar.onclick=async()=>{const r=await call('barb_painel_salvar',{acao:'servico_editar',id:s.id,nome:nome.value,preco:preco.value,duracao_min:duracao.value});status(r.ok?'Serviço atualizado':'Não consegui atualizar',!r.ok);if(r.ok)ver()};const apagar=criar('button','', 'Apagar');apagar.onclick=async()=>{if(!confirm('Apagar este serviço?'))return;const r=await call('barb_painel_salvar',{acao:'servico_apagar',id:s.id});status(r.ok?'Serviço apagado':'Não consegui apagar',!r.ok);if(r.ok)ver()};box.append(nome,preco,duracao,editar,apagar);serv.append(box)});const prod=document.getElementById('produtos');prod.innerHTML='';(d.produtos||[]).forEach(p=>{const box=criar('div','item linha');const nome=document.createElement('input');nome.value=p.nome||'';const preco=document.createElement('input');preco.type='number';preco.value=p.preco||0;const editar=criar('button','', 'Salvar');editar.onclick=async()=>{const r=await call('barb_painel_salvar',{acao:'produto_editar',id:p.id,nome:nome.value,preco:preco.value});status(r.ok?'Produto atualizado':'Não consegui atualizar',!r.ok);if(r.ok)ver()};const apagar=criar('button','', 'Apagar');apagar.onclick=async()=>{if(!confirm('Apagar este produto?'))return;const r=await call('barb_painel_salvar',{acao:'produto_apagar',id:p.id});status(r.ok?'Produto apagado':'Não consegui apagar',!r.ok);if(r.ok)ver()};box.append(nome,preco,editar,apagar);prod.append(box)});const h=document.getElementById('horarios');h.innerHTML='';const nomes=['domingo','segunda','terça','quarta','quinta','sexta','sábado'];const por={};(d.horarios||[]).forEach(x=>por[Number(x.dia)]=x);for(let i=0;i<7;i++){const x=por[i]||{};const row=criar('div','item linha');row.append(criar('b','',nomes[i]));const fecha=document.createElement('input');fecha.className='fecha';fecha.dataset.dia=i;fecha.value=x.fecha||'';fecha.placeholder='19:00';row.append(fecha);h.append(row)}document.getElementById('pagamentos').value=(d.pagamentos||[]).map(p=>p.nome).join(', ');const fotos=document.getElementById('fotos');fotos.innerHTML='';(d.fotos||[]).forEach(f=>{const box=criar('div','item linha');if(f.arquivo){const img=document.createElement('img');img.src=${JSON.stringify(baseDoSite())}+'/'+SLUG+'/'+f.arquivo;box.append(img)}const remover=criar('button','', 'Remover');remover.onclick=async()=>{const r=await call('barb_painel_foto_apagar',{id:f.id});status(r.ok?'Foto removida':'Não consegui remover',!r.ok);if(r.ok)ver()};box.append(remover);fotos.append(box)})
}
document.getElementById('salvarDados').onclick=async()=>{const r=await call('barb_painel_salvar',{nome:document.getElementById('nome').value,telefone_publico:document.getElementById('telefone_publico').value,endereco:document.getElementById('endereco').value});status(r.ok?'Dados salvos':'Não consegui salvar',!r.ok);if(r.ok)ver()}
document.getElementById('adicionarServico').onclick=async()=>{const nome=document.getElementById('novoServico').value.trim(),preco=Number(document.getElementById('novoPreco').value||0),duracao=Number(document.getElementById('novoDuracao').value||30);if(!nome)return status('Escreva o nome do serviço',true);const r=await call('barb_painel_salvar',{acao:'servico',nome,preco,duracao_min:duracao});status(r.ok?'Serviço salvo':'Não consegui salvar',!r.ok);if(r.ok)ver()}
document.getElementById('adicionarProduto').onclick=async()=>{const nome=document.getElementById('novoProduto').value.trim(),preco=Number(document.getElementById('novoProdutoPreco').value||0);if(!nome)return status('Escreva o nome do produto',true);const r=await call('barb_painel_salvar',{acao:'produto',nome,preco});status(r.ok?'Produto salvo':'Não consegui salvar',!r.ok);if(r.ok)ver()}
document.getElementById('salvarHorarios').onclick=async()=>{const horarios=[];document.querySelectorAll('#horarios .item').forEach(row=>{const abre=row.querySelector('.abre'),fecha=row.querySelector('.fecha');if(abre&&fecha&&abre.value&&fecha.value)horarios.push({dia:Number(abre.dataset.dia),abre:abre.value,fecha:fecha.value})});const r=await call('barb_painel_salvar',{horarios});status(r.ok?'Horários salvos':'Não consegui salvar',!r.ok);if(r.ok)ver()}
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
  if (funcionario) {
    const e = await consultar1(
      `select telefone from public.barber_funcionario where barbearia = $1 and telefone = $2 and ativo`,
      [telefone, funcionario],
    );
    if (!e) return { ok: false, erro: "sem_funcionario" };
  }
  const r = await vagasDoDia(telefone, String(dados.dia || ""), duracao, funcionario);
  return { ok: true, ...r };
};

const REGISTROS_IP = new Map<string, number[]>();
const MAX_POR_MINUTO = 8;

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
  const servico = String(dados.servico || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (nome.length < 2) return { ok: false, erro: "sem_nome" };
  if (!telefoneValido(cliente)) return { ok: false, erro: "sem_telefone" };
  if (!/^\d{1,2}:\d{2}$/.test(hora)) return { ok: false, erro: "sem_hora" };

  const item = await consultar1(
    `select nome, duracao_min from public.barber_servico
      where telefone = $1 and ativo and lower(nome) = lower($2) limit 1`,
    [telefone, servico],
  );
  if (!item) return { ok: false, erro: "sem_servico" };
  if (funcionario) {
    const e = await consultar1(
      `select telefone from public.barber_funcionario where barbearia = $1 and telefone = $2 and ativo`,
      [telefone, funcionario],
    );
    if (!e) return { ok: false, erro: "sem_funcionario" };
  }

  const livre = await vagasDoDia(telefone, dia, duracao, funcionario);
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
  });
  if (!criado) return { ok: false, erro: "banco" };

  await avisarDono(telefone, {
    nome, cliente, servico: servicoGravado, horario: marca, dia: livre.rotulo,
    numero: criado.numero, funcionario,
  });
  return {
    ok: true, numero: criado.numero,
    texto: `Pronto, ${nome.split(" ")[0]}! ${livre.rotulo} às ${marca} — ${servicoGravado}.`,
  };
};

/** O dono precisa saber na hora: é o mesmo WhatsApp do robô, e o envio respeita o modo teste. */
async function avisarDono(
  telefone: string,
  reserva: {
    nome: string; cliente: string; servico: string; horario: string;
    dia: string; numero: number; funcionario: string;
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
    dia: string; numero: number; funcionario: string;
  },
): Promise<string> {
  const quem = reserva.funcionario
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
