# Cópia de testes do painel (`2PEER`)

É o mesmo código do painel, rodando em cima de um **banco separado** e com a trava de
teste ligada. Nada do que acontece aqui chega num cliente de verdade.

## O que está travado

Com `PEIXEIRO_MODO_TESTE=1` (vem ligado no `render-2peer.yaml`):

- `greenapi_send_file` e `greenapi_send_text` devolvem `{"ok": true, "simulado": true}`
  sem tocar no GreenAPI. As telas mostram "enviado" e o controle de avisos grava normal,
  porque quem manda é o banco da cópia.
- `_deletar_linha` devolve `(200, {"simulado": true})`: a aba **Deletar** percorre o
  intervalo inteiro, risca o espelho e registra o evento, mas **nenhuma linha do painel
  MC é apagada**.
- Ler o painel MC continua funcionando (as listas e a contagem são reais), porque leitura
  não muda nada para o cliente.

Para ligar a cópia no painel MC de verdade é preciso tirar a variável e saber exatamente
o que se está fazendo — ela foi feita para não precisar disso.

## Publicar no Render

Este repositório é **público** e não tem nenhuma credencial dentro — nem no código, nem no
histórico (ele começa num commit único, justamente para não carregar as senhas antigas do
site que está no ar). Por isso o Render pega o código por *New → Web Service → Public Git
Repository*, com `https://github.com/kuttenc/2PEER.git`, branch `main`. Nesse modo a
atualização é manual: *Manual Deploy → Deploy latest commit* depois de cada push.

O `render-2peer.yaml` é o desenho do serviço (blueprint); ele serve para conferir as
variáveis ou para publicar por *New → Blueprint* caso o Render passe a enxergar a conta
`kuttenc`.

| Variável | O que é |
| --- | --- |
| `DATABASE_URL` | conexão do projeto Supabase da cópia (o formato está abaixo) |
| `MC_USERNAME` / `MC_PASSWORD` | só para as abas Acessos e Deletar listarem de verdade |
| `PAINEL_SENHA_INICIAL` | a senha que abre o painel na primeira vez; em branco ele sorteia uma e escreve no log |
| `URTADOR_TOKEN` | opcional; sem ele o link curto sai como visita |
| `GREENAPI_*` | opcional; só preenche a aba Config de um banco zerado (a cópia não manda nada) |

O formato da conexão (o endereço do projeto está no `.env` local, a senha não vai para
lugar nenhum do repositório):

```
postgres://postgres.<ref>:<senha>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require
```

O `ensure_schema()` roda em toda conexão, então as 10 tabelas aparecem sozinhas na
primeira abertura — foi assim que o banco `bzgtptbwcvwpgnhbctjn` foi criado.

**A senha do painel na cópia nunca foi a mesma do site no ar.** Ela vem de
`PAINEL_SENHA_INICIAL`; sem essa variável o sorteio é impresso uma vez no log do Render.
De qualquer forma, troque em `/painel/senha` assim que abrir.

## Rodar no computador

```
pip install -r requirements.txt
copy .env.example .env      # e preencher DATABASE_URL
python -c "import app; app.app.run(debug=True, port=5055)"
```

Abrir `http://127.0.0.1:5055/painel/`. O `.env` está no `.gitignore` e nunca sobe.

## Encurtador de links

`encurtador.py` fala com o mesmo serviço que o site de encurtar usa (uma Edge Function do
Supabase com API de ação única). A chave que vai no cabeçalho `apikey` é a chave pública
do próprio site — ela aparece no HTML público do encurtador, então embutir o padrão no
código não revela nada. O token de sessão (`URTADOR_TOKEN`) é o único segredo e só vem de
variável de ambiente.

```python
import encurtador
encurtador.encurtar("https://pagamento.exemplo/abc", slug="pix hoje", titulo="renovacao")
# {"ok": True, "curto": "https://kuttenc.github.io/urtador/pix-hoje",
#  "slug": "pix-hoje", "alvo": "https://pagamento.exemplo/abc", "visita": True}
```

- O slug é limpado no mesmo formato do servidor (minúsculo, só `a-z0-9_-`, até 48) e nomes
  que já são páginas do encurtador (`index`, `admin`, `assets`…) são recusados antes de
  sair qualquer chamada.
- Se o encurtador estiver fora do ar, volta `{"ok": False, "erro": ...}` — **nenhuma
  exceção sobe**, então uma mensagem continua sendo enviada com o endereço comprido.
- Sem token: 10 links por minuto por IP (o módulo manda um `guestSessionId`; fixe em
  `URTADOR_SESSAO` para não estourar o limite). Com token: 30 por minuto e o link fica na
  conta, com o clique no relatório.
- `encurtador.resolver(slug)` consulta para onde um link curto está apontando.

No painel a tela é **Links** (`/painel/links`) e a API é
`POST /painel/links/encurtar` com `url`, `slug` e `titulo` — atrás do mesmo login do
restante do painel, então nenhuma chave aparece no navegador.

## Como isto foi verificado

`_smoke_2peer.py` (arquivo de teste local, fora do repositório) roda a suíte inteira do
painel contra a cópia e ainda checa: o payload e os cabeçalhos do encurtador, o erro do
servidor quando o nome já está em uso, o caminho sem rede, a tela Links aberta e fechada
para quem não fez login, e que com a trava ligada os dois envios e o `DELETE` do MC
devolvem "simulado" sem tocar na rede.
