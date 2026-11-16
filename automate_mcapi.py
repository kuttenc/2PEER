import base64
import hashlib
import hmac
import json
import math
import os
import random
import re
import secrets
import socket
import string
import threading
import unicodedata
from io import BytesIO
from urllib.parse import parse_qsl, unquote, urlparse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import psycopg2
import requests
from dotenv import load_dotenv
from psycopg2.extras import Json
from PIL import Image, ImageDraw, ImageFont


LOGIN_URL = "https://mcapi.knewcms.com:2087/auth/login"
TEST_URL = "https://mcapi.knewcms.com:2087/lines/test"
LINES_URL = "https://mcapi.knewcms.com:2087/lines"
RESALE_MOVIE_URL = "https://mcapi.knewcms.com:2087/streams/resale/movie"
RESALE_CANAL_URL = "https://mcapi.knewcms.com:2087/streams/resale/canal"
RESALE_FINDALL_URL = "https://mcapi.knewcms.com:2087/streams/resale/findAll"
REPORT_CONTENT_RESALE_URL = "https://mcapi.knewcms.com:2087/report-content/resale/create"
TMDB_SEARCH_MOVIE_URL = "https://api.themoviedb.org/3/search/movie"
TMDB_SEARCH_TV_URL = "https://api.themoviedb.org/3/search/tv"
TMDB_DEFAULT_BEARER_TOKEN = ""
TMDB_DEFAULT_API_KEY = ""
BRAZIL_TZ = ZoneInfo("America/Sao_Paulo")
DEFAULT_SUPABASE_REGION = "sa-east-1"
TOKEN_LOCK_KEY = 92745131
KIRVANO_ACCESS_EVENTS = {"SALE_APPROVED", "SUBSCRIPTION_RENEWED"}
KIRVANO_APPROVED_STATUSES = {"APPROVED", "PAID", "COMPLETED"}
MEMORY_TOKEN_LOCK = threading.Lock()
MEMORY_TOKEN_CACHE = {"token": None, "expires_at": None}
MEMORY_WEBHOOK_LOCK = threading.Lock()
MEMORY_WEBHOOK_RESULTS = {}

LOGIN_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "origin": "https://wwpanel.link",
    "referer": "https://wwpanel.link/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
}

TEST_HEADERS_BASE = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "origin": "https://wwpanel.link",
    "referer": "https://wwpanel.link/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
}

STREAM_HEADERS_BASE = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
    "origin": "https://wwpanel.link",
    "referer": "https://wwpanel.link/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
}


def rand_suffix(n=8):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def only_digits(value: str) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def mask_phone_for_note(phone: str) -> str:
    digits = only_digits(phone)
    if len(digits) >= 11:
        base = digits[-11:]
        ddd = base[:2]
        first_mobile = base[2]
        last4 = base[-4:]
        return f"{ddd}{first_mobile}xxxx-{last4}"

    if len(digits) >= 4:
        ddd = (digits[:2] if len(digits) >= 2 else "xx")
        first_mobile = digits[2] if len(digits) >= 3 else "9"
        last4 = digits[-4:]
        return f"{ddd}{first_mobile}xxxx-{last4}"

    return "xx9xxxx-xxxx"


def mask_telegram_for_note(telegram_id: str) -> str:
    digits = only_digits(telegram_id)
    if not digits:
        return ""
    return f"tg:xxxx{digits[-4:].rjust(4, 'x')}"


def build_lead_note(phone: str, telegram_id: str) -> str:
    phone_mask = mask_phone_for_note(phone)
    tg_mask = mask_telegram_for_note(telegram_id)
    if tg_mask:
        return f"cap:{phone_mask} | {tg_mask}"
    return f"cap:{phone_mask}"


def get_supabase_project_info(access_token: str, project_name: str) -> dict:
    resp = requests.get(
        "https://api.supabase.com/v1/projects",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    resp.raise_for_status()
    projects = resp.json()
    for project in projects:
        if project.get("name") == project_name:
            return {
                "ref": project.get("id") or project.get("ref"),
                "region": project.get("region") or "",
            }
    names = [project.get("name") for project in projects]
    raise RuntimeError(f"Projeto '{project_name}' nao encontrado. Disponiveis: {names}")


def get_supabase_ref(access_token: str, project_name: str) -> str:
    return get_supabase_project_info(access_token, project_name)["ref"]


def connect_with_ipv4_fallback(conn_kwargs: dict):
    host = conn_kwargs.get("host")
    port = int(conn_kwargs.get("port", 5432))
    ipv4_kwargs = dict(conn_kwargs)
    try:
        info = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
        if info:
            ipv4 = info[0][4][0]
            if ipv4:
                ipv4_kwargs["hostaddr"] = ipv4
    except Exception:
        pass

    try:
        return psycopg2.connect(**ipv4_kwargs)
    except psycopg2.OperationalError:
        return psycopg2.connect(**conn_kwargs)


def db_url_to_conn_kwargs(database_url: str) -> dict:
    parsed = urlparse(database_url)
    if not parsed.scheme or not parsed.hostname:
        raise RuntimeError("DATABASE_URL/SUPABASE_DB_URL invalida.")

    query = dict(parse_qsl(parsed.query))
    kwargs = {
        "host": parsed.hostname,
        "port": parsed.port or int(query.pop("port", 5432)),
        "dbname": unquote(parsed.path.lstrip("/") or "postgres"),
        "user": unquote(parsed.username or "postgres"),
        "password": unquote(parsed.password or ""),
        "sslmode": query.pop("sslmode", os.getenv("SUPABASE_DB_SSLMODE", "require")),
    }
    kwargs.update(query)
    return kwargs


def connect_db(
    db_password: str,
    project_ref: str,
    project_region: str = "",
    pooler_host_override: str = "",
    pooler_port_override: str = "",
    database_url: str = "",
    db_host_override: str = "",
    db_port_override: str = "",
    db_name_override: str = "",
    db_user_override: str = "",
    db_sslmode: str = "require",
):
    if database_url:
        return connect_with_ipv4_fallback(db_url_to_conn_kwargs(database_url))

    last_exc = None

    if db_host_override:
        host_user = db_user_override or ("postgres" if db_host_override.startswith("db.") else f"postgres.{project_ref}")
        host_kwargs = {
            "host": db_host_override,
            "port": int(db_port_override or 5432),
            "dbname": db_name_override or "postgres",
            "user": host_user,
            "password": db_password,
            "sslmode": db_sslmode or "require",
        }
        try:
            return connect_with_ipv4_fallback(host_kwargs)
        except psycopg2.OperationalError as host_exc:
            last_exc = host_exc
    else:
        if not project_ref:
            raise RuntimeError(
                "Informe SUPABASE_PROJECT_REF, SUPABASE_DB_HOST ou DATABASE_URL/SUPABASE_DB_URL para conectar ao banco."
            )

        direct_host = f"db.{project_ref}.supabase.co"
        direct_kwargs = {
            "host": direct_host,
            "port": 5432,
            "dbname": "postgres",
            "user": "postgres",
            "password": db_password,
            "sslmode": "require",
        }

        try:
            return connect_with_ipv4_fallback(direct_kwargs)
        except psycopg2.OperationalError as direct_exc:
            last_exc = direct_exc

    # db.<ref>.supabase.co is IPv6-only now and Render free has no IPv6 egress,
    # so the Supavisor poolers (IPv4) are always worth a try before failing.
    if not project_ref:
        raise last_exc

    region = project_region or DEFAULT_SUPABASE_REGION
    if pooler_host_override:
        pooler_hosts = [pooler_host_override]
    else:
        pooler_hosts = [
            f"aws-1-{region}.pooler.supabase.com",
            f"aws-0-{region}.pooler.supabase.com",
        ]
    pooler_ports = []
    if pooler_port_override:
        try:
            pooler_ports.append(int(pooler_port_override))
        except ValueError:
            pass
    if not pooler_ports:
        pooler_ports = [6543, 5432]

    for pooler_host in pooler_hosts:
        for pooler_port in pooler_ports:
            pooler_kwargs = {
                "host": pooler_host,
                "port": pooler_port,
                "dbname": "postgres",
                "user": f"postgres.{project_ref}",
                "password": db_password,
                "sslmode": "require",
            }
            try:
                return connect_with_ipv4_fallback(pooler_kwargs)
            except psycopg2.OperationalError as pooler_exc:
                last_exc = pooler_exc

    raise last_exc


def _semente(variavel: str) -> str:
    """Valor inicial de uma coluna do banco, lido do ambiente (este repositorio e publico)."""
    return (os.getenv(variavel) or "").strip()


def _semente_senha():
    """Hash da senha que abre o painel numa banco zerado.

    Vem de PAINEL_SENHA_INICIAL; sem ela sorteia uma e imprime no log para ele copiar do
    Render na primeira abertura.
    """
    senha = _semente("PAINEL_SENHA_INICIAL")
    sorteada = not senha
    senha = senha or secrets.token_urlsafe(9)
    salt = base64.urlsafe_b64encode(os.urandom(16)).decode("ascii")
    derivada = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), salt.encode("utf-8"), 200_000, dklen=32)
    return "pbkdf2_sha256$200000$%s$%s" % (salt, derivada.hex()), (senha if sorteada else "")


