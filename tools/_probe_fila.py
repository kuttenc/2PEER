"""Sonda da aba Nao recuperados: monta uma fila de mentira no banco da copia e mostra o estado.

  python tools/_probe_fila.py install   -> plano de 6 linhas stub em recuperar_todos
  python tools/_probe_fila.py show      -> plano + estado como o banco ve
  python tools/_probe_fila.py clean     -> apaga o que veio de stub%
"""
import json
import re
import sys
import pathlib

import psycopg2
import psycopg2.extras

ENV = dict(re.findall(r"^([A-Z_0-9]+)=(.*)$", (pathlib.Path(__file__).resolve().parents[1] / ".env").read_text(), re.M))
URL = ENV["DATABASE_URL"].strip().strip('"')


def conn():
    return psycopg2.connect(URL)


def install():
    plano = [
        {"username": "stub%02d" % i, "telefone": "55119000000%02d" % i,
         "exp_iso": "2026-10-%02dT12:00:00+00:00" % (i + 1), "busca": ""}
        for i in range(1, 7)
    ]
    estado = {"rodando": False, "enviados": 0, "falhas": 0, "erros": [], "indice": 0,
              "total": len(plano), "seguidas": 0, "resultados": {}, "enviando": None}
    with conn() as c:
        c.cursor().execute(
            """insert into public.painel_lote (chave, tipo, plano, estado, aviso, atualizado_em)
               values ('recuperar_todos','recuperar',%s::jsonb,%s::jsonb,'sonda da fila',now())
               on conflict (chave) do update set tipo='recuperar', plano=excluded.plano,
                 estado=excluded.estado, aviso='sonda da fila', atualizado_em=now()""",
            (json.dumps(plano), json.dumps(estado)),
        )
    print("plano de mentira gravado:", len(plano), "linhas")


def show():
    with conn() as c:
        cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("select plano, estado, aviso, atualizado_em from public.painel_lote where chave='recuperar_todos'")
        r = cur.fetchone()
        if not r:
            print("sem linha recuperar_todos")
            return
        e = r["estado"]
        print("atualizado:", r["atualizado_em"], "aviso:", r["aviso"])
        print("estado:", json.dumps({k: v for k, v in e.items() if k != "erros"}, ensure_ascii=False))
        for i, item in enumerate(r["plano"]):
            marca = (e.get("resultados") or {}).get(str(i))
            print(" #%d %s%s%s" % (i + 1, item["username"], " FORA" if item.get("ignorado") else "",
                                   " -> " + json.dumps(marca, ensure_ascii=False) if marca else ""))


def clean():
    with conn() as c:
        cur = c.cursor()
        cur.execute("delete from public.painel_lote where chave='recuperar_todos'")
        cur.execute("delete from public.painel_links where usuario like 'stub%%'")
        cur.execute("delete from public.renovacao_avisos where username like 'stub%%'")
        cur.execute("delete from public.usuarios_criados_ip where username like 'stub%%'")
        cur.execute(
            "delete from public.mcapi_events where request_payload::text like '%stub%' or response_payload::text like '%stub%'")
        print("limpo:", cur.rowcount, "eventos")


if __name__ == "__main__":
    {"install": install, "show": show, "clean": clean}[sys.argv[1]]()
