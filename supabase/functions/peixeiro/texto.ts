// Datas, textos de dias e telefone: as mesmas regras do automate_mcapi.py, sem fuso surprises.
// Brasília não tem horário de verão desde 2019, então o deslocamento fixo -03:00 bate com o
// ZoneInfo("America/Sao_Paulo") que o site usa hoje.
import { painelBase } from "./encurtador.ts";

const enc = new TextEncoder();

export const BRAZIL_OFFSET_MS = 3 * 3600 * 1000;

export function agoraUtc(): Date {
  return new Date();
}

/** Aceita o que o painel MC devolve (ISO com ou sem Z) e o que o formulário manda.
 *  Data sem fuso é UTC, exatamente como o fromisoformat()+replace(tzinfo=utc) do Python. */
export function parseExpDate(valor: string): Date | null {
  const texto = (valor || "").trim().replace("Z", "+00:00");
  if (!texto) return null;
  const m = texto.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!m) {
    const outro = new Date(texto);
    return isNaN(outro.getTime()) ? null : outro;
  }
  const [, a, mo, d, h = "0", mi = "0", s = "0", fuso] = m;
  const base = Date.UTC(+a, +mo - 1, +d, +h, +mi, +s);
  if (!fuso || fuso === "Z" || fuso === "+00:00") return new Date(base);
  const f = fuso.replace(":", "");
  const sinal = f[0] === "-" ? -1 : 1;
  const desvio = sinal * (+f.slice(1, 3) * 60 + +f.slice(3, 5)) * 60_000;
  return new Date(base - desvio);
}