def ensure_schema(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
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
            """
        )
        cur.execute("alter table public.mcapi_events add column if not exists client_ip text;")
        cur.execute(
            """
            create table if not exists public.ip_liberados (
              id bigserial primary key,
              ip text not null unique,
              descricao text,
              ativo boolean not null default true,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            """
        )
        cur.execute(
            """
            create table if not exists public.mcapi_token_cache (
              id smallint primary key check (id = 1),
              bearer_token text not null,
              expires_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            """
        )
        cur.execute(
            """
            create table if not exists public.mcapi_user_token_cache (
              user_id text primary key,
              bearer_token text not null,
              expires_at timestamptz,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );
            """
        )
        cur.execute(
            """
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
            """
        )
        cur.execute(
            """
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
            """
        )
        cur.execute(
            "create index if not exists idx_mcapi_events_event_ip_created on public.mcapi_events (event_type, client_ip, created_at desc);"
        )
        cur.execute(
            "create index if not exists idx_usuarios_criados_ip_client_ip on public.usuarios_criados_ip (client_ip, created_at desc);"
        )
        cur.execute(
            "create index if not exists idx_ip_liberados_ip_ativo on public.ip_liberados (ip, ativo);"
        )
        cur.execute(
            "create index if not exists idx_mcapi_user_token_cache_updated on public.mcapi_user_token_cache (updated_at desc);"
        )
        cur.execute(
            "create index if not exists idx_kirvano_webhooks_event_created on public.kirvano_webhooks (event, created_at desc);"
        )
        cur.execute(
            "create index if not exists idx_kirvano_webhooks_sale_id on public.kirvano_webhooks (sale_id);"
        )
        cur.execute(
            """
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
            """
        )
        cur.execute("alter table public.greenapi_config enable row level security;")
        cur.execute(
            """
            insert into public.greenapi_config (id, api_url, media_url, id_instance, instance_name, owner_phone)
            values (1, %s, %s, %s, %s, %s)
            on conflict (id) do update
              set api_url = excluded.api_url,
                  media_url = excluded.media_url,
                  id_instance = excluded.id_instance,
                  instance_name = excluded.instance_name,
                  owner_phone = excluded.owner_phone
              where public.greenapi_config.api_token = '';
            """,
            (
                _semente("GREENAPI_API_URL"),
                _semente("GREENAPI_MEDIA_URL"),
                _semente("GREENAPI_ID_INSTANCE"),
                "Instance " + _semente("GREENAPI_ID_INSTANCE"),
                _semente("GREENAPI_OWNER_PHONE"),
            ),
        )
        cur.execute(
            """
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
                'Olá, vi que {dias} que está sem acesso, Vamos ativa-lo agora mesmo, efetue o pix na chave: ' || E'\n' || '{pix}';
            """
        )
        cur.execute(
            """
            update public.greenapi_config
               set aviso_token = %s
             where id = 1 and aviso_token = '';
            """,
            (secrets.token_hex(16),),
        )
        cur.execute(
            """
            update public.greenapi_config
               set painel_token = %s
             where id = 1 and painel_token = '';
            """,
            (secrets.token_hex(16),),
        )
        senha_hash, senha_nova = _semente_senha()
        cur.execute(
            """
            update public.greenapi_config
               set painel_senha_hash = %s
             where id = 1 and painel_senha_hash = '';
            """,
            (senha_hash,),
        )
        if senha_nova:
            print("[painel] senha inicial desta copia: %s  (troque em /painel/senha)" % senha_nova)
        cur.execute(
            """
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
            create index if not exists idx_vencimento_avisos_created
              on public.vencimento_avisos (created_at desc);
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
            create index if not exists idx_renovacao_avisos_updated
              on public.renovacao_avisos (updated_at desc);
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
            alter table public.greenapi_config
              add column if not exists recupera_photo_base64 text not null default '',
              add column if not exists recupera_photo_name text not null default '',
              add column if not exists recupera_send_photo boolean not null default false;
            """
        )
    conn.commit()


def normalize_whatsapp(raw_phone: str) -> str:
    digits = "".join(ch for ch in (raw_phone or "") if ch.isdigit())
    if not digits:
        return ""
    if len(digits) in (10, 11) and not digits.startswith("55"):
        return f"55{digits}"
    return digits


def telefone_valido(digitos: str) -> bool:
    """DDD + 8 ou 9 números, com ou sem o 55 do país."""
    n = len(digitos or "")
    if n in (10, 11):
        return True
    return n in (12, 13) and digitos.startswith("55")


def formatar_telefone(valor: str) -> str:
    """Só para a tela mostrar bonitinho: (11) 98934-6164. Guardamos os dígitos puros."""
    digitos = normalize_whatsapp(valor)
    if not telefone_valido(digitos):
        return digitos
    local = digitos[2:] if len(digitos) in (12, 13) and digitos.startswith("55") else digitos
    ddd, resto = local[:2], local[2:]
    meio = 5 if len(resto) == 9 else 4
    return f"({ddd}) {resto[:meio]}-{resto[meio:]}"


def salvar_telefone(conn, username: str, telefone: str) -> dict:
    """Troca o telefone do cliente em todos os sítios que o site usa para enviar."""
    digitos = normalize_whatsapp(telefone)
    nome = (username or "").strip()
    if not nome:
        return {"ok": False, "error": "sem_destino"}
    if not telefone_valido(digitos):
        return {"ok": False, "error": "telefone_invalido", "digitos": digitos}
    with conn.cursor() as cur:
        cur.execute(
            "update public.usuarios_criados_ip set telefone = %s, updated_at = now() where username = %s",
            (digitos, nome),
        )
        alteradas = cur.rowcount or 0
        if not alteradas:
            cur.execute(
                """
                insert into public.usuarios_criados_ip (client_ip, username, telefone, updated_at)
                values ('painel', %s, %s, now())
                on conflict (client_ip, username)
                  do update set telefone = excluded.telefone, updated_at = now()
                """,
                (nome, digitos),
            )
        cur.execute(
            """
            insert into public.mc_linhas (username, telefone, synced_at)
            values (%s, %s, now())
            on conflict (username) do update
              set telefone = excluded.telefone, synced_at = now()
            """,
            (nome, digitos),
        )
        espelho = cur.rowcount or 0
    conn.commit()
    return {"ok": True, "username": nome, "telefone": digitos, "linhas": alteradas, "espelho": espelho}


def mesclar_telefones(conn, origem: str, destino: str) -> dict:
    """Copia o telefone de um usuário para o outro; nada é apagado e vale para os parados."""
    de_nome = (origem or "").strip()
    para_nome = (destino or "").strip()
    if not de_nome or not para_nome:
        return {"ok": False, "error": "sem_destino"}
    if de_nome == para_nome:
        return {"ok": False, "error": "mesmo_usuario"}
    numero = telefones_por_usuario(conn).get(de_nome, "")
    if not numero:
        return {"ok": False, "error": "origem_sem_telefone", "origem": de_nome}
    resultado = salvar_telefone(conn, para_nome, numero)
    if not resultado.get("ok"):
        return resultado
    return {
        "ok": True,
        "origem": de_nome,
        "destino": para_nome,
        "telefone": numero,
        "linhas": resultado["linhas"],
        "espelho": resultado["espelho"],
    }


def get_greenapi_config(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            """
            select api_url, media_url, id_instance, api_token, instance_name,
                   owner_phone, qr_url, photo_base64, photo_name, caption, send_photo,
                   aviso_ativo, aviso_dias, aviso_pix_key, aviso_pix_mascara,
                   aviso_titulo, aviso_rodape, aviso_legenda, aviso_token, painel_token,
                   renova_ativo, renova_dias, renova_janela_dias, renova_legenda,
                   recupera_legenda, updated_at,
                   recupera_photo_base64, recupera_photo_name, recupera_send_photo
            from public.greenapi_config
            where id = 1
            """
        )
        row = cur.fetchone()
    if not row:
        return {}
    return {
        "api_url": row[0],
        "media_url": row[1],
        "id_instance": row[2],
        "api_token": row[3],
        "instance_name": row[4],
        "owner_phone": row[5],
        "qr_url": row[6],
        "photo_base64": row[7],
        "photo_name": row[8],
        "caption": row[9],
        "send_photo": row[10],
        "aviso_ativo": row[11],
        "aviso_dias": float(row[12] or 2),
        "aviso_pix_key": row[13],
        "aviso_pix_mascara": row[14],
        "aviso_titulo": row[15],
        "aviso_rodape": row[16],
        "aviso_legenda": row[17],
        "aviso_token": row[18],
        "painel_token": row[19],
        "renova_ativo": row[20],
        "renova_dias": float(row[21] or 3),
        "renova_janela_dias": float(row[22] or 30),
        "renova_legenda": row[23],
        "recupera_legenda": row[24],
        "updated_at": row[25].isoformat(sep=" ", timespec="seconds") if row[25] else "",
        "recupera_photo_base64": row[26] or "",
        "recupera_photo_name": row[27] or "",
        "recupera_send_photo": bool(row[28]),
    }


_HOST_GREENAPI = re.compile(r"(\d{2,6})\.(api|media)\.green-?api\.com", re.I)


def servidor_greenapi(valor: str) -> str:
    """Devolve o número do servidor (7105) de qualquer URL do GreenAPI, vazio se não houver."""
    achado = _HOST_GREENAPI.search(str(valor or ""))
    return achado.group(1) if achado else ""


def hosts_greenapi(api_url: str, media_url: str, id_instance: str = "") -> tuple:
    """Corrige os dois hosts: chamar é sempre .api, baixar mídia é sempre .media.

    O painel dele cola uma URL de cada vez, então aceitamos as duas nos dois campos e
    reconstruimos o par a partir do número do servidor.
    """
    servidor = servidor_greenapi(api_url) or servidor_greenapi(media_url)
    if not servidor:
        prefixo = re.match(r"\s*(\d{4})", str(id_instance or ""))
        servidor = prefixo.group(1) if prefixo else ""
    if not servidor:
        return (str(api_url or "").strip(), str(media_url or "").strip())
    return ("https://%s.api.greenapi.com" % servidor, "https://%s.media.greenapi.com" % servidor)


def api_base_greenapi(conf: dict) -> str:
    """URL base para chamar a API, mesmo que alguém tenha salvo o host de mídia ali."""
    api = str(conf.get("api_url") or "").strip()
    if servidor_greenapi(api) and _HOST_GREENAPI.search(api).group(2).lower() == "media":
        return "https://%s.api.greenapi.com" % servidor_greenapi(api)
    return api.rstrip("/")


def _invoke_status(resultado: dict) -> dict:
    corpo = resultado.get("response") or {}
    invoke = corpo.get("invokeStatus")
    return invoke if isinstance(invoke, dict) else {}


def cota_esgotada(resultado: dict) -> bool:
    """True quando o GreenAPI respondeu 466: o plano ficou sem saldo de mensagens."""
    invoke = _invoke_status(resultado)
    texto = str(invoke.get("description") or "").lower()
    if "quota" in texto:
        return True
    return str(resultado.get("status_code") or "") == "466"


def host_errado_greenapi(resultado: dict) -> bool:
    """O nginx devolve HTML 403 quando a chamada vai para o host de mídia em vez do de API."""
    if str(resultado.get("status_code") or "") not in ("403", "404"):
        return False
    corpo = resultado.get("response") or {}
    return "<html" in str(corpo.get("raw") or "").lower() or "forbidden" in str(corpo).lower()


def validacao_greenapi(resultado: dict) -> str:
    """O GreenAPI devolve 400 com 'Validation failed. Details: ...' quando o corpo esta errado."""
    if str(resultado.get("status_code") or "") != "400":
        return ""
    corpo = resultado.get("response") or {}
    texto = str(corpo.get("message") or corpo.get("description") or "")
    return texto if "validation" in texto.lower() else ""


def falha_greenapi(resultado: dict) -> str:
    """Traduz o erro do GreenAPI em uma frase que da para agir pelo celular."""
    if (resultado.get("error") or "") == "telefone_invalido":
        return ("O numero guardado para este cliente e curto demais para o WhatsApp "
                "(falta o DDD). Digite o numero completo na caixinha da linha e tente de novo.")
    if cota_esgotada(resultado):
        invoke = _invoke_status(resultado)
        usados = invoke.get("used", "?")
        sobra = invoke.get("total", 0)
        return (
            "GreenAPI sem saldo do mes: %s chamadas usadas, %s restantes. "
            "O plano gratuito (Developer) so libera 3 conversas por mes; "
            "mude o tariff da instancia para Business no painel do GreenAPI e espere virar o mes."
            % (usados, sobra)
        )
    if host_errado_greenapi(resultado):
        return (
            "A URL de API esta errada: o servidor devolveu 403 do nginx. Chamar e postar arquivo "
            "usam https://NUMERO.api.greenapi.com; o host .media so serve para baixar midia. "
            "O painel agora corrige esse par sozinho ao gravar."
        )
    detalhe = validacao_greenapi(resultado)
    if detalhe:
        if "chatid" in detalhe.lower().replace(" ", ""):
            return ("O GreenAPI nao aceitou o numero guardado para este cliente (telefone invalido). "
                    "Corrija o numero na caixinha da linha e tente de novo. Detalhe: %s" % detalhe[:120])
        return ("O GreenAPI recusou o pedido antes de enviar (corpo da mensagem invalido). "
                "Detalhe: %s" % detalhe[:150])
    corpo = resultado.get("response") or {}
    texto = str(corpo.get("description") or corpo.get("message") or resultado.get("error") or corpo or "falha")
    return texto[:180]


def greenapi_get_settings(conf: dict) -> dict:
    """Lê da instância quem ela é: número do WhatsApp e webhook configurado lá dentro."""
    api_url = api_base_greenapi(conf)
    id_instance = (conf.get("id_instance") or "").strip()
    api_token = (conf.get("api_token") or "").strip()
    if not all([api_url, id_instance, api_token]):
        return {"ok": False, "error": "sem configuracao"}
    url = "%s/waInstance%s/getSettings/%s" % (api_url, id_instance, api_token)
    try:
        resp = requests.get(url, timeout=6)
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:160]}
    try:
        corpo = resp.json()
    except ValueError:
        corpo = {}
    if resp.status_code >= 400:
        return {"ok": False, "status_code": resp.status_code, "response": corpo}
    dados = corpo.get("params") or corpo
    wid = str(dados.get("wid") or "")
    numero = wid.split("@")[0] if wid else ""
    return {
        "ok": True,
        "status_code": resp.status_code,
        "numero": numero,
        "webhook_url": str(dados.get("webhookUrl") or ""),
        "incoming_webhook": "sim" if dados.get("incomingWebhook") else "não",
        "delay": dados.get("delaySendMessagesMilliseconds"),
    }


def modo_teste() -> bool:
    """PEIXEIRO_MODO_TESTE=1: a copia de testes nao manda WhatsApp nem apaga linha no MC.

    Serve para abrir o painel gêmeo sem risco de ninguém receber mensagem de verdade.
    """
    return (os.getenv("PEIXEIRO_MODO_TESTE") or "").strip().lower() in ("1", "true", "sim", "on")


def greenapi_send_file(conf: dict, phone: str, conteudo: bytes, file_name: str, caption: str) -> dict:
    api_url = api_base_greenapi(conf)
    id_instance = (conf.get("id_instance") or "").strip()
    api_token = (conf.get("api_token") or "").strip()
    chat_phone = normalize_whatsapp(phone)
    if not all([api_url, id_instance, api_token, chat_phone]):
        return {"ok": False, "skipped": True}
    if len(chat_phone) < 10:
        return {"ok": False, "skipped": True, "error": "telefone_invalido"}

    if modo_teste():
        return {"ok": True, "simulado": True, "status_code": 200,
                "response": {"chatId": f"{chat_phone}@c.us", "simulado": True}}

    url = f"{api_url}/waInstance{id_instance}/sendFileByUpload/{api_token}"
    data = {
        "chatId": f"{chat_phone}@c.us",
        "fileName": file_name,
        "caption": caption or "",
    }
    mime = "image/png" if file_name.lower().endswith("png") else "image/jpeg"
    try:
        resp = requests.post(url, data=data, files={"file": (file_name, conteudo, mime)}, timeout=90)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text[:500]}
    return {
        "ok": resp.status_code < 400 and isinstance(body, dict) and bool(body.get("idMessage")),
        "status_code": resp.status_code,
        "response": body,
    }


def greenapi_send_text(conf: dict, phone: str, message: str) -> dict:
    """Mensagem só de texto, sem imagem — usada na renovação e no 'recuperar'."""
    api_url = api_base_greenapi(conf)
    id_instance = (conf.get("id_instance") or "").strip()
    api_token = (conf.get("api_token") or "").strip()
    chat_phone = normalize_whatsapp(phone)
    if not all([api_url, id_instance, api_token, chat_phone]):
        return {"ok": False, "skipped": True}
    if len(chat_phone) < 10:
        return {"ok": False, "skipped": True, "error": "telefone_invalido"}

    if modo_teste():
        return {"ok": True, "simulado": True, "status_code": 200,
                "response": {"chatId": f"{chat_phone}@c.us", "simulado": True}}

    url = f"{api_url}/waInstance{id_instance}/sendMessage/{api_token}"
    if not message:
        return {"ok": False, "skipped": True, "error": "mensagem vazia"}
    # sem parseMode: nas instancias novas o campo e rejeitado na validacao (400 'parseMode' is not allowed)
    payload = {"chatId": f"{chat_phone}@c.us", "message": message}
    try:
        resp = requests.post(url, json=payload, timeout=60)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text[:500]}
    return {
        "ok": resp.status_code < 400 and isinstance(body, dict) and bool(body.get("idMessage")),
        "status_code": resp.status_code,
        "response": body,
    }


def greenapi_send_photo(cfg: dict, phone: str) -> dict:
    photo_base64 = (cfg.get("photo_base64") or "").strip()
    if not photo_base64:
        return {"ok": False, "skipped": True}
    try:
        foto = base64.b64decode(photo_base64.split(",")[-1].strip())
    except Exception as exc:
        return {"ok": False, "error": f"photo_base64 invalido: {exc}"}
    return greenapi_send_file(
        cfg,
        phone,
        foto,
        cfg.get("photo_name") or "imagem.jpg",
        cfg.get("caption") or "",
    )


def greenapi_send_recuperacao(conf: dict, phone: str, texto: str) -> dict:
    """O botão 'recuperar': manda a foto guardada na aba Recuperação junto do texto.

    Sem foto ou com a chave desligada, cai no envio só de texto de sempre.
    """
    base64_foto = (conf.get("recupera_photo_base64") or "").strip()
    if conf.get("recupera_send_photo") and base64_foto:
        try:
            foto = base64.b64decode(base64_foto.split(",")[-1].strip())
        except Exception as exc:
            return {"ok": False, "error": f"recupera_photo_base64 invalido: {exc}"}
        resultado = greenapi_send_file(
            conf, phone, foto, conf.get("recupera_photo_name") or "imagem.jpg", texto)
        resultado["com_foto"] = True
        return resultado
    resultado = greenapi_send_text(conf, phone, texto)
    resultado["com_foto"] = False
    return resultado


def send_greenapi_photo_on_generation(conn, telefone: str, client_ip: str = "") -> dict:
    if not (telefone or "").strip():
        return {"ok": False, "skipped": True}
    try:
        cfg = get_greenapi_config(conn)
    except Exception:
        conn.rollback()
        return {"ok": False, "skipped": True}
    if not cfg.get("send_photo"):
        return {"ok": False, "skipped": True}

    result = greenapi_send_photo(cfg, telefone)
    if result.get("skipped"):
        return result

    try:
        save_event(
            conn,
            event_type="greenapi_send_photo",
            status_code=result.get("status_code"),
            request_payload={"chat_phone": normalize_whatsapp(telefone)},
            response_payload=result.get("response") or {"error": result.get("error", "")},
            error_message=None if result.get("ok") else "greenapi send failed",
            client_ip=client_ip,
        )
    except Exception:
        conn.rollback()
    return result


AVISO_FONTES = (
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "DejaVuSans-Bold.ttf"),
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\DejaVuSans-Bold.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
)
AVISO_LEGENDA_PADRAO = (
    "Ola! Faltam {dias} para o seu plano expirar.\n"
    "Para renovar agora, copie a chave PIX abaixo (CNPJ):\n{pix}\n"
    "Caiu no nosso sistema, renovou na hora."
)
RENOVA_LEGENDA_PADRAO = (
    "Olá, Vi que esta sem acesso para renovar só falta efetuar o pix na chave:\n{pix}"
)
RECUPERA_LEGENDA_PADRAO = (
    "Olá, vi que {dias} que está sem acesso, Vamos ativa-lo agora mesmo, efetue o pix na chave:\n{pix}"
)


def carregar_fonte_aviso(tamanho: int):
    for caminho in AVISO_FONTES:
        if os.path.exists(caminho):
            try:
                return ImageFont.truetype(caminho, tamanho)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size=tamanho)
    except TypeError:
        return ImageFont.load_default()


def quebrar_texto(draw, texto: str, fonte, largura_maxima: int):
    linhas, atual = [], ""
    for palavra in (texto or "").split():
        teste = (atual + " " + palavra).strip()
        box = draw.textbbox((0, 0), teste, font=fonte)
        if (box[2] - box[0]) > largura_maxima and atual:
            linhas.append(atual)
            atual = palavra
        else:
            atual = teste
    if atual:
        linhas.append(atual)
    return linhas or [""]


def gerar_imagem_aviso(conf: dict, texto_dias: str) -> bytes:
    """Ladrilho azul 1080x1080 com os dias que faltam e a chave PIX do CNPJ."""
    largura, altura = 1080, 1080
    utilizavel = altura - 150
    img = Image.new("RGB", (largura, altura), (18, 74, 168))
    draw = ImageDraw.Draw(img)

    fonte_titulo = carregar_fonte_aviso(70)
    fonte_media = carregar_fonte_aviso(58)
    fonte_pix = carregar_fonte_aviso(86)

    def montar(tamanho_grande):
        grupos = [
            (conf.get("aviso_titulo") or "ATENCAO: SEU PLANO VAI VENCER", fonte_titulo, 0),
            (f"Faltam {texto_dias}", carregar_fonte_aviso(tamanho_grande), 46),
            ("para o seu plano expirar", fonte_media, 24),
            (conf.get("aviso_rodape") or "Para renovar, pague pelo PIX:", carregar_fonte_aviso(50), 54),
            ("PIX CNPJ", fonte_media, 24),
            (conf.get("aviso_pix_mascara") or conf.get("aviso_pix_key") or "", fonte_pix, 14),
        ]
        blocos = []
        for texto, fonte, espaco_grupo in grupos:
            for indice, linha in enumerate(quebrar_texto(draw, texto, fonte, largura - 110)):
                blocos.append((linha, fonte, espaco_grupo if indice == 0 else 10))
        alturas = [
            draw.textbbox((0, 0), t, font=f)[3] - draw.textbbox((0, 0), t, font=f)[1]
            for t, f, _ in blocos
        ]
        return blocos, alturas, sum(a + e for a, (_, _, e) in zip(alturas, blocos))

    for tamanho in (104, 90, 78, 66, 56, 48):
        blocos, alturas, total = montar(tamanho)
        if total <= utilizavel:
            break

    topo = 75 + max(0, (utilizavel - total) / 2)
    for (texto, fonte, espaco), altura_linha in zip(blocos, alturas):
        topo += espaco
        box = draw.textbbox((0, 0), texto, font=fonte)
        draw.text(((largura - (box[2] - box[0])) / 2, topo), texto, font=fonte, fill=(255, 255, 255))
        topo += altura_linha

    draw.rectangle([0, 0, largura, 12], fill=(255, 214, 10))
    draw.rectangle([0, altura - 12, largura, altura], fill=(255, 214, 10))

    buffer = BytesIO()
    img.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def parse_exp_date(valor: str):
    texto = (valor or "").strip().replace("Z", "+00:00")
    if not texto:
        return None
    try:
        quando = datetime.fromisoformat(texto)
    except ValueError:
        try:
            quando = datetime.strptime(texto[:19], "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            return None
    if quando.tzinfo is None:
        quando = quando.replace(tzinfo=timezone.utc)
    return quando.astimezone(timezone.utc)


def texto_dias_restantes(horas: float) -> str:
    if horas <= 24:
        return "menos de 24 horas"
    return f"apenas {max(1, math.ceil(horas / 24.0))} dias"


def _preencher(modelo: str, conf: dict, texto_dias: str) -> str:
    """Troca {dias} e {pix} sem quebrar se o texto tiver outra chave entre chaves."""
    dados = {"dias": texto_dias, "pix": conf.get("aviso_pix_key") or ""}
    try:
        return modelo.format(**dados)
    except (KeyError, IndexError, ValueError):
        saida = modelo
        for chave, valor in dados.items():
            saida = saida.replace("{%s}" % chave, valor)
        return saida


def legenda_aviso(conf: dict, texto_dias: str) -> str:
    return _preencher(conf.get("aviso_legenda") or AVISO_LEGENDA_PADRAO, conf, texto_dias)


def legenda_renovacao(conf: dict, texto_dias: str) -> str:
    return _preencher(conf.get("renova_legenda") or RENOVA_LEGENDA_PADRAO, conf, texto_dias)


def legenda_recuperar(conf: dict, texto_dias: str) -> str:
    return _preencher(conf.get("recupera_legenda") or RECUPERA_LEGENDA_PADRAO, conf, texto_dias)


def texto_vencido(horas: float) -> str:
    """'em 1 mês e 4 dias' para quem ainda tem plano, 'há 1 mês e 4 dias' para quem venceu."""
    horas = float(horas or 0)
    vencido = horas <= 0
    dias = int(abs(horas) // 24)
    if dias < 1:
        return "há menos de 24 horas" if vencido else "em menos de 24 horas"
    meses, sobra = divmod(dias, 30)
    partes = []
    if meses:
        partes.append(f"{meses} {'mês' if meses == 1 else 'meses'}")
    if sobra or not meses:
        partes.append(f"{sobra} {'dia' if sobra == 1 else 'dias'}")
    texto = " e ".join(partes)
    return f"há {texto}" if vencido else f"em {texto}"


def coletar_linhas_vencendo(bearer_token: str, limite_horas: float, max_paginas: int = 8):
    headers = dict(TEST_HEADERS_BASE)
    headers["authorization"] = f"Bearer {normalize_bearer_token(bearer_token)}"
    params_base = {"quantityPerPage": 200, "orderBy": "exp_date.ASC"}
    agora = datetime.now(timezone.utc)
    vencendo, status = [], 0

    for pagina in range(1, max_paginas + 1):
        params = dict(params_base, page=pagina)
        try:
            resp = requests.get(LINES_URL, headers=headers, params=params, timeout=60)
        except Exception as exc:
            return vencendo, {"error": str(exc)}
        status = resp.status_code
        if resp.status_code >= 400:
            return vencendo, status
        try:
            body = resp.json()
        except ValueError:
            return vencendo, status

        itens = body.get("items") or []
        for item in itens:
            expira_em = parse_exp_date(item.get("exp_date") or "")
            if not expira_em:
                continue
            horas = (expira_em - agora).total_seconds() / 3600.0
            if horas >= limite_horas:
                return vencendo, status
            if horas <= 0 or int(item.get("status") or 0) != 1:
                continue
            vencendo.append(
                {
                    "username": (item.get("username") or "").strip(),
                    "exp_date": expira_em.isoformat(),
                    "expira_brasilia": expira_em.astimezone(BRAZIL_TZ).strftime("%d/%m/%Y %H:%M"),
                    "horas": horas,
                    "texto_dias": texto_dias_restantes(horas),
                }
            )
        if len(itens) < 200 or pagina >= int(body.get("pagesQuantity") or 1):
            break
    return vencendo, status


def avisar_vencimentos(conn, cfg, client_ip: str = None, forcar: bool = False) -> dict:
    conf = get_greenapi_config(conn)
    if not conf:
        return {"ok": False, "error": "greenapi_config sem linha 1"}
    if not conf.get("aviso_ativo"):
        return {"ok": True, "ativo": False, "enviados": 0, "avaliados": 0}

    limite_dias = float(conf.get("aviso_dias") or 2)
    token_info = get_or_refresh_shared_token(conn, cfg, client_ip=client_ip)
    if not token_info.get("ok"):
        return {"ok": False, "error": "login no painel mc falhou", "login_status": token_info.get("login_status")}

    vencendo, lines_status = coletar_linhas_vencendo(token_info["token"], limite_dias * 24.0)
    if isinstance(lines_status, dict):
        return {"ok": False, "error": lines_status.get("error"), "avaliados": 0}

    telefones = {}
    with conn.cursor() as cur:
        cur.execute(
            "select username, telefone from public.usuarios_criados_ip "
            "where telefone <> '' order by updated_at desc"
        )
        for nome, telefone in cur.fetchall():
            if nome:
                telefones.setdefault(str(nome).strip(), str(telefone or "").strip())

    enviados, sem_telefone, falhas, cota = 0, 0, [], False
    for linha in vencendo:
        username = linha["username"]
        telefone = telefones.get(username, "")
        if not username or not telefone:
            sem_telefone += 1
            continue

        with conn.cursor() as cur:
            cur.execute(
                """
                insert into public.vencimento_avisos (username, exp_date, telefone, horas_restantes)
                values (%s, %s, %s, %s)
                on conflict (username, exp_date) do nothing
                """,
                (username, linha["exp_date"], telefone, round(linha["horas"], 2)),
            )
            reivindicado = cur.rowcount > 0
        conn.commit()
        if not reivindicado and not forcar:
            continue

        imagem = gerar_imagem_aviso(conf, linha["texto_dias"])
        legenda = legenda_aviso(conf, linha["texto_dias"])
        resultado = greenapi_send_file(conf, telefone, imagem, "aviso-vencimento.png", legenda)

        if resultado.get("ok"):
            enviados += 1
            body = resultado.get("response") or {}
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.vencimento_avisos
                       set status_code = %s, id_message = %s, response = %s
                     where username = %s and exp_date = %s
                    """,
                    (resultado.get("status_code"), str(body.get("idMessage") or ""), Json(body), username, linha["exp_date"]),
                )
            conn.commit()
        else:
            falhas.append({"username": username, "erro": resultado.get("error") or resultado.get("response")})
            with conn.cursor() as cur:
                cur.execute(
                    "delete from public.vencimento_avisos where username = %s and exp_date = %s",
                    (username, linha["exp_date"]),
                )
            conn.commit()

        save_event(
            conn,
            event_type="aviso_vencimento",
            status_code=resultado.get("status_code"),
            request_payload={"username": username, "expira": linha["expira_brasilia"], "dias": linha["texto_dias"]},
            response_payload=resultado.get("response") or {"error": resultado.get("error", "")},
            error_message=None if resultado.get("ok") else "aviso de vencimento falhou",
            client_ip=client_ip,
        )

        if not resultado.get("ok") and cota_esgotada(resultado):
            cota = True
            break

    return {
        "ok": True,
        "ativo": True,
        "cota": cota,
        "limite_dias": limite_dias,
        "avaliados": len(vencendo),
        "enviados": enviados,
        "sem_telefone": sem_telefone,
        "falhas": falhas[:10],
        "lines_status": lines_status,
    }


def telefones_por_usuario(conn) -> dict:
    """Um nome pode existir em vários IPs; vale o cadastro mais recente."""
    with conn.cursor() as cur:
        cur.execute(
            "select username, telefone from public.usuarios_criados_ip "
            "where telefone <> '' order by updated_at desc"
        )
        saida = {}
        for nome, telefone in cur.fetchall():
            if nome:
                saida.setdefault(str(nome).strip(), str(telefone or "").strip())
        return saida


def coletar_linhas_vencidas(bearer_token: str, janela_dias: float = 30.0, max_paginas: int = 8):
    """Linhas que já venceram dentro da janela, da mais recente para a mais antiga."""
    headers = dict(TEST_HEADERS_BASE)
    headers["authorization"] = f"Bearer {normalize_bearer_token(bearer_token)}"
    params_base = {"quantityPerPage": 200, "orderBy": "exp_date.DESC"}
    agora = datetime.now(timezone.utc)
    corte = agora - timedelta(days=float(janela_dias))
    vencidas, status = [], 0

    for pagina in range(1, max_paginas + 1):
        params = dict(params_base, page=pagina)
        try:
            resp = requests.get(LINES_URL, headers=headers, params=params, timeout=60)
        except Exception as exc:
            return vencidas, {"error": str(exc)}
        status = resp.status_code
        if resp.status_code >= 400:
            return vencidas, status
        try:
            body = resp.json()
        except ValueError:
            return vencidas, status

        itens = body.get("items") or []
        for item in itens:
            expira_em = parse_exp_date(item.get("exp_date") or "")
            if not expira_em:
                continue
            if expira_em > agora:
                continue
            if expira_em < corte:
                return vencidas, status
            horas = (expira_em - agora).total_seconds() / 3600.0
            vencidas.append(
                {
                    "username": (item.get("username") or "").strip(),
                    "exp_date": expira_em.isoformat(),
                    "expira_brasilia": expira_em.astimezone(BRAZIL_TZ).strftime("%d/%m/%Y %H:%M"),
                    "horas": horas,
                    "texto_dias": texto_vencido(horas),
                }
            )
        if len(itens) < 200 or pagina >= int(body.get("pagesQuantity") or 1):
            break
    return vencidas, status


def espelhar_linhas(conn, itens, telefones: dict = None) -> int:
    """Copia para o Supabase o que o painel MC mostrou: backup e base da aba Clientes."""
    telefones = telefones or {}
    gravadas = 0
    with conn.cursor() as cur:
        for item in itens:
            username = (item.get("username") or "").strip()
            if not username:
                continue
            cur.execute(
                """
                insert into public.mc_linhas (username, linha_id, telefone, exp_date, status, notes, synced_at)
                values (%s, %s, %s, %s, %s, %s, now())
                on conflict (username) do update
                  set linha_id = excluded.linha_id,
                      telefone = coalesce(nullif(excluded.telefone, ''), mc_linhas.telefone),
                      exp_date = excluded.exp_date,
                      status = excluded.status,
                      notes = excluded.notes,
                      synced_at = now()
                """,
                (
                    username,
                    str(item.get("id") or ""),
                    telefones.get(username, ""),
                    parse_exp_date(item.get("exp_date") or ""),
                    int(item.get("status") or 0),
                    (item.get("notes") or "")[:200],
                ),
            )
            gravadas += 1
    conn.commit()
    return gravadas


def sincronizar_linhas(conn, cfg, client_ip: str = None, max_paginas: int = 5) -> dict:
    """Varre o /lines do MC e devolve o espelho atualizado para o Supabase."""
    token_info = get_or_refresh_shared_token(conn, cfg, client_ip=client_ip)
    if not token_info.get("ok"):
        return {"ok": False, "error": "login no painel mc falhou", "login_status": token_info.get("login_status")}
    headers = dict(TEST_HEADERS_BASE)
    headers["authorization"] = f"Bearer {normalize_bearer_token(token_info['token'])}"
    telefones = telefones_por_usuario(conn)
    itens, status = [], 0
    for pagina in range(1, max_paginas + 1):
        try:
            resp = requests.get(
                LINES_URL,
                headers=headers,
                params={"page": pagina, "quantityPerPage": 200, "orderBy": "createdAt.DESC"},
                timeout=60,
            )
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:180]}
        status = resp.status_code
        if resp.status_code >= 400:
            return {"ok": False, "error": "MC devolveu %s" % status, "lines_status": status}
        pagina_itens = (resp.json() or {}).get("items") or []
        itens.extend(pagina_itens)
        if len(pagina_itens) < 200:
            break
    return {"ok": True, "linhas": espelhar_linhas(conn, itens, telefones), "lines_status": status}


