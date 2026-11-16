"""Prova do telefone que viaja no link de recuperação, sem mandar nada para ninguém.

O cliente clica no link curto -> a página `r/` do Pages pergunta `links_destino` -> a função
devolve o destino já com `?telefone=<dígitos>` -> o site no Render preenche o campo do WhatsApp,
tranca (readonly) e guarda no aparelho por 4 horas.

Rode a função primeiro, em modo teste, do jeito de sempre:

  cd supabase/functions/peixeiro
  PEIXEIRO_MODO_TESTE=1 npx --yes deno run -A --env-file=../../../.env index.ts

e então, da pasta 2peer:

  python tools/_prova_link.py

A primeira metade bate em `links_destino` (que é a única ação anônima do painel de links) com
linhas `stub-link-*` gravadas no banco da cópia, e apaga tudo no fim. A segunda metade levanta o
Flask do próprio `app.py` dentro do processo, com as funções de rede trocadas por um carimbo,
então nada sai do computador e nenhum WhatsApp é tocado.
"""
import base64
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

ENV = dict(re.findall(r"^([A-Z_a-z0-9]+)=(.*)$",
                      (pathlib.Path(__file__).resolve().parents[1] / ".env").read_text(encoding="utf-8"), re.M))
URL_BANCO = ENV["DATABASE_URL"].strip().strip('"')
FUNCAO = "http://127.0.0.1:8000/"

SITE = "https://wplay-teste-4h.onrender.com/"
COM_TEL = "5511900000011"        # número de prova, de ninguém
SEM_TEL = "5511900000022"
NOVO_TEL = "5511900000033"
STUB = "stub-link-prova"

RESULTADOS = []


def mascarar(texto):
    return re.sub(r"\d{8,}", "****", str(texto))


def checar(rotulo, verdadeiro, detalhe=""):
    RESULTADOS.append((bool(verdadeiro), rotulo))
    print("%s %-58s %s" % ("OK  " if verdadeiro else "FAIL", rotulo, mascarar(detalhe)[:170]))


