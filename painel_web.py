"""Painel online: as telas do .exe hospedadas no proprio site do Render.

Tudo que fala com o painel MC, com o GreenAPI ou com o Supabase acontece aqui no
servidor, entao nenhuma chave aparece no navegador de quem abre a pagina.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import threading
import time
import unicodedata
from datetime import datetime, timezone

import requests
from flask import Blueprint, Response, jsonify, redirect, render_template, request, url_for

import automate_mcapi as mc
import encurtador

PAINEL = Blueprint("painel", __name__, url_prefix="/painel")

COOKIE = "painel_sessao"
DIAS_SESSAO = 30
LIMITE_TENTATIVAS = 8
JANELA_TENTATIVAS = 600

CAMPOS_TEXTO = (
    "api_url",
    "media_url",
    "id_instance",
    "api_token",
    "instance_name",
    "owner_phone",
    "caption",
    "aviso_pix_key",
    "aviso_pix_mascara",
    "aviso_titulo",
    "aviso_rodape",
    "aviso_legenda",
    "aviso_token",
    "renova_legenda",
    "recupera_legenda",
)
CAMPOS_BOOL = ("send_photo", "aviso_ativo", "renova_ativo")
CAMPOS_NUMERICO = ("aviso_dias", "renova_dias", "renova_janela_dias")
OBRIGATORIOS = ("api_url", "media_url", "id_instance", "api_token")
# idInstance e apiTokenInstance só são gravados depois de clicar em "Editar variáveis".
TRAVADOS = ("id_instance", "api_token")
QR_BASE = "https://qr.green-api.com/waInstance"
LIMITE_FOTO = 1_500_000

MSG_OK = {
    "gravado": "Gravado no banco. O site e a agenda das 6h ja usam esses valores.",
    "enviado": "Aviso(s) enviado(s) e registrado no controle do site (nao vai repetir).",
    "varrido": "Varredura rodou agora.",
    "apagado": "Acesso apagado do painel MC.",
    "recuperado": "Mensagem enviada e guardada no Supabase (a agenda das 6h so repete depois dos dias configurados).",
    "sincronizado": "Espelho do MC atualizado no Supabase.",
    "importado": "CSV lido e gravado no Supabase (telefone tambem foi para a lista de envios).",
    "telefone": "Telefone guardado no banco. Ja da para usar o botao recuperar.",
    "mesclado": "Telefone copiado de um usuario para o outro (nada foi apagado).",
    "senha": "Senha trocada. Faca login de novo com a senha nova.",
    "foto": "Foto nova gravada no banco.",
    "foto_removida": "Foto removida do banco.",
    "recupera_gravado": "Salvo. Todo clique em recuperar agora sai com essa mensagem.",
    "recupera_foto": "Foto da recuperação gravada no banco.",
    "recupera_foto_removida": "Foto da recuperação removida. O recuperar volta a mandar só texto.",
    "recupera_foto_ligado": "Envio da foto LIGADO. Todo clique em recuperar agora sai com essa imagem junto.",
    "recupera_foto_desligado": "Envio da foto desligado. O recuperar manda só o texto, mas a foto continua guardada.",
}
MSG_ERRO = {
    "senha": "Senha errada.",
    "muitas": "Muitas tentativas seguidas. Espere uns 10 minutos e tente de novo.",
    "gravado": "O banco recusou a gravacao.",
    "obrigatorio": "Faltou apiUrl, mediaUrl, idInstance ou apiToken.",
    "numero": "Os campos de dias precisam ser um número (pode usar vírgula).",
    "foto_grande": "Foto maior que 1,5 MB. Escolha uma menor.",
    "sem_foto": "Voce ligou o envio automatico, mas nao ha foto guardada. O envio ficou desligado.",
    "sem_foto_recupera": "Voce ligou a foto da recuperação, mas ainda nao ha foto guardada aqui. Escolha o arquivo e salve de novo.",
    "enviar": "Nenhum aviso conseguiu ser enviado.",
    "cota": "O GreenAPI esta sem saldo de mensagens do mes. Nenhum WhatsApp saiu.",
    "apagar": "O painel MC recusou a exclusao.",
    "sem_confirmar": "Marque a caixa de confirmacao para apagar.",
    "sem_palavra": "Escreva a palavra deletar para liberar o botao.",
    "banco": "O site nao conseguiu falar com o banco agora. Tente de novo em um minuto.",
    "mc_login": "O site nao conseguiu logar no painel MC (MC_USERNAME/MC_PASSWORD).",
    "sem_destino": "Nenhum destinatario selecionado (ou ninguem com telefone).",
    "sem_telefone": "Este acesso esta sem telefone: digite o numero na caixinha da linha e salve, depois use o recuperar.",
    "telefone_invalido": "Telefone incompleto: digite o DDD e os 8 ou 9 numeros, como (11) 91234-5678.",
    "origem_sem_telefone": "Quem vai emprestar o telefone esta sem numero: cadastre primeiro na caixinha da linha.",
    "mesmo_usuario": "Escolha dois usuarios diferentes para mesclar.",
    "csv_vazio": "O CSV nao veio, ou nao tem nenhuma linha com usuario.",
    "csv_cabecalho": "Use as colunas Usuario, Telefone, Expira, Status, Nota (na ordem ou no cabecalho).",
}

_tentativas: dict = {}
_hash_cache: dict = {"valor": None, "quando": 0.0}
_estado_cache: dict = {"chave": "", "valor": None, "quando": 0.0}
_info_cache: dict = {"chave": "", "valor": None, "quando": 0.0}
ESTADO_TTL = 180


def _ip() -> str:
    return (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or (request.remote_addr or "?")


def _muitas_tentativas(ip: str) -> bool:
    agora = time.time()
    historico = [t for t in _tentativas.get(ip, []) if agora - t < JANELA_TENTATIVAS]
    _tentativas[ip] = historico
    return len(historico) >= LIMITE_TENTATIVAS


def _registrar_tentativa(ip: str) -> None:
    _tentativas.setdefault(ip, []).append(time.time())


def _zerar_tentativas(ip: str) -> None:
    _tentativas.pop(ip, None)


def hash_senha(senha: str, salt: str = None, iteracoes: int = 200_000) -> str:
    salt = salt or base64.urlsafe_b64encode(os.urandom(16)).decode("ascii")
    derivada = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), salt.encode("utf-8"), iteracoes, dklen=32)
    return "pbkdf2_sha256$%d$%s$%s" % (iteracoes, salt, derivada.hex())


def _confere_senha(senha: str, armazenada: str) -> bool:
    try:
        _, iteracoes, salt, hexdigest = armazenada.split("$")
        derivada = hashlib.pbkdf2_hmac("sha256", senha.encode("utf-8"), salt.encode("utf-8"), int(iteracoes), dklen=32)
        return hmac.compare_digest(derivada.hex(), hexdigest)
    except Exception:
        return False


def _chave_sessao(armazenada: str) -> bytes:
    return hashlib.sha256(("painel-sessao|" + armazenada).encode("utf-8")).digest()


def _novo_token(armazenada: str) -> str:
    expira = int(time.time()) + DIAS_SESSAO * 86400
    assinatura = hmac.new(_chave_sessao(armazenada), str(expira).encode(), hashlib.sha256).hexdigest()
    return "%d.%s" % (expira, assinatura)


def _token_valido(token: str, armazenada: str) -> bool:
    try:
        expira, assinatura = token.split(".")
    except ValueError:
        return False
    esperada = hmac.new(_chave_sessao(armazenada), expira.encode(), hashlib.sha256).hexdigest()
    return int(expira) > time.time() and hmac.compare_digest(assinatura, esperada)


def _db():
    conn, cfg = mc.open_db_from_env()
    return conn, cfg


def _hash_armazenado(conn) -> str:
    with conn.cursor() as cur:
        cur.execute("select painel_senha_hash from public.greenapi_config where id = 1")
        row = cur.fetchone()
    return (row[0] or "") if row else ""


def _hash_cacheado() -> str:
    agora = time.time()
    if _hash_cache["valor"] is not None and agora - _hash_cache["quando"] < 60:
        return _hash_cache["valor"]
    conn, _ = _db()
    try:
        valor = _hash_armazenado(conn)
    finally:
        conn.close()
    _hash_cache["valor"], _hash_cache["quando"] = valor, agora
    return valor


@PAINEL.before_request
def _exige_login():
    if request.endpoint in ("painel.entrar", "painel.sair"):
        return None
    token = request.cookies.get(COOKIE)
    if not token:
        return redirect(url_for("painel.entrar"))
    try:
        armazenado = _hash_cacheado()
    except Exception:
        return render_template("painel_erro.html", motivo=MSG_ERRO["banco"]), 503
    if not armazenado or not _token_valido(token, armazenado):
        return redirect(url_for("painel.entrar"))
    return None


@PAINEL.context_processor
def _utilitarios():
    return {
        "msg_ok": MSG_OK.get(request.args.get("ok", ""), ""),
        "msg_erro": MSG_ERRO.get(request.args.get("erro", ""), ""),
        "telefone_br": mc.formatar_telefone,
        "agora": datetime.now(timezone.utc).strftime("%d/%m %H:%M"),
    }


@PAINEL.route("/entrar", methods=["GET", "POST"])
def entrar():
    ip = _ip()
    if request.method == "POST":
        if _muitas_tentativas(ip):
            return render_template("painel_login.html", erro=MSG_ERRO["muitas"]), 429
        conn, _ = _db()
        try:
            armazenado = _hash_armazenado(conn)
        finally:
            conn.close()
        if armazenado and _confere_senha((request.form.get("senha") or "").strip(), armazenado):
            _zerar_tentativas(ip)
            _hash_cache["valor"], _hash_cache["quando"] = armazenado, time.time()
            resposta = redirect(url_for("painel.index"))
            resposta.set_cookie(
                COOKIE,
                _novo_token(armazenado),
                max_age=DIAS_SESSAO * 86400,
                httponly=True,
                samesite="Lax",
                secure=True,
                path="/",
            )
            return resposta
        _registrar_tentativa(ip)
        return render_template("painel_login.html", erro=MSG_ERRO["senha"]), 401
    return render_template("painel_login.html", erro="")


@PAINEL.route("/sair")
def sair():
    resposta = redirect(url_for("painel.entrar"))
    resposta.delete_cookie(COOKIE, path="/")
    return resposta


def _estado_instancia(conf: dict, recarregar: bool = False) -> dict:
    """O getStateInstance pode levar meio minuto no plano free, então guardamos a última resposta."""
    if not (conf.get("api_url") and conf.get("id_instance") and conf.get("api_token")):
        return {"ok": False, "state": "sem configuracao"}
    api_base = mc.api_base_greenapi(conf)
    inst = (conf.get("id_instance") or "").strip()
    token = (conf.get("api_token") or "").strip()
    chave = "%s|%s|%s" % (api_base, inst, token)
    agora = time.time()
    if (not recarregar and _estado_cache["chave"] == chave
            and _estado_cache["valor"] is not None and agora - _estado_cache["quando"] < ESTADO_TTL):
        return _estado_cache["valor"]
    url = "%s/waInstance%s/getStateInstance/%s" % (api_base, inst, token)
    try:
        resp = requests.get(url, timeout=12)
        body = resp.json() if (resp.headers.get("content-type") or "").startswith("application/json") else {}
    except Exception as exc:
        texto = str(exc)
        curto = "O GreenAPI demorou para responder. Abra de novo." if "timed out" in texto else texto[:160]
        saida = {"ok": False, "state": "sem resposta", "error": curto}
        _estado_cache.update({"chave": chave, "valor": saida, "quando": agora})
        return saida
    estado = str(body.get("stateInstance") or body.get("state") or body.get("errorCode") or "").upper()
    saida = {"ok": resp.status_code < 400, "state": estado or "DESCONHECIDO", "status_code": resp.status_code}
    _estado_cache.update({"chave": chave, "valor": saida, "quando": agora})
    return saida


@PAINEL.route("/")
def index():
    conn, cfg = _db()
    try:
        conf = mc.get_greenapi_config(conn)
        com_telefone = _telefones(conn)
        com_aviso = _ja_avisados(conn)
    finally:
        conn.close()
    return render_template(
        "painel_index.html",
        conf=conf,
        estado=_estado_instancia(conf, request.args.get("estado") == "1"),
        tem_foto=bool(conf.get("photo_base64")),
        foto_kb=round(len(conf.get("photo_base64") or "") / 1024),
        qr_link=_qr_link(conf),
        total_telefones=len(com_telefone),
        total_avisados=len(com_aviso),
        erro_db="",
    )


def _qr_link(conf: dict) -> str:
    """O link do QR é sempre montado a partir de idInstance + apiTokenInstance."""
    inst, token = (conf.get("id_instance") or "").strip(), (conf.get("api_token") or "").strip()
    if inst and token:
        return "%s%s/%s" % (QR_BASE, inst, token)
    return (conf.get("qr_url") or "").strip()


def _telefones(conn) -> dict:
    return mc.telefones_por_usuario(conn)


def _ja_avisados(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("select username, exp_date from public.vencimento_avisos")
        return {"%s|%s" % (str(u).strip(), str(e).strip()) for u, e in cur.fetchall()}


def _infos_instancia(conf: dict, recarregar: bool = False) -> dict:
    """Pergunta para a própria instância quem ela é, para conferir se a troca pegou."""
    chave = "%s|%s|%s" % (mc.api_base_greenapi(conf), conf.get("id_instance"), conf.get("api_token"))
    agora = time.time()
    if (not recarregar and _info_cache["chave"] == chave
            and _info_cache["valor"] is not None and agora - _info_cache["quando"] < ESTADO_TTL):
        return _info_cache["valor"]
    saida = mc.greenapi_get_settings(conf)
    _info_cache.update({"chave": chave, "valor": saida, "quando": agora})
    return saida


@PAINEL.route("/config", methods=["GET", "POST"])
def config():
    conn, cfg = _db()
    try:
        if request.method == "POST":
            campos = {c: (request.form.get(c) or "").strip() for c in CAMPOS_TEXTO}
            if request.form.get("editar_instancia") != "1":
                for c in TRAVADOS:
                    campos.pop(c, None)
            for c in CAMPOS_BOOL:
                campos[c] = request.form.get(c) == "on"
            for c in CAMPOS_NUMERICO:
                bruto = (request.form.get(c) or "").strip().replace(",", ".")
                if not bruto:
                    continue
                try:
                    campos[c] = float(bruto)
                except ValueError:
                    return redirect(url_for("painel.config", erro="numero"))

            faltando = [c for c in OBRIGATORIOS if c in campos and not campos[c]]
            if faltando:
                return redirect(url_for("painel.config", erro="obrigatorio"))

            avisos = []
            upload = request.files.get("foto")
            if upload and upload.filename:
                bruto = upload.read()
                if len(bruto) > 1_500_000:
                    return redirect(url_for("painel.config", erro="foto_grande"))
                campos["photo_base64"] = base64.b64encode(bruto).decode("ascii")
                campos["photo_name"] = os.path.basename(upload.filename)
            if request.form.get("limpar_foto") == "1":
                campos["photo_base64"], campos["photo_name"] = "", ""
                campos["send_photo"] = False
                avisos = ["foto_removida"]

            tem_foto = bool(campos.get("photo_base64") or cfg_foto(conn))
            if campos["send_photo"] and not tem_foto:
                campos["send_photo"] = False
                avisos = ["sem_foto"]

            resultado = mc.atualizar_greenapi_config(conn, campos)
            if not resultado.get("ok"):
                return redirect(url_for("painel.config", erro="gravado"))
            _hash_cache["valor"] = None
            _info_cache["valor"] = None
            destino = {"ok": "gravado"}
            if avisos == ["foto_removida"]:
                destino = {"ok": "foto_removida"}
            elif avisos == ["sem_foto"]:
                destino = {"erro": "sem_foto", "ok": "gravado"}
            if resultado.get("ajuste"):
                destino["ajuste"] = resultado["ajuste"][:180]
            return redirect(url_for("painel.config", **destino))

        conf = mc.get_greenapi_config(conn)
    finally:
        conn.close()
    return render_template(
        "painel_config.html",
        conf=conf,
        estado=_estado_instancia(conf, request.args.get("estado") == "1"),
        infos=_infos_instancia(conf, request.args.get("estado") == "1"),
        qr_link=_qr_link(conf),
        qr_base=QR_BASE,
    )


def cfg_foto(conn) -> bool:
    with conn.cursor() as cur:
        cur.execute("select photo_base64 from public.greenapi_config where id = 1")
        row = cur.fetchone()
    return bool(row and row[0])


@PAINEL.route("/avisos", methods=["GET"])
def avisos():
    conn, cfg = _db()
    try:
        conf = mc.get_greenapi_config(conn)
        telefones = _telefones(conn)
        avisados = _ja_avisados(conn)
        limite = float(request.args.get("dias") or conf.get("aviso_dias") or 2)
        mostrar_todos = request.args.get("todos") == "1"
        token_info = mc.get_or_refresh_shared_token(conn, cfg, client_ip=_ip())
        linhas, status = ([], None)
        if token_info.get("ok"):
            linhas, status = mc.coletar_linhas_vencendo(token_info["token"], limite * 24.0)
    finally:
        conn.close()

    itens = []
    for linha in linhas:
        chave = "%s|%s" % (linha["username"], linha["exp_date"])
        itens.append(
            {
                **linha,
                "telefone": telefones.get(linha["username"], ""),
                "ja_enviado": chave in avisados,
                "chave": chave,
            }
        )
    if not mostrar_todos:
        itens = [i for i in itens if not i["ja_enviado"]]

    previa, texto_dias = "", ""
    try:
        texto_dias = itens[0]["texto_dias"] if itens else mc.texto_dias_restantes(limite * 24.0)
        previa = "data:image/png;base64," + base64.b64encode(
            mc.gerar_imagem_aviso(conf, texto_dias)
        ).decode("ascii")
    except Exception:
        previa = ""

    return render_template(
        "painel_avisos.html",
        conf=conf,
        itens=itens,
        limite=limite,
        previa_dias=texto_dias or "%.1f dias" % limite,
        mostrar_todos=mostrar_todos,
        previa=previa,
        com_telefone=len([i for i in itens if i["telefone"]]),
        sem_token=not token_info.get("ok"),
        lines_status=status,
    )


def _legenda(conf: dict, texto_dias: str) -> str:
    return mc.legenda_aviso(conf, texto_dias)


@PAINEL.route("/avisos/enviar", methods=["POST"])
def avisos_enviar():
    conn, cfg = _db()
    try:
        conf = mc.get_greenapi_config(conn)
        telefones = _telefones(conn)
        limite = float(conf.get("aviso_dias") or 2)
        token_info = mc.get_or_refresh_shared_token(conn, cfg, client_ip=_ip())
        if not token_info.get("ok"):
            return redirect(url_for("painel.avisos", erro="mc_login"))
        linhas, _status = mc.coletar_linhas_vencendo(token_info["token"], limite * 24.0)
        candidatos = {l["username"]: l for l in linhas}

        alvos = request.form.getlist("username")
        if request.form.get("todos") == "1":
            alvos = [u for u, l in candidatos.items() if telefones.get(u)]
        alvos = [u for u in alvos if u]

        enviados, erros, cota, ultimo = 0, [], False, {}
        for username in alvos:
            linha = candidatos.get(username)
            telefone = telefones.get(username, "")
            if not linha or not telefone:
                continue
            imagem = mc.gerar_imagem_aviso(conf, linha["texto_dias"])
            legenda = _legenda(conf, linha["texto_dias"])
            resultado = mc.greenapi_send_file(conf, telefone, imagem, "aviso-vencimento.png", legenda)
            ultimo = resultado
            if resultado.get("ok"):
                enviados += 1
                _registrar_aviso(conn, username, linha, telefone, resultado)
            else:
                erros.append("%s: %s" % (username, str(resultado.get("error") or resultado.get("response"))[:120]))
                if mc.cota_esgotada(resultado):
                    cota = True
                    break
    finally:
        conn.close()

    if enviados:
        return redirect(url_for("painel.avisos", ok="enviado", n=enviados))
    if erros:
        return redirect(
            url_for("painel.avisos", erro="cota" if cota else "enviar", detalhe=mc.falha_greenapi(ultimo)[:220])
        )
    return redirect(url_for("painel.avisos", erro="sem_destino"))


def _registrar_aviso(conn, username, linha, telefone, resultado) -> None:
    corpo = resultado.get("response") or {}
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into public.vencimento_avisos (username, exp_date, telefone, horas_restantes, status_code, id_message, response)
            values (%s, %s, %s, %s, %s, %s, %s::jsonb)
            on conflict (username, exp_date) do update
              set status_code = excluded.status_code, id_message = excluded.id_message, response = excluded.response
            """,
            (
                username,
                linha["exp_date"],
                telefone,
                round(float(linha["horas"]), 2),
                resultado.get("status_code"),
                str(corpo.get("idMessage") or ""),
                str({"via": "painel_online"}),
            ),
        )
    conn.commit()