def avisar_renovacao(conn, cfg, client_ip: str = None, forcar: bool = False) -> dict:
    """Renovação: avisa quem já venceu, no máximo a cada renova_dias, dentro da janela configurada."""
    conf = get_greenapi_config(conn)
    if not conf:
        return {"ok": False, "error": "greenapi_config sem linha 1"}
    if not conf.get("renova_ativo"):
        return {"ok": True, "ativo": False, "enviados": 0, "avaliados": 0}

    intervalo = float(conf.get("renova_dias") or 3)
    janela = float(conf.get("renova_janela_dias") or 30)
    token_info = get_or_refresh_shared_token(conn, cfg, client_ip=client_ip)
    if not token_info.get("ok"):
        return {"ok": False, "error": "login no painel mc falhou", "login_status": token_info.get("login_status")}

    vencidas, lines_status = coletar_linhas_vencidas(token_info["token"], janela)
    if isinstance(lines_status, dict):
        return {"ok": False, "error": lines_status.get("error"), "avaliados": 0}

    telefones = telefones_por_usuario(conn)
    corte = datetime.now(timezone.utc) - timedelta(days=intervalo)
    onde = "" if forcar else "where renovacao_avisos.updated_at < %s"
    claim = (
        """
        insert into public.renovacao_avisos (username, exp_date, telefone, dias_vencido, via, updated_at)
        values (%%s, %%s, %%s, %%s, 'agenda', now())
        on conflict (username, exp_date) do update
          set telefone = excluded.telefone,
              dias_vencido = excluded.dias_vencido,
              via = excluded.via,
              updated_at = now()
        %s
        returning username
        """ % onde
    )

    enviados, sem_telefone, esperando, falhas, cota = 0, 0, 0, [], False
    for linha in vencidas:
        username, telefone = linha["username"], telefones.get(linha["username"], "")
        if not username or not telefone:
            sem_telefone += 1
            continue
        valores = (username, linha["exp_date"], telefone, round(abs(linha["horas"]) / 24.0, 1))
        with conn.cursor() as cur:
            cur.execute(claim, valores + ((corte,) if onde else ()))
            reivindicado = cur.fetchone() is not None
        conn.commit()
        if not reivindicado:
            esperando += 1
            continue

        resultado = greenapi_send_text(conf, telefone, legenda_renovacao(conf, linha["texto_dias"]))
        if resultado.get("ok"):
            enviados += 1
            body = resultado.get("response") or {}
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.renovacao_avisos
                       set status_code = %s, id_message = %s, response = %s
                     where username = %s and exp_date = %s
                    """,
                    (
                        resultado.get("status_code"),
                        str(body.get("idMessage") or ""),
                        Json(body),
                        username,
                        linha["exp_date"],
                    ),
                )
            conn.commit()
        else:
            falhas.append({"username": username, "erro": resultado.get("error") or resultado.get("response")})
            with conn.cursor() as cur:
                cur.execute(
                    "delete from public.renovacao_avisos where username = %s and exp_date = %s",
                    (username, linha["exp_date"]),
                )
            conn.commit()

        save_event(
            conn,
            event_type="aviso_renovacao",
            status_code=resultado.get("status_code"),
            request_payload={"username": username, "venceu": linha["expira_brasilia"], "dias": linha["texto_dias"]},
            response_payload=resultado.get("response") or {"error": resultado.get("error", "")},
            error_message=None if resultado.get("ok") else "aviso de renovacao falhou",
            client_ip=client_ip,
        )

        if not resultado.get("ok") and cota_esgotada(resultado):
            cota = True
            break

    return {
        "ok": True,
        "ativo": True,
        "cota": cota,
        "intervalo_dias": intervalo,
        "janela_dias": janela,
        "avaliados": len(vencidas),
        "enviados": enviados,
        "sem_telefone": sem_telefone,
        "esperando": esperando,
        "falhas": falhas[:10],
        "lines_status": lines_status,
    }


PAINEL_CONFIG_CAMPOS = (
    "api_url",
    "media_url",
    "id_instance",
    "api_token",
    "instance_name",
    "owner_phone",
    "qr_url",
    "photo_base64",
    "photo_name",
    "caption",
    "send_photo",
    "aviso_ativo",
    "aviso_dias",
    "aviso_pix_key",
    "aviso_pix_mascara",
    "aviso_titulo",
    "aviso_rodape",
    "aviso_legenda",
    "aviso_token",
    "renova_ativo",
    "renova_dias",
    "renova_janela_dias",
    "renova_legenda",
    "recupera_legenda",
    "recupera_photo_base64",
    "recupera_photo_name",
    "recupera_send_photo",
)

# campo: (minimo, maximo, padrao)
CONFIG_NUMERICOS = {
    "aviso_dias": (0.1, 30.0, 2.0),
    "renova_dias": (1.0, 30.0, 3.0),
    "renova_janela_dias": (1.0, 365.0, 30.0),
}


def resumo_greenapi_config(conf: dict) -> dict:
    foto = (conf.get("photo_base64") or "")
    foto_recupera = (conf.get("recupera_photo_base64") or "")
    resumo = dict(conf)
    resumo.pop("photo_base64", None)
    resumo.pop("recupera_photo_base64", None)
    resumo.pop("painel_token", None)
    resumo["photo_present"] = bool(foto)
    resumo["photo_kb"] = round(len(foto) / 1024)
    resumo["recupera_photo_present"] = bool(foto_recupera)
    resumo["recupera_photo_kb"] = round(len(foto_recupera) / 1024)
    return resumo


def atualizar_greenapi_config(conn, campos: dict) -> dict:
    ajuste = ""
    if any(chave in campos for chave in ("api_url", "media_url", "id_instance")):
        guardado = get_greenapi_config(conn) or {}
        api_novo, media_novo = hosts_greenapi(
            campos.get("api_url") or guardado.get("api_url") or "",
            campos.get("media_url") or guardado.get("media_url") or "",
            campos.get("id_instance") or guardado.get("id_instance") or "",
        )
        if api_novo and api_novo != (guardado.get("api_url") or "").strip():
            ajuste = "apiUrl corrigida para %s" % api_novo
        if media_novo and media_novo != (guardado.get("media_url") or "").strip():
            ajuste = (ajuste + " | " if ajuste else "") + "mediaUrl corrigida para %s" % media_novo
        campos = dict(campos)
        if api_novo:
            campos["api_url"] = api_novo
        if media_novo:
            campos["media_url"] = media_novo
        if ajuste and ("id_instance" in campos or "api_token" in campos):
            campos["qr_url"] = ""

    clausulas, valores = [], []
    for chave in PAINEL_CONFIG_CAMPOS:
        if chave not in campos:
            continue
        valor = campos.get(chave)
        if chave in ("send_photo", "aviso_ativo", "renova_ativo", "recupera_send_photo"):
            valor = bool(valor)
        elif chave in CONFIG_NUMERICOS:
            minimo, maximo, padrao = CONFIG_NUMERICOS[chave]
            try:
                valor = max(minimo, min(maximo, float(valor or padrao)))
            except (TypeError, ValueError):
                valor = padrao
        else:
            valor = str(valor if valor is not None else "").strip()
        clausulas.append(f"{chave} = %s")
        valores.append(valor)

    if not clausulas:
        return {"ok": False, "error": "nenhum campo reconhecido para salvar"}

    clausulas.append("updated_at = now()")
    with conn.cursor() as cur:
        cur.execute(
            f"update public.greenapi_config set {', '.join(clausulas)} where id = 1",
            valores,
        )
    conn.commit()

    save_event(
        conn,
        event_type="painel_config_write",
        status_code=200,
        request_payload={"campos": sorted(k for k in campos if k in PAINEL_CONFIG_CAMPOS)},
        response_payload={"atualizado": True},
    )
    return {"ok": True, "campos": sorted(k for k in campos if k in PAINEL_CONFIG_CAMPOS), "ajuste": ajuste}


def executar_config_painel(token: str = "", campos=None) -> dict:
    """Leitura e escrita da configuração pelo painel local, sem chave service_role."""
    conn, _ = open_db_from_env()
    try:
        conf = get_greenapi_config(conn)
        esperado = (conf.get("painel_token") or "").strip()
        if not esperado:
            return {"ok": False, "error": "painel_token vazio no greenapi_config", "status": 503}
        if not hmac.compare_digest(str(token or "").strip(), esperado):
            return {"ok": False, "error": "token invalido", "status": 401}

        if campos:
            resultado = atualizar_greenapi_config(conn, campos)
            if resultado.get("ok"):
                resultado["config"] = resumo_greenapi_config(get_greenapi_config(conn))
        else:
            resultado = {"ok": True, "config": resumo_greenapi_config(conf)}

        resultado["status"] = 200 if resultado.get("ok") else 400
        return resultado
    finally:
        try:
            conn.close()
        except Exception:
            pass


def executar_aviso_vencimentos(token: str = "", forcar: bool = False, client_ip: str = None) -> dict:
    """Chamado pelo cron do Supabase: valida o token e roda a varredura."""
    conn, cfg = open_db_from_env()
    try:
        conf = get_greenapi_config(conn)
        esperado = (conf.get("aviso_token") or "").strip()
        if not esperado:
            return {"ok": False, "error": "aviso_token vazio no greenapi_config", "status": 503}
        if not hmac.compare_digest(str(token or "").strip(), esperado):
            return {"ok": False, "error": "token invalido", "status": 401}
        resultado = avisar_vencimentos(conn, cfg, client_ip=client_ip, forcar=forcar)
        resultado["espelho"] = sincronizar_linhas(conn, cfg, client_ip=client_ip)
        renovacao = avisar_renovacao(conn, cfg, client_ip=client_ip, forcar=forcar)
        resultado["renovacao"] = renovacao
        resultado["status"] = 200 if resultado.get("ok") and renovacao.get("ok") else 500
        return resultado
    finally:
        try:
            conn.close()
        except Exception:
            pass


def load_config(exige_mc: bool = True):
    load_dotenv()


    mc_username = os.getenv("MC_USERNAME")
    mc_password = os.getenv("MC_PASSWORD")
    supabase_access_token = os.getenv("SUPABASE_ACCESS_TOKEN")
    supabase_project_name = os.getenv("SUPABASE_PROJECT_NAME")
    supabase_db_password = os.getenv("SUPABASE_DB_PASSWORD")
    database_url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL") or ""
    supabase_db_host = os.getenv("SUPABASE_DB_HOST", "")
    supabase_db_port = os.getenv("SUPABASE_DB_PORT", "")
    supabase_db_name = os.getenv("SUPABASE_DB_NAME", "postgres")
    supabase_db_user = os.getenv("SUPABASE_DB_USER", "")
    supabase_db_sslmode = os.getenv("SUPABASE_DB_SSLMODE", "require")

    if exige_mc and not all([mc_username, mc_password]):
        raise RuntimeError("Variaveis MC_USERNAME/MC_PASSWORD faltando no .env ou no Render.")

    project_ref = os.getenv("SUPABASE_PROJECT_REF")
    project_region = os.getenv("SUPABASE_PROJECT_REGION", "")
    supabase_pooler_host = os.getenv("SUPABASE_POOLER_HOST", "")
    supabase_pooler_port = os.getenv("SUPABASE_POOLER_PORT", "")

    if not database_url and not supabase_db_host and not supabase_db_password:
        raise RuntimeError("Informe SUPABASE_DB_PASSWORD ou DATABASE_URL/SUPABASE_DB_URL no .env ou no Render.")

    if not database_url and not supabase_db_host:
        if not project_ref and supabase_access_token and supabase_project_name:
            try:
                project_info = get_supabase_project_info(supabase_access_token, supabase_project_name)
            except Exception as exc:
                raise RuntimeError(
                    "Nao foi possivel consultar o projeto pelo SUPABASE_ACCESS_TOKEN. "
                    "Configure SUPABASE_PROJECT_REF no Render/.env para nao depender desse token administrativo."
                ) from exc
            if not project_ref:
                project_ref = project_info["ref"]
            if not project_region:
                project_region = project_info.get("region", "")
        elif not project_ref:
            raise RuntimeError(
                "Informe SUPABASE_PROJECT_REF, SUPABASE_DB_HOST ou DATABASE_URL/SUPABASE_DB_URL no .env ou no Render."
            )
        elif not project_region and supabase_access_token and supabase_project_name:
            try:
                project_region = get_supabase_project_info(supabase_access_token, supabase_project_name).get("region", "")
            except Exception:
                project_region = ""

    return {
        "mc_username": mc_username,
        "mc_password": mc_password,
        "project_ref": project_ref,
        "project_region": project_region,
        "supabase_pooler_host": supabase_pooler_host,
        "supabase_pooler_port": supabase_pooler_port,
        "supabase_db_password": supabase_db_password,
        "database_url": database_url,
        "supabase_db_host": supabase_db_host,
        "supabase_db_port": supabase_db_port,
        "supabase_db_name": supabase_db_name,
        "supabase_db_user": supabase_db_user,
        "supabase_db_sslmode": supabase_db_sslmode,
    }


def load_mc_config():
    load_dotenv()
    mc_username = os.getenv("MC_USERNAME")
    mc_password = os.getenv("MC_PASSWORD")
    if not all([mc_username, mc_password]):
        raise RuntimeError("Variaveis MC_USERNAME/MC_PASSWORD faltando no .env ou no Render.")
    return {"mc_username": mc_username, "mc_password": mc_password}


def open_db_from_env():
    # So o banco: a copia de testes abre o painel sem as credenciais do painel MC.
    cfg = load_config(exige_mc=False)
    conn = connect_db(
        cfg["supabase_db_password"],
        cfg["project_ref"],
        cfg.get("project_region", ""),
        cfg.get("supabase_pooler_host", ""),
        cfg.get("supabase_pooler_port", ""),
        cfg.get("database_url", ""),
        cfg.get("supabase_db_host", ""),
        cfg.get("supabase_db_port", ""),
        cfg.get("supabase_db_name", "postgres"),
        cfg.get("supabase_db_user", ""),
        cfg.get("supabase_db_sslmode", "require"),
    )
    ensure_schema(conn)
    return conn, cfg


def save_event(
    conn,
    event_type,
    status_code=None,
    bearer_token=None,
    request_payload=None,
    response_payload=None,
    error_message=None,
    client_ip=None,
):
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into public.mcapi_events (
                event_type, status_code, bearer_token, request_payload, response_payload, error_message, client_ip
            ) values (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                event_type,
                status_code,
                bearer_token,
                Json(request_payload) if request_payload is not None else None,
                Json(response_payload) if response_payload is not None else None,
                error_message,
                client_ip,
            ),
        )
    conn.commit()


def login(username: str, password: str):
    payload = {"username": username, "password": password, "twoFacToken": ""}
    resp = requests.post(LOGIN_URL, headers=LOGIN_HEADERS, json=payload, timeout=30)
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text}

    token = None
    if isinstance(body, dict):
        for key in ["token", "accessToken", "access_token", "jwt"]:
            if body.get(key):
                token = body[key]
                break

    return resp.status_code, payload, body, token


def create_test_line(bearer_token: str, note_text: str = ""):
    payload = {
        "notes": note_text or f"auto-{rand_suffix()}",
        "package_p2p": "646d1492db22a7b1bc518941",
        "package_iptv": "70",
        "testDuration": 4,
        "krator_package": "1",
    }
    headers = dict(TEST_HEADERS_BASE)
    headers["authorization"] = f"Bearer {bearer_token}"
    resp = requests.post(TEST_URL, headers=headers, json=payload, timeout=30)
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text}
    return resp.status_code, payload, body


def fetch_resale_stream_page(bearer_token: str, stream_kind: str, page: int = 1):
    safe_token = normalize_bearer_token(bearer_token)
    kind = (stream_kind or "").strip().lower()
    if kind == "movie":
        url = RESALE_MOVIE_URL
        params = {"removeTmdbNull": "true", "page": page}
    elif kind == "canal":
        url = RESALE_CANAL_URL
        params = {"page": page}
    else:
        raise ValueError("stream_kind invalido")

    headers = dict(STREAM_HEADERS_BASE)
    headers["authorization"] = f"Bearer {safe_token}"
    resp = requests.get(url, headers=headers, params=params, timeout=30)
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text}
    return resp.status_code, {"url": url, "params": params}, body


def fetch_resale_findall_page(bearer_token: str, search_text: str = "ss", page: int = 1):
    safe_token = normalize_bearer_token(bearer_token)
    headers = dict(STREAM_HEADERS_BASE)
    headers["authorization"] = f"Bearer {safe_token}"
    params = {"removeTmdbNull": "true", "search": (search_text or "ss"), "page": page}
    resp = requests.get(RESALE_FINDALL_URL, headers=headers, params=params, timeout=30)
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text}
    return resp.status_code, {"url": RESALE_FINDALL_URL, "params": params}, body


def tmdb_image_url(path: str, width: str = "w400") -> str:
    safe = (path or "").strip()
    if not safe:
        return ""
    if safe.startswith("http://") or safe.startswith("https://"):
        return safe
    if not safe.startswith("/"):
        safe = f"/{safe}"
    return f"https://image.tmdb.org/t/p/{width}{safe}"


def normalize_title_for_match(title: str) -> str:
    text = unicodedata.normalize("NFKD", (title or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    cleaned = []
    for ch in text.lower():
        cleaned.append(ch if ch.isalnum() else " ")
    return " ".join("".join(cleaned).split())


def normalize_media_family(kind: str) -> str:
    safe = (kind or "").strip().lower()
    if safe in {"movie", "filme"}:
        return "movie"
    if safe in {"series", "serie", "tv", "show"}:
        return "tv"
    return ""


def stream_kind_label(type_stream: str) -> str:
    safe = (type_stream or "").strip().lower()
    if safe == "movie":
        return "Filme"
    if safe == "series":
        return "Serie"
    return "Canal"


def request_content_type_for_stream(type_stream: str) -> str:
    safe = (type_stream or "").strip().lower()
    if safe == "series":
        return "serie"
    if safe == "movie":
        return "filme"
    return "canal"


def normalize_findall_search_items(payload, limit: int = 18):
    rows = payload.get("data", []) if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        return []

    normalized = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        type_stream = (row.get("type_stream") or "movie").strip().lower()
        sort_text = row.get("sort_order") or row.get("release_date") or row.get("added") or ""
        sort_dt = parse_recent_datetime(sort_text)
        tmdb_id = row.get("tmdb_id")
        tmdb_id_text = str(tmdb_id).strip() if tmdb_id not in (None, "") else ""
        normalized.append(
            {
                "id": row.get("id") or f"findall-{tmdb_id_text or rand_suffix(6)}",
                "title": (row.get("title") or "").strip(),
                "cover": (row.get("cover") or "").strip(),
                "backdrop": (row.get("backdrop") or "").strip(),
                "added": (row.get("added") or "").strip(),
                "sort_order": (row.get("sort_order") or "").strip(),
                "type_stream": type_stream,
                "kind": type_stream,
                "kind_label": stream_kind_label(type_stream),
                "tmdb_id": tmdb_id_text,
                "source": "mcapi_findall",
                "can_request": True,
                "request_content_type": request_content_type_for_stream(type_stream),
                "sort_dt": sort_dt,
            }
        )

    normalized.sort(key=lambda item: item.get("sort_dt") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return normalized[: max(1, int(limit))]


def fetch_tmdb_search_page(url: str, query: str = "ss", page: int = 1, language: str = "pt-BR"):
    tmdb_api_key = (os.getenv("TMDB_API_KEY") or TMDB_DEFAULT_API_KEY).strip()
    tmdb_bearer = (os.getenv("TMDB_BEARER_TOKEN") or TMDB_DEFAULT_BEARER_TOKEN).strip()
    if not tmdb_api_key and not tmdb_bearer:
        return 0, {"url": url, "params": {"query": query, "page": page}}, {"error": "tmdb_missing_credentials"}

    headers = {"accept": "application/json"}
    params = {
        "query": query or "ss",
        "include_adult": "false",
        "language": language or "pt-BR",
        "page": page,
    }
    if tmdb_api_key:
        params["api_key"] = tmdb_api_key
    if tmdb_bearer:
        headers["authorization"] = f"Bearer {tmdb_bearer}"

    resp = requests.get(url, headers=headers, params=params, timeout=30)
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text}
    safe_params = dict(params)
    if "api_key" in safe_params:
        safe_params["api_key"] = "***"
    return resp.status_code, {"url": url, "params": safe_params}, body


def fetch_tmdb_search_movie_page(query: str = "ss", page: int = 1, language: str = "pt-BR"):
    return fetch_tmdb_search_page(TMDB_SEARCH_MOVIE_URL, query=query, page=page, language=language)


def fetch_tmdb_search_tv_page(query: str = "ss", page: int = 1, language: str = "pt-BR"):
    return fetch_tmdb_search_page(TMDB_SEARCH_TV_URL, query=query, page=page, language=language)


def normalize_tmdb_movie_items(payload, limit: int = 18):
    rows = payload.get("results", []) if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        return []

    normalized = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        tmdb_id = row.get("id")
        if tmdb_id in (None, ""):
            continue
        title = (row.get("title") or row.get("original_title") or "").strip()
        if not title:
            continue
        release_date = (row.get("release_date") or "").strip()
        sort_dt = parse_recent_datetime(release_date) if release_date else None
        added_text = ""
        if release_date:
            try:
                added_text = datetime.strptime(release_date, "%Y-%m-%d").strftime("%d/%m/%Y")
            except Exception:
                added_text = ""
        normalized.append(
            {
                "id": f"tmdb-{tmdb_id}",
                "title": title,
                "cover": tmdb_image_url(row.get("poster_path"), width="w400"),
                "backdrop": tmdb_image_url(row.get("backdrop_path"), width="w780"),
                "added": added_text,
                "sort_order": release_date,
                "type_stream": "movie",
                "kind": "movie",
                "kind_label": "Filme",
                "tmdb_id": str(tmdb_id),
                "source": "tmdb_movie",
                "can_request": True,
                "request_content_type": "filme",
                "sort_dt": sort_dt,
            }
        )

    normalized.sort(key=lambda item: item.get("sort_dt") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return normalized[: max(1, int(limit))]


def normalize_tmdb_tv_items(payload, limit: int = 18):
    rows = payload.get("results", []) if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        return []

    normalized = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        tmdb_id = row.get("id")
        if tmdb_id in (None, ""):
            continue
        title = (row.get("name") or row.get("original_name") or "").strip()
        if not title:
            continue
        first_air_date = (row.get("first_air_date") or "").strip()
        sort_dt = parse_recent_datetime(first_air_date) if first_air_date else None
        added_text = ""
        if first_air_date:
            try:
                added_text = datetime.strptime(first_air_date, "%Y-%m-%d").strftime("%d/%m/%Y")
            except Exception:
                added_text = ""
        normalized.append(
            {
                "id": f"tmdb-tv-{tmdb_id}",
                "title": title,
                "cover": tmdb_image_url(row.get("poster_path"), width="w400"),
                "backdrop": tmdb_image_url(row.get("backdrop_path"), width="w780"),
                "added": added_text,
                "sort_order": first_air_date,
                "type_stream": "series",
                "kind": "series",
                "kind_label": "Serie",
                "tmdb_id": str(tmdb_id),
                "source": "tmdb_tv",
                "can_request": True,
                "request_content_type": "serie",
                "sort_dt": sort_dt,
            }
        )

    normalized.sort(key=lambda item: item.get("sort_dt") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return normalized[: max(1, int(limit))]


def reconcile_findall_with_tmdb(findall_items, tmdb_items, merged_limit: int = 18):
    if not isinstance(findall_items, list):
        findall_items = []
    if not isinstance(tmdb_items, list):
        tmdb_items = []

    tmdb_by_family_id = {}
    tmdb_by_family_title = {}
    for tmdb in tmdb_items:
        family = normalize_media_family(tmdb.get("kind") or tmdb.get("type_stream"))
        if not family:
            continue
        tmdb_id = (tmdb.get("tmdb_id") or "").strip()
        if tmdb_id:
            tmdb_by_family_id[(family, tmdb_id)] = tmdb
        norm_title = normalize_title_for_match(tmdb.get("title", ""))
        if norm_title:
            tmdb_by_family_title[(family, norm_title)] = tmdb

    seen_family_tmdb_ids = set()
    seen_family_titles = set()
    enriched_findall = []
    for item in findall_items:
        family = normalize_media_family(item.get("kind") or item.get("type_stream"))
        tmdb_id = (item.get("tmdb_id") or "").strip()
        norm_title = normalize_title_for_match(item.get("title", ""))
        tmdb_ref = None
        if family:
            if tmdb_id:
                tmdb_ref = tmdb_by_family_id.get((family, tmdb_id))
            if tmdb_ref is None and norm_title:
                tmdb_ref = tmdb_by_family_title.get((family, norm_title))
        if tmdb_ref:
            if not item.get("cover"):
                item["cover"] = tmdb_ref.get("cover", "")
            if not item.get("backdrop"):
                item["backdrop"] = tmdb_ref.get("backdrop", "")
        if family and tmdb_id:
            seen_family_tmdb_ids.add((family, tmdb_id))
        if family and norm_title:
            seen_family_titles.add((family, norm_title))
        item["can_request"] = False
        enriched_findall.append(item)

    tmdb_missing = []
    for tmdb in tmdb_items:
        family = normalize_media_family(tmdb.get("kind") or tmdb.get("type_stream"))
        if not family:
            continue
        tmdb_id = (tmdb.get("tmdb_id") or "").strip()
        norm_title = normalize_title_for_match(tmdb.get("title", ""))
        if tmdb_id and (family, tmdb_id) in seen_family_tmdb_ids:
            continue
        if norm_title and (family, norm_title) in seen_family_titles:
            continue
        tmdb_missing.append(tmdb)

    merged = sorted(
        tmdb_missing,
        key=lambda item: item.get("sort_dt") or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )[: max(1, int(merged_limit))]
    return enriched_findall, tmdb_missing, merged


def create_resale_content_request(
    bearer_token: str,
    *,
    content_name: str,
    content_type: str,
    tmdb_id: str = "",
    img_url: str = "",
    user_id: str = "",
):
    safe_token = normalize_bearer_token(bearer_token)
    headers = dict(STREAM_HEADERS_BASE)
    headers["authorization"] = f"Bearer {safe_token}"

    multipart_fields = [
        ("content_name", (None, (content_name or "").strip())),
        ("content_type", (None, (content_type or "filme").strip())),
        ("tmdb_id", (None, (tmdb_id or "").strip())),
        ("request", (None, "true")),
        ("request_type", (None, "solicitacao")),
        ("img_url", (None, (img_url or "").strip())),
        ("user_id", (None, (user_id or "").strip())),
    ]

    resp = requests.post(REPORT_CONTENT_RESALE_URL, headers=headers, files=multipart_fields, timeout=30)
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text}

    request_summary = {
        "content_name": (content_name or "").strip(),
        "content_type": (content_type or "filme").strip(),
        "tmdb_id": (tmdb_id or "").strip(),
        "user_id": (user_id or "").strip(),
    }
    return resp.status_code, request_summary, body


def parse_recent_datetime(value):
    text = (value or "").strip()
    if not text:
        return None

    for parser in (
        lambda x: datetime.fromisoformat(x.replace("Z", "+00:00")),
        lambda x: datetime.strptime(x, "%Y-%m-%d").replace(tzinfo=BRAZIL_TZ),
        lambda x: datetime.strptime(x, "%d/%m/%Y").replace(tzinfo=BRAZIL_TZ),
    ):
        try:
            dt = parser(text)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except Exception:
            continue
    return None


def normalize_recent_stream_items(payload, stream_kind: str, limit: int = 10):
    safe_kind = (stream_kind or "").strip().lower()
    rows = payload.get("data", []) if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        return []

    normalized = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        sort_text = row.get("sort_order") or row.get("release_date") or row.get("added") or ""
        sort_dt = parse_recent_datetime(sort_text)
        normalized.append(
            {
                "id": row.get("id") or "",
                "title": row.get("title") or "",
                "cover": row.get("cover") or "",
                "backdrop": row.get("backdrop") or "",
                "added": row.get("added") or "",
                "sort_order": row.get("sort_order") or "",
                "type_stream": row.get("type_stream") or "",
                "kind": safe_kind,
                "kind_label": "Filme" if safe_kind == "movie" else "Canal",
                "sort_dt": sort_dt,
            }
        )

    normalized.sort(key=lambda item: item.get("sort_dt") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return normalized[: max(1, int(limit))]


def parse_iso_to_utc(iso_text: str):
    if not iso_text:
        return None
    try:
        dt = datetime.fromisoformat(iso_text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def normalize_bearer_token(token: str) -> str:
    raw = (token or "").strip()
    if not raw:
        return ""
    if raw.lower().startswith("bearer "):
        return raw.split(" ", 1)[1].strip()
    return raw


def parse_jwt_payload(token: str):
    safe_token = normalize_bearer_token(token)
    try:
        parts = safe_token.split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload_json = base64.urlsafe_b64decode(payload_b64.encode("utf-8")).decode("utf-8")
        payload = json.loads(payload_json)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def parse_jwt_exp_to_utc(token: str):
    payload = parse_jwt_payload(token)
    exp = payload.get("exp")
    if exp is None:
        return None
    try:
        return datetime.fromtimestamp(int(exp), tz=timezone.utc)
    except Exception:
        return None


def upsert_usuario_criado_ip(conn, client_ip: str, username: str, telefone: str = "", telegram_id: str = "", exp_date_text: str = ""):
    if not client_ip or not username:
        return
    exp_date = parse_iso_to_utc(exp_date_text) if exp_date_text else None

    with conn.cursor() as cur:
        cur.execute(
            """
            insert into public.usuarios_criados_ip (
              client_ip, username, telefone, telegram_id, exp_date, updated_at
            )
            values (%s, %s, %s, %s, %s, now())
            on conflict (client_ip, username)
            do update
              set telefone = excluded.telefone,
                  telegram_id = excluded.telegram_id,
                  exp_date = excluded.exp_date,
                  updated_at = now()
            """,
            (client_ip, username, telefone or None, telegram_id or None, exp_date),
        )
    conn.commit()


def register_usuario_criado_ip(client_ip: str, username: str, telefone: str = "", telegram_id: str = "", exp_date_text: str = ""):
    conn, _ = open_db_from_env()
    try:
        upsert_usuario_criado_ip(conn, client_ip, username, telefone, telegram_id, exp_date_text)
    finally:
        conn.close()


def get_cached_token(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            select bearer_token, expires_at
            from public.mcapi_token_cache
            where id = 1
            """
        )
        row = cur.fetchone()
    if not row:
        return None, None
    return row[0], row[1]


