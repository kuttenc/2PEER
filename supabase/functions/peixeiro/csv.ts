// Leitura e escrita do CSV de clientes, igual ao csv.reader/csv.writer do Python:
// ponto e vírgula, CRLF, aspas duplas quando o texto tem o separador.
export const SEPARADOR = ";";
const LINHA_NOVA = "\r\n";

function campo(valor: string): string {
  const texto = String(valor ?? "");
  return /[";\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

export function escreverCsv(linhas: string[][]): string {
  return linhas.map((linha) => linha.map(campo).join(SEPARADOR)).join(LINHA_NOVA) + LINHA_NOVA;
}

/** Aceita ; , ou tab, com aspas, e pula o cabeçalho quando ele existe. */
export function lerCsv(texto: string): string[][] {
  const corpo = String(texto || "").replace(/﻿/g, "").trim();
  if (!corpo) return [];
  const primeira = corpo.split(/\r?\n/)[0];
  // O tab vem primeiro: colar a tabela do painel MC em uma textarea traz o tab, e um nome com
  // vírgula ("Silva, Aderson") não pode fazer a leitura inteira trocar de separador.
  const separador = ["\t", ";", ","].find((c) => primeira.includes(c)) || ";";
  const linhas = dividir(corpo, separador).filter((linha) => linha.length && linha.some((c) => c.trim()));
  const cabecalho = ["usuario", "user", "username"];
  if (linhas.length && cabecalho.includes(normalizar(linhas[0][0] || ""))) linhas.shift();
  return linhas;
}

function dividir(texto: string, separador: string): string[][] {
  const saida: string[][] = [];
  let linha: string[] = [], atual = "", dentro = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentro) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          atual += '"';
          i++;
        } else dentro = false;
      } else atual += c;
      continue;
    }
    if (c === '"') dentro = true;
    else if (c === separador) {
      linha.push(atual);
      atual = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(atual);
      atual = "";
      saida.push(linha);
      linha = [];
    } else atual += c;
  }
  linha.push(atual);
  saida.push(linha);
  return saida;
}

function normalizar(texto: string): string {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}
