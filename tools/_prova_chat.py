"""Prova do robô de conversa na cópia, sem mandar nada para cliente nenhum.

Rode a função primeiro, com o envio desarmado (PEIXEIRO_MODO_TESTE faz o enviarTexto
devolver "simulado" antes de qualquer rede):

  cd supabase/functions/peixeiro
  PEIXEIRO_MODO_TESTE=1 npx --yes deno run -A --env-file=../../../.env index.ts

e então, da pasta 2peer:

  python tools/_prova_chat.py            # roda a bateria toda e limpa o que criou
  python tools/_prova_chat.py limpar     # só a limpeza, se a bateria quebrar no meio

O telefone "FORA" não é cliente de ninguém. O cliente verdadeiro vem do próprio espelho
do banco, mas com o envio simulado nada sai do computador.
"""
import json
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
FUNCAO = "http://127.0.0.1:8000/"

FORA = "5511900000011"          # ninguém nosso: o caminho do telefone desconhecido
NOSSO = "5511999998888"         # finge ser o número da própria instância: nunca pode receber resposta
STUB = "STUB-CHAT"
STUB_STATUS = "STUB-STATUS-0001"

RESULTADOS = []
MARCA = {}                      # ultimo id de cada tabela antes da bateria: o que veio depois é stub
DIGITOS = re.compile(r"\d{8,}")


def mascarar(texto):
    return DIGITOS.sub("****", str(texto))


def checar(rotulo, verdadeiro, detalhe=""):
    RESULTADOS.append((bool(verdadeiro), rotulo))
    print("%s %-54s %s" % ("OK  " if verdadeiro else "FAIL", rotulo, mascarar(detalhe)[:150]))


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
        with urllib.request.urlopen(req, timeout=120) as resp:
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


def webhook(chave, corpo):
    return _pos(FUNCAO + "?action=chat_webhook&token=" + str(chave), corpo)


def mensagem(chave_id, telefone, texto, desde_mim=False):
    """O corpo que a GreenAPI manda hoje (eventType 1, body.content.text)."""
    return {
        "type": "message",
        "eventType": 1,
        "senderDeviceId": NOSSO + "@c.us",
        "chatId": telefone + "@c.us",
        "body": {
            "messageId": {"id": chave_id, "chat_id": telefone + "@c.us", "fromMe": desde_mim},
            "senderDeviceId": telefone + "@c.us",
            "chatId": telefone + "@c.us",
            "content": {"text": texto},
            "timestamp": int(time.time()),
            "type": "incomingMessage" if not desde_mim else "outgoingMessage",
        },
    }


def status_evento(id_message, telefone, estado):
    return {
        "type": "message",
        "eventType": 8,
        "senderDeviceId": NOSSO + "@c.us",
        "body": {
            "chatId": telefone + "@c.us",
            "idMessage": id_message,
            "status": estado,
            "type": "messageStatus",
        },
    }


def consulta(cli, sql, params=()):
    cur = cli.cursor()
    cur.execute(sql) if not params else cur.execute(sql, params)
    return cur.fetchall()


def executar(cli, sql, params=()):
    cur = cli.cursor()
    cur.execute(sql) if not params else cur.execute(sql, params)
    cli.commit()
    return cur.rowcount