def token_is_valid(expires_at, margin_seconds: int = 60):
    if not expires_at:
        return False
    return expires_at > (datetime.now(timezone.utc) + timedelta(seconds=margin_seconds))


def save_cached_token(conn, token: str, expires_at):
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into public.mcapi_token_cache (id, bearer_token, expires_at, updated_at)
            values (1, %s, %s, now())
            on conflict (id)
            do update set bearer_token = excluded.bearer_token, expires_at = excluded.expires_at, updated_at = now()
            """,
            (token, expires_at),
        )
    conn.commit()


def save_user_cached_token(conn, token: str):
    safe_token = normalize_bearer_token(token)
    if not safe_token:
        return {"user_id": None, "expires_at": None}

    payload = parse_jwt_payload(safe_token)
    user_id = payload.get("id")
    user_id_text = str(user_id) if user_id is not None else None
    expires_at = parse_jwt_exp_to_utc(safe_token)
    if not expires_at:
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=18)

    save_cached_token(conn, safe_token, expires_at)

    if user_id_text:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into public.mcapi_user_token_cache (user_id, bearer_token, expires_at, updated_at)
                values (%s, %s, %s, now())
                on conflict (user_id)
                do update
                  set bearer_token = excluded.bearer_token,
                      expires_at = excluded.expires_at,
                      updated_at = now()
                """,
                (user_id_text, safe_token, expires_at),
            )
        conn.commit()

    return {"user_id": user_id_text, "expires_at": expires_at}


