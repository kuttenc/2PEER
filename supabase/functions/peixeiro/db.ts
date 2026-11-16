// Conexão direta com o Postgres do Supabase (o mesmo banco que o site no Render usava).
// O painel inteiro passa por aqui: nenhuma chave de banco vai para o navegador.
import pg from "npm:pg@8.13.1";

const enc = new TextEncoder();

let cliente: pg.Client | null = null;
let esquemaPronto = false;

type Config = {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
};

function lerConexao(): Config {
  const url = (Deno.env.get("DATABASE_URL") || "").trim();
  const m = url.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\/([^?]+)/);
  if (!m) throw new Error("DATABASE_URL faltando ou em formato inesperado");
  return {
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    host: m[3],
    port: Number(m[4]),
    database: m[5],
  };
}

export async function cliente_(): Promise<pg.Client> {
  if (cliente) return cliente;
  const cfg = lerConexao();
  // ssl com rejectUnauthorized falso: o pooler do Supabase atende com cadeia emitida
  // pela Let's Encrypt e o runtime do Deno não traz esse certificado raiz.
  cliente = new pg.Client({ ...cfg, ssl: { rejectUnauthorized: false } });
  await cliente.connect();
  if (!esquemaPronto) {
    await cliente.query(ESQUEMA);
    await semear(cliente);
    esquemaPronto = true;
  }
  return cliente;
}

/** O `pg.QueryResult` vindo do import default do CJS chega como `any` no Deno, e isso
 *  deixava cada `r.rows.map(...)` sem tipo. Um tipo próprio aqui tipa o painel inteiro. */
export type Resultado = { rows: Record<string, unknown>[]; rowCount: number };

export async function consultar(sql: string, params: unknown[] = []): Promise<Resultado> {
  const cli = await cliente_();
  return await cli.query(sql, params as unknown[]);
}