def provar():
    cli = banco()
    limpar_cli(cli)
    MARCA.update({
        "mensagens": consulta(cli, "select coalesce(max(id),0) from public.chat_mensagens")[0][0],
        "treino": consulta(cli, "select coalesce(max(id),0) from public.chat_treino")[0][0],
    })

    _, ping = chamar("ping")
    checar("a função está em modo teste (nada sai)", ping.get("modo_teste") is True, ping)

    sem_login = chamar("chat_ver")
    checar("chat_ver sem sessão é recusado",
           sem_login[0] == 401 and sem_login[1].get("erro") == "sem_sessao", sem_login[1])

    sessao = token_sessao(cli)
    status, ver = chamar("chat_ver", token=sessao)
    chave = str(ver.get("token") or "")
    checar("chat_ver autenticado", status == 200 and "webhook" in ver,
           {k: ver.get(k) for k in ("ativo", "dias", "mensagens", "mensagens", "treino")})
    checar("a chave do webhook nasceu com 16 bytes", len(chave) >= 20, len(chave))
    checar("a url do webhook carrega a ação e a chave",
           "action=chat_webhook" in str(ver.get("webhook")) and str(ver.get("webhook")).endswith("&token=" + chave),
           ver.get("webhook"))
    checar("as regras de fábrica vieram prontas", len(ver.get("regras") or []) >= 4,
           [r["gatilho"][:18] for r in (ver.get("regras") or [])])
    checar("leu a instância no GreenAPI", ver.get("instancia", {}).get("ok") is True, ver.get("instancia"))
    checar("avisa que o webhook ainda não está armado", ver.get("webhook_ok") is False,
           (ver.get("webhook_ok"), ver.get("telefone_diferente")))

    recusado = webhook("chave-errada", mensagem(STUB + "-1", FORA, "pix"))
    checar("webhook com a chave errada dá 401", recusado[0] == 401, recusado[1])

    evento = webhook(chave, status_evento(STUB_STATUS, FORA, "DELIVERY_ACK"))
    guardado = consulta(cli, "select status, telefone from public.whatsapp_status where id_message = %s", [STUB_STATUS])
    checar("o status de entrega é gravado",
           evento[1].get("entrega") == "DELIVERY_ACK" and guardado == [("DELIVERY_ACK", FORA)], (evento[1], guardado))

    de_fora = webhook(chave, mensagem(STUB + "-1", FORA, "qual é o pix?"))
    linhas = consulta(cli, "select direcao, usuario, telefone from public.chat_mensagens where chave = %s", [STUB + "-1"])
    checar("a mensagem entra na conversa com o robô desligado",
           de_fora[1].get("ignorado") == "robô desligado" and linhas == [("entrada", None, FORA)], (de_fora[1], linhas))
    checar("o telefone guardado é o do cliente, não o da instância",
           bool(linhas) and linhas[0][2] == FORA and NOSSO not in str(linhas), linhas)

    repedida = webhook(chave, mensagem(STUB + "-1", FORA, "qual é o pix?"))
    total = consulta(cli, "select count(*) from public.chat_mensagens where chave = %s", [STUB + "-1"])[0][0]
    checar("a mesma mensagem entregue duas vezes não vira duas respostas",
           repedida[1].get("duplicado") is True and total == 1, (repedida[1], total))

    midia = webhook(chave, {
        "type": "message", "eventType": 1, "chatId": FORA + "@c.us",
        "body": {"messageId": {"id": STUB + "-midia", "chat_id": FORA + "@c.us"},
                 "chatId": FORA + "@c.us", "content": {"locationMessage": {}}, "type": "incomingMessage"},
    })
    checar("localização/mídia sem texto é ignorada", midia[1].get("ignorado") == "sem texto", midia[1])

    meu = webhook(chave, mensagem(STUB + "-mim", FORA, "oi", desde_mim=True))
    checar("o que a gente mesmo mandou não dispara resposta", meu[1].get("ignorado") == "envio nosso", meu[1])

    grupo = webhook(chave, {
        "type": "message", "eventType": 1,
        "body": {"messageId": {"id": STUB + "-grupo", "chat_id": "120363000000000000@g.us"},
                 "chatId": "120363000000000000@g.us", "content": {"text": "pix"}, "type": "incomingMessage"},
    })
    checar("grupo fica de fora", grupo[1].get("ignorado") == "grupo", grupo[1])

    estado = webhook(chave, {"type": "stateInstance", "eventType": 7, "body": {"state": "authorized"}})
    checar("mudança de estado da instância não vira conversa",
           estado[1].get("ignorado") in ("tipo:stateinstance", "sem texto"), estado[1])

    # ------------------------------------------------------------------ liga o robô
    _, ligado = chamar("chat_ligar", {"ativo": True}, token=sessao)
    checar("o botão liga o robô", ligado.get("ativo") is True, ligado.get("ativo"))

    sem_cadastro = webhook(chave, mensagem(STUB + "-desc", FORA, "quero renovar"))
    treino = consulta(cli, "select resposta is null, cadastrado, telefone from public.chat_treino where telefone = %s", [FORA])
    checar("desconhecido não recebe resposta enquanto não for liberado",
           sem_cadastro[1].get("ignorado") == "telefone sem cadastro", sem_cadastro[1])
    checar("mas o par vai para o arquivo de treino sem resposta", treino == [(True, False, FORA)], treino)

    _, com_desconhecido = chamar("chat_ligar", {"desconhecido": True}, token=sessao)
    checar("liberar quem não está na base", com_desconhecido.get("desconhecido") is True, com_desconhecido.get("desconhecido"))

    regra_pix = consulta(cli, "select id, contagem from public.chat_regras where gatilho like 'pix,%'")[0]
    respondido = webhook(chave, mensagem(STUB + "-pix", FORA, "me manda a chave pix"))
    saida = consulta(cli, "select texto, chave from public.chat_mensagens where direcao = 'saida' and telefone = %s", [FORA])
    depois = consulta(cli, "select contagem from public.chat_regras where id = %s", [regra_pix[0]])[0][0]
    par = consulta(cli, "select resposta from public.chat_treino where entrada = 'me manda a chave pix'")[0][0]
    checar("a regra do PIX respondeu simulada",
           respondido[1].get("respondido") is True and respondido[1].get("simulado") is True
           and respondido[1].get("regra") == regra_pix[0], respondido[1])
    checar("a resposta ficou guardada como saída da conversa",
           bool(saida) and saida[0][1].startswith("saida-simulada"), (len(saida), saida[0][1] if saida else ""))
    checar("a regra contou o uso", int(depois) == int(regra_pix[1]) + 1, (regra_pix[1], depois))
    checar("o par pergunta-resposta virou treino com resposta", bool(par) and "PIX" in par.upper(), par)

    telefone_cliente = consulta(
        cli, "select telefone from public.mc_linhas where telefone <> '' and exp_date is not null"
             " order by exp_date desc limit 1")[0][0]
    nota_cliente = consulta(cli, "select notes from public.mc_linhas where telefone = %s", [telefone_cliente])[0][0]
    cliente_resposta = webhook(chave, mensagem(STUB + "-cliente", telefone_cliente, "quando vence meu acesso?"))
    texto_cliente = consulta(cli, "select texto from public.chat_mensagens"
                                  " where direcao = 'saida' and telefone = %s order by id desc limit 1", [telefone_cliente])
    corpo_resposta = texto_cliente[0][0] if texto_cliente else ""
    checar("a variável {{expira}} do cliente foi preenchida",
           cliente_resposta[1].get("respondido") is True and "{{" not in corpo_resposta,
           corpo_resposta.replace("\n", " | "))
    checar("o {{nome}} veio da nota do espelho do MC",
           bool(nota_cliente.strip()) and nota_cliente.strip().split()[0] in corpo_resposta, nota_cliente)
    conversa_cliente = consulta(cli, "select usuario from public.chat_mensagens where chave = %s", [STUB + "-cliente"])
    checar("a mensagem do cliente foi ligada ao usuário dele",
           bool(conversa_cliente) and bool(conversa_cliente[0][0]), conversa_cliente)

    sem_regra = webhook(chave, mensagem(STUB + "-vazio", FORA, "asdkjh qwe zxc"))
    checar("mensagem que nenhuma regra entendeu cai no treino",
           sem_regra[1].get("sem_regra") is True, sem_regra[1])

    _, conversa = chamar("chat_conversas", {"telefone": FORA}, token=sessao)
    direcoes = [m["direcao"] for m in (conversa.get("mensagens") or [])]
    checar("a conversa do telefone abre na tela",
           "entrada" in direcoes and "saida" in direcoes, direcoes)

    _, de_novo = chamar("chat_ver", token=sessao)
    telefones = [c["telefone"] for c in (de_novo.get("conversas") or [])]
    checar("os telefones conversados aparecem na lista", FORA in telefones, telefones[:3])
    checar("a contagem da aba bate com o banco",
           de_novo.get("mensagens") == consulta(cli, "select count(*) from public.chat_mensagens")[0][0],
           (de_novo.get("mensagens"), de_novo.get("treino")))

    # ------------------------------------------------------- criar / salvar / apagar
    _, criado = chamar("chat_novo", {"gatilho": "stub chatbot", "resposta": "oi {{nome}}", "prioridade": "5"},
                       token=sessao)
    id_novo = criado.get("id")
    checar("o botão criar outro chat fez a regra",
           bool(id_novo) and len(criado.get("regras") or []) == len(de_novo.get("regras") or []) + 1,
           (id_novo, len(criado.get("regras") or [])))

    _, gravada = chamar("chat_salvar", {"id": id_novo, "gatilho": "stub chatbot", "resposta": "resposta nova",
                                        "prioridade": "7", "ativo": False}, token=sessao)
    linha = [r for r in (gravada.get("regras") or []) if r["id"] == id_novo]
    checar("salvar a regra editada",
           bool(linha) and linha[0]["resposta"] == "resposta nova" and linha[0]["prioridade"] == 7
           and linha[0]["ativo"] is False, linha)

    sem_gatilho = chamar("chat_salvar", {"id": id_novo, "gatilho": "", "resposta": "x"}, token=sessao)
    checar("regra sem gatilho é recusada",
           sem_gatilho[0] == 400 and sem_gatilho[1].get("erro") == "chat_gatilho", sem_gatilho[1])

    teste_casamento = webhook(chave, mensagem(STUB + "-desligada", FORA, "stub chatbot"))
    checar("regra desligada não responde",
           teste_casamento[1].get("sem_regra") is True, teste_casamento[1])

    _, apagada = chamar("chat_apagar", {"id": id_novo}, token=sessao)
    checar("apagar a regra", not [r for r in (apagada.get("regras") or []) if r["id"] == id_novo],
           len(apagada.get("regras") or []))

    fantasma = chamar("chat_apagar", {"id": 99999999}, token=sessao)
    checar("apagar regra que não existe dá aviso",
           fantasma[0] == 400 and fantasma[1].get("erro") == "sem_regra", fantasma[1])

    # ------------------------------------------------------------- retenção e exportar
    _, dias = chamar("chat_ligar", {"dias": 7}, token=sessao)
    checar("mudar a retenção para 7 dias", dias.get("dias") == 7, dias.get("dias"))
    _, guardada = chamar("chat_ligar", {"dias": 90}, token=sessao)
    checar("voltar a retenção para 90 dias", guardada.get("dias") == 90, guardada.get("dias"))

    executar(cli, "insert into public.chat_mensagens (chave, telefone, direcao, texto, criado_em, expira_em)"
                  " values (%s, %s, 'entrada', 'velha', now() - interval '91 days', now() - interval '1 day')",
             [STUB + "-velha", FORA])
    webhook(chave, mensagem(STUB + "-poda", FORA, "pix"))
    sobrou = consulta(cli, "select count(*) from public.chat_mensagens where chave = %s", [STUB + "-velha"])[0][0]
    expiradas = consulta(cli, "select count(*) from public.chat_mensagens where expira_em < now()")[0][0]
    checar("cada mensagem nova limpa o que venceu os 90 dias",
           sobrou == 0 and expiradas == 0, (sobrou, expiradas))

    _, treino_csv = chamar("chat_treino_exportar", token=sessao)
    cabecalho = (treino_csv.get("csv") or "").splitlines()
    checar("exportar o treino vem em CSV com cabeçalho",
           bool(cabecalho) and cabecalho[0].lstrip("﻿") == "Pergunta;Resposta;Regra;Cliente;Cadastrado;Quando"
           and treino_csv.get("n", 0) >= 3, (treino_csv.get("nome"), len(cabecalho) - 1))

    # ------------------------------------------------------------- a coluna "entrega"
    dentro = banco()
    dentro.autocommit = False
    cur = dentro.cursor()
    cur.execute("insert into public.renovacao_avisos (username, exp_date, telefone, status_code, id_message, response)"
                " values ('stubchat01', '2026-11-15', %s, 200, %s, '{}'::jsonb)", (FORA, STUB_STATUS))
    cur.execute("select distinct on (a.username) a.username, coalesce(s.status,'') as status, s.detalhe"
                " from public.renovacao_avisos a join public.whatsapp_status s on s.id_message = a.id_message"
                " where a.username = any(%s::text[]) order by a.username, a.updated_at desc", ([ "stubchat01"],))
    uniao = cur.fetchall()
    dentro.rollback()
    dentro.close()
    checar("a junta fila + entrega devolve o status do cliente",
           uniao == [("stubchat01", "DELIVERY_ACK", "")], uniao)

    _, fila = chamar("lote_fila", {"tipo": "recuperar"}, token=sessao)
    itens = fila.get("itens") or []
    checar("a fila devolve o campo entrega para cada linha",
           bool(fila.get("itens", True)) and all("entrega" in item for item in itens),
           [(i.get("situacao"), i.get("entrega")) for i in itens[:2]])

    chamar("chat_ligar", {"desconhecido": False}, token=sessao)
    cli.close()