@PAINEL.route("/avisos/varrer", methods=["POST"])
def avisos_varrer():
    conn, cfg = _db()
    forcar = request.form.get("reenviar") == "1"
    try:
        resultado = mc.avisar_vencimentos(conn, cfg, client_ip=_ip(), forcar=forcar)
        renovacao, espelho = {}, {}
        if resultado.get("ok"):
            renovacao = mc.avisar_renovacao(conn, cfg, client_ip=_ip(), forcar=forcar)
            espelho = mc.sincronizar_linhas(conn, cfg, client_ip=_ip())
    finally:
        conn.close()
    if not resultado.get("ok"):
        detalhe = str(resultado.get("error") or "falha")[:180]
        return redirect(url_for("painel.index", erro="varrer", detalhe=detalhe))
    return redirect(
        url_for(
            "painel.avisos",
            ok="varrido",
            cota="1" if (resultado.get("cota") or renovacao.get("cota")) else "",
            avaliados=resultado.get("avaliados"),
            enviados=resultado.get("enviados"),
            sem_telefone=resultado.get("sem_telefone"),
            renova_avaliados=renovacao.get("avaliados"),
            renova_enviados=renovacao.get("enviados"),
            renova_esperando=renovacao.get("esperando"),
            espelho=espelho.get("linhas"),
        )
    )


