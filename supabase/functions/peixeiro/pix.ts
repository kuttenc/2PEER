// A lista com CPF que ele cola do painel MC na aba Clientes. As colunas são as da tabela dele:
// Nome · Dados · Expira · Status · Telefone · Usuário, separadas por tab, com ou sem o cabeçalho.
// O que interessa do paste é o "dados+82071527291": com esse CPF ele confere no extrato do PIX
// se o crédito saiu da conta do próprio cliente. O Status da tabela dele é uma hora (23:00), não
// um ativo/parado, por isso nada aqui escreve na coluna status.
import { consultar } from "./db.ts";
import { lerCsv } from "./csv.ts";
import { cpfDaDados, normalizarWhatsapp, parseDataBr, semAcento, telefoneValido } from "./texto.ts";

export type LinhaPix = {
  linha: number;
  usuario: string;
  nome: string;
  cpf: string;
  telefone: string;
  expira: Date | null;
};

export type ErroPix = { linha: number; texto: string; motivo: string };

const COLUNAS = "Nome · dados+CPF · Expira · Status · Telefone · Usuário";

function porqueFalha(celulas: string[]): string {
  if (celulas.length < 6) return `faltam colunas (precisa de ${COLUNAS})`;
  if (!String(celulas[5] || "").trim()) return "sem usuário na última coluna";
  if (!cpfDaDados(celulas[1] || "")) return "sem CPF na coluna Dados";
  const telefone = normalizarWhatsapp(celulas[4] || "");
  if (!telefoneValido(telefone)) return `telefone inválido ("${String(celulas[4] || "").trim().slice(0, 24)}")`;
  const expira = String(celulas[2] || "").trim();
  if (expira && !parseDataBr(expira)) return `data inválida ("${expira.slice(0, 24)}")`;
  return "";
}

/** Linha com erro não entra: volta no modal, com o número e o texto, e o resto é gravado. */
export function parsearPix(texto: string): { linhas: LinhaPix[]; erros: ErroPix[] } {
  const brutas = lerCsv(texto);
  if (brutas.length && semAcento(brutas[0][1] || "") === "dados") brutas.shift();
  const linhas: LinhaPix[] = [];
  const erros: ErroPix[] = [];
  brutas.forEach((celulas, i) => {
    const motivo = porqueFalha(celulas);
    if (motivo) {
      erros.push({ linha: i + 1, texto: celulas.join("\t").slice(0, 160), motivo });
      return;
    }
    linhas.push({
      linha: i + 1,
      usuario: String(celulas[5]).trim(),
      nome: String(celulas[0] || "").trim().slice(0, 120),
      cpf: cpfDaDados(celulas[1]),
      telefone: normalizarWhatsapp(celulas[4]),
      expira: parseDataBr(String(celulas[2] || "")),
    });
  });
  return { linhas, erros };
}

/** O mesmo upsert do importador CSV, mas em blocos de 200: uma lista colada pode ter quase mil
 *  linhas e um round-trip por linha estouraria o prazo da chamada. */
export async function gravarPix(linhas: LinhaPix[]): Promise<number> {
  const unicas = new Map<string, LinhaPix>();
  for (const l of linhas) unicas.set(l.usuario, l);
  const todas = [...unicas.values()];
  for (let inicio = 0; inicio < todas.length; inicio += 200) {
    const bloco = todas.slice(inicio, inicio + 200);
    const usuarios = bloco.map((l) => l.usuario);
    const telefones = bloco.map((l) => l.telefone);
    await consultar(
      `insert into public.mc_linhas (username, telefone, exp_date, synced_at)
         select u, t, nullif(e, '')::timestamptz, now()
           from unnest($1::text[], $2::text[], $3::text[]) as x(u, t, e)
       on conflict (username) do update
         set telefone = coalesce(nullif(excluded.telefone, ''), mc_linhas.telefone),
             exp_date = coalesce(excluded.exp_date, mc_linhas.exp_date),
             synced_at = now()`,
      [usuarios, telefones, bloco.map((l) => (l.expira ? l.expira.toISOString() : ""))],
    );
    await consultar(
      `insert into public.cliente_pix (usuario, cpf, nome)
         select u, c, n from unnest($1::text[], $2::text[], $3::text[]) as x(u, c, n)
       on conflict (usuario) do update set cpf = excluded.cpf, nome = excluded.nome, atualizado_em = now()`,
      [usuarios, bloco.map((l) => l.cpf), bloco.map((l) => l.nome)],
    );
    // O telefone vai para a lista de envios do mesmo jeito que no CSV, senão o botão
    // recuperar e o lote continuam cegos para quem só existe aqui.
    await consultar(
      `insert into public.usuarios_criados_ip (client_ip, username, telefone)
         select 'csv', u, t from unnest($1::text[], $2::text[]) as x(u, t)
       on conflict (client_ip, username) do update set telefone = excluded.telefone, updated_at = now()`,
      [usuarios, telefones],
    );
  }
  return todas.length;
}