/** "%d/%m/%Y %H:%M" no horário de Brasília, como o painel sempre mostrou. */
export function formatarBrasilia(data: Date): string {
  const d = new Date(data.getTime() - BRAZIL_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** O que o site mostra em "Expira em": a mesma data, com os segundos. */
export function formatarBrasiliaSegundos(data: Date): string {
  const d = new Date(data.getTime() - BRAZIL_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${formatarBrasilia(data)}:${p(d.getUTCSeconds())}`;
}

export function horaDeBrasilia(data: Date): number {
  return new Date(data.getTime() - BRAZIL_OFFSET_MS).getUTCHours();
}

/** ISO com "+00:00", exatamente como o Python grava em vencimento_avisos/renovacao_avisos. */
export function isoUtc(data: Date): string {
  return data.toISOString().replace(".000Z", "Z").replace("Z", "+00:00");
}

export function textoDiasRestantes(horas: number): string {
  if (horas <= 24) return "menos de 24 horas";
  return `apenas ${Math.max(1, Math.ceil(horas / 24))} dias`;
}

/** 'em 1 mês e 4 dias' para quem ainda tem plano, 'há 1 mês e 4 dias' para quem venceu. */
export function textoVencido(horas: number): string {
  const h = Number(horas || 0);
  const vencido = h <= 0;
  const dias = Math.floor(Math.abs(h) / 24);
  if (dias < 1) return vencido ? "há menos de 24 horas" : "em menos de 24 horas";
  const meses = Math.floor(dias / 30);
  const sobra = dias % 30;
  const partes: string[] = [];
  if (meses) partes.push(`${meses} ${meses === 1 ? "mês" : "meses"}`);
  if (sobra || !meses) partes.push(`${sobra} ${sobra === 1 ? "dia" : "dias"}`);
  const texto = partes.join(" e ");
  return vencido ? `há ${texto}` : `em ${texto}`;
}

export const AVISO_LEGENDA_PADRAO =
  "Ola! Faltam {dias} para o seu plano expirar.\n" +
  "Para renovar agora, copie a chave PIX abaixo (CNPJ):\n{pix}\n" +
  "Caiu no nosso sistema, renovou na hora.";
export const RENOVA_LEGENDA_PADRAO =
  "Olá, Vi que esta sem acesso para renovar só falta efetuar o pix na chave:\n{pix}";
export const RECUPERA_LEGENDA_PADRAO =
  "Olá, vi que {dias} que está sem acesso, Vamos ativa-lo agora mesmo, efetue o pix na chave:\n{pix}\n" +
  "Indique agora mesmo e ganhe desconto dois acessos por um:\n{link}";

const PARTICULAS = ["da", "de", "do", "dos", "das", "du", "e"];

/** Só o primeiro nome, do jeito que se fala com a pessoa. As notas do painel MC são telefone
 *  mascarado ("Simone 129xxxx4466", "129xxxxxx13"), então token com dígito não é nome, e "da"/"de"
 *  no meio do caminho também não. Sem nada aproveitável, sai "amigo(a)" — nunca o código do
 *  usuário no lugar de um nome. */
export function primeiroNome(nome: string): string {
  const partes = String(nome || "").trim().split(/\s+/).filter(Boolean);
  const achada = partes.find((p) => !/\d/.test(p) && p.length >= 2 &&
    !PARTICULAS.includes(semAcento(p).toLowerCase()));
  return achada || "amigo(a)";
}

export type ClienteMensagem = {
  nome?: string;
  usuario?: string;
  telefone?: string;
  status?: number | null;
  expira?: Date | null;
};

/** O que uma mensagem pode usar no lugar de um dado do cliente. Os nomes são os mesmos da aba
 *  Chat, para ele escrever uma vez e valer nos dois lugares. As três maneiras de falar do
 *  vencimento existem porque `{{expira}}` sozinho já enganou: `expira` é a DATA gravada (vale
 *  para quem está no prazo e para quem venceu), `expirou` é o TEMPO QUE PASSOU, e `vence` é a
 *  FRASE INTEIRA, que troca o verbo sozinha — é a única que nunca mente para um vencido. */
export function variaveisMensagem(
  conf: Record<string, unknown>,
  cliente: ClienteMensagem,
  extras: Record<string, string> = {},
  agora: Date = new Date(),
): Record<string, string> {
  const horas = cliente.expira ? (cliente.expira.getTime() - agora.getTime()) / 3_600_000 : null;
  const venceu = horas !== null && horas <= 0;
  const data = cliente.expira ? formatarBrasilia(cliente.expira) : "não está no nosso sistema";
  const telefone = formatarTelefone(cliente.telefone || "");
  return {
    nome: cliente.nome || cliente.usuario || "amigo(a)",
    primeiro: primeiroNome(cliente.nome || ""),
    usuario: cliente.usuario || telefone,
    telefone,
    expira: data,
    expirou: horas === null
      ? "não está no nosso sistema"
      : venceu ? textoVencido(horas) : `ainda não venceu (${textoVencido(horas)})`,
    vence: horas === null ? "não está no nosso sistema" : `${venceu ? "venceu" : "vence"} em ${data}`,
    dias: horas === null ? "sem data de vencimento" : textoVencido(horas),
    status: cliente.status === null || cliente.status === undefined
      ? "sem cadastro"
      : Number(cliente.status) === 1 ? "ativo" : "parado",
    pix: String(conf.aviso_pix_key || "").trim() || "(chave ainda não cadastrada)",
    site: painelBase(),
    data: formatarBrasilia(agora).split(" ")[0],
    hora: formatarBrasilia(agora).split(" ")[1],
    ...extras,
  };
}

/** A aba Chat escreve `{{nome}}` e as mensagens do painel sempre escreveram `{nome}`: aqui os
 *  dois valem. O que não é variável conhecida fica escrito do mesmo jeito no texto, para ele ver
 *  que errou a chave em vez de sair uma mensagem muda. */
export function preencherVariaveis(modelo: string, v: Record<string, string>): string {
  return String(modelo || "").replace(/\{\{?\s*([a-z0-9_]+)\s*\}?\}/gi, (tudo, chave: string) => {
    const valor = v[chave.toLowerCase()];
    return valor === undefined ? tudo : valor;
  });
}

/** O aviso das 6h e a cobrança de renovação conhecem o mesmo cliente que a recuperação. O
 *  `{dias}` continua sendo o texto que o próprio painel MC calcula (é ele que aparece na tela
 *  Avisos), tudo o mais vem da ficha. Sem ficha, só {dias} e {pix} respondem — igual a antes. */
function legendaAgenda(
  modelo: string,
  conf: Record<string, unknown>,
  textoDias: string,
  cliente: ClienteMensagem = {},
  agora: Date = new Date(),
): string {
  return preencherVariaveis(modelo, { ...variaveisMensagem(conf, cliente, {}, agora), dias: textoDias });
}

export function legendaAviso(
  conf: Record<string, unknown>,
  textoDias: string,
  cliente?: ClienteMensagem,
  agora: Date = new Date(),
): string {
  return legendaAgenda(String(conf.aviso_legenda || AVISO_LEGENDA_PADRAO), conf, textoDias, cliente, agora);
}

export function legendaRenovacao(
  conf: Record<string, unknown>,
  textoDias: string,
  cliente?: ClienteMensagem,
  agora: Date = new Date(),
): string {
  return legendaAgenda(String(conf.renova_legenda || RENOVA_LEGENDA_PADRAO), conf, textoDias, cliente, agora);
}

/** A mensagem do "recuperar" (botão da linha e lote) é a única que conhece o cliente inteiro:
 *  ela sai com nome, usuário, telefone, situação e o link curto daquele cliente. */
export function legendaRecuperar(
  conf: Record<string, unknown>,
  cliente: ClienteMensagem,
  link = "",
  agora: Date = new Date(),
): string {
  return preencherVariaveis(
    String(conf.recupera_legenda || RECUPERA_LEGENDA_PADRAO),
    variaveisMensagem(conf, cliente, { link }, agora),
  );
}

/** dd/mm/aa ou dd/mm/aaaa no horário de Brasília, com ou sem hora. O CSV dele e a tabela
 *  colada do painel MC usam as duas larguras de ano, e "15/10/26" sem os dois dígitos
 *  virava lixo no parseExpDate. Os quatro anos vêm antes no alternado de propósito: com
 *  \d{2} primeiro, "2026" casava como "20" e sobrava "26". */
export function parseDataBr(texto: string): Date | null {
  const valor = String(texto || "").trim();
  if (!valor) return null;
  const br = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(valor);
  if (br) {
    const dia = Number(br[1]), mes = Number(br[2]);
    // Sem essa checagem, "32/13/26" rolava sozinha no Date.UTC e virava uma data de 2027.
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    const ano = br[3].length === 2 ? 2000 + Number(br[3]) : Number(br[3]);
    return new Date(Date.UTC(ano, mes - 1, dia, Number(br[4] || 0) - 3, Number(br[5] || 0)));
  }
  return parseExpDate(valor);
}

/** O CPF que vem na coluna "Dados" do painel MC, no formato dados+82071527291. São sempre
 *  onze dígitos, com os zeros da esquerda (00955986427 é um CPF real dele). */
export function cpfDaDados(texto: string): string {
  const m = /(\d{11})/.exec(String(texto || ""));
  return m ? m[1] : "";
}

// ---------------------------------------------------------------- telefone

export function normalizarWhatsapp(bruto: string): string {
  const digitos = (bruto || "").replace(/\D/g, "");
  if (!digitos) return "";
  if ((digitos.length === 10 || digitos.length === 11) && !digitos.startsWith("55")) return "55" + digitos;
  return digitos;
}

/** DDD + 8 ou 9 números, com ou sem o 55 do país. */
export function telefoneValido(digitos: string): boolean {
  const n = (digitos || "").length;
  if (n === 10 || n === 11) return true;
  return (n === 12 || n === 13) && digitos.startsWith("55");
}

export function formatarTelefone(valor: string): string {
  const digitos = normalizarWhatsapp(valor);
  if (!telefoneValido(digitos)) return digitos;
  const local = digitos.length >= 12 && digitos.startsWith("55") ? digitos.slice(2) : digitos;
  const ddd = local.slice(0, 2);
  const resto = local.slice(2);
  const meio = resto.length === 9 ? 5 : 4;
  return `(${ddd}) ${resto.slice(0, meio)}-${resto.slice(meio)}`;
}

// ---------------------------------------------------------------- base64

export function b64ParaBytes(base64: string): Uint8Array {
  const limpo = (base64 || "").split(",").pop()!.trim();
  const bin = atob(limpo);
  const saida = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) saida[i] = bin.charCodeAt(i);
  return saida;
}

export function bytesParaB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function textoUtf8(s: string): Uint8Array<ArrayBuffer> {
  return enc.encode(s);
}

/** O "há X" do rodapé do CSV e das notas, sem acento, como o site grava. */
export function semAcento(texto: string): string {
  return (texto || "").normalize("NFD").replace(/\p{Mn}/gu, "").trim().toLowerCase();
}