def limpar_cli(cli=None):
    próprio = cli is None
    if próprio:
        cli = banco()
    if MARCA:
        # tudo que nasceu depois da marca é da bateria: apaga pelo id, sem depender do texto
        executar(cli, "delete from public.chat_mensagens where id > %s", [MARCA["mensagens"]])
        executar(cli, "delete from public.chat_treino where id > %s", [MARCA["treino"]])
    executar(cli, "delete from public.chat_mensagens where telefone in (%s, %s) or chave like %s",
             [FORA, NOSSO, STUB + "%"])
    executar(cli, "delete from public.chat_mensagens where chave like 'saida-simulada%'")
    executar(cli, "delete from public.chat_treino where telefone in ('', %s, %s)"
                  " or entrada in ('me manda a chave pix', 'quando vence meu acesso?')", [FORA, NOSSO])
    executar(cli, "delete from public.whatsapp_status where id_message = %s or id_message like 'simulada-%%'", [STUB_STATUS])
    executar(cli, "delete from public.chat_regras where gatilho = 'stub chatbot'")
    executar(cli, "update public.greenapi_config set chat_ativo = false, chat_desconhecido = false,"
                  " chat_dias = 90 where id = 1")
    sobras = consulta(cli, "select (select count(*) from public.chat_mensagens),"
                           " (select count(*) from public.chat_treino),"
                           " (select count(*) from public.whatsapp_status),"
                           " (select count(*) from public.chat_regras),"
                           " (select chat_ativo or chat_desconhecido from public.greenapi_config where id = 1)")
    print("\n   sobras (mensagens, treino, status, regras, robô ligado):", sobras[0])
    if próprio:
        cli.close()


if __name__ == "__main__":
    if "limpar" in sys.argv:
        limpar_cli()
    else:
        try:
            provar()
        finally:
            limpar_cli()
        falhas = [r for r in RESULTADOS if not r[0]]
        print("\n%d/%d provas passaram" % (len(RESULTADOS) - len(falhas), len(RESULTADOS)))
        if falhas:
            print("falharam:", [f[1] for f in falhas])
            sys.exit(1)