@PAINEL.route("/acessos")
def acessos():
    pagina = max(1, int(request.args.get("pagina") or 1))
    busca = (request.args.get("q") or "").strip()
    conn, cfg = _db()
    try:
        telefones = _telefones(conn)
        token_info = mc.get_or_refresh_shared_token(conn, cfg, client_ip=_ip())
        linhas, status, brutos = [], None, []
        if token_info.get("ok"):
            linhas, status, brutos = _listar_linhas(token_info["token"], pagina, busca)
            if brutos:
                mc.espelhar_linhas(conn, brutos, telefones)
    finally:
        conn.close()
    return render_template(
        "painel_acessos.html",
        linhas=linhas,
        telefones=telefones,
        pagina=pagina,
        busca=busca,
        sem_token=not token_info.get("ok"),
        lines_status=status,
    )


def _listar_linhas(bearer_token: str, pagina: int, busca: str, por_pagina: int = 40):
    headers = dict(mc.TEST_HEADERS_BASE)
    headers["authorization"] = "Bearer " + mc.normalize_bearer_token(bearer_token)
    params = {"page": pagina, "quantityPerPage": por_pagina, "orderBy": "createdAt.DESC"}
    if busca:
        params["generalSearch"] = busca
    try:
        resp = requests.get(mc.LINES_URL, headers=headers, params=params, timeout=60)
    except Exception as exc:
        return [], {"error": str(exc)[:160]}, []
    if resp.status_code >= 400:
        return [], {"status": resp.status_code}, []
    body = resp.json()
    agora = datetime.now(timezone.utc)
    itens, brutos = [], []
    for item in body.get("items") or []:
        expira = mc.parse_exp_date(item.get("exp_date") or "")
        horas = (expira - agora).total_seconds() / 3600.0 if expira else None
        brutos.append(item)
        itens.append(
            {
                "id": item.get("id"),
                "username": (item.get("username") or "").strip(),
                "senha": item.get("password") or "",
                "expira": expira.astimezone(mc.BRAZIL_TZ).strftime("%d/%m/%Y %H:%M") if expira else "",
                "exp_iso": expira.isoformat() if expira else "",
                "vencido": bool(horas is not None and horas <= 0),
                "texto_dias": mc.texto_vencido(horas) if horas is not None else "",
                "status": int(item.get("status") or 0),
                "notes": (item.get("notes") or "")[:80],
                "criado": (item.get("createdAt") or "")[:16],
            }
        )
    return itens, _pagina_info(body, pagina, por_pagina, len(itens)), brutos


def _pagina_info(body: dict, pagina: int, por_pagina: int, recebidos: int) -> dict:
    """O /lines nem sempre devolve contagem: mostramos a página seguinte quando a atual encheu."""
    total = _inteiro(body.get("count") or body.get("total") or body.get("totalCount"))
    paginas = _inteiro(body.get("pagesQuantity") or body.get("totalPages"))
    cheia = recebidos >= por_pagina
    return {
        "pagina": pagina,
        "paginas": paginas or (pagina + 1 if cheia else pagina),
        "total": total if total is not None else recebidos,
        "exato": total is not None,
    }