def get_user_cached_token(conn, user_id: str):
    safe_user_id = (user_id or "").strip()
    if not safe_user_id:
        return None, None
    with conn.cursor() as cur:
        cur.execute(
            """
            select bearer_token, expires_at
            from public.mcapi_user_token_cache
            where user_id = %s
            """,
            (safe_user_id,),
        )
        row = cur.fetchone()
    if not row:
        return None, None
    return row[0], row[1]


def get_latest_user_cached_token(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            select user_id, bearer_token, expires_at
            from public.mcapi_user_token_cache
            order by updated_at desc
            limit 1
            """
        )
        row = cur.fetchone()
    if not row:
        return None, None, None
    return row[0], row[1], row[2]


def resolve_user_bearer_token(
    conn,
    provided_token: str = "",
    preferred_user_id: str = "",
    allow_shared_fallback: bool = False,
):
    safe_provided = normalize_bearer_token(provided_token)
    if safe_provided:
        saved = save_user_cached_token(conn, safe_provided)
        return {
            "token": safe_provided,
            "source": "request_bearer",
            "user_id": saved.get("user_id"),
            "expires_at": saved.get("expires_at"),
        }

    safe_user_id = (preferred_user_id or "").strip()
    if safe_user_id:
        token, exp = get_user_cached_token(conn, safe_user_id)
        if token and token_is_valid(exp, margin_seconds=0):
            return {
                "token": token,
                "source": "user_cache",
                "user_id": safe_user_id,
                "expires_at": exp,
            }

    if allow_shared_fallback:
        latest_user_id, latest_token, latest_exp = get_latest_user_cached_token(conn)
        if latest_token and token_is_valid(latest_exp, margin_seconds=0):
            return {
                "token": latest_token,
                "source": "latest_user_cache",
                "user_id": latest_user_id,
                "expires_at": latest_exp,
            }

        cached_token, cached_exp = get_cached_token(conn)
        if cached_token and token_is_valid(cached_exp, margin_seconds=0):
            return {
                "token": cached_token,
                "source": "legacy_shared_cache",
                "user_id": None,
                "expires_at": cached_exp,
            }

    return {"token": None, "source": "none", "user_id": None, "expires_at": None}


def get_or_refresh_shared_token(conn, cfg, client_ip: str = None, force_refresh: bool = False):
    with conn.cursor() as cur:
        cur.execute("select pg_advisory_lock(%s);", (TOKEN_LOCK_KEY,))

    try:
        if not force_refresh:
            cached_token, cached_exp = get_cached_token(conn)
            if cached_token and token_is_valid(cached_exp):
                return {
                    "ok": True,
                    "token": cached_token,
                    "expires_at": cached_exp,
                    "from_cache": True,
                }

        login_status, login_req, login_resp, token = login(cfg["mc_username"], cfg["mc_password"])
        save_event(
            conn,
            event_type="login_refresh",
            status_code=login_status,
            bearer_token=token,
            request_payload=login_req,
            response_payload=login_resp,
            error_message=None if login_status < 400 else "login refresh failed",
            client_ip=client_ip,
        )

        if login_status >= 400 or not token:
            return {
                "ok": False,
                "token": None,
                "expires_at": None,
                "from_cache": False,
                "login_status": login_status,
                "login_response": login_resp,
            }

        expires_at = parse_jwt_exp_to_utc(token)
        if not expires_at:
            expires_at = datetime.now(timezone.utc) + timedelta(minutes=18)
        save_cached_token(conn, token, expires_at)
        save_user_cached_token(conn, token)

        return {
            "ok": True,
            "token": token,
            "expires_at": expires_at,
            "from_cache": False,
            "login_status": login_status,
            "login_response": login_resp,
        }
    finally:
        with conn.cursor() as cur:
            cur.execute("select pg_advisory_unlock(%s);", (TOKEN_LOCK_KEY,))


def get_or_refresh_memory_token(cfg, force_refresh: bool = False):
    with MEMORY_TOKEN_LOCK:
        cached_token = MEMORY_TOKEN_CACHE.get("token")
        cached_exp = MEMORY_TOKEN_CACHE.get("expires_at")
        if not force_refresh and cached_token and token_is_valid(cached_exp):
            return {
                "ok": True,
                "token": cached_token,
                "expires_at": cached_exp,
                "from_cache": True,
            }

        login_status, login_req, login_resp, token = login(cfg["mc_username"], cfg["mc_password"])
        if login_status >= 400 or not token:
            return {
                "ok": False,
                "token": None,
                "expires_at": None,
                "from_cache": False,
                "login_status": login_status,
                "login_response": login_resp,
            }

        expires_at = parse_jwt_exp_to_utc(token)
        if not expires_at:
            expires_at = datetime.now(timezone.utc) + timedelta(minutes=18)

        MEMORY_TOKEN_CACHE["token"] = token
        MEMORY_TOKEN_CACHE["expires_at"] = expires_at

        return {
            "ok": True,
            "token": token,
            "expires_at": expires_at,
            "from_cache": False,
            "login_status": login_status,
            "login_response": login_resp,
        }


def generate_access_without_db(client_ip: str = None, telefone: str = "", telegram_id: str = "", db_error: str = ""):
    cfg = load_mc_config()
    token_info = get_or_refresh_memory_token(cfg, force_refresh=False)
    if not token_info.get("ok"):
        return {
            "ok": False,
            "login_status": token_info.get("login_status"),
            "login_response": token_info.get("login_response"),
            "error": "Falha ao obter token compartilhado em memoria.",
            "storage": "memory",
            "db_error": db_error,
        }

    token = token_info["token"]
    lead_note = build_lead_note(telefone, telegram_id)
    test_status, test_req, test_resp = create_test_line(token, note_text=lead_note)

    if test_status in (401, 403):
        token_info = get_or_refresh_memory_token(cfg, force_refresh=True)
        if not token_info.get("ok"):
            return {
                "ok": False,
                "login_status": token_info.get("login_status"),
                "login_response": token_info.get("login_response"),
                "error": "Token em memoria expirou e nao foi possivel renovar.",
                "storage": "memory",
                "db_error": db_error,
            }
        token = token_info["token"]
        test_status, test_req, test_resp = create_test_line(token, note_text=lead_note)

    return {
        "ok": test_status < 400,
        "login_status": token_info.get("login_status"),
        "login_response": token_info.get("login_response"),
        "bearer_token": token,
        "test_status": test_status,
        "test_response": test_resp,
        "token_from_cache": token_info.get("from_cache", False),
        "storage": "memory",
        "db_error": db_error,
    }


def get_active_access_for_ip(client_ip: str):
    if not client_ip:
        return None

    conn, _ = open_db_from_env()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                select response_payload
                from public.mcapi_events
                where event_type = 'line_test'
                  and status_code < 400
                  and client_ip = %s
                order by created_at desc
                limit 1
                """,
                (client_ip,),
            )
            row = cur.fetchone()

        if not row:
            return None

        payload = row[0] if isinstance(row[0], dict) else {}
        exp_date = payload.get("exp_date")
        exp_utc = parse_iso_to_utc(exp_date)
        if not exp_utc or exp_utc <= datetime.now(timezone.utc):
            return None

        reused_payload = {
            "username": payload.get("username", ""),
            "password": payload.get("password", ""),
            "exp_date": exp_date,
        }
        save_event(
            conn,
            event_type="line_test_reuse",
            status_code=200,
            request_payload={"reason": "active_access_reused"},
            response_payload=reused_payload,
            client_ip=client_ip,
        )
        return reused_payload
    finally:
        conn.close()


