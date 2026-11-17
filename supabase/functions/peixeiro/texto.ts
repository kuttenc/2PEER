// Datas, textos de dias e telefone: as mesmas regras do automate_mcapi.py, sem fuso surprises.
// Brasília não tem horário de verão desde 2019, então o deslocamento fixo -03:00 bate com o
// ZoneInfo("America/Sao_Paulo") que o site usa hoje.

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

/** Troca {dias}, {pix} e {link} sem quebrar se o texto tiver outra chave entre chaves. */
function preencher(
  modelo: string,
  conf: Record<string, unknown>,
  textoDias: string,
  extras: Record<string, string> = {},
): string {
  const dados: Record<string, string> = {
    dias: textoDias,
    pix: String(conf.aviso_pix_key || ""),
    ...extras,
  };
  let saida = modelo;
  for (const [chave, valor] of Object.entries(dados)) {
    saida = saida.replaceAll(`{${chave}}`, valor);
  }
  return saida;
}

export function legendaAviso(conf: Record<string, unknown>, textoDias: string): string {
  return preencher(String(conf.aviso_legenda || AVISO_LEGENDA_PADRAO), conf, textoDias);
}

export function legendaRenovacao(conf: Record<string, unknown>, textoDias: string): string {
  return preencher(String(conf.renova_legenda || RENOVA_LEGENDA_PADRAO), conf, textoDias);
}

export function legendaRecuperar(conf: Record<string, unknown>, textoDias: string, link = ""): string {
  return preencher(String(conf.recupera_legenda || RECUPERA_LEGENDA_PADRAO), conf, textoDias, { link });
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