def _inteiro(valor):
    try:
        return int(valor)
    except (TypeError, ValueError):
        return None


@PAINEL.route("/clientes")
def clientes():
    conn, _ = _db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                select username, linha_id, telefone, exp_date, status, notes, synced_at
                  from public.mc_linhas
                 order by exp_date desc nulls last
                """
            )
            agora = datetime.now(timezone.utc)
            linhas = [
                {
                    "username": n or "",
                    "linha_id": lid or "",
                    "telefone": tel or "",
                    "expira": exp.astimezone(mc.BRAZIL_TZ).strftime("%d/%m/%Y %H:%M") if exp else "",
                    "exp_iso": exp.isoformat() if exp else "",
                    "texto_dias": mc.texto_vencido((exp - agora).total_seconds() / 3600.0) if exp else "",
                    "vencido": bool(exp and exp <= agora),
                    "status": int(st or 0),
                    "ativo": int(st or 0) == 1,
                    "notes": (no or "")[:80],
                    "sincronizado": syn.astimezone(mc.BRAZIL_TZ).strftime("%d/%m %H:%M") if syn else "",
                }
                for n, lid, tel, exp, st, no, syn in cur.fetchall()
            ]
    finally:
        conn.close()
    return render_template("painel_clientes.html", linhas=linhas, com_telefone=len([l for l in linhas if l["telefone"]]))


@PAINEL.route("/clientes/sincronizar", methods=["POST"])
def clientes_sincronizar():
    conn, cfg = _db()
    try:
        resultado = mc.sincronizar_linhas(conn, cfg, client_ip=_ip())
    finally:
        conn.close()
    if resultado.get("ok"):
        return redirect(url_for("painel.clientes", ok="sincronizado", n=resultado.get("linhas")))
    return redirect(url_for("painel.clientes", erro="mc_login", detalhe=str(resultado.get("error") or "")[:180]))


@PAINEL.route("/clientes/exportar")
def clientes_exportar():
    conn, _ = _db()
    try:
        with conn.cursor() as cur:
            cur.execute("select username, telefone, exp_date, status, notes from public.mc_linhas order by username")
            linhas = cur.fetchall()
    finally:
        conn.close()
    saida = io.StringIO()
    escritor = csv.writer(saida, delimiter=";", lineterminator="\r\n")
    escritor.writerow(["Usuário", "Telefone", "Expira", "Status", "Nota"])
    for nome, telefone, expira, status, notes in linhas:
        escritor.writerow(
            [
                nome or "",
                telefone or "",
                expira.astimezone(mc.BRAZIL_TZ).strftime("%d/%m/%Y %H:%M") if expira else "",
                "ativo" if int(status or 0) == 1 else "parado",
                (notes or "").strip(),
            ]
        )
    resposta = Response("﻿" + saida.getvalue(), mimetype="text/csv; charset=utf-8")
    resposta.headers["Content-Disposition"] = 'attachment; filename="clientes.csv"'
    return resposta


@PAINEL.route("/clientes/importar", methods=["POST"])
def clientes_importar():
    upload = request.files.get("csv")
    if not upload or not upload.filename:
        return redirect(url_for("painel.clientes", erro="csv_vazio"))
    bruto = upload.read()
    for codificacao in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            texto = bruto.decode(codificacao)
            break
        except UnicodeDecodeError:
            continue
    else:
        return redirect(url_for("painel.clientes", erro="csv_vazio"))

    linhas = _ler_csv(texto)
    if not linhas:
        return redirect(url_for("painel.clientes", erro="csv_vazio"))

    conn, _ = _db()
    try:
        novos, sem_usuario = 0, 0
        for colunas in linhas:
            nome = (colunas[0] or "").strip()
            if not nome:
                sem_usuario += 1
                continue
            telefone = (colunas[1] if len(colunas) > 1 else "").strip()
            expira = _parse_data_br(colunas[2] if len(colunas) > 2 else "")
            status = _parse_status(colunas[3] if len(colunas) > 3 else "")
            nota = (colunas[4] if len(colunas) > 4 else "").strip()
            with conn.cursor() as cur:
                cur.execute(
                    """
                    insert into public.mc_linhas (username, telefone, exp_date, status, notes, synced_at)
                    values (%s, %s, %s, %s, %s, now())
                    on conflict (username) do update
                      set telefone = coalesce(nullif(%s, ''), mc_linhas.telefone),
                          exp_date = coalesce(%s, mc_linhas.exp_date),
                          status = %s,
                          notes = %s,
                          synced_at = now()
                    """,
                    (nome, telefone, expira, status, nota, telefone, expira, status, nota),
                )
            if telefone:
                mc.upsert_usuario_criado_ip(conn, "csv", nome, telefone)
            novos += 1
        mc.save_event(
            conn,
            event_type="painel_clientes_import",
            status_code=200,
            request_payload={"arquivo": os.path.basename(upload.filename), "linhas": novos},
            response_payload={"sem_usuario": sem_usuario},
            client_ip=_ip(),
        )
    finally:
        conn.close()
    return redirect(url_for("painel.clientes", ok="importado", n=novos))


def _ler_csv(texto: str):
    """Aceita ; , ou tab e pula o cabeçalho quando ele existe."""
    corpo = texto.replace("﻿", "").strip()
    if not corpo:
        return []
    primeira = corpo.splitlines()[0]
    delimitador = ";"
    for candidato in (";", ",", "\t"):
        if candidato in primeira:
            delimitador = candidato
            break
    linhas = [l for l in csv.reader(io.StringIO(corpo), delimiter=delimitador) if l and any(c.strip() for c in l)]
    if linhas and _normalizar(linhas[0][0]) in ("usuario", "user", "username"):
        linhas = linhas[1:]
    return linhas


def _normalizar(texto: str) -> str:
    sem_acento = "".join(c for c in unicodedata.normalize("NFD", texto or "") if unicodedata.category(c) != "Mn")
    return sem_acento.strip().lower()


def _parse_status(texto: str) -> int:
    valor = _normalizar(texto)
    if valor in ("1", "ativo", "true", "on"):
        return 1
    return 0


def _parse_data_br(texto: str):
    valor = (texto or "").strip()
    if not valor:
        return None
    for formato in ("%d/%m/%Y %H:%M", "%d/%m/%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            quando = datetime.strptime(valor[:19], formato)
        except ValueError:
            continue
        return quando.replace(tzinfo=mc.BRAZIL_TZ).astimezone(timezone.utc)
    return mc.parse_exp_date(valor)


@PAINEL.route("/telefone", methods=["POST"])
def telefone():
    """Cadastra ou corrige o telefone de um cliente direto na lista de acessos."""
    username = (request.form.get("username") or "").strip()
    busca = (request.form.get("q") or "").strip()
    destino = "painel.clientes" if request.form.get("destino") == "clientes" else "painel.acessos"
    if not username:
        return redirect(url_for(destino, erro="sem_destino", q=busca))
    conn, _ = _db()
    try:
        resultado = mc.salvar_telefone(conn, username, request.form.get("telefone") or "")
        if resultado.get("ok"):
            mc.save_event(
                conn,
                event_type="painel_telefone",
                status_code=200,
                request_payload={"username": username},
                response_payload={"telefone": resultado["telefone"], "linhas": resultado["linhas"]},
                client_ip=_ip(),
            )
    finally:
        conn.close()
    if not resultado.get("ok"):
        return redirect(url_for(destino, erro=resultado.get("error") or "telefone_invalido", q=busca or username))
    return redirect(url_for(destino, ok="telefone", q=busca or username))


@PAINEL.route("/mesclar", methods=["POST"])
def mesclar():
    """Passa o telefone do primeiro usuário escolhido para o segundo (modal de confirmação)."""
    origem = (request.form.get("origem") or "").strip()
    destino = (request.form.get("destino") or "").strip()
    busca = (request.form.get("q") or "").strip()
    conn, _ = _db()
    try:
        resultado = mc.mesclar_telefones(conn, origem, destino)
        if resultado.get("ok"):
            mc.save_event(
                conn,
                event_type="painel_mesclar",
                status_code=200,
                request_payload={"origem": origem, "destino": destino},
                response_payload={"telefone": resultado["telefone"], "linhas": resultado["linhas"]},
                client_ip=_ip(),
            )
    finally:
        conn.close()
    if not resultado.get("ok"):
        return redirect(url_for("painel.acessos", erro=resultado.get("error") or "sem_destino", q=busca or origem))
    return redirect(
        url_for("painel.acessos", ok="mesclado", de=origem, para=destino, tel=resultado["telefone"], q=busca)
    )


@PAINEL.route("/recuperacao", methods=["GET", "POST"])
def recuperacao():
    """Aba própria: a legenda do recuperar e a foto que sai junto com ele."""
    conn, cfg = _db()
    try:
        if request.method == "POST":
            if request.form.get("alternar") == "1":
                atual = mc.get_greenapi_config(conn)
                alvo = not bool(atual.get("recupera_send_photo"))
                if alvo and not atual.get("recupera_photo_base64"):
                    return redirect(url_for("painel.recuperacao", erro="sem_foto_recupera"))
                resultado = mc.atualizar_greenapi_config(conn, {"recupera_send_photo": alvo})
                if not resultado.get("ok"):
                    return redirect(url_for("painel.recuperacao", erro="gravado"))
                return redirect(url_for("painel.recuperacao",
                                        ok="recupera_foto_ligado" if alvo else "recupera_foto_desligado"))
            campos = {
                "recupera_legenda": (request.form.get("recupera_legenda") or "").strip(),
                "recupera_send_photo": request.form.get("recupera_send_photo") == "on",
            }
            avisos = []
            upload = request.files.get("foto")
            if upload and upload.filename:
                bruto = upload.read()
                if len(bruto) > LIMITE_FOTO:
                    return redirect(url_for("painel.recuperacao", erro="foto_grande"))
                campos["recupera_photo_base64"] = base64.b64encode(bruto).decode("ascii")
                campos["recupera_photo_name"] = os.path.basename(upload.filename)[:60]
                # escolheu a foto = quer a foto no envio; a caixa de baixo continua ligada
                campos["recupera_send_photo"] = True
                avisos.append("recupera_foto")
            if request.form.get("limpar_foto") == "1":
                campos["recupera_photo_base64"], campos["recupera_photo_name"] = "", ""
                campos["recupera_send_photo"] = False
                avisos.append("recupera_foto_removida")

            if campos["recupera_send_photo"] and not campos.get("recupera_photo_base64"):
                if not _foto_recuperacao_guardada(conn):
                    campos["recupera_send_photo"] = False
                    avisos.append("sem_foto_recupera")

            resultado = mc.atualizar_greenapi_config(conn, campos)
            if not resultado.get("ok"):
                return redirect(url_for("painel.recuperacao", erro="gravado"))
            if "sem_foto_recupera" in avisos:
                return redirect(url_for("painel.recuperacao", erro="sem_foto_recupera", ok="recupera_gravado"))
            if avisos:
                return redirect(url_for("painel.recuperacao", ok=avisos[-1]))
            return redirect(url_for("painel.recuperacao", ok="recupera_gravado"))
        conf = mc.get_greenapi_config(conn)
        exemplo = mc.legenda_recuperar(conf, "há 1 mês e 4 dias")
    finally:
        conn.close()
    return render_template("painel_recuperacao.html", conf=conf, exemplo=exemplo)


def _foto_recuperacao_guardada(conn) -> bool:
    with conn.cursor() as cur:
        cur.execute("select recupera_photo_base64 from public.greenapi_config where id = 1")
        row = cur.fetchone()
    return bool(row and row[0])


@PAINEL.route("/recuperacao/foto")
def recuperacao_foto():
    """Mostra a foto guardada sem despejar 1 MB de base64 na página."""
    conn, _ = _db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "select recupera_photo_base64, recupera_photo_name from public.greenapi_config where id = 1"
            )
            row = cur.fetchone()
    finally:
        conn.close()
    bruto = (row[0] or "") if row else ""
    if not bruto:
        return Response("", status=404)
    try:
        imagem = base64.b64decode(bruto.split(",")[-1].strip())
    except Exception:
        return Response("", status=404)
    nome = (row[1] or "").lower()
    resposta = Response(imagem, mimetype="image/png" if nome.endswith("png") else "image/jpeg")
    resposta.headers["Cache-Control"] = "no-store"
    return resposta


@PAINEL.route("/recuperar", methods=["POST"])
def recuperar():
    """Manda a mensagem de 'voltar agora' para um cliente que já venceu."""
    username = (request.form.get("username") or "").strip()
    exp_iso = (request.form.get("exp_iso") or "").strip()
    tela = "clientes" if (request.form.get("destino") or "") == "clientes" else "acessos"

    def volta(**kw):
        """Volta para a aba de onde ele clicou; a busca só existe na tela Acessos."""
        if tela == "clientes":
            kw.pop("q", None)
            return redirect(url_for("painel.clientes", **kw))
        return redirect(url_for("painel.acessos", **kw))

    if not username:
        return redirect(url_for("painel." + tela, erro="sem_destino"))
    conn, cfg = _db()
    try:
        conf = mc.get_greenapi_config(conn)
        telefone = _telefones(conn).get(username, "")
        if not telefone:
            return volta(erro="sem_telefone", q=username)
        expira = mc.parse_exp_date(exp_iso)
        fonte = ("espelho" if tela == "clientes" else "linha") if expira else ""
        if not expira:
            expira = _expira_do_espelho(conn, username)
            fonte = "espelho" if expira else "nenhuma"
        agora = datetime.now(timezone.utc)
        horas = (expira - agora).total_seconds() / 3600.0 if expira else 0.0
        dias = mc.texto_vencido(horas)
        resultado = mc.greenapi_send_recuperacao(conf, telefone, mc.legenda_recuperar(conf, dias))
        if resultado.get("ok"):
            _registrar_renovacao(conn, username, exp_iso or (expira.isoformat() if expira else ""),
                                 telefone, horas, resultado, "painel")
            corpo = resultado.get("response") or {}
            mc.save_event(
                conn,
                event_type="recuperar_envio",
                status_code=resultado.get("status_code"),
                request_payload={"username": username, "telefone": telefone,
                                 "dias": dias, "fonte_data": fonte, "exp_iso": exp_iso[:40],
                                 "com_foto": bool(resultado.get("com_foto"))},
                response_payload=corpo,
                client_ip=_ip(),
            )
    finally:
        conn.close()
    if resultado.get("ok"):
        if resultado.get("com_foto"):
            motivo = "1"
        elif conf.get("recupera_photo_base64"):
            motivo = "desligada"
        else:
            motivo = "sem_foto"
        return volta(ok="recuperado", q=username, dias=dias, data=fonte, foto=motivo)
    detalhe = mc.falha_greenapi(resultado)
    erro = "cota" if mc.cota_esgotada(resultado) else "enviar"
    return volta(erro=erro, detalhe=detalhe[:220])


def _expira_do_espelho(conn, username: str):
    """Só vale data do espelho se a linha veio do painel MC e foi sincronizada há pouco.

    Linha criada por importação de CSV ou pela caixinha de telefone não tem linha_id, e a
    data do arquivo pode ser velha — usar isso faria o "recuperar" anunciar dias errados.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            select exp_date from public.mc_linhas
             where username = %s and linha_id <> '' and synced_at > now() - interval '2 days'
            """,
            (username,),
        )
        row = cur.fetchone()
    return row[0] if row and row[0] else None


def _registrar_renovacao(conn, username, exp_date, telefone, horas, resultado, via) -> None:
    corpo = resultado.get("response") or {}
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into public.renovacao_avisos
                (username, exp_date, telefone, dias_vencido, via, status_code, id_message, response, updated_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, now())
            on conflict (username, exp_date) do update
              set telefone = excluded.telefone,
                  dias_vencido = excluded.dias_vencido,
                  via = excluded.via,
                  status_code = excluded.status_code,
                  id_message = excluded.id_message,
                  response = excluded.response,
                  updated_at = now()
            """,
            (
                username,
                exp_date,
                telefone,
                round(abs(float(horas)) / 24.0, 1),
                via,
                resultado.get("status_code"),
                str(corpo.get("idMessage") or ""),
                json.dumps(corpo, default=str),
            ),
        )
    conn.commit()


