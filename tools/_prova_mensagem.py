"""Prova da mensagem avulsa da aba Clientes: WhatsApp comum, sem painel MC no meio.

Rode a função primeiro, com o envio desarmado (PEIXEIRO_MODO_TESTE faz o GreenAPI devolver
"simulado" antes de qualquer rede):

  cd supabase/functions/peixeiro
  PEIXEIRO_MODO_TESTE=1 npx --yes deno run -A --env-file=../../../.env index.ts

e então, da pasta 2peer:

  python tools/_prova_mensagem.py            # roda a bateria e limpa o que criou
  python tools/_prova_mensagem.py limpar     # só a limpeza, se a bateria quebrar no meio

É o caminho de quem foi apagado do painel MC mas continua na agenda de telefones: o texto sai
pelo GreenAPI, sem criar link, sem foto e sem uma chamada ao MC. Nada deixa este computador
enquanto o modo teste estiver ligado; no fim apago a fila, os avisos e os logs que a bateria criou.
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
TEXTO = "Oi {{usuario}}, seu acesso está parado. Responda aqui que eu mando o novo."

RESULTADOS = []
# Quem a aba Clientes mostra embaixo do espelho: telefone na agenda, linha que não existe no MC.
FORA_MC_SQL = """
  select a.username
    from (select distinct on (username) username
            from public.usuarios_criados_ip
           where coalesce(telefone, '') <> ''
             and not exists (select 1 from public.mc_linhas m
                               where m.username = usuarios_criados_ip.username)
           order by username, updated_at desc) a
"""
# O outro pedaço da lista: quem tem linha no painel MC e número para receber.
NO_MC_SQL = """
  select m.username from public.mc_linhas m
   where coalesce(m.linha_id, '') <> '' and coalesce(m.telefone, '') <> ''
     and m.username not in (select username from public.renovacao_avisos
                             where updated_at > now() - interval '3 hours')