def ensure_first_allowed_ip(conn, client_ip: str):
    if not client_ip:
        return False

    with conn.cursor() as cur:
        cur.execute("select count(*) from public.ip_liberados;")
        total = cur.fetchone()[0]
        if total == 0:
            cur.execute(
                """
                insert into public.ip_liberados (ip, descricao, ativo)
                values (%s, %s, true)
                on conflict (ip) do nothing
                """,
                (client_ip, "Primeiro IP liberado automaticamente"),
            )
            conn.commit()
            return True
    return False


def is_ip_liberado(conn, client_ip: str):
    with conn.cursor() as cur:
        cur.execute(
            """
            select exists (
              select 1
              from public.ip_liberados
              where ip = %s and ativo = true
            )
            """,
            (client_ip,),
        )
        return bool(cur.fetchone()[0])


def get_ip_usage(conn, client_ip: str):
    now_brt = datetime.now(BRAZIL_TZ)
    day_start_brt = now_brt.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start_brt = day_start_brt - timedelta(days=day_start_brt.weekday())

    day_start_utc = day_start_brt.astimezone(timezone.utc)
    week_start_utc = week_start_brt.astimezone(timezone.utc)

    with conn.cursor() as cur:
        cur.execute(
            """
            select
              count(*) filter (where created_at >= %s) as day_count,
              count(*) filter (where created_at >= %s) as week_count
            from public.mcapi_events
            where event_type = 'line_test'
              and status_code < 400
              and client_ip = %s
            """,
            (day_start_utc, week_start_utc, client_ip),
        )
        row = cur.fetchone()
        return int(row[0] or 0), int(row[1] or 0)


