"""Encurtador: fala com o servico de links do Fabio (o mesmo do urtador).

A chave usada aqui e a mesma que o site publico do encurtador ja entrega no proprio
HTML (a chave publicavel), entao nao e segredo. O que nunca fica no codigo e o token
de sessao (URTADOR_TOKEN), que so vem de variavel de ambiente.

Sem token o link e criado como visita (limite de 10 por minuto por IP). Com token o
link fica na conta dele e o limite sobe para 30 por minuto.
"""

from __future__ import annotations

import os
import re
import uuid

import requests

API_PADRAO = "https://ggufcvrwctieacvbbwim.supabase.co/functions/v1/kutt-short-links"
CHAVE_PUBLICAVEL_PADRAO = "sb_publishable_RP6trGNKQOv2EKEl0tqfkw_xHkbIylG"
BASE_PADRAO = "https://kuttenc.github.io/urtador"

# Nomes que ja sao paginas do proprio encurtador: um link curto com um desses nunca
# abre, porque o GitHub Pages entrega a pagina em vez do redirecionamento.
RESERVADOS = {
    "index", "404", "admin", "guia", "sobre", "privacidade", "nes", "snes", "ps2",
    "emulador", "investindo", "aluguel", "peixeiro-pedidos", "rapidao", "assets",
    "robots", "sitemap", "ads", "api", "painel",
}

SLUG_BOM = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
URL_BOM = re.compile(r"^https?://[^\s/$.?#].[^\s]*$", re.I)


def _cfg() -> dict:
    return {
        "api": (os.getenv("URTADOR_API_URL") or API_PADRAO).strip(),
        "chave": (os.getenv("URTADOR_API_KEY") or CHAVE_PUBLICAVEL_PADRAO).strip(),
        "token": (os.getenv("URTADOR_TOKEN") or "").strip(),
        "sessao": (os.getenv("URTADOR_SESSAO") or "").strip(),
        "base": (os.getenv("URTADOR_BASE_URL") or BASE_PADRAO).strip().rstrip("/"),
    }


def base() -> str:
    """Prefixo dos links curtos, sem barra no fim."""
    return _cfg()["base"]


def autenticado() -> bool:
    return bool(_cfg()["token"])


def _cabecalhos(cfg: dict) -> dict:
    cab = {"Content-Type": "application/json", "apikey": cfg["chave"]}
    if cfg["token"]:
        cab["Authorization"] = "Bearer " + cfg["token"]
    return cab


def _corpo_base(cfg: dict) -> dict:
    """Com token nao mandamos sessao de visita; sem token, uma sessao estavel evita
    estourar o limite de 10/min - e sem configuracao usamos uma nova por chamada."""
    if cfg["token"]:
        return {}
    return {"guestSessionId": cfg["sessao"] or str(uuid.uuid4())}


def limpar_slug(slug) -> str:
    """Mesma regra do servidor: minusculo, so letra/numero/traco, ate 48."""
    texto = re.sub(r"[^a-z0-9_-]+", "-", str(slug or "").strip().lower())
    return texto.strip("-")[:48]


def _erro(dados: dict, status: int) -> dict:
    return {"ok": False,
            "erro": str(dados.get("error") or "o encurtador respondeu %s" % status)[:200]}


def encurtar(url: str, slug: str = "", titulo: str = "", timeout: int = 15) -> dict:
    """Encurta um endereco. Nunca levanta excecao: se o encurtador estiver fora volta
    ok=False e o chamador usa o endereco comprido (mensagem nao pode falhar por isso)."""
    alvo = str(url or "").strip()
    if not URL_BOM.match(alvo):
        return {"ok": False, "erro": "o endereco precisa comecar com http:// ou https://"}
    cfg = _cfg()
    corpo = {"action": "create", "url": alvo, "title": str(titulo or "").strip()[:120]}
    corpo.update(_corpo_base(cfg))
    pedido = limpar_slug(slug)
    if pedido:
        if pedido in RESERVADOS:
            return {"ok": False,
                    "erro": "o final '%s' ja e uma pagina do encurtador, escolha outro" % pedido}
        corpo["slug"] = pedido
    try:
        resp = requests.post(cfg["api"], headers=_cabecalhos(cfg), json=corpo, timeout=timeout)
        dados = resp.json() if (resp.text or "").strip() else {}
    except Exception as exc:
        return {"ok": False, "erro": "o encurtador nao respondeu (%s)" % type(exc).__name__}
    if resp.status_code >= 400 or not dados.get("slug"):
        return _erro(dados, resp.status_code)
    return {"ok": True,
            "curto": dados.get("shortUrl") or "%s/%s" % (cfg["base"], dados["slug"]),
            "slug": dados["slug"], "alvo": dados.get("url") or alvo,
            "visita": not cfg["token"]}


def resolver(slug: str, timeout: int = 15) -> dict:
    """Para onde um link curto aponta agora - da para conferir antes de mandar."""
    pedido = limpar_slug(str(slug or "").strip().rstrip("/").rsplit("/", 1)[-1])
    if not pedido or not SLUG_BOM.match(pedido):
        return {"ok": False, "erro": "final de link invalido"}
    cfg = _cfg()
    corpo = {"action": "resolve", "slug": pedido}
    corpo.update(_corpo_base(cfg))
    try:
        resp = requests.post(cfg["api"], headers=_cabecalhos(cfg), json=corpo, timeout=timeout)
        dados = resp.json() if (resp.text or "").strip() else {}
    except Exception as exc:
        return {"ok": False, "erro": "o encurtador nao respondeu (%s)" % type(exc).__name__}
    if resp.status_code >= 400 or not dados.get("url"):
        return _erro(dados, resp.status_code)
    return {"ok": True, "curto": "%s/%s" % (cfg["base"], pedido),
            "alvo": dados["url"], "slug": pedido}
