"""Prova do lote "Não recuperados" montado a partir do espelho (aba Clientes).

Rode a função primeiro, com o envio desarmado (PEIXEIRO_MODO_TESTE faz o GreenAPI devolver
"simulado" antes de qualquer rede):

  cd supabase/functions/peixeiro
  PEIXEIRO_MODO_TESTE=1 npx --yes deno run -A --env-file=../../../.env index.ts

e então, da pasta 2peer:

  python tools/_prova_lote.py            # roda a bateria e limpa o que criou
  python tools/_prova_lote.py limpar     # só a limpeza, se a bateria quebrar no meio

É o caminho dos clientes importados por CSV, que nunca tiveram linha no painel MC. Nada sai
do computador enquanto o modo teste estiver ligado; no fim apago a fila, os avisos e os links
que esta bateria criou.
"""
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

import psycopg2

ENV = dict(re.findall(r"^([A-Z_a-z0-9]+)=(.*)$",
                      (pathlib.Path(__file__).resolve().parents[1] / ".env").read_text(encoding="utf-8"), re.M))
URL_BANCO = ENV["DATABASE_URL"].strip().strip('"')
FUNCAO = os.environ.get("PEIXEIRO_PROVA_URL", "http://127.0.0.1:8000/")

RESULTADOS = []
VENCIDOS_SQL = """
  select m.username,
         coalesce((select u.telefone from public.usuarios_criados_ip u
                    where u.username = m.username and u.telefone <> ''
                    order by u.updated_at desc limit 1), m.telefone, '') as telefone,
         coalesce(m.linha_id, '') <> '' as tem_linha
    from public.mc_linhas m
   where m.exp_date is not null and m.exp_date <= now()
"""


def mascarar(texto):
    return re.sub(r"\d{8,}", "****", str(texto))


def checar(rotulo, verdadeiro, detalhe=""):
    RESULTADOS.append((bool(verdadeiro), rotulo))
    print("%s %-58s %s" % ("OK  " if verdadeiro else "FAIL", rotulo, mascarar(detalhe)[:150]))


def banco():
    cli = psycopg2.connect(URL_BANCO)
    cli.autocommit = True
    return cli


def token_sessao(cli):
    """O mesmo "<expira>.<hmac>" que a função assina no login, para chamar sem saber a senha."""
    import hashlib
    import hmac

    cur = cli.cursor()
    cur.execute("select painel_senha_hash from public.greenapi_config where id = 1")
    armazenada = cur.fetchone()[0]
    chave = hashlib.sha256(("painel-sessao|" + armazenada).encode()).digest()
    expira = int(time.time()) + 3600
    return "%d.%s" % (expira, hmac.new(chave, str(expira).encode(), hashlib.sha256).hexdigest())


