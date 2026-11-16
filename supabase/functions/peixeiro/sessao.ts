// A sessão do painel sem Render: o mesmo token "<expira>.<hmac>" de antes, mas entregue no
// corpo da resposta e devolvido no header Authorization (o Pages é outro site, o cookie do
// Render não atravessaria). As tentativas de login moram no banco porque a função não guarda
// nada entre uma chamada e outra.
import { consultar, igual, pbkdf2 } from "./db.ts";
import { textoUtf8 } from "./texto.ts";
import { hashArmazenado } from "./banco.ts";

const DIAS_SESSAO = 30;
const LIMITE_TENTATIVAS = 8;
const JANELA_TENTATIVAS = 600;

let cacheHash: { valor: string; quando: number } = { valor: "", quando: 0 };

async function sha256Hex(texto: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", textoUtf8(texto));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(chave: Uint8Array, mensagem: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", chave as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const assinatura = await crypto.subtle.sign("HMAC", cryptoKey, textoUtf8(mensagem));
  return [...new Uint8Array(assinatura)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function chaveSessao(armazenada: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", textoUtf8("painel-sessao|" + armazenada)));
}

export async function novoToken(armazenada: string): Promise<string> {
  const expira = Math.floor(Date.now() / 1000) + DIAS_SESSAO * 86400;
  return `${expira}.${await hmacHex(await chaveSessao(armazenada), String(expira))}`;
}

export async function tokenValido(token: string, armazenada: string): Promise<boolean> {
  const ponto = token.indexOf(".");
  if (ponto < 0) return false;
  const expira = token.slice(0, ponto);
  const assinatura = token.slice(ponto + 1);
  if (!/^\d+$/.test(expira)) return false;
  const esperada = await hmacHex(await chaveSessao(armazenada), expira);
  return Number(expira) > Date.now() / 1000 && igual(assinatura, esperada);
}

/** O hash da senha fica 60 segundos na memória da instância: cada requisição não precisa ler. */
export async function hashCacheado(forcar = false): Promise<string> {
  const agora = Date.now() / 1000;
  if (!forcar && cacheHash.valor && agora - cacheHash.quando < 60) return cacheHash.valor;
  const valor = await hashArmazenado();
  cacheHash = { valor, quando: agora };
  return valor;
}

/** Depois de trocar a senha a cache velha recusaria o login novo. */
export function esquecerHash(): void {
  cacheHash = { valor: "", quando: 0 };
}

export async function conferida(senha: string, armazenada: string): Promise<boolean> {
  try {
    const partes = armazenada.split("$");
    if (partes.length !== 4) return false;
    const derivada = await pbkdf2(senha, partes[2], Number(partes[1]));
    return igual(derivada, partes[3]);
  } catch {
    return false;
  }
}

export async function muitasTentativas(ip: string): Promise<boolean> {
  const r = await consultar(
    "select count(*)::int AS n from public.painel_tentativas where ip = $1 and quando > now() - ($2 || ' seconds')::interval",
    [ip, String(JANELA_TENTATIVAS)],
  );
  return Number(r.rows[0]?.n || 0) >= LIMITE_TENTATIVAS;
}

export async function registrarTentativa(ip: string): Promise<void> {
  await consultar("insert into public.painel_tentativas (ip) values ($1)", [ip]);
}

export async function zerarTentativas(ip: string): Promise<void> {
  await consultar("delete from public.painel_tentativas where ip = $1", [ip]);
}

/** Chama a função com o token da sessão; devolve "" quando ele expirou ou é falso. */
export async function usuarioAutenticado(authorization: string): Promise<boolean> {
  const token = (authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const armazenada = await hashCacheado();
  if (!armazenada) return false;
  return await tokenValido(token, armazenada);
}

export { DIAS_SESSAO };