def check_ip_limits(client_ip: str):
    conn, _ = open_db_from_env()
    try:
        first_seeded = ensure_first_allowed_ip(conn, client_ip)
        liberado = is_ip_liberado(conn, client_ip)
        day_count, week_count = get_ip_usage(conn, client_ip)

        allowed_by_rule = day_count < 1 and week_count < 2
        allowed = liberado or allowed_by_rule

        reason = ""
        if not allowed:
            if day_count >= 1:
                reason = "Limite diario atingido: 1 geracao por dia para este IP."
            elif week_count >= 2:
                reason = "Limite semanal atingido: 2 geracoes por semana para este IP."
            else:
                reason = "Limite de IP atingido."

        return {
            "allowed": allowed,
            "is_liberado": liberado,
            "first_seeded": first_seeded,
            "day_count": day_count,
            "week_count": week_count,
            "reason": reason,
        }
    finally:
        conn.close()


def add_ip_liberado(client_ip: str, descricao: str = "Liberado manualmente"):
    conn, _ = open_db_from_env()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into public.ip_liberados (ip, descricao, ativo, updated_at)
                values (%s, %s, true, now())
                on conflict (ip)
                do update set ativo = true, descricao = excluded.descricao, updated_at = now()
                """,
                (client_ip, descricao),
            )
        conn.commit()
    finally:
        conn.close()


def remove_ip_liberado(client_ip: str):
    conn, _ = open_db_from_env()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                update public.ip_liberados
                set ativo = false, updated_at = now()
                where ip = %s
                """,
                (client_ip,),
            )
        conn.commit()
    finally:
        conn.close()