LOTE_VALIDAR = 900
LOTE_PAGINAS = 60
LOTE_POR_PAGINA = 200
LOTE_JANELA = 3.0
LOTE_PARADA_ERROS = 3

LOTE = {"rodando": False, "revisado": False, "plano": None, "total": 0, "enviados": 0,
        "falhas": 0, "sem_telefone": 0, "pulados": 0, "esperando": 0, "parou": False,
        "motivo": "", "erros": [], "quando": 0.0, "fim": 0.0}
PLANO = threading.Lock()


def _varrer_mc(bearer_token: str, busca: str = "", fica=None) -> tuple:
    """Varre TODAS as páginas do painel MC; `fica(linha)` escolhe quais linhas voltam.

    O navegador mostra uma página por vez, então nenhum lote pode depender do que está
    na tela: a lista é remontada aqui, página por página, na ordem de criação do MC.
    Se o MC devolver menos linhas do que pedimos, o tamanho real da página passa a valer
    como referência de "página cheia" — assim nenhuma página fica de fora por engano.
    Os usuários vistos servem para avisar quando o espelho guarda linha que já foi apagada.
    """
    escolhidas, aviso, vistas, todos = [], "", 0, set()
    por_pagina = LOTE_POR_PAGINA
    for pagina in range(1, LOTE_PAGINAS + 1):
        linhas, status, _ = _listar_linhas(bearer_token, pagina, busca, por_pagina)
        erro = (status or {}).get("error") or (status or {}).get("status")
        if erro and not linhas:
            aviso = "o painel MC respondeu %s na página %d" % (erro, pagina)
            break
        vistas += len(linhas)
        for linha in linhas:
            if not linha.get("username"):
                continue
            todos.add(linha["username"])
            if fica is None or fica(linha):
                escolhidas.append(linha)
        if pagina == 1 and 0 < len(linhas) < por_pagina:
            por_pagina = len(linhas)
        if len(linhas) < por_pagina:
            return escolhidas, aviso, todos
        if (status or {}).get("exato") and vistas >= int(status.get("total") or 0):
            return escolhidas, aviso, todos
    if not aviso:
        aviso = "a varredura parou no limite de %d páginas (%d linhas vistas)" % (
            LOTE_PAGINAS, vistas)
    return escolhidas, aviso, todos