"""
RECENTES_SQL = "select distinct username from public.renovacao_avisos where updated_at > now() - interval '3 hours'"


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


def eventos_mc(cli):
    """O rastro de quem abriu o painel MC: só o login do `tokenDoPainel` escreve isto."""
    return consulta(cli, "select count(*) from public.mcapi_events where event_type = 'login_refresh'")[0][0]


def plano_congelado(cli):
    linhas = consulta(cli, "select plano from public.painel_lote where chave = 'mensagem_lote'")
    if not linhas:
        return []
    valor = linhas[0][0]
    return json.loads(valor) if isinstance(valor, str) else (valor or [])


def limpar(cli):
    cur = cli.cursor()
    cur.execute("delete from public.painel_lote where chave = 'mensagem_lote'")
    cur.execute("delete from public.renovacao_avisos where via = 'mensagem'"
                "  and updated_at > now() - interval '30 minutes'")
    cur.execute("delete from public.mcapi_events where event_type in ('mensagem_envio', 'mensagem_lote_inicio',"
                "                                          'mensagem_lote_retoma')"
                "  and created_at > now() - interval '30 minutes'")
    cli.commit()
    print("limpo: fila 'mensagem_lote', avisos via=mensagem e os logs desta bateria")


def provar(token, cli, fora, no_mc, nomes):
    local = "127.0.0.1" in FUNCAO
    pulado, alvo, avulso = nomes
    recentes = {r[0] for r in consulta(cli, RECENTES_SQL)}
    alvos_fora = len([u for u in fora if u not in recentes])

    status, d = chamar("ping")
    checar("a função está de pé", status == 200 and d.get("ok"), str(d))
    if local:
        checar("o envio está DESARMADO (modo teste ligado)", d.get("modo_teste") is True,
               "sem modo teste esta bateria manda WhatsApp de verdade")

    status, d = chamar("clientes_ver", {}, token)
    checar("a aba Clientes enxerga os fora do MC", d.get("ok") and d.get("so_agenda") == len(fora),
           "%s vs %s na agenda" % (d.get("so_agenda"), len(fora)))

    antes = eventos_mc(cli)
    t0 = time.time()
    status, d = chamar("lote_contagem", {"tipo": "mensagem", "texto": TEXTO, "quem": "fora",
                                         "pular": [pulado]}, token)
    durou = time.time() - t0
    checar("a contagem da mensagem responde", status == 200 and d.get("ok"), str(d)[:120])
    checar("na_lista é o espelho em cima da agenda", d.get("na_lista") == len(fora) + d.get("com_linha_mc"),
           str(d.get("na_lista")))
    checar("sem_linha_mc bate com a aba Clientes", d.get("sem_linha_mc") == len(fora),
           "%s vs %s" % (d.get("sem_linha_mc"), len(fora)))
    checar("o marcado para pular saiu da conta", d.get("pulados") == 1, str(d.get("pulados")))
    checar("vão receber é a agenda menos o marcado", d.get("alvos") == alvos_fora - 1,
           "%s vs %s" % (d.get("alvos"), alvos_fora - 1))
    checar("quem recebeu algo nas últimas 3h ficou de fora",
           d.get("esperando") == len([u for u in fora if u in recentes]), str(d.get("esperando")))
    checar("a contagem da mensagem não abre o painel MC", durou < 20 and eventos_mc(cli) == antes, "%.1fs" % durou)
    checar("o tamanho do texto volta conferido", d.get("caracteres") == len(TEXTO), str(d.get("caracteres")))

    plano = plano_congelado(cli)
    checar("o plano congelado tem exatamente os alvos", len(plano) == d.get("alvos"),
           "%s vs %s" % (len(plano), d.get("alvos")))
    checar("todo item do plano carrega o texto", bool(plano) and all(i.get("texto") == TEXTO for i in plano), "")
    checar("todo item do plano tem telefone", all(str(i.get("telefone") or "") for i in plano), "")
    checar("o marcado para pular não entrou no plano", pulado not in {i["username"] for i in plano}, "")
    checar("quem tem linha no MC ficou de fora do \"fora\"",
           all(u not in no_mc for u in [i["username"] for i in plano]), "")
    checar("a mensagem alcança muito mais gente que o MC", len(plano) > 100, "%s na fila" % len(plano))

    if no_mc:
        status, d = chamar("lote_contagem", {"tipo": "mensagem", "texto": TEXTO, "quem": "todos",
                                             "pular": [pulado]}, token)
        checar("\"todos\" chama o espelho de volta para a fila",
               d.get("ok") and d.get("alvos") == alvos_fora - 1 + len(no_mc),
               "%s vs %s+%s" % (d.get("alvos"), alvos_fora - 1, len(no_mc)))
        checar("e o marcado para pular continua de fora", d.get("pulados") == 1, str(d.get("pulados")))
        chamar("lote_contagem", {"tipo": "mensagem", "texto": TEXTO, "quem": "fora", "pular": [pulado]}, token)
    else:
        print("   (nenhum cliente do espelho com telefone fora das últimas 3h: \"todos\" não foi provado)")

    status, d = chamar("lote_contagem", {"tipo": "mensagem", "texto": TEXTO, "quem": "fora", "q": alvo}, token)
    checar("o filtro da tela também vale na mensagem", d.get("ok") and d.get("alvos") == 1, str(d.get("alvos")))
    status, d = chamar("lote_contagem", {"tipo": "mensagem", "texto": "   ", "quem": "fora"}, token)
    checar("texto vazio não monta fila", not d.get("ok") and d.get("erro") == "sem_texto", str(d)[:80])
    status, d = chamar("lote_contagem", {"tipo": "mensagem", "texto": "x" * 1300, "quem": "fora"}, token)
    checar("texto acima de 1200 caracteres é recusado", not d.get("ok") and d.get("erro") == "texto_grande",
           str(d)[:80])

    # Volta para a conferência do lote, com o pulado de fora e sem filtro.
    status, d = chamar("lote_contagem", {"tipo": "mensagem", "texto": TEXTO, "quem": "fora",
                                         "pular": [pulado]}, token)
    plano = plano_congelado(cli)

    telefone_do_avulso = [i["telefone"] for i in plano if i["username"] == avulso]
    status, d = chamar("mensagem_um", {"username": avulso, "texto": TEXTO}, token)
    checar("a mensagem de um cliente só sai simulada", d.get("ok"), str(d)[:120])
    checar("ela devolve o número da agenda e o tamanho",
           bool(telefone_do_avulso) and d.get("telefone") == telefone_do_avulso[0] and
           d.get("caracteres") == len(TEXTO), mascarar(str(telefone_do_avulso)))
    registro = consulta(cli, "select request_payload ->> 'via', request_payload ->> 'username'"
                             " from public.mcapi_events where event_type = 'mensagem_envio'"
                             " order by id desc limit 1")[0]
    checar("o log marca o envio avulso sem passar pelo MC",
           registro[0] == "avulso" and registro[1] == avulso, str(registro))
    checar("a mensagem avulsa não criou link de recuperação",
           consulta(cli, "select count(*) from public.painel_links where usuario = %s"
                         "  and atualizado_em > now() - interval '30 minutes'", (avulso,))[0][0] == 0, "")
    status, d = chamar("mensagem_um", {"username": "fulanodanunga27", "texto": TEXTO}, token)
    checar("sem telefone em lugar nenhum a mensagem não sai",
           not d.get("ok") and d.get("erro") == "sem_telefone", str(d)[:80])

    status, d = chamar("lote_executar", {"tipo": "mensagem"}, token)
    if not local:
        checar("sem confirmar o lote não sai", not d.get("ok"), str(d)[:80])
        return
    checar("sem confirmar o lote não sai", not d.get("ok"), str(d)[:80])

    status, d = chamar("lote_executar", {"tipo": "mensagem", "confirmar": "sim"}, token)
    checar("a conferência ainda vale e o lote abre", d.get("ok") and d.get("total") == len(plano), str(d)[:120])

    enviados, estado = [], {}
    for _ in range(3):
        status, d = chamar("lote_item", {"tipo": "mensagem"}, token)
        item = (d.get("item") or {}) if d.get("ok") else {}
        if item.get("username"):
            enviados.append(item["username"])
        estado = d.get("estado") or {}
        if not d.get("ok") or not estado.get("rodando"):
            break
    checar("as três mensagens saíram simuladas", len(enviados) == 3 and pulado not in enviados,
           ",".join(enviados))
    checar("o estado conta os enviados", (estado.get("enviados") or 0) >= 3, str(estado.get("enviados")))
    checar("o lote de mensagem também sorteia a pausa", "esperar" in d, str(d.get("esperar")))
    guardados = consulta(cli, "select username, exp_date, via from public.renovacao_avisos"
                              " where username = any(%s) and via = 'mensagem'", (enviados,))
    checar("cada mensagem do lote fica registrada com a data vazia",
           len(guardados) == 3 and all(g[1] == "" for g in guardados), str(guardados)[:120])
    checar("o lote de mensagem não criou link de recuperação",
           consulta(cli, "select count(*) from public.painel_links where usuario = any(%s)"
                         "  and atualizado_em > now() - interval '30 minutes'", (enviados,))[0][0] == 0, "")

    status, d = chamar("lote_fila", {"tipo": "mensagem"}, token)
    checar("a fila viva mostra a lista de fora do MC", d.get("ok") and d.get("fonte") == "fora",
           str(d.get("fonte")))
    checar("a fila tem o total do plano", d.get("total") == len(plano), str(d.get("total")))
    situacoes = {i["usuario"]: i["situacao"] for i in d.get("itens", [])}
    checar("quem já saiu aparece como enviado",
           all(situacoes.get(u) == "enviado" for u in enviados), str([situacoes.get(u) for u in enviados]))

    status, d = chamar("lote_parar", {"tipo": "mensagem"}, token)
    checar("parar o envio funciona", d.get("ok") and not (d.get("estado") or {}).get("rodando"), "")
    status, d = chamar("lote_retomar", {"tipo": "mensagem"}, token)
    checar("retomar continua do ponto em que parou", d.get("ok") and (d.get("estado") or {}).get("rodando"),
           str(d)[:120])
    chamar("lote_parar", {"tipo": "mensagem"}, token)

    checar("o painel MC não foi aberto em nenhum momento da bateria", eventos_mc(cli) == antes,
           "%s -> %s" % (antes, eventos_mc(cli)))


def main():
    cli = banco()
    token = token_sessao(cli)
    fora = [r[0] for r in consulta(cli, FORA_MC_SQL + " order by a.username")]
    no_mc = [r[0] for r in consulta(cli, NO_MC_SQL)]
    if len(fora) < 3:
        print("a agenda da cópia não tem 3 clientes fora do MC: %s" % fora[:3])
        sys.exit(2)
    if "limpar" in sys.argv[1:]:
        limpar(cli)
        return
    # A ordem do plano é a da tela; escolho o marcado, o filtro e o avulso por dentro dela para
    # nenhum dos três brigar com os três envios do lote.
    chamar("lote_contagem", {"tipo": "mensagem", "texto": TEXTO, "quem": "fora"}, token)
    ordem = [str(i.get("username")) for i in plano_congelado(cli)]
    nomes = (ordem[0], ordem[1], ordem[-1])
    try:
        provar(token, cli, fora, no_mc, nomes)
    finally:
        limpar(cli)
        print("fila congelada depois da limpeza: %s"
              % consulta(cli, "select count(*) from public.painel_lote where chave = 'mensagem_lote'")[0][0])
    falhas = [r for ok_, r in RESULTADOS if not ok_]
    print("%d/%d provas passaram" % (len(RESULTADOS) - len(falhas), len(RESULTADOS)))
    if falhas:
        print("falharam:", falhas)
        sys.exit(1)


if __name__ == "__main__":
    main()