def list_ip_liberados():
    conn, _ = open_db_from_env()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                select ip, descricao, ativo, created_at, updated_at
                from public.ip_liberados
                order by ativo desc, created_at asc
                """
            )
            rows = cur.fetchall()

        data = []
        for row in rows:
            data.append(
                {
                    "ip": row[0],
                    "descricao": row[1] or "",
                    "ativo": bool(row[2]),
                    "created_at": row[3].astimezone(BRAZIL_TZ).strftime("%d/%m/%Y %H:%M:%S"),
                    "updated_at": row[4].astimezone(BRAZIL_TZ).strftime("%d/%m/%Y %H:%M:%S"),
                }
            )
        return data
    finally:
        conn.close()


def summarize_stream_payload(payload):
    if not isinstance(payload, dict):
        return {"ok": False}
    data = payload.get("data", [])
    sample = []
    if isinstance(data, list):
        for row in data[:3]:
            if isinstance(row, dict):
                sample.append(row.get("id"))
    return {
        "ok": True,
        "total": payload.get("total"),
        "count": len(data) if isinstance(data, list) else 0,
        "sample_ids": sample,
    }


def resolve_bearer_for_user(
    conn,
    cfg,
    *,
    provided_bearer: str = "",
    preferred_user_id: str = "",
    client_ip: str = None,
    allow_shared_fallback: bool = False,
):
    bearer_info = resolve_user_bearer_token(
        conn,
        provided_token=provided_bearer,
        preferred_user_id=preferred_user_id,
        allow_shared_fallback=allow_shared_fallback,
    )
    bearer_token = bearer_info.get("token")
    if not bearer_token and allow_shared_fallback:
        token_info = get_or_refresh_shared_token(conn, cfg, client_ip=client_ip, force_refresh=False)
        if token_info.get("ok") and token_info.get("token"):
            bearer_token = token_info.get("token")
            parsed = parse_jwt_payload(bearer_token)
            user_id_text = str(parsed.get("id")) if parsed.get("id") is not None else None
            bearer_info = {
                "source": "shared_token",
                "user_id": user_id_text,
                "expires_at": token_info.get("expires_at"),
            }

    return {
        "token": bearer_token,
        "source": bearer_info.get("source"),
        "user_id": bearer_info.get("user_id"),
        "expires_at": bearer_info.get("expires_at"),
    }


def fetch_recent_streams_for_user(
    provided_bearer: str = "",
    preferred_user_id: str = "",
    movies_limit: int = 12,
    channels_limit: int = 12,
    client_ip: str = None,
    allow_shared_fallback: bool = False,
):
    conn, cfg = open_db_from_env()
    try:
        bearer_info = resolve_bearer_for_user(
            conn,
            cfg,
            provided_bearer=provided_bearer,
            preferred_user_id=preferred_user_id,
            client_ip=client_ip,
            allow_shared_fallback=allow_shared_fallback,
        )
        bearer_token = bearer_info.get("token")

        if not bearer_token:
            return {
                "ok": False,
                "error": "Nenhum bearer disponivel para este usuario.",
                "token_source": bearer_info.get("source"),
                "user_id": bearer_info.get("user_id"),
                "movies": [],
                "channels": [],
                "merged": [],
            }

        movie_status, movie_req, movie_resp = fetch_resale_stream_page(bearer_token, "movie", page=1)
        save_event(
            conn,
            event_type="resale_movie_recent",
            status_code=movie_status,
            request_payload=movie_req,
            response_payload=summarize_stream_payload(movie_resp),
            error_message=None if movie_status < 400 else "movie recent fetch failed",
            client_ip=client_ip,
        )

        channel_status, channel_req, channel_resp = fetch_resale_stream_page(bearer_token, "canal", page=1)
        save_event(
            conn,
            event_type="resale_canal_recent",
            status_code=channel_status,
            request_payload=channel_req,
            response_payload=summarize_stream_payload(channel_resp),
            error_message=None if channel_status < 400 else "canal recent fetch failed",
            client_ip=client_ip,
        )

        movies = normalize_recent_stream_items(movie_resp, "movie", limit=movies_limit) if movie_status < 400 else []
        channels = normalize_recent_stream_items(channel_resp, "canal", limit=channels_limit) if channel_status < 400 else []
        merged = sorted(
            movies + channels,
            key=lambda item: item.get("sort_dt") or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )

        for row in merged:
            sort_dt = row.get("sort_dt")
            if not row.get("added") and sort_dt:
                row["added"] = sort_dt.astimezone(BRAZIL_TZ).strftime("%d/%m/%Y")
            row.pop("sort_dt", None)
        for row in movies:
            row.pop("sort_dt", None)
        for row in channels:
            row.pop("sort_dt", None)

        return {
            "ok": movie_status < 400 and channel_status < 400,
            "token_source": bearer_info.get("source"),
            "user_id": bearer_info.get("user_id"),
            "movie_status": movie_status,
            "channel_status": channel_status,
            "movies": movies,
            "channels": channels,
            "merged": merged,
        }
    finally:
        conn.close()


def fetch_catalog_request_tracks_for_user(
    provided_bearer: str = "",
    preferred_user_id: str = "",
    search_query: str = "ss",
    findall_limit: int = 18,
    tmdb_limit: int = 18,
    merged_limit: int = 20,
    client_ip: str = None,
    allow_shared_fallback: bool = False,
):
    conn, cfg = open_db_from_env()
    try:
        bearer_info = resolve_bearer_for_user(
            conn,
            cfg,
            provided_bearer=provided_bearer,
            preferred_user_id=preferred_user_id,
            client_ip=client_ip,
            allow_shared_fallback=allow_shared_fallback,
        )
        bearer_token = bearer_info.get("token")
        if not bearer_token:
            return {
                "ok": False,
                "error": "Nenhum bearer disponivel para esta consulta.",
                "token_source": bearer_info.get("source"),
                "user_id": bearer_info.get("user_id"),
                "findall_items": [],
                "tmdb_missing_items": [],
                "merged_items": [],
            }

        findall_status, findall_req, findall_resp = fetch_resale_findall_page(
            bearer_token,
            search_text=search_query,
            page=1,
        )
        save_event(
            conn,
            event_type="resale_findall_search",
            status_code=findall_status,
            request_payload=findall_req,
            response_payload=summarize_stream_payload(findall_resp),
            error_message=None if findall_status < 400 else "findall search failed",
            client_ip=client_ip,
        )
        findall_items = normalize_findall_search_items(findall_resp, limit=findall_limit) if findall_status < 400 else []

        tmdb_movie_status, tmdb_movie_req, tmdb_movie_resp = fetch_tmdb_search_movie_page(query=search_query, page=1)
        tmdb_movie_summary = (
            summarize_stream_payload({"data": tmdb_movie_resp.get("results", [])})
            if isinstance(tmdb_movie_resp, dict)
            else {"ok": False}
        )
        save_event(
            conn,
            event_type="tmdb_search_movie",
            status_code=tmdb_movie_status if tmdb_movie_status else None,
            request_payload=tmdb_movie_req,
            response_payload=tmdb_movie_summary,
            error_message=None if tmdb_movie_status == 200 else "tmdb movie search unavailable",
            client_ip=client_ip,
        )

        tmdb_tv_status, tmdb_tv_req, tmdb_tv_resp = fetch_tmdb_search_tv_page(query=search_query, page=1)
        tmdb_tv_summary = (
            summarize_stream_payload({"data": tmdb_tv_resp.get("results", [])})
            if isinstance(tmdb_tv_resp, dict)
            else {"ok": False}
        )
        save_event(
            conn,
            event_type="tmdb_search_tv",
            status_code=tmdb_tv_status if tmdb_tv_status else None,
            request_payload=tmdb_tv_req,
            response_payload=tmdb_tv_summary,
            error_message=None if tmdb_tv_status == 200 else "tmdb tv search unavailable",
            client_ip=client_ip,
        )

        tmdb_movie_items = normalize_tmdb_movie_items(tmdb_movie_resp, limit=tmdb_limit) if tmdb_movie_status == 200 else []
        tmdb_tv_items = normalize_tmdb_tv_items(tmdb_tv_resp, limit=tmdb_limit) if tmdb_tv_status == 200 else []
        tmdb_items = sorted(
            tmdb_movie_items + tmdb_tv_items,
            key=lambda item: item.get("sort_dt") or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        tmdb_status = 200 if (tmdb_movie_status == 200 or tmdb_tv_status == 200) else (tmdb_movie_status or tmdb_tv_status or 0)

        findall_items, tmdb_missing_items, merged_items = reconcile_findall_with_tmdb(
            findall_items,
            tmdb_items,
            merged_limit=merged_limit,
        )

        for row in merged_items:
            sort_dt = row.get("sort_dt")
            if not row.get("added") and sort_dt:
                row["added"] = sort_dt.astimezone(BRAZIL_TZ).strftime("%d/%m/%Y")
            row.pop("sort_dt", None)
        for row in findall_items:
            row.pop("sort_dt", None)
        for row in tmdb_missing_items:
            row.pop("sort_dt", None)

        return {
            "ok": findall_status < 400,
            "token_source": bearer_info.get("source"),
            "user_id": bearer_info.get("user_id"),
            "findall_status": findall_status,
            "tmdb_status": tmdb_status,
            "tmdb_movie_status": tmdb_movie_status,
            "tmdb_tv_status": tmdb_tv_status,
            "findall_items": findall_items,
            "tmdb_missing_items": tmdb_missing_items,
            "merged_items": merged_items,
        }
    finally:
        conn.close()


def submit_content_request_for_user(
    *,
    provided_bearer: str = "",
    preferred_user_id: str = "",
    content_name: str,
    content_type: str = "filme",
    tmdb_id: str = "",
    img_url: str = "",
    user_id: str = "",
    client_ip: str = None,
    allow_shared_fallback: bool = False,
):
    conn, cfg = open_db_from_env()
    try:
        bearer_info = resolve_bearer_for_user(
            conn,
            cfg,
            provided_bearer=provided_bearer,
            preferred_user_id=preferred_user_id,
            client_ip=client_ip,
            allow_shared_fallback=allow_shared_fallback,
        )
        bearer_token = bearer_info.get("token")
        if not bearer_token:
            return {
                "ok": False,
                "error": "Nenhum bearer disponivel para enviar pedido.",
                "token_source": bearer_info.get("source"),
                "user_id": bearer_info.get("user_id"),
            }

        resolved_user_id = (user_id or "").strip()
        if not resolved_user_id:
            resolved_user_id = (bearer_info.get("user_id") or "").strip()
        if not resolved_user_id:
            payload = parse_jwt_payload(bearer_token)
            if payload.get("id") is not None:
                resolved_user_id = str(payload.get("id"))

        status_code, request_payload, response_payload = create_resale_content_request(
            bearer_token,
            content_name=content_name,
            content_type=content_type,
            tmdb_id=tmdb_id,
            img_url=img_url,
            user_id=resolved_user_id,
        )
        save_event(
            conn,
            event_type="resale_content_request",
            status_code=status_code,
            request_payload=request_payload,
            response_payload=response_payload if isinstance(response_payload, dict) else {"raw": str(response_payload)},
            error_message=None if status_code < 400 else "content request failed",
            client_ip=client_ip,
        )

        ok = status_code < 400 and isinstance(response_payload, dict)
        return {
            "ok": ok,
            "status_code": status_code,
            "token_source": bearer_info.get("source"),
            "user_id": resolved_user_id,
            "request_payload": request_payload,
            "response": response_payload,
        }
    finally:
        conn.close()


def get_nested_value(data: dict, *path):
    value = data
    for key in path:
        if not isinstance(value, dict):
            return ""
        value = value.get(key)
    return value if value is not None else ""


def make_kirvano_webhook_key(payload: dict) -> str:
    event = str(payload.get("event") or "UNKNOWN").strip().upper()
    sale_id = str(payload.get("sale_id") or "").strip()
    checkout_id = str(payload.get("checkout_id") or "").strip()
    created_at = str(payload.get("created_at") or get_nested_value(payload, "payment", "finished_at") or "").strip()

    parts = [event, sale_id or checkout_id, created_at]
    if any(parts[1:]):
        return ":".join(part or "-" for part in parts)

    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()
    return f"{event}:{digest}"


def extract_kirvano_customer(payload: dict) -> dict:
    customer = payload.get("customer") if isinstance(payload.get("customer"), dict) else {}
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    custom_fields = payload.get("custom_fields") if isinstance(payload.get("custom_fields"), dict) else {}

    telegram_id = (
        customer.get("telegram_id")
        or metadata.get("telegram_id")
        or custom_fields.get("telegram_id")
        or payload.get("telegram_id")
        or ""
    )

    return {
        "name": str(customer.get("name") or payload.get("customer_name") or "").strip(),
        "email": str(customer.get("email") or payload.get("customer_email") or "").strip(),
        "phone": str(customer.get("phone_number") or customer.get("phone") or payload.get("phone_number") or "").strip(),
        "telegram_id": str(telegram_id or "").strip(),
    }


def build_kirvano_public_result(result: dict) -> dict:
    test_response = result.get("test_response") if isinstance(result.get("test_response"), dict) else {}
    username = test_response.get("username", "")
    password = test_response.get("password", "")
    ok = bool(result.get("ok") and username and password)
    return {
        "ok": ok,
        "test_status": result.get("test_status"),
        "token_from_cache": bool(result.get("token_from_cache")),
        "storage": result.get("storage", "supabase"),
        "access": {
            "username": username,
            "password": password,
            "exp_date": test_response.get("exp_date", ""),
        },
        "error": result.get("error", "") if ok else result.get("error", "") or "MCAPI nao retornou usuario/senha.",
    }


def process_kirvano_webhook(payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {"ok": False, "error": "Payload invalido."}

    event = str(payload.get("event") or "").strip().upper()
    status = str(payload.get("status") or "").strip().upper()
    sale_id = str(payload.get("sale_id") or "").strip()
    checkout_id = str(payload.get("checkout_id") or "").strip()
    webhook_key = make_kirvano_webhook_key(payload)
    customer = extract_kirvano_customer(payload)
    should_release_access = event in KIRVANO_ACCESS_EVENTS and status in KIRVANO_APPROVED_STATUSES

    try:
        conn, _ = open_db_from_env()
    except Exception:
        if not should_release_access:
            return {
                "ok": True,
                "action": "ignored",
                "reason": "Evento sem liberacao de acesso.",
                "event": event,
                "status": status,
                "storage": "memory",
                "db_available": False,
            }

        with MEMORY_WEBHOOK_LOCK:
            cached_result = MEMORY_WEBHOOK_RESULTS.get(webhook_key)
            if cached_result:
                return {**cached_result, "duplicate": True, "action": "already_processed"}

            lead_key = sale_id or checkout_id or webhook_key
            result = generate_access_once(
                client_ip=f"kirvano:{lead_key}",
                telefone=customer["phone"],
                telegram_id=customer["telegram_id"],
            )
            public_result = {
                **build_kirvano_public_result(result),
                "webhook_key": webhook_key,
                "event": event,
                "sale_id": sale_id,
                "checkout_id": checkout_id,
                "db_available": False,
            }
            if public_result.get("ok"):
                MEMORY_WEBHOOK_RESULTS[webhook_key] = public_result
            return public_result

    try:
        with conn.cursor() as cur:
            cur.execute("select pg_advisory_lock(hashtext(%s));", (webhook_key,))

        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.kirvano_webhooks (
                      webhook_key, event, sale_id, checkout_id, status,
                      customer_name, customer_email, customer_phone,
                      request_payload, updated_at
                    )
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                    on conflict (webhook_key)
                    do update set
                      status = excluded.status,
                      customer_name = excluded.customer_name,
                      customer_email = excluded.customer_email,
                      customer_phone = excluded.customer_phone,
                      request_payload = excluded.request_payload,
                      updated_at = now()
                    returning processed_at, access_username, access_password, access_exp_date, result_payload
                    """,
                    (
                        webhook_key,
                        event or "UNKNOWN",
                        sale_id or None,
                        checkout_id or None,
                        status or None,
                        customer["name"] or None,
                        customer["email"] or None,
                        customer["phone"] or None,
                        Json(payload),
                    ),
                )
                row = cur.fetchone()
            conn.commit()

            if row and row[0] and row[1]:
                return {
                    "ok": True,
                    "duplicate": True,
                    "action": "already_processed",
                    "webhook_key": webhook_key,
                    "event": event,
                    "access": {
                        "username": row[1],
                        "password": row[2] or "",
                        "exp_date": row[3].isoformat() if row[3] else "",
                    },
                }

            if not should_release_access:
                ignored_result = {
                    "ok": True,
                    "action": "ignored",
                    "reason": "Evento sem liberacao de acesso.",
                    "event": event,
                    "status": status,
                }
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        update public.kirvano_webhooks
                        set result_payload = %s,
                            error_message = null,
                            updated_at = now()
                        where webhook_key = %s
                        """,
                        (Json(ignored_result), webhook_key),
                    )
                conn.commit()
                return ignored_result

            lead_key = sale_id or checkout_id or webhook_key
            client_key = f"kirvano:{lead_key}"
            result = generate_access_once(
                client_ip=client_key,
                telefone=customer["phone"],
                telegram_id=customer["telegram_id"],
            )
            public_result = build_kirvano_public_result(result)
            access = public_result["access"]
            access_exp = parse_iso_to_utc(access.get("exp_date")) if access.get("exp_date") else None

            with conn.cursor() as cur:
                cur.execute(
                    """
                    update public.kirvano_webhooks
                    set access_username = %s,
                        access_password = %s,
                        access_exp_date = %s,
                        result_payload = %s,
                        processed_at = case when %s then now() else processed_at end,
                        error_message = %s,
                        updated_at = now()
                    where webhook_key = %s
                    """,
                    (
                        access.get("username") or None,
                        access.get("password") or None,
                        access_exp,
                        Json(public_result),
                        bool(public_result["ok"]),
                        None if public_result["ok"] else public_result.get("error") or "Falha ao gerar acesso.",
                        webhook_key,
                    ),
                )
            conn.commit()

            return {
                **public_result,
                "webhook_key": webhook_key,
                "event": event,
                "sale_id": sale_id,
                "checkout_id": checkout_id,
            }
        finally:
            with conn.cursor() as cur:
                cur.execute("select pg_advisory_unlock(hashtext(%s));", (webhook_key,))
            conn.commit()
    finally:
        conn.close()


def generate_access_once(client_ip: str = None, telefone: str = "", telegram_id: str = ""):
    try:
        conn, cfg = open_db_from_env()
    except Exception as exc:
        return generate_access_without_db(
            client_ip=client_ip,
            telefone=telefone,
            telegram_id=telegram_id,
            db_error=str(exc),
        )

    try:
        token_info = get_or_refresh_shared_token(conn, cfg, client_ip=client_ip, force_refresh=False)
        if not token_info.get("ok"):
            return {
                "ok": False,
                "login_status": token_info.get("login_status"),
                "login_response": token_info.get("login_response"),
                "error": "Falha ao obter token compartilhado.",
            }

        token = token_info["token"]
        lead_note = build_lead_note(telefone, telegram_id)
        test_status, test_req, test_resp = create_test_line(token, note_text=lead_note)

        if test_status in (401, 403):
            save_event(
                conn,
                event_type="line_test_token_expired",
                status_code=test_status,
                bearer_token=token,
                request_payload=test_req,
                response_payload=test_resp,
                error_message="token expirado/invalido - tentando refresh",
                client_ip=client_ip,
            )
            token_info = get_or_refresh_shared_token(conn, cfg, client_ip=client_ip, force_refresh=True)
            if not token_info.get("ok"):
                return {
                    "ok": False,
                    "login_status": token_info.get("login_status"),
                    "login_response": token_info.get("login_response"),
                    "error": "Token expirou e nao foi possivel renovar.",
                }
            token = token_info["token"]
            test_status, test_req, test_resp = create_test_line(token, note_text=lead_note)

        save_event(
            conn,
            event_type="line_test",
            status_code=test_status,
            bearer_token=token,
            request_payload=test_req,
            response_payload=test_resp,
            error_message=None if test_status < 400 else "line test failed",
            client_ip=client_ip,
        )

        if test_status < 400 and isinstance(test_resp, dict):
            upsert_usuario_criado_ip(
                conn,
                client_ip=client_ip or "",
                username=test_resp.get("username", ""),
                telefone=telefone,
                telegram_id=telegram_id,
                exp_date_text=test_resp.get("exp_date", ""),
            )
            send_greenapi_photo_on_generation(conn, telefone, client_ip=client_ip)

        return {
            "ok": test_status < 400,
            "login_status": token_info.get("login_status"),
            "login_response": token_info.get("login_response"),
            "bearer_token": token,
            "test_status": test_status,
            "test_response": test_resp,
            "token_from_cache": token_info.get("from_cache", False),
        }
    finally:
        conn.close()


if __name__ == "__main__":
    print(generate_access_once())
