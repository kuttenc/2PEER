// Quem pediu para não receber mais mensagem. O número entra aqui e sai de toda fila automática
// (Não recuperados, aviso das 6h, renovação e mensagem avulsa) até ele ser desbloqueado na aba
// Bloqueados — é o que protege a instância do WhatsApp de reclamação e bloqueio.
import { consultar, consultar1 } from "./db.ts";
import { formatarTelefone, nomeAproveitavel, normalizarWhatsapp } from "./texto.ts";

export type Bloqueado = {
  telefone: string;
  usuario: string;
  nome: string;
  motivo: string;
  criado_em: string;
};

/** O motivo que a gente escreve quando o próprio cliente diz "não" no WhatsApp. */
export const MOTIVO_NAO = 'o cliente respondeu "não"';

const chave = (telefone: string) => normalizarWhatsapp(telefone);

/** Todos os números bloqueados, de uma vez: a fila inteira consulta o conjunto antes de montar
 *  a lista, em vez de bater no banco mensagem por mensagem. */
export async function telefonesBloqueados(): Promise<Set<string>> {
  const r = await consultar("select telefone from public.clientes_bloqueados");
  return new Set((r.rows as { telefone: string }[]).map((l) => chave(l.telefone)));
}

export async function estaBloqueado(telefone: string): Promise<boolean> {
  const numero = chave(telefone);
  if (numero.length < 10) return false;
  const linha = await consultar1("select 1 as tem from public.clientes_bloqueados where telefone = $1 limit 1", [numero]);
  return Boolean(linha);
}

/** Bloqueia e devolve true quando foi a primeira vez (para não responder "ok, saí da base" duas
 *  vezes para a mesma pessoa). */
export async function bloquear(
  telefone: string,
  usuario = "",
  nome = "",
  motivo = MOTIVO_NAO,
): Promise<boolean> {
  const numero = chave(telefone);
  if (numero.length < 10) return false;
  const r = await consultar(
    `insert into public.clientes_bloqueados (telefone, usuario, nome, motivo)
     values ($1, $2, $3, $4)
     on conflict (telefone) do nothing`,
    [numero, usuario, nomeAproveitavel(nome), motivo],
  );
  return (r.rowCount || 0) > 0;
}

export async function desbloquear(telefone: string): Promise<boolean> {
  const numero = chave(telefone);
  if (numero.length < 10) return false;
  const r = await consultar("delete from public.clientes_bloqueados where telefone = $1", [numero]);
  return (r.rowCount || 0) > 0;
}

/** A lista da aba Bloqueados. A busca é a mesma régua da aba Clientes: o que tem letra procura
 *  como palavra em nome, usuário e motivo; o que é só número procura o telefone, com ponto,
 *  traço ou sem o 55 na frente. */
export async function listarBloqueados(
  termo: string,
): Promise<{ itens: Bloqueado[]; total: number; busca: string }> {
  const bruto = (termo || "").trim();
  const temLetra = /\p{L}/u.test(bruto);
  const alvo = temLetra ? bruto.replace(/[%_]/g, "") : bruto.replace(/\D/g, "");
  const colunas = temLetra
    ? "nome ilike '%' || $1 || '%' or usuario ilike '%' || $1 || '%' or motivo ilike '%' || $1 || '%'"
    : "telefone like '%' || $1 || '%'";
  const filtro = alvo ? `where ${colunas}` : "";
  // Sem busca não há o que ligar, e mandar um parâmetro sobrando derruba a consulta inteira.
  const args = alvo ? [alvo] : [];

  const r = await consultar(
    `select telefone, usuario, nome, motivo,
            to_char(criado_em, 'DD/MM/YYYY "às" HH24:MI') as criado_em
       from public.clientes_bloqueados
       ${filtro}
      order by criado_em desc
      limit 900`,
    args,
  );
  const total = await consultar(`select count(*)::int n from public.clientes_bloqueados ${filtro}`, args);
  return {
    itens: (r.rows as Record<string, unknown>[]).map((l) => ({
      telefone: formatarTelefone(String(l.telefone || "")),
      usuario: String(l.usuario || ""),
      nome: String(l.nome || ""),
      motivo: String(l.motivo || ""),
      criado_em: String(l.criado_em || ""),
    })),
    total: Number((total.rows[0] as Record<string, unknown> | undefined)?.n || 0),
    busca: bruto,
  };
}