export async function consultar1(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | null> {
  const r = await consultar(sql, params);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------- senha do painel

export async function pbkdf2(senha: string, salt: string, iteracoes: number): Promise<string> {
  const chave = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: iteracoes, hash: "SHA-256" },
    chave,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashSenha(senha: string, salt?: string, iteracoes = 200_000): Promise<string> {
  // O salt guarda o "==" no fim, exatamente como o urlsafe_b64encode do Python: quem confere
  // usa o texto literal, mas manter o desenho igual deixa os dumps das duas fontes comparáveis.
  const s = salt || saltBase64(await crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2_sha256$${iteracoes}$${s}$${await pbkdf2(senha, s, iteracoes)}`;
}

export async function confereSenha(senha: string, armazenada: string): Promise<boolean> {
  try {
    const [, it, salt, hex] = armazenada.split("$");
    const dito = await pbkdf2(senha, salt, Number(it));
    return igual(dito, hex);
  } catch {
    return false;
  }
}

/** Comparação em tempo constante, como o hmac.compare_digest do Python. */
export function igual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let dif = 0;
  for (let i = 0; i < x.length; i++) dif |= x[i] ^ y[i];
  return dif === 0;
}

export function b64url(bytes: Uint8Array): string {
  return saltBase64(bytes).replace(/=+$/, "");
}

/** urlsafe_b64encode do Python, com o "==" no fim. */
function saltBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_");
}

export function aleatorio(hex_bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(hex_bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- DDL idempotente

/** Mesmo desenho do ensure_schema() do Python, com as duas tabelas novas que só o
 *  painel sem Render precisa: tentativas de login e o estado dos lotes. */
const ESQUEMA = `
create table if not exists public.mcapi_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  event_type text not null,
  status_code integer,
  bearer_token text,
  request_payload jsonb,
  response_payload jsonb,
  error_message text
);
alter table public.mcapi_events add column if not exists client_ip text;

create table if not exists public.ip_liberados (
  id bigserial primary key,
  ip text not null unique,
  descricao text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mcapi_token_cache (
  id smallint primary key check (id = 1),
  bearer_token text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mcapi_user_token_cache (
  user_id text primary key,
  bearer_token text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usuarios_criados_ip (
  id bigserial primary key,
  client_ip text not null,
  username text not null,
  telefone text,
  telegram_id text,
  exp_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_ip, username)
);

create table if not exists public.kirvano_webhooks (
  id bigserial primary key,
  webhook_key text not null unique,
  event text not null,
  sale_id text,
  checkout_id text,
  status text,
  customer_name text,
  customer_email text,
  customer_phone text,
  access_username text,
  access_password text,
  access_exp_date timestamptz,
  request_payload jsonb,
  result_payload jsonb,
  processed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mcapi_events_event_ip_created on public.mcapi_events (event_type, client_ip, created_at desc);
create index if not exists idx_usuarios_criados_ip_client_ip on public.usuarios_criados_ip (client_ip, created_at desc);
create index if not exists idx_ip_liberados_ip_ativo on public.ip_liberados (ip, ativo);
create index if not exists idx_mcapi_user_token_cache_updated on public.mcapi_user_token_cache (updated_at desc);
create index if not exists idx_kirvano_webhooks_event_created on public.kirvano_webhooks (event, created_at desc);
create index if not exists idx_kirvano_webhooks_sale_id on public.kirvano_webhooks (sale_id);

create table if not exists public.greenapi_config (
  id smallint primary key check (id = 1),
  api_url text not null default '',
  media_url text not null default '',
  id_instance text not null default '',
  api_token text not null default '',
  instance_name text not null default '',
  owner_phone text not null default '',
  qr_url text not null default '',
  photo_base64 text not null default '',
  photo_name text not null default '',
  caption text not null default '',
  send_photo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.greenapi_config enable row level security;

alter table public.greenapi_config
  add column if not exists aviso_ativo boolean not null default true,
  add column if not exists aviso_dias numeric not null default 2,
  add column if not exists aviso_pix_key text not null default '53453648000180',
  add column if not exists aviso_pix_mascara text not null default '53.453.648/0001-80',
  add column if not exists aviso_titulo text not null default 'ATENCAO: SEU PLANO VAI VENCER',
  add column if not exists aviso_rodape text not null default 'Para renovar, pague pelo PIX:',
  add column if not exists aviso_legenda text not null default
    'Ola! Faltam {dias} para o seu plano expirar.' || E'\n' ||
    'Para renovar agora, copie a chave PIX abaixo (CNPJ):' || E'\n' || '{pix}' || E'\n' ||
    'Caiu no nosso sistema, renovou na hora.',
  add column if not exists aviso_token text not null default '',
  add column if not exists painel_token text not null default '',
  add column if not exists painel_senha_hash text not null default '',
  add column if not exists renova_ativo boolean not null default true,
  add column if not exists renova_dias numeric not null default 3,
  add column if not exists renova_janela_dias numeric not null default 30,
  add column if not exists renova_legenda text not null default
    'Olá, Vi que esta sem acesso para renovar só falta efetuar o pix na chave: ' || E'\n' || '{pix}',
  add column if not exists recupera_legenda text not null default
    'Olá, vi que {dias} que está sem acesso, Vamos ativa-lo agora mesmo, efetue o pix na chave: ' || E'\n' || '{pix}',
  add column if not exists recupera_photo_base64 text not null default '',
  add column if not exists recupera_photo_name text not null default '',
  add column if not exists recupera_send_photo boolean not null default false,
  add column if not exists recupera_destino text not null default '';

create table if not exists public.vencimento_avisos (
  username text not null,
  exp_date text not null,
  telefone text not null default '',
  horas_restantes numeric,
  status_code int,
  id_message text not null default '',
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (username, exp_date)
);
alter table public.vencimento_avisos enable row level security;
create index if not exists idx_vencimento_avisos_created on public.vencimento_avisos (created_at desc);

create table if not exists public.renovacao_avisos (
  username text not null,
  exp_date text not null,
  telefone text not null default '',
  dias_vencido numeric,
  via text not null default 'agenda',
  status_code int,
  id_message text not null default '',
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (username, exp_date)
);
alter table public.renovacao_avisos enable row level security;
create index if not exists idx_renovacao_avisos_updated on public.renovacao_avisos (updated_at desc);

create table if not exists public.mc_linhas (
  username text primary key,
  linha_id text not null default '',
  telefone text not null default '',
  exp_date timestamptz,
  status integer not null default 0,
  notes text not null default '',
  created_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
alter table public.mc_linhas enable row level security;
create index if not exists idx_mc_linhas_exp on public.mc_linhas (exp_date desc);

-- Quem abriu o painel e errou a senha (o limite por IP que antes vivia na memória do Render).
create table if not exists public.painel_tentativas (
  id bigserial primary key,
  ip text not null,
  quando timestamptz not null default now()
);
create index if not exists idx_painel_tentativas_ip_quando on public.painel_tentativas (ip, quando desc);

-- O plano dos lotes (recuperar todos / apagar intervalo) e o progresso: sem processo
-- fixo, é aqui que a conferência sobrevive entre as chamadas.
create table if not exists public.painel_lote (
  chave text primary key,
  tipo text not null,
  plano jsonb not null default '{}'::jsonb,
  estado jsonb not null default '{}'::jsonb,
  aviso text not null default '',
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.painel_lote add column if not exists aviso text not null default '';

-- Para onde um clique em um link de recuperação leva o cliente. Mora aqui, e não no
-- encurtador, justamente para dar de trocar depois: o que o cliente tem no WhatsApp é só o
-- final do link; o endereço é lido na hora do clique, então um link já enviado passa a abrir
-- o endereço novo. Linha com destino vazio segue o padrão (recupera_destino da config).
create table if not exists public.painel_links (
  slug text primary key,
  destino text not null default '',
  usuario text not null default '',
  telefone text not null default '',
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.painel_links enable row level security;
create index if not exists idx_painel_links_atualizado on public.painel_links (atualizado_em desc);
`;

/** Mesma semente do ensure_schema: um banco zerado ganha a linha 1 e a senha do painel. */
async function semear(cli: pg.Client) {
  await cli.query(
    `insert into public.greenapi_config (id, api_url, media_url, id_instance, instance_name, owner_phone)
     values (1, $1, $2, $3, $4, $5)
     on conflict (id) do update
       set api_url = excluded.api_url,
           media_url = excluded.media_url,
           id_instance = excluded.id_instance,
           instance_name = excluded.instance_name,
           owner_phone = excluded.owner_phone
       where public.greenapi_config.api_token = ''`,
    [
      semente("GREENAPI_API_URL"),
      semente("GREENAPI_MEDIA_URL"),
      semente("GREENAPI_ID_INSTANCE"),
      "Instance " + semente("GREENAPI_ID_INSTANCE"),
      semente("GREENAPI_OWNER_PHONE"),
    ],
  );
  await cli.query(`update public.greenapi_config set aviso_token = $1 where id = 1 and aviso_token = ''`, [aleatorio(16)]);
  await cli.query(`update public.greenapi_config set painel_token = $1 where id = 1 and painel_token = ''`, [aleatorio(16)]);

  const [hash, sorteada] = await sementeSenha();
  const aplicada = await cli.query(
    `update public.greenapi_config set painel_senha_hash = $1 where id = 1 and painel_senha_hash = ''`,
    [hash],
  );
  // Sem o rowCount no meio, toda cópia que já tem senha gravada imprimia uma senha
  // sorteada que nunca abriu o painel.
  if (sorteada && Number(aplicada.rowCount || 0) > 0) {
    console.log(`[painel] senha inicial desta copia: ${sorteada}  (troque em Senha)`);
  }
}

function semente(nome: string): string {
  return (Deno.env.get(nome) || "").trim();
}

async function sementeSenha(): Promise<[string, string]> {
  let senha = semente("PAINEL_SENHA_INICIAL");
  const sorteada = senha === "";
  if (!senha) senha = b64url(await crypto.getRandomValues(new Uint8Array(9)));
  const hash = await hashSenha(senha);
  return [hash, sorteada ? senha : ""];
}
