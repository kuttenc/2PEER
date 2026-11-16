// O destino dos links de recuperação fica no banco, não no encurtador. Um link criado ontem
// abre hoje o endereço que você editar na aba Links, porque a página de redirecionamento lê
// isto aqui no momento do clique.
import { consultar, consultar1 } from "./db.ts";
import { painelBase } from "./encurtador.ts";

export type LinkItem = {
  slug: string;
  usuario: string;
  telefone: string;
  destino: string;
  atualizado_em: string;
};

/** O endereço usado por todo link que não tem destino próprio. */
export async function destinoPadrao(): Promise<string> {
  const linha = await consultar1(`select recupera_destino from public.greenapi_config where id = 1`);
  return String(linha?.recupera_destino || "").trim();
}

export async function salvarPadrao(destino: string): Promise<boolean> {
  const r = await consultar(
    `update public.greenapi_config set recupera_destino = $1, updated_at = now() where id = 1`,
    [destino],
  );
  return (r.rowCount || 0) > 0;
}

/** A linha nasce no envio do recuperar. Nunca toca no destino: o que ele editou na aba Links
 *  continua valendo depois de um novo disparo para o mesmo cliente. */
export async function registrarLink(slug: string, usuario: string, telefone: string): Promise<void> {
  await consultar(
    `insert into public.painel_links (slug, usuario, telefone)
     values ($1, $2, $3)
     on conflict (slug) do update
       set usuario = excluded.usuario, telefone = excluded.telefone, atualizado_em = now()`,
    [slug, usuario, telefone],
  );
}

/** O destino gravado para este link, sem cair no padrão: é o que a tela mostra no campo. */
export async function listarLinks(): Promise<LinkItem[]> {
  const r = await consultar(
    `select slug, usuario, telefone, destino,
            to_char(atualizado_em, 'DD/MM/YYYY "às" HH24:MI') as atualizado_em
       from public.painel_links
      order by atualizado_em desc
      limit 200`,
  );
  return r.rows.map((l) => ({
    slug: String(l.slug || ""),
    usuario: String(l.usuario || ""),
    telefone: String(l.telefone || ""),
    destino: String(l.destino || ""),
    atualizado_em: String(l.atualizado_em || ""),
  }));
}

/** Vazio = volta a seguir o padrão. */
export async function salvarDestino(slug: string, destino: string): Promise<boolean> {
  const r = await consultar(
    `insert into public.painel_links (slug, destino)
     values ($1, $2)
     on conflict (slug) do update set destino = excluded.destino, atualizado_em = now()`,
    [slug, destino],
  );
  return (r.rowCount || 0) > 0;
}

/** Para onde o clique vai agora: o destino do link, senão o padrão, senão nada (quem chama
 *  decide o último recurso). É a única consulta que um visitante anônimo consegue fazer. */
export async function destinoNoClique(slug: string): Promise<string> {
  const linha = await consultar1(`select destino from public.painel_links where slug = $1`, [slug]);
  const proprio = String(linha?.destino || "").trim();
  return proprio || (await destinoPadrao());
}

/** O destino já com o número do cliente no endereço. Quem escreve o destino na aba Links pode
 *  ter posto query ou âncora, então o par vai antes da âncora e sem duplicar o que já tinha. */
export function destinoComTelefone(destino: string, digitos: string): string {
  if (!digitos || digitos.length < 10) return destino;
  try {
    const u = new URL(destino, painelBase());
    u.searchParams.set("telefone", digitos);
    return u.href;
  } catch {
    return destino;
  }
}

/** O WhatsApp daquele link, em dígitos, para ir junto no endereço: o cliente que veio pelo link
 *  do WhatsApp já chega com o número dele no site e não precisa (nem pode) digitar outro.
 *  Primeiro o que foi gravado no envio; se o link é mais velho que a tabela, o número ainda
 *  está dentro do base64 que ele mesmo carrega. */
export async function telefoneNoClique(slug: string, bruto = ""): Promise<string> {
  const linha = await consultar1(`select telefone from public.painel_links where slug = $1`, [slug]);
  const gravado = String(linha?.telefone || "").replace(/\D/g, "");
  if (gravado.length >= 10) return gravado;
  const payload = String(bruto || "").trim();
  if (!/^[a-z0-9_-]{4,96}$/i.test(payload)) return "";
  try {
    const decodificado = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    if (decodificado.indexOf("|") < 0) return "";
    return (decodificado.split("|")[1] || "").replace(/\D/g, "");
  } catch {
    return "";
  }
}