def _vencidos_do_mc(bearer_token: str, busca: str = "") -> tuple:
    """Os vencidos do painel MC e todos os usuários que a varrida viu."""
    return _varrer_mc(bearer_token, busca, lambda l: l.get("vencido"))


def _lote_alvos(vencidos, telefones, pular, recentes) -> tuple:
    """Tira quem ele marcou, quem não tem telefone e quem acabou de receber."""
    alvos, sem_telefone, pulados, esperando = [], 0, 0, 0
    marcados = set(pular or [])
    for linha in vencidos:
        nome = linha["username"]
        if nome in marcados:
            pulados += 1
            continue
        telefone = telefones.get(nome) or ""
        if not telefone:
            sem_telefone += 1
            continue
        if nome in recentes:
            esperando += 1
            continue
        alvos.append((nome, telefone, linha.get("exp_iso") or ""))
    return alvos, {"sem_telefone": sem_telefone, "pulados": pulados, "esperando": esperando}


def _lote_plano():
    """Monta a lista-alvo e devolve o resumo; também guarda o plano para o "enviar"."""
    busca = (request.form.get("q") or request.args.get("q") or "").strip()
    pular = request.form.getlist("pular") or [
        x for x in (request.args.get("pular") or "").split(",") if x]
    conn, cfg = _db()
    try:
        conf = mc.get_greenapi_config(conn)
        telefones = _telefones(conn)
        with conn.cursor() as cur:
            cur.execute(
                "select username from public.renovacao_avisos "
                "where updated_at > now() - %s * interval '1 hour'",
                (LOTE_JANELA,),
            )
            recentes = {r[0] for r in cur.fetchall()}
            cur.execute(
                """
                select username from public.mc_linhas
                 where exp_date is not null and exp_date <= now()
                """
            )
            vencidos_espelho = {r[0] for r in cur.fetchall() if r[0]}
        token_info = mc.get_or_refresh_shared_token(conn, cfg, client_ip=_ip())
    finally:
        conn.close()
    if not token_info.get("ok"):
        return None, {"erro": MSG_ERRO["mc_login"]}
    vencidos, aviso, todos_mc = _vencidos_do_mc(token_info["token"], busca)
    alvos, contagem = _lote_alvos(vencidos, telefones, pular, recentes)
    # Linha que existe só no espelho (apagada do MC depois da última sincronização): o lote
    # nunca manda nela, porque o acesso não existe mais para recuperar.
    fora_do_mc = [] if aviso else sorted(vencidos_espelho - todos_mc)
    plano = {
        "alvos": alvos,
        "busca": busca,
        "vencidos": len(vencidos),
        "marcados": len(set(pular or [])),
        "fora_do_mc": fora_do_mc,
        "aviso": aviso,
        "conf": conf,
        **contagem,
    }
    with PLANO:
        LOTE["plano"] = plano
        LOTE["revisado"] = True
        LOTE["quando"] = time.time()
        LOTE["sem_telefone"] = plano["sem_telefone"]
        LOTE["pulados"] = plano["pulados"]
        LOTE["esperando"] = plano["esperando"]
    return plano, None


@PAINEL.route("/recuperar_todos/contagem", methods=["GET", "POST"])
def recuperar_todos_contagem():
    """Só conta: o modal usa isto antes de prometer qualquer envio."""
    plano, erro = _lote_plano()
    if erro:
        return jsonify({"ok": False, "erro": erro["erro"]}), 502
    conf = plano["conf"]
    return jsonify({
        "ok": True,
        "vencidos": plano["vencidos"],
        "marcados": plano["marcados"],
        "so_no_espelho": len(plano["fora_do_mc"]),
        "fora_do_mc": plano["fora_do_mc"][:8],
        "alvos": len(plano["alvos"]),
        "sem_telefone": plano["sem_telefone"],
        "pulados": plano["pulados"],
        "esperando": plano["esperando"],
        "busca": plano["busca"],
        "aviso": plano["aviso"],
        "foto": bool(conf.get("recupera_send_photo") and (conf.get("recupera_photo_base64") or "")),
        "primeiros": [a[0] for a in plano["alvos"][:8]],
    })


@PAINEL.route("/recuperar_todos/parar", methods=["POST"])
def recuperar_todos_parar():
    LOTE["parou"] = True
    LOTE["motivo"] = "cancelado por você"
    return jsonify({"ok": True, "enviados": LOTE["enviados"], "total": LOTE["total"]})


@PAINEL.route("/recuperar_todos/status")
def recuperar_todos_status():
    return jsonify({
        "ok": True,
        "rodando": LOTE["rodando"],
        "total": LOTE["total"],
        "enviados": LOTE["enviados"],
        "falhas": LOTE["falhas"],
        "sem_telefone": LOTE["sem_telefone"],
        "pulados": LOTE["pulados"],
        "esperando": LOTE["esperando"],
        "parou": LOTE["parou"],
        "motivo": LOTE["motivo"],
        "erros": LOTE["erros"][:5],
        "fim": LOTE["fim"],
    })


def _lote_rodar(plano):
    """Dispara a mensagem da aba Recuperação, um por um, em thread separada."""
    conn, cfg = _db()
    try:
        conf = plano["conf"]
        agora = datetime.now(timezone.utc)
        seguidas = 0
        for nome, telefone, exp_iso in plano["alvos"]:
            if LOTE["parou"]:
                break
            expira = mc.parse_exp_date(exp_iso)
            horas = (expira - agora).total_seconds() / 3600.0 if expira else 0.0
            dias = mc.texto_vencido(horas)
            texto = mc.legenda_recuperar(conf, dias)
            try:
                resultado = mc.greenapi_send_recuperacao(conf, telefone, texto)
            except Exception as exc:
                resultado = {"ok": False, "error": str(exc)[:160]}
            if resultado.get("ok"):
                _registrar_renovacao(conn, nome, exp_iso, telefone, horas, resultado, "lote")
                LOTE["enviados"] += 1
                seguidas = 0
            else:
                LOTE["falhas"] += 1
                seguidas += 1
                if len(LOTE["erros"]) < 20:
                    LOTE["erros"].append({"usuario": nome, "motivo": mc.falha_greenapi(resultado)[:120]})
                if mc.cota_esgotada(resultado):
                    LOTE["parou"] = True
                    LOTE["motivo"] = MSG_ERRO["cota"]
                    break
                if seguidas >= LOTE_PARADA_ERROS:
                    LOTE["parou"] = True
                    LOTE["motivo"] = "parou: %s seguidas sem enviar" % seguidas
                    break
        mc.save_event(
            conn,
            event_type="recuperar_lote",
            status_code=200,
            request_payload={"alvos": LOTE["total"], "busca": plano["busca"],
                             "pulados": plano["pulados"]},
            response_payload={"enviados": LOTE["enviados"], "falhas": LOTE["falhas"],
                              "sem_telefone": plano["sem_telefone"],
                              "esperando": plano["esperando"], "motivo": LOTE["motivo"]},
            client_ip=plano["ip"],
        )
    except Exception as exc:
        LOTE["motivo"] = str(exc)[:160]
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        conn.close()
        LOTE["rodando"] = False
        LOTE["revisado"] = False
        LOTE["plano"] = None
        LOTE["fim"] = time.time()


