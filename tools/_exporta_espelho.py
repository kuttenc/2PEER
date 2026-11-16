"""Backup do espelho de clientes (`public.mc_linhas`) para um CSV fora do repositório.

Faz a mesma coisa que a aba Clientes > Exportar do painel, mas do computador, sem abrir o
navegador e sem mexer em nada: só lê e escreve arquivo. O arquivo sai para
`../backup-espelho/` (fora do git de propósito: tem telefone de cliente dentro).

    cd 2peer
    python tools/_exporta_espelho.py            # tudo
    python tools/_exporta_espelho.py so-espelho # só quem nunca teve linha no painel MC

`so-espelho` é o filtro `linha_id` vazio: são as linhas que existem apenas aqui no banco
(importadas por CSV), exatamente as que o lote montado no painel MC não consegue achar.
"""

import csv
import datetime
import os
import re
import sys

import psycopg2

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
DESTINO = os.path.join(os.path.dirname(RAIZ), "backup-espelho")


def url_do_banco():
    ambiente = os.environ.get("DATABASE_URL")
    if ambiente:
        return ambiente
    caminho = os.path.join(RAIZ, ".env")
    with open(caminho, encoding="utf-8", errors="replace") as arquivo:
        for linha in arquivo:
            if linha.strip().startswith("DATABASE_URL="):
                return linha.split("=", 1)[1].strip().strip('"')
    raise SystemExit("sem DATABASE_URL no ambiente nem no .env")


def principal():
    so_espelho = "so-espelho" in sys.argv[1:]
    filtro = "where coalesce(linha_id, '') = ''" if so_espelho else ""
    with psycopg2.connect(url_do_banco()) as conexao:
        with conexao.cursor() as cursor:
            cursor.execute(
                f"""
                select username, telefone, linha_id, exp_date, status, notes, synced_at
                  from public.mc_linhas
                  {filtro}
                 order by username
                """
            )
            linhas = cursor.fetchall()

    os.makedirs(DESTINO, exist_ok=True)
    dia = datetime.date.today().isoformat()
    nome = f"mc_linhas-{dia}{'-so-espelho' if so_espelho else '-tudo'}.csv"
    caminho = os.path.join(DESTINO, nome)
    with open(caminho, "w", newline="", encoding="utf-8-sig") as arquivo:
        escritor = csv.writer(arquivo, delimiter=";")
        escritor.writerow(["usuario", "telefone", "linha_id", "expira", "status", "nota", "sincronizado"])
        for linha in linhas:
            escritor.writerow([coluna if coluna is not None else "" for coluna in linha])

    print(f"{len(linhas)} linhas -> {caminho}")
    sem_telefone = sum(1 for linha in linhas if not re.sub(r"\D", "", str(linha[1] or "")))
    print(f"dessas, {sem_telefone} sem telefone e {len(linhas) - sem_telefone} com telefone")


if __name__ == "__main__":
    principal()