def chamar(acao, dados=None):
    corpo = dict(dados or {})
    corpo["action"] = acao
    req = urllib.request.Request(FUNCAO, data=json.dumps(corpo).encode(),
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as erro:
        bruto = erro.read().decode("utf8", "replace")
        try:
            return erro.code, json.loads(bruto)
        except ValueError:
            return erro.code, {"cru": bruto[:200]}


def payload(usuario, telefone):
    """Do mesmo jeito que o link velho vinha: base64 sem os `+/=` da vida."""
    return (base64.b64encode(f"{usuario}|{telefone}".encode()).decode()
            .replace("+", "-").replace("/", "_").rstrip("="))


def banco():
    import psycopg2
    cli = psycopg2.connect(URL_BANCO)
    cli.autocommit = True
    return cli


def executar(cli, sql, params=()):
    cur = cli.cursor()
    cur.execute(sql) if not params else cur.execute(sql, params)
    cli.commit()
    return cur.rowcount


def limpar(cli):
    executar(cli, "delete from public.painel_links where slug like 'stub-link%%'")


def provar_clique():
    cli = banco()
    limpar(cli)
    executar(cli, "insert into public.painel_links (slug, usuario, telefone, destino)"
                  " values (%s, 'stublink01', %s, %s)", [STUB, COM_TEL, SITE])

    _, com = chamar("links_destino", {"slug": STUB})
    checar("o clique devolve o destino com o telefone do cliente no endereço",
           com.get("ok") is True and str(com.get("destino", "")).startswith(SITE)
           and "telefone=" + COM_TEL in str(com.get("destino")), com)
    checar("o telefone também sai solto, para quem só quer saber o número",
           com.get("telefone") == COM_TEL, com.get("telefone"))

    executar(cli, "update public.painel_links set destino = %s || '?p=1#fim' where slug = %s",
             [SITE, STUB])
    _, query = chamar("links_destino", {"slug": STUB})
    destino = str(query.get("destino") or "")
    checar("um destino que já traz query ou âncora continua inteiro",
           "p=1" in destino and "telefone=" + COM_TEL in destino and destino.endswith("#fim"), destino)

    executar(cli, "update public.painel_links set telefone = '' where slug = %s", [STUB])
    _, sem = chamar("links_destino", {"slug": STUB})
    checar("link sem número cadastrado sai exatamente como saía antes",
           sem.get("telefone") == "" and "telefone=" not in str(sem.get("destino")), sem)

    velho = payload("stubuser", NOVO_TEL)
    _, decod = chamar("links_destino", {"d": velho})
    checar("o link velho, que só traz o base64, também chega com o número de dentro dele",
           decod.get("telefone") == NOVO_TEL and "telefone=" + NOVO_TEL in str(decod.get("destino")),
           decod)

    _, sem_row = chamar("links_destino", {"slug": "stub-link-que-nao-existe"})
    checar("um link que nunca foi cadastrado não inventa telefone de ninguém",
           sem_row.get("ok") is True and sem_row.get("telefone") == ""
           and "telefone=" not in str(sem_row.get("destino")), sem_row)

    codigo, torto = chamar("links_destino", {"d": "!!!não é base64!!!"})
    checar("um payload torto é recusado sem quebrar a página",
           codigo == 400 and torto.get("erro") == "sem_slug", (codigo, torto))

    limpar(cli)
    cli.close()


def provar_site():
    # PEIXEIRO_SITE_DIR aponta para o outro site (o do Render) — a mesma prova vale para os dois.
    sys.path.insert(0, str(os.environ.get("PEIXEIRO_SITE_DIR") or
                           pathlib.Path(__file__).resolve().parents[1]))
    import app

    # Nada de rede nem de banco: o site é provado pelo desenho da página, não pelo envio.
    app.safe_recent_media = lambda *a, **k: {"items": [], "ok": True, "user_id": ""}
    app.safe_request_media = lambda *a, **k: {"items": [], "ok": True, "user_id": ""}
    app.safe_check_ip_limits = lambda *a, **k: app.default_limit_info()
    app.get_active_access_for_ip = lambda *a, **k: None
    app.register_usuario_criado_ip = lambda *a, **k: None
    app.generate_access_once = lambda *a, **k: {"ok": False, "error": "stub"}
    cliente = app.app.test_client()

    def telefone_no_html(html):
        m = re.search(r'name="telefone"[^>]*value="([^"]*)"', html)
        return m.group(1) if m else None

    sem_link = cliente.get("/").get_data(as_text=True)
    checar("quem chega sem link digita o número normalmente",
           'name="telefone"' in sem_link and "readonly" not in sem_link.split('name="telefone"')[1][:200]
           and telefone_no_html(sem_link) == "", telefone_no_html(sem_link))

    com_link = cliente.get("/?telefone=" + COM_TEL).get_data(as_text=True)
    checar("o telefone do link já vem preenchido no campo",
           telefone_no_html(com_link) == "(11) 90000-0011", telefone_no_html(com_link))
    checar("e o campo vem travado, sem poder ser trocado",
           "readonly" in com_link.split('name="telefone"')[1][:220],
           com_link.split('name="telefone"')[1][:120].replace("\n", " "))
    checar("o formulário leva o número junto quando é enviado",
           'action="/?telefone=' + COM_TEL + '"' in com_link,
           re.search(r'<form method="post" action="([^"]*)"', com_link).group(1) if
           re.search(r'<form method="post" action="([^"]*)"', com_link) else "")
    checar("a página avisa que o número é o que chegou no WhatsApp",
           "chegou no seu WhatsApp" in com_link, "")

    alterado = cliente.post("/?telefone=" + COM_TEL,
                            data={"telefone": "11999998888", "telegram_id": ""}).get_data(as_text=True)
    checar("um POST por cima do número travado não muda o número",
           telefone_no_html(alterado) == "(11) 90000-0011", telefone_no_html(alterado))

    quatro_horas = cliente.get("/?tel=55119000000" + "33").get_data(as_text=True)
    checar("o atalho ?tel do endereço velho também é aceito",
           telefone_no_html(quatro_horas) == "(11) 90000-0033", telefone_no_html(quatro_horas))
    checar("o número fica guardado no aparelho por 4 horas",
           '"peixeiro_telefone_link"' in quatro_horas and "HORAS = 4" in quatro_horas, "")

    torto = cliente.get("/?telefone=abc").get_data(as_text=True)
    checar("um telefone torto no endereço não trava a tela do cliente",
           telefone_no_html(torto) == "" and "readonly" not in torto.split('name="telefone"')[1][:220],
           telefone_no_html(torto))


if __name__ == "__main__":
    # `site` roda só a metade do Flask (serve para provar o site do Render, que não tem função local).
    if len(sys.argv) > 1 and sys.argv[1] == "site":
        provar_site()
    else:
        provar_clique()
        provar_site()
    falhas = [f[1] for f in RESULTADOS if not f[0]]
    print("\n%d/%d provas passaram" % (len(RESULTADOS) - len(falhas), len(RESULTADOS)))
    if falhas:
        print("falharam:", falhas)
        sys.exit(1)