@PAINEL.route("/recuperar_todos", methods=["POST"])
def recuperar_todos():
    """Segunda fase do modal: confirma e manda na lista que a contagem mostrou."""
    if request.form.get("confirmar") != "sim":
        return redirect(url_for("painel.acessos", erro="sem_confirmar"))
    plano = (LOTE.get("plano") or {}) if LOTE.get("revisado") else {}
    if not plano or time.time() - LOTE["quando"] > LOTE_VALIDAR:
        return jsonify({"ok": False,
                        "erro": "A conferência venceu. Feche o modal e abra de novo."})
    if LOTE["rodando"]:
        return jsonify({"ok": False, "erro": "Já tem um lote rodando agora.",
                        "rodando": True})
    alvos = list(plano["alvos"])
    if not alvos:
        return jsonify({"ok": False, "erro": "Ninguém sobrou para enviar."})
    plano["ip"] = _ip()
    LOTE.update({"rodando": True, "parou": False, "motivo": "", "erros": [],
                 "total": len(alvos), "enviados": 0, "falhas": 0, "fim": 0.0})
    threading.Thread(target=_lote_rodar, args=(plano,), daemon=True).start()
    return jsonify({"ok": True, "total": len(alvos),
                    "sem_telefone": plano["sem_telefone"], "esperando": plano["esperando"]})


APAGAR_VALIDAR = 600
APAGAR_MAX = 300
APAGAR_PARADA_ERROS = 3
PALAVRA_APAGAR = "deletar"

APAGAR = {"rodando": False, "revisado": False, "plano": None, "total": 0, "apagados": 0,
          "falhas": 0, "parou": False, "motivo": "", "erros": [], "quando": 0.0, "fim": 0.0}


def _numero_do_nome(username: str, prefixo: str = ""):
    """r566001 com prefixo r → 566001. Zero na frente (r0566001) também bate; nome que
    não fecha com o prefixo, ou tem letra no resto, não é do intervalo."""
    nome = (username or "").strip()
    if prefixo and nome[:len(prefixo)].lower() != prefixo.lower():
        return None
    resto = nome[len(prefixo):]
    if not (resto.isascii() and resto.isdigit()):
        return None
    return int(resto)


def _apagar_plano():
    """Varre o MC pelo intervalo e congela a lista que o modal vai revisar."""
    prefixo = (request.form.get("prefixo") or request.args.get("prefixo") or "").strip()
    de_txt = (request.form.get("de") or request.args.get("de") or "").strip()
    ate_txt = (request.form.get("ate") or request.args.get("ate") or "").strip()
    if len(prefixo) > 24 or " " in prefixo:
        return None, {"erro": "O prefixo não pode ter espaço e nem passar de 24 caracteres."}
    try:
        de, ate = int(de_txt), int(ate_txt)
    except (TypeError, ValueError):
        return None, {"erro": "Os dois números do intervalo são obrigatórios (ex.: 566001 até 566100)."}
    qtd = ate - de + 1
    if qtd <= 0:
        return None, {"erro": "O número final vem antes do inicial — confira o intervalo."}
    if qtd > APAGAR_MAX:
        return None, {"erro": "O intervalo tem %d nomes e o limite do lote é %d — faça em partes."
                              % (qtd, APAGAR_MAX)}
    conn, cfg = _db()
    try:
        telefones = _telefones(conn)
        token_info = mc.get_or_refresh_shared_token(conn, cfg, client_ip=_ip())
    finally:
        conn.close()
    if not token_info.get("ok"):
        return None, {"erro": MSG_ERRO["mc_login"]}
    def no_intervalo(linha):
        numero = _numero_do_nome(linha.get("username") or "", prefixo)
        return numero is not None and de <= numero <= ate

    encontradas, aviso, vistos = _varrer_mc(token_info["token"], "", no_intervalo)
    linhas = []
    for linha in encontradas:
        linhas.append({
            "id": str(linha.get("id") or ""),
            "usuario": linha["username"],
            "numero": _numero_do_nome(linha["username"], prefixo) or 0,
            "expira": linha.get("expira") or "",
            "nota": (linha.get("notes") or "")[:60],
            "telefone": mc.formatar_telefone(telefones.get(linha["username"]) or ""),
            "vencido": bool(linha.get("vencido")),
        })
    linhas.sort(key=lambda l: (l["numero"], l["usuario"]))
    plano = {
        "prefixo": prefixo, "de": de, "ate": ate, "qtd": qtd, "linhas": linhas,
        "faltando": max(0, qtd - len(linhas)), "aviso": aviso, "mc_total": len(vistos),
    }
    with PLANO:
        APAGAR["plano"] = plano
        APAGAR["revisado"] = True
        APAGAR["quando"] = time.time()
    return plano, None


def _apagar_filtrada(plano, manter, incluir_ativos):
    """Só tira coisas da lista congelada: o filtro nunca acrescenta ninguém."""
    marcados = set(manter or [])
    return [l for l in plano["linhas"]
            if l["usuario"] not in marcados and (incluir_ativos or l["vencido"]) and l["id"]]


@PAINEL.route("/deletar", methods=["GET"])
def deletar():
    return render_template("painel_deletar.html", palavra=PALAVRA_APAGAR, limite=APAGAR_MAX)


@PAINEL.route("/deletar/contagem", methods=["GET", "POST"])
def deletar_contagem():
    """Só conta: o modal usa isto antes de prometer qualquer exclusão."""
    plano, erro = _apagar_plano()
    if erro:
        with PLANO:
            APAGAR["revisado"] = False
            APAGAR["plano"] = None
        return jsonify({"ok": False, "erro": erro["erro"]}), 502
    vencidos = len([l for l in plano["linhas"] if l["vencido"]])
    return jsonify({
        "ok": True,
        "prefixo": plano["prefixo"], "de": plano["de"], "ate": plano["ate"],
        "qtd": plano["qtd"], "no_mc": len(plano["linhas"]), "vencidos": vencidos,
        "ativos": len(plano["linhas"]) - vencidos, "faltando": plano["faltando"],
        "aviso": plano["aviso"], "mc_total": plano["mc_total"],
        "painel_inteiro": (bool(plano["linhas"]) and not plano["aviso"]
                           and len(plano["linhas"]) >= plano["mc_total"] > 0),
        "linhas": plano["linhas"],
    })


@PAINEL.route("/deletar/executar", methods=["POST"])
def deletar_executar():
    """Segunda fase do modal: apaga, mas só se ele escreveu a palavra e a conta ainda vale."""
    if (request.form.get("palavra") or "").strip().lower() != PALAVRA_APAGAR:
        return jsonify({"ok": False, "erro": MSG_ERRO["sem_palavra"]}), 400
    if request.form.get("confirmar") != "sim":
        return jsonify({"ok": False, "erro": MSG_ERRO["sem_confirmar"]}), 400
    plano = (APAGAR.get("plano") or {}) if APAGAR.get("revisado") else {}
    if not plano or time.time() - APAGAR["quando"] > APAGAR_VALIDAR:
        return jsonify({"ok": False,
                        "erro": "A conferência venceu. Feche o modal e detecte o intervalo de novo."})
    if APAGAR["rodando"] or LOTE["rodando"]:
        return jsonify({"ok": False, "erro": "Já tem um lote rodando agora.", "rodando": True})
    manter = request.form.getlist("manter") or [
        x for x in (request.form.get("manter_csv") or "").split(",") if x]
    incluir_ativos = (request.form.get("ativos") or "") in ("1", "on", "sim")
    plano["ip"] = _ip()
    plano["tirar_espelho"] = (request.form.get("espelho") or "") in ("1", "on", "sim")
    alvos = _apagar_filtrada(plano, manter, incluir_ativos)
    if not alvos:
        APAGAR["revisado"] = False
        return jsonify({"ok": False, "erro": "Nenhum acesso sobrou para apagar."})
    plano["alvos"] = alvos
    APAGAR.update({"rodando": True, "parou": False, "motivo": "", "erros": [],
                   "total": len(alvos), "apagados": 0, "falhas": 0, "fim": 0.0})
    threading.Thread(target=_apagar_rodar, args=(plano,), daemon=True).start()
    return jsonify({"ok": True, "total": len(alvos), "mantidos": len(plano["linhas"]) - len(alvos),
                    "tirar_espelho": plano["tirar_espelho"]})