def _pos(url, corpo, token=None):
    cabecalhos = {"content-type": "application/json"}
    if token:
        cabecalhos["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=json.dumps(corpo).encode(), headers=cabecalhos)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as erro:
        bruto = erro.read().decode("utf8", "replace")
        try:
            return erro.code, json.loads(bruto)
        except ValueError:
            return erro.code, {"cru": bruto[:200]}


def chamar(acao, dados=None, token=None):
    corpo = dict(dados or {})
    corpo["action"] = acao
    return _pos(FUNCAO, corpo, token)


def consulta(cli, sql, params=()):
    cur = cli.cursor()
    cur.execute(sql, params)
    return cur.fetchall()


def plano_congelado(cli):
    linhas = consulta(cli, "select plano from public.painel_lote where chave = 'recuperar_todos'")
    if not linhas:
        return []
    valor = linhas[0][0]
    return json.loads(valor) if isinstance(valor, str) else (valor or [])


def limpar(cli, nomes):
    """Some com a fila congelada e com o rastro da bateria. Os três que chegaram a enviar não
       são os mesmos de `nomes` (o plano vai por nome), então pego a lista do próprio plano."""
    cur = cli.cursor()
    do_plano = [str(i.get("username")) for i in plano_congelado(cli) if i.get("username")]
    todos = list({*nomes, *do_plano})
    cur.execute("delete from public.painel_lote where chave = 'recuperar_todos'")
    cur.execute("delete from public.renovacao_avisos where username = any(%s) and via = 'lote'"
                "  and updated_at > now() - interval '30 minutes'", (todos,))
    cur.execute("delete from public.painel_links where usuario = any(%s)"
                "  and atualizado_em > now() - interval '30 minutes'", (todos,))
    cli.commit()


def provar(token, cli, nomes):
    local = "127.0.0.1" in FUNCAO
    pulado, alvo_a, alvo_b = nomes
    antes = consulta(cli, "select count(*) from public.mcapi_events where event_type = 'login_refresh'")[0][0]
    vencidos = consulta(cli, "select count(*) from (" + VENCIDOS_SQL + ") t")[0][0]
    com_linha = consulta(cli, "select count(*) from (" + VENCIDOS_SQL + ") t where t.tem_linha")[0][0]
    sem_numero = consulta(cli, "select count(*) from (" + VENCIDOS_SQL + ") t where t.telefone = ''")[0][0]
    na_fila = consulta(
        cli,
        "select count(*) from (" + VENCIDOS_SQL + ") t where t.telefone <> ''"
        " and t.username not in (select username from public.renovacao_avisos"
        "                          where updated_at > now() - interval '3 hours')")[0][0]

    status, d = chamar("ping")
    checar("a função está de pé", status == 200 and d.get("ok"), str(d))
    if local:
        checar("o envio está DESARMADO (modo teste ligado)", d.get("modo_teste") is True,
               "sem modo teste esta bateria manda WhatsApp de verdade")
    else:
        print("   (função publicada: nada é enviado — o lote é aberto e conferido, mas "
              "lote_item/lote_executar não são chamados)")

    t0 = time.time()
    status, d = chamar("lote_contagem", {"tipo": "recuperar", "fonte": "espelho",
                                         "pular": [pulado]}, token)
    durou = time.time() - t0
    checar("a contagem do espelho responde", status == 200 and d.get("ok"), str(d)[:120])
    checar("a resposta diz que a lista veio do espelho", d.get("fonte") == "espelho", "")
    checar("vencidos do espelho batem com o banco", d.get("vencidos") == vencidos,
           "%s vs %s" % (d.get("vencidos"), vencidos))
    checar("a lista do espelho é maior que o painel MC", (d.get("vencidos") or 0) > (d.get("com_linha_mc") or 0),
           "%s vencidos, %s com linha no MC" % (d.get("vencidos"), d.get("com_linha_mc")))
    checar("com_linha_mc bate com o banco", d.get("com_linha_mc") == com_linha,
           "%s vs %s" % (d.get("com_linha_mc"), com_linha))
    checar("o marcado para pular saiu da conta", d.get("pulados") == 1, str(d.get("pulados")))
    checar("sem_telefone bate com o banco", d.get("sem_telefone") == sem_numero,
           "%s vs %s" % (d.get("sem_telefone"), sem_numero))
    checar("vão receber bate com o banco", d.get("alvos") == na_fila - 1,
           "%s vs %s" % (d.get("alvos"), na_fila - 1))
    checar("a contagem do espelho não varre o painel MC", durou < 20 and
           consulta(cli, "select count(*) from public.mcapi_events where event_type = 'login_refresh'")[0][0] == antes,
           "%.1fs" % durou)
    checar("o botão fica liberado (tem alvo)", (d.get("alvos") or 0) > 0, "")

    plano = plano_congelado(cli)
    checar("o plano congelado tem exatamente os alvos", len(plano) == d.get("alvos"),
           "%s vs %s" % (len(plano), d.get("alvos")))
    checar("todo item do plano veio do espelho", bool(plano) and all(i.get("fonte") == "espelho" for i in plano), "")
    checar("quem foi marcado para pular não entrou no plano", pulado not in {i.get("username") for i in plano}, "")
    checar("todo item do plano tem telefone", all(str(i.get("telefone") or "") for i in plano), "")
    checar("o espelho manda para muito mais gente que o MC", len(plano) > 100, "%s na fila" % len(plano))

    status, d = chamar("lote_contagem", {"tipo": "recuperar", "fonte": "espelho",
                                         "pular": [pulado, alvo_a, alvo_b]}, token)
    checar("marcar dois a mais tira os dois da fila", d.get("pulados") == 3 and
           pulado not in {i.get("username") for i in plano_congelado(cli)}, str(d.get("pulados")))

    status, d = chamar("lote_contagem", {"tipo": "recuperar", "fonte": "espelho", "q": alvo_a}, token)
    checar("o filtro da tela também vale no espelho", d.get("ok") and d.get("vencidos") == 1, str(d.get("vencidos")))
    chamar("lote_contagem", {"tipo": "recuperar", "fonte": "espelho", "pular": [pulado]}, token)

    status, d = chamar("lote_executar", {"tipo": "recuperar"}, token)
    if not local:
        checar("sem confirmar o lote não sai", not d.get("ok"), str(d)[:80])
        return
    checar("sem confirmar o lote não sai", not d.get("ok"), str(d)[:80])

    status, d = chamar("lote_executar", {"tipo": "recuperar", "confirmar": "sim"}, token)
    checar("a conferência ainda vale e o lote abre", d.get("ok") and d.get("total") == len(plano), str(d)[:120])

    enviados, estado = [], {}
    for _ in range(3):
        status, d = chamar("lote_item", {"tipo": "recuperar"}, token)
        item = (d.get("item") or {}) if d.get("ok") else {}
        if item.get("username"):
            enviados.append(item["username"])
        estado = d.get("estado") or {}
        if not d.get("ok") or not estado.get("rodando"):
            break
    checar("as três primeiras mensagens saíram simuladas", len(enviados) == 3 and
           all(u != pulado for u in enviados), ",".join(enviados))
    checar("o estado conta os enviados", (estado.get("enviados") or 0) >= 3, str(estado.get("enviados")))
    checar("o lote sorteia a pausa antes do próximo item", "esperar" in d, str(d.get("esperar")))

    registro = consulta(
        cli,
        "select request_payload ->> 'fonte_data' from public.mcapi_events"
        " where event_type = 'recuperar_envio' order by id desc limit 1")[0][0]
    checar("o log diz que a data veio do espelho", registro == "espelho", str(registro))

    status, d = chamar("lote_fila", {"tipo": "recuperar"}, token)
    checar("a fila viva mostra a lista do espelho", d.get("ok") and d.get("fonte") == "espelho", str(d.get("fonte")))
    checar("a fila tem o total do plano", d.get("total") == len(plano), str(d.get("total")))
    situacoes = {i["usuario"]: i["situacao"] for i in d.get("itens", [])[:400]}
    checar("quem já saiu da fila aparece como enviado",
           any(v == "enviado" for v in situacoes.values()), "")

    status, d = chamar("lote_parar", {"tipo": "recuperar"}, token)
    checar("parar o envio funciona", d.get("ok") and not (d.get("estado") or {}).get("rodando"), "")

    checar("quem estava marcado para pular não recebeu", pulado not in [
        r[0] for r in consulta(cli, "select username from public.renovacao_avisos"
                                    " where updated_at > now() - interval '10 minutes'")], "")


def main():
    cli = banco()
    token = token_sessao(cli)
    nomes = [r[0] for r in consulta(
        cli,
        "select username from public.mc_linhas m"
        " where exp_date is not null and exp_date <= now() and coalesce(linha_id,'') = ''"
        "   and coalesce(telefone,'') <> ''"
        "   and username not in (select username from public.renovacao_avisos"
        "                         where updated_at > now() - interval '3 hours')"
        " order by username limit 3")]
    if len(nomes) < 3:
        print("o espelho da cópia não tem 3 clientes vencidos só-no-espelho: %s" % nomes)
        sys.exit(2)
    if "limpar" in sys.argv[1:]:
        limpar(cli, nomes)
        print("limpo")
        return
    try:
        provar(token, cli, nomes)
    finally:
        limpar(cli, nomes)
        restante = consulta(cli, "select count(*) from public.painel_lote where chave = 'recuperar_todos'")[0][0]
        print("\nfila congelada depois da limpeza: %s" % restante)
    falhas = [r for ok_, r in RESULTADOS if not ok_]
    print("%d/%d provas passaram" % (len(RESULTADOS) - len(falhas), len(RESULTADOS)))
    if falhas:
        print("falharam:", falhas)
        sys.exit(1)


if __name__ == "__main__":
    main()