@PAINEL.route("/deletar/parar", methods=["POST"])
def deletar_parar():
    APAGAR["parou"] = True
    APAGAR["motivo"] = "cancelado por você"
    return jsonify({"ok": True, "apagados": APAGAR["apagados"], "total": APAGAR["total"]})


@PAINEL.route("/deletar/status")
def deletar_status():
    return jsonify({
        "ok": True,
        "rodando": APAGAR["rodando"],
        "total": APAGAR["total"],
        "apagados": APAGAR["apagados"],
        "falhas": APAGAR["falhas"],
        "parou": APAGAR["parou"],
        "motivo": APAGAR["motivo"],
        "erros": APAGAR["erros"][:5],
        "fim": APAGAR["fim"],
    })


def _apagar_rodar(plano):
    """DELETE /lines/<id> um por um, em thread separada, com evento no mcapi_events."""
    conn, cfg = _db()
    try:
        token_info = mc.get_or_refresh_shared_token(conn, cfg, client_ip=plano["ip"])
        if not token_info.get("ok"):
            APAGAR["motivo"] = MSG_ERRO["mc_login"]
            APAGAR["parou"] = True
            return
        intervalo = "%s%d..%s%d" % (plano["prefixo"], plano["de"], plano["prefixo"], plano["ate"])
        seguidas = 0
        for linha in plano["alvos"]:
            if APAGAR["parou"]:
                break
            try:
                status, corpo = _deletar_linha(token_info["token"], linha["id"])
            except Exception as exc:
                status, corpo = 0, {"error": str(exc)[:160]}
            if 200 <= status < 300:
                APAGAR["apagados"] += 1
                seguidas = 0
                if plano["tirar_espelho"]:
                    with conn.cursor() as cur:
                        cur.execute("delete from public.mc_linhas where username = %s",
                                    (linha["usuario"],))
                    conn.commit()
            else:
                APAGAR["falhas"] += 1
                seguidas += 1
                if len(APAGAR["erros"]) < 20:
                    APAGAR["erros"].append({"usuario": linha["usuario"],
                                            "motivo": "o MC respondeu %s" % status})
                if status in (401, 403):
                    APAGAR["parou"] = True
                    APAGAR["motivo"] = ("o painel MC recusou a chave de acesso (%s) — "
                                        "nada mais foi apagado." % status)
                    break
                if seguidas >= APAGAR_PARADA_ERROS:
                    APAGAR["parou"] = True
                    APAGAR["motivo"] = "parou: %s respostas ruins seguidas" % seguidas
                    break
            mc.save_event(
                conn,
                event_type="painel_online_batch_delete",
                status_code=status,
                request_payload={"line_id": linha["id"], "username": linha["usuario"],
                                 "via": "lote", "intervalo": intervalo[:40]},
                response_payload=corpo if isinstance(corpo, dict) else {"raw": str(corpo)[:300]},
                error_message=None if 200 <= status < 300 else "exclusao em lote falhou",
                client_ip=plano["ip"],
            )
    except Exception as exc:
        APAGAR["motivo"] = str(exc)[:160]
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        conn.close()
        APAGAR["rodando"] = False
        APAGAR["revisado"] = False
        APAGAR["plano"] = None
        APAGAR["fim"] = time.time()


@PAINEL.route("/apagar/<linha_id>", methods=["GET", "POST"])
def apagar(linha_id: str):
    if not linha_id.isdigit():
        return redirect(url_for("painel.acessos", erro="apagar"))
    if request.method == "POST":
        if request.form.get("confirmar") != "sim":
            return redirect(url_for("painel.acessos", erro="sem_confirmar"))
        conn, cfg = _db()
        try:
            token_info = mc.get_or_refresh_shared_token(conn, cfg, client_ip=_ip())
            if not token_info.get("ok"):
                return redirect(url_for("painel.acessos", erro="mc_login"))
            status, corpo = _deletar_linha(token_info["token"], linha_id)
            mc.save_event(
                conn,
                event_type="painel_online_delete",
                status_code=status,
                request_payload={"line_id": linha_id},
                response_payload=corpo if isinstance(corpo, dict) else {"raw": str(corpo)[:300]},
                error_message=None if status < 400 else "exclusao pelo painel online falhou",
                client_ip=_ip(),
            )
        finally:
            conn.close()
        if 200 <= status < 300:
            return redirect(url_for("painel.acessos", ok="apagado", linha=linha_id))
        return redirect(url_for("painel.acessos", erro="apagar", detalhe=str(corpo)[:180]))

    conn, cfg = _db()
    try:
        telefones = _telefones(conn)
        token_info = mc.get_or_refresh_shared_token(conn, cfg, client_ip=_ip())
        alvo = {}
        if token_info.get("ok"):
            item = _linha_por_id(token_info["token"], linha_id)
            if item:
                expira = mc.parse_exp_date(item.get("exp_date") or "")
                alvo = {
                    "username": (item.get("username") or "").strip(),
                    "expira": expira.astimezone(mc.BRAZIL_TZ).strftime("%d/%m/%Y %H:%M") if expira else "",
                "exp_iso": expira.isoformat() if expira else "",
                    "notes": (item.get("notes") or "")[:120],
                    "parado": int(item.get("status") or 0) != 1,
                }
    finally:
        conn.close()
    return render_template("painel_apagar.html", linha_id=linha_id, alvo=alvo, telefone=telefones.get(alvo.get("username", ""), ""))


def _linha_por_id(bearer_token: str, linha_id: str, max_paginas: int = 4) -> dict:
    """O generalSearch do MC não acha pelo id, então varremos as linhas até bater."""
    headers = dict(mc.TEST_HEADERS_BASE)
    headers["authorization"] = "Bearer " + mc.normalize_bearer_token(bearer_token)
    for pagina in range(1, max_paginas + 1):
        try:
            resp = requests.get(
                mc.LINES_URL,
                headers=headers,
                params={"page": pagina, "quantityPerPage": 200, "orderBy": "createdAt.DESC"},
                timeout=60,
            )
            itens = (resp.json() or {}).get("items") or []
        except Exception:
            return {}
        for item in itens:
            if str(item.get("id")) == str(linha_id):
                return item
        if len(itens) < 200:
            return {}
    return {}


def _deletar_linha(bearer_token: str, linha_id: str):
    if mc.modo_teste():
        # Na copia de testes a linha nao e apagada do painel MC de verdade.
        return 200, {"simulado": True}
    headers = dict(mc.TEST_HEADERS_BASE)
    headers["authorization"] = "Bearer " + mc.normalize_bearer_token(bearer_token)
    resp = requests.delete("%s/%s" % (mc.LINES_URL, linha_id), headers=headers, timeout=60)
    if resp.status_code in (401, 403):
        chave = (os.getenv("MC_PANEL_KEY") or "").strip()
        if chave:
            headers = dict(mc.TEST_HEADERS_BASE)
            headers["x-api-key"] = chave
            headers["authorization"] = "Bearer " + chave
            resp = requests.delete("%s/%s" % (mc.LINES_URL, linha_id), headers=headers, timeout=60)
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {"raw": (resp.text or "")[:300]}


@PAINEL.route("/senha", methods=["GET", "POST"])
def senha():
    if request.method == "POST":
        conn, _ = _db()
        try:
            atual = _hash_armazenado(conn)
            if not _confere_senha((request.form.get("atual") or "").strip(), atual):
                return render_template("painel_senha.html", erro="Senha atual incorreta."), 401
            nova = (request.form.get("nova") or "").strip()
            if len(nova) < 8:
                return render_template("painel_senha.html", erro="A senha nova precisa de pelo menos 8 caracteres."), 400
            with conn.cursor() as cur:
                cur.execute("update public.greenapi_config set painel_senha_hash = %s, updated_at = now() where id = 1", (hash_senha(nova),))
            conn.commit()
        finally:
            conn.close()
        resposta = redirect(url_for("painel.entrar"))
        resposta.delete_cookie(COOKIE, path="/")
        return resposta
    return render_template("painel_senha.html", erro="")


@PAINEL.route("/links", methods=["GET"])
def links():
    return render_template("painel_links.html", base=encurtador.base(),
                           logado=encurtador.autenticado())


@PAINEL.route("/links/encurtar", methods=["POST"])
def links_encurtar():
    """Encurta no servico de links dele. Se o servico estiver fora, o erro volta em
    JSON para a tela mostrar - o endereco comprido continua valendo do mesmo jeito."""
    dados = request.form if request.form else (request.get_json(silent=True) or {})
    resultado = encurtador.encurtar(dados.get("url") or "", dados.get("slug") or "",
                                    dados.get("titulo") or "")
    return jsonify(resultado), (200 if resultado.get("ok") else 400)
