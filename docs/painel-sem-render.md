# Painel sem Render: Pages + Edge Function

Este documento cobre o painel de `kuttenc.github.io/2PEER`, que desde 18/11/2026 roda no
projeto `ggufcvrwctieacvbbwim` (o mesmo do Urtador) em vez da cópia `bzgtptbwcvwpgnhbctjn`.
Nada aqui mexe no serviço do Render nem no banco de produção: o site principal continua
exatamente como está hoje. Veja "Onde cada projeto está hoje" e "A virada para o projeto do
Urtador".

## O que mudou de arquitetura

Antes: navegador → Flask no Render → Supabase + painel MC.
Agora: navegador (página estática no GitHub Pages) → Edge Function `peixeiro` no Supabase
→ Postgres do Supabase + painel MC.

O Render deixa de existir no caminho. As chaves (GreenAPI, token do MC, telefone do MC)
nunca passam pelo navegador: ficam como secrets da função, e toda rota sensível é uma
chamada `POST` com `{"action": "..."}` e o token de sessão no header `Authorization`.

Arquivos novos:

- `painel/index.html` — a SPA com todas as abas (Início, Configuração, Avisos, Acessos,
  Recuperação, Clientes, Deletar, Links, Senha) e o texto em português igual ao painel antigo.
- `painel/app.js` — quem chama a função, monta as tabelas e conduz os lotes.
- `painel/styles.css` — o CSS do painel antigo, sem dependência de build.
- `painel/config.js` — **o único arquivo que muda entre a cópia e a produção** (aponta o
  endereço da função).
- `Chatbot/index.html` — o clone estático do site do cliente (`wplay-teste-4h.onrender.com`),
  sem Flask e sem Render. Quem aperta "Gerar acesso 4 horas" aqui fala direto com a função.
- `supabase/functions/peixeiro/site.ts` — o motor do botão do clone (`site_gerar`).
- `supabase/functions/peixeiro/*.ts` — o motor portado do `painel_web.py` (Deno).
- `assets/resvg_bg.wasm` e `assets/DejaVuSans-Bold.ttf` — a função baixa estes dois arquivos
  daqui para desenhar a imagem do aviso de vencimento. Sem eles, o aviso sai só com texto.

## Onde cada projeto está hoje

| Projeto Supabase | Ref | O que roda nele |
| --- | --- | --- |
| **`ggufcvrwctieacvbbwim`** (kuttenc's Project, us-east-2) | o do painel desde 18/11/2026 | `peixeiro` (este painel) **e** `kutt-short-links` (o Urtador) |
| `bzgtptbwcvwpgnhbctjn` ("painel-2peer", sa-east-1) | a cópia antiga, ainda no ar | backup/rollback: função e banco intocados |
| `suipuquznkksgrkchqrv` ("wolverineifix") | produção do site do Render | não mexe neste painel |

O painel usa o projeto do Urtador porque os dois são seus e o free resetou a conta de banda
lá (a cópia tinha comido os 9,88 GB de egress — ver a seção do lote). As tabelas do painel
não se misturam com as do Urtador: as 20 tabelas do painel pertencem ao papel
**`peixeiro_2peer`**, e o `kutt_*`/`rental_*` continua do `postgres` do Urtador. O banco do
painel fala com essa função pela string `DATABASE_URL = postgres://peixeiro_2peer.ggufcvrwctieacvbbwim:***@aws-0-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require`, que é um secret.

A senha do papel está em `.env` (`PEIXEIRO_2PEER_DB_SENHA`), arquivo que nunca vai para o git.

## Como publicar de novo (projeto do painel)

```bash
cd 2peer
# o token (sbp_...) fica no .env como SUPABASE_TOKEN_NOVO; o CLI só aceita no formato sbp_
export SUPABASE_ACCESS_TOKEN=$(grep -oE 'SUPABASE_TOKEN_NOVO=.*' .env | cut -d= -f2 | tr -d '\r')
# só quando os endereços mudam:
npx supabase secrets set \
  PAINEL_ORIGENS=https://kuttenc.github.io \
  PAINEL_ASSETS_URL=https://kuttenc.github.io/2PEER/assets \
  --project-ref ggufcvrwctieacvbbwim
npx supabase functions deploy peixeiro \
  --no-verify-jwt --yes --project-ref ggufcvrwctieacvbbwim
```

`supabase.exe` em `C:/Users/ps4la/bin` funciona no lugar do `npx` e não baixa nada (a máquina
dele é apertada). O CLI desta versão não tem `--remote=`.

## Como publicar de novo (cópia, se precisar voltar atrás)

```bash
cd 2peer
export SUPABASE_ACCESS_TOKEN=$(grep -oE 'SUPABASE_PROJECT_2peer=.*' .env | cut -d= -f2 | tr -d '\r')
# só quando os endereços mudam (a cópia hoje já tem estes dois gravados):
npx supabase secrets set \
  PAINEL_ORIGENS=https://kuttenc.github.io \
  PAINEL_ASSETS_URL=https://kuttenc.github.io/2PEER/assets \
  --project-ref bzgtptbwcvwpgnhbctjn
npx supabase functions deploy peixeiro \
  --no-verify-jwt --yes --project-ref bzgtptbwcvwpgnhbctjn
```

O `--no-verify-jwt` é obrigatório: quem chama é o navegador com o token de sessão do painel,
não o JWT do Supabase. Sem ele toda chamada volta 401.

O nome da flag é `--project-ref` (um `--remote=` desse jeito o CLI responde
`Unrecognized flag`). Se o `npx supabase` falhar com `ENOSPC` ou "No matching Supabase CLI
binary package found", use o binário que já está no cache do npm em vez de instalar de novo:
`C:/Users/ps4la/AppData/Local/npm-cache/_npx/91eb58246759989d/node_modules/@supabase/cli-windows-x64/bin/supabase.exe`.

O push do `painel/` para o GitHub Pages publica a página; não existe deploy separado.

Se os dois comandos voltarem `403 (does not have the necessary privileges)`, o problema é o
`SUPABASE_ACCESS_TOKEN`, não o código: ele expira ou perde escopo na sua conta e é preciso
gerar um novo em Account settings → Access tokens. A função que já está no ar continua
respondendo enquanto isso.

O token é **sempre** `sbp_...` (o da sua conta, em Account → API Tokens). As chaves da tela
Settings → API Keys do projeto (`sb_publishable_...` e `sb_secret_...`) não servem aqui: elas
são para chamar o banco/Auth/Storage, e o CLI responde `Invalid access token format` para elas.

## Secrets que a função usa

| Nome | Para quê | Na cópia hoje |
|---|---|---|
| `DATABASE_URL` | Postgres do Supabase (o painel abre a conexão direto) | banco da cópia |
| `MC_USERNAME` / `MC_PASSWORD` | logar no painel MC | preenchidas (a conta real do revendedor) |
| `PEIXEIRO_MODO_TESTE` | `1` = nada é enviado nem apagado de verdade; a tela mostra a faixa "MODO DE TESTE" | **desligado** desde 16/11/2026 |
| `URTADOR_TOKEN` | link curto criado na conta dele (aparece no admin do Urtador) em vez de visita. **Não** muda a janela de 15 minutos. É a sessão do login por WhatsApp, vencível: se estiver morta, o `create` falha e a mensagem sai comprida | secret existe; valor não conferido daqui |
| `PAINEL_ORIGENS` | origens permitidas no CORS, separadas por vírgula | `https://kuttenc.github.io` |
| `PAINEL_ASSETS_URL` | onde ficam o wasm e a fonte da imagem do aviso | endereço do Pages |
| `PAINEL_LINK_BASE` | para onde o `{link}` da mensagem de recuperação leva o cliente | `https://kuttenc.github.io/2PEER` |

O `{link}` da Recuperação é montado assim: o endereço acima + `/r/?l=` + o final `rc-<usuario>-<base64>`
(o base64 do usuário e do telefone, tudo em minúscula). Mesmo cliente e mesmo telefone reusam sempre
o mesmo link; trocou o telefone, o link é outro. Se o encurtador estiver fora, a mensagem sai com o
endereço comprido — nunca sai sem link. Na virada para produção, é este secret que tem de apontar
para a página real do cliente.

**O final `rc-...` nunca muda, mas o destino muda quando você quiser.** A página `/2PEER/r/` não tem
endereço nenhum escrito nela: no clique ela pergunta à função (`links_destino`, sem login) para onde
aquele cliente vai hoje, e a resposta vem de `painel_links.destino` — se estiver vazio, vale
`greenapi_config.recupera_destino`, o padrão da aba **Links**. Editou na aba, vale também para o link
que o cliente recebeu ontem, sem reenviar nada. Os links velhos no formato `?d=<base64>` entram pela
mesma porta: a função decodifica o base64 e chega no mesmo `rc-...`.

| Coluna / tabela | Para quê |
|---|---|
| `painel_links` (`slug`, `destino`, `usuario`, `telefone`) | um registro por link enviado; criado sozinho no `recuperar_um` e no lote |
| `greenapi_config.recupera_destino` | endereço padrão de todos os links sem endereço próprio |

A aba **Links** (`#links`) tem três blocos: o padrão, a lista de links com um campo de endereço por
cliente, e o encurtador avulso de sempre. As ações novas são `links_padrao_salvar` e
`links_destino_salvar` (com login) e `links_destino` (sem login, é o clique do cliente).

## Cuidado com o que o Urtador faz

Os parágrafos abaixo são do produto do Fabio — o repo `kuttenc/urtador`, função `kutt-short-links` no
projeto `ggufcvrwctieacvbbwim` — e valem tanto para a cópia quanto para a produção.

- `https://kuttenc.github.io/urtador/<slug>` não é arquivo nenhum: o Pages devolve o **404** do
  Urtador, que carrega `assets/redirect.js`. Aquela tela **"Toque em Abrir destino"** é esse 404.
- O `redirect.js` chama `start-link-access-window` **assim que a página abre** (antes do toque) e só
  chama `resolve` quando ele aperta o botão. `resolve` é o que faz `location.assign(destino)`.
- A janela era **15 minutos por link por IP do visitante**, contados do primeiro acesso. **Ela não existe
  mais**: em 16/11/2026, por ordem dele (*"pode mexer, não quero que o link expire nunca"*), a função
  `kutt-short-links` do repo `kuttenc/urtador` (commit `452016e`) parou de ler o prazo e nenhum clique
  devolve `accessExpired`. As linhas de `kutt_link_access_windows` continuam sendo escritas (primeiro e
  último acesso), e os `expires_at` novos vão para 100 anos na frente. Prova depois do deploy: os slugs
  `rc-11zc083-...` e `rc-4849b6s-...`, que estavam mortos, responderam `{"accessExpired": false,
  "expiresAt": null}` e o `resolve` devolveu o destino. Voltar atrás = reimplantar o commit anterior da
  função pela Action `Deploy Urtador backend`.
- `URTADOR_TOKEN` (secret existe na cópia; valor não conferido daqui) só muda **em nome de quem** o link
  nasce no admin do Urtador — nunca decide se o link abre.
- O Urtador só aceita **10 criações por minuto** por sessão de visita e por IP (`guest-create-ip`,
  `guest-create-session`). Medido daqui em 16/11/2026: a 4ª chamada seguida já devolve "Muitas
  tentativas" (as sondas daquela semana já tinham gasto o resto do minuto). Como a função chama o
  encurtador de um IP só, um lote de clientes **novos** com a pausa mínima em 4,5 s (≈13 links/min)
  passa do limite — os que estourarem saem com o endereço comprido. Para todo mundo sair com link
  curto, a régua do item 5 da aba Configuração precisa de `recupera_pausa_min` em **7 segundos** ou
  mais. Reenvio para o mesmo cliente não conta: o final já existe e o painel monta o endereço sem
  chamar o encurtador.

**Publicar mudança no Urtador.** A Action `Deploy Urtador backend` (`kuttenc/urtador`) é só manual:
`gh workflow run deploy-kutt-backend.yml --ref main`, com os secrets `SUPABASE_ACCESS_TOKEN` e
`SUPABASE_DB_PASSWORD` do repo. A CLI 3.x mudou as flags em relação à que o arquivo usava em outubro:
agora é `supabase db push --remote <ref> --yes` e `supabase functions deploy kutt-short-links
--remote=<ref> --yes` (o `--remote` do functions precisa do `=`, e sem `--yes` a Action recusa porque
não tem terminal). A versão da CLI está fixada em 3.2.0 porque `latest` quebra essas flags sem aviso e
ainda estoura o rate limit do GitHub.

**O que mudou em 16/11/2026 (link comprido no reenvio).** Antes, no reenvio para o mesmo cliente o
`create` respondia "final já está em uso", o painel ia chamar `resolve` só para descobrir o endereço,
e o `resolve` vinha morto (janela daquele IP já vencida) — a mensagem saía com o **endereço
comprido**, pulando o Urtador: é o "está indo direto" que ele viu. Desde a versão 15 da função o
reenvio remonta `BASE/<slug>` direto e continua saindo com o link curto. Prova do caminho (sem mandar
WhatsApp): `linkRecuperacao("11zc083", <telefone>)` devolve `.../urtador/rc-11zc083-...` enquanto
`resolver("rc-11zc083-...")` continua `ok:false`.

Com o modo teste desligado, **a cópia age de verdade**: o botão da aba Deletar apaga a linha no
painel MC real, e recuperar/avisar disparam no WhatsApp assim que a instância GreenAPI for
colocada na aba Configuração (sem ela, o envio morre em `sem configuracao`). É a mesma conta e
os mesmos acessos da produção, só que o banco de clientes/telefones é o da cópia.

**Desde 16/11/2026 a instância GreenAPI real está GRAVADA no banco da cópia** (`greenapi_config`:
`api_url`, `media_url`, `id_instance`, `api_token`), junto da foto de recuperação (o cartão azul
gerado pela própria função, 59 KB). Ou seja: clicar em recuperar na cópia manda WhatsApp de
verdade para o telefone que estiver gravado na linha, e os avisos automáticos só não saem porque
`aviso_ativo` e `renova_ativo` foram deixados **desligados** na cópia. Antes de mexer nesses dois
interruptores, religue a trava acima. O token em si nunca entra neste repositório nem em issue.

Para religar a trava enquanto testar:

```bash
npx supabase secrets set --yes --project-ref bzgtptbwcvwpgnhbctjn PEIXEIRO_MODO_TESTE=1
```

O `2peer/.env` não tem mais essa linha de propósito: se ela estivesse lá, o comando de publicar
do item "Como publicar de novo" religaria o modo teste sem você querer.

Sem `MC_USERNAME`/`MC_PASSWORD` só duas abas ficam paradas, e elas avisam o motivo na tela:
**Acessos** e **Deletar** (é o que fala com o painel MC). Início, Configuração, Avisos,
Recuperação, Clientes, Links e Senha funcionam com o banco sozinho. Para colocar as chaves,
rode o mesmo `secrets set` acima com `MC_USERNAME=... MC_PASSWORD=...` no fim da linha, ou
pelo dashboard em Edge Functions → Secrets. Não cole essas chaves em issue, chat ou arquivo
do repositório.

O token da agenda (`aviso_cron`) não é secret: ele mora na coluna `aviso_token` de
`greenapi_config` e é criado sozinho na primeira abertura do painel.

### Uma conta do MC, dois lugares logando nela

O painel MC segura **um** bearer por conta. Enquanto a cópia e o serviço do Render (ou a agenda
das 6h) usam o mesmo `MC_USERNAME`, quem logar por último derruba o token do outro. O sintoma
é o aviso "O site não conseguiu logar no painel MC." no primeiro clique e tudo funcionando no
seguinte: a função agora joga fora o bearer morto sozinha quando o MC responde 401/403 e loga
de novo na chamada seguinte. Não é preciso fazer nada, mas se os dois rodarem juntos esse
aviso vai aparecer de vez em quando — é por isso, não é senha errada.

## Sessão, senha e travas

- A senha do painel continua `pbkdf2_sha256$200000$...` na mesma linha `greenapi_config`, e a
  sessão é o mesmo token `exp.hmac` do Flask, guardado no `localStorage`. Sessões antigas do
  Render valem aqui e vice-versa.
- Trocar a senha derruba todas as sessões abertas, inclusive a sua.
- Login errado tem a mesma trava de antes: 8 tentativas por IP em 10 minutos.
- Lote (Não recuperados / Deletar) é conduzido pelo navegador: a conferência congela a lista
  no banco (`painel_lote`), cada clique manda um item por vez, e fechar a aba para o lote sem
  deixar metade enviado. A conferência vale 15 minutos (recuperar) / 10 minutos (apagar).
- **Ritmo do "Não recuperados"**: depois de cada mensagem a função sorteia a espera entre
  `recupera_pausa_min` e `recupera_pausa_max` (colunas de `greenapi_config`, reguláveis na aba
  Configuração, item 5; padrão 4,5 s a 1 min 45 s) e devolve em `esperar` na resposta do
  `lote_item`. O navegador obedece e mostra a contagem. O sorteio é no servidor de propósito:
  Acessos e Clientes usam o mesmo motor e um F5 no meio do lote não muda o ritmo. Não vale para
  apagar nem para a agenda das 6h. Com 900 clientes na lista, a conta é de horas com o painel
  aberto (4,5–105 s ≈ 13 h 40 no meio-termo) — por isso a régua existe.

### Quem conta o tempo (e por que o lote parava sozinho)

O `esperar` sai do servidor, mas **quem conta os segundos é a aba** — não existe timer nenhum no
backend, e a prova é o próprio banco: no intervalo morto o `painel_lote` fica com `rodando: true`,
`enviando: null` e `atualizado_em` parado, porque nenhum `lote_item` chegou.

Como o navegador congela a aba em segundo plano (no celular, com a tela apagada, em poucos
minutos), o desenho antigo morria aí: ele **decrementava um contador** a cada tick. Em segundo
plano o Chrome dispara o timer uma vez por minuto, então uma pausa de 50 s virava 50 minutos;
congelada de vez, nada rodava e o lote parava de aparecer. Isso é o `tools/_prova_pausa.js`:

```bash
node tools/_prova_pausa.js   # 7 provas — relógio falso, nenhuma rede, nenhuma mensagem
```

O motor de agora guarda um **prazo** (`lote.limite`, uma hora no relógio) e um vigia de 1 s só
compara a hora. Congelou e acordou 6 minutos depois, o prazo já venceu e o item sai no primeiro
tique — atraso máximo de um tique, nunca uma parada. Vem junto:

- **wake lock** (`navigator.wakeLock`) enquanto o lote corre: no celular a tela fica acesa, que é
  o que impede o congelamento. Perde o lock quando a aba some e pede de novo no `visibilitychange`.
- **um item por vez no mundo**: `proximoItem` recusa entregar cliente enquanto `estado.enviando`
  estiver preenchido e devolve `em_envio` + `esperar: 8`; sem isso, celular e PC abertos na mesma
  conta mandavam o mesmo cliente duas vezes. A trava vence sozinha em 3 minutos (quem pegou o
  item morreu no meio), senão o lote ficaria preso para sempre.
- **o banco diz a verdade**: se o navegador desistiu de um `lote_item` por erro, ele chama
  `lote_parar` em vez de só apagar o timer — assim a faixa de andamento não fica acesa mentindo
  e o lote seguinte não trava em "já existe um lote rodando".

> `python tools/_prova_lote.py` **apaga** a linha `recuperar_todos` de `painel_lote` na limpeza.
> Não rode com um lote de verdade em andamento.

## O telefone que viaja com o link de recuperação

Quem chega pelo link curto (`.../urtador/rc-<usuario>-<payload>`) já foi identificado: o número
está dentro do próprio link. A tela de acesso não pede para digitar de novo — ela vem preenchida,
trancada e o número continua salvo no aparelho por 4 horas.

- `links_destino` (a ação sem sessão que a página `r/` chama no clique) devolve agora
  `{slug, telefone, destino}`. O `destino` já sai com `?telefone=<dígitos>` colado: `destinoComTelefone`
  usa `URL` + `searchParams`, então **preserva** o que o destino já tinha (`?p=1&telefone=...#fim`)
  em vez de trocar a query inteira. Sem telefone, o endereço sai exatamente como estava gravado.
- De onde sai o número (`telefoneNoClique`): primeiro a coluna `telefone` de `painel_links` (linha
  criada no envio do recuperar); se não houver — link antigo, ou reenvio que não gravou — decodifica
  o payload base64 do próprio slug (`usuario|telefone`), aceitando só `a-z0-9_-` de 4 a 96 e exigindo
  o `|`. Um slug qualquer não inventa telefone nenhum.
- No site (`app.py` → `telefone_do_link()`): lê `?telefone` ou `?tel`, aceita só 10 a 13 dígitos,
  tira o `55` da frente e formata `(DD) 9xxxx-xxxx`. O `index()` mostra no campo, o `gerar()` **obedece
  ao link, não ao formulário**: com número no link, o POST que vier trocado é ignorado e vale o do link
  (é por isso que o campo nasce `readonly` e o `action` carrega `?telefone=` junto).
- `templates/index.html` guarda os dígitos em `localStorage["peixeiro_telefone_link"]` com o prazo de
  4 horas (`HORAS = 4`). Abrir o site depois, sem link, recupera o número e tranca o campo do mesmo
  jeito; passou o prazo, apaga e a tela volta a pedir.
- Prova: `python tools/_prova_link.py` (16 provas — metade na função local, metade chamando o `app.py`
  com o gerador de acesso monkeypatchado, então **nenhum WhatsApp sai** e nenhuma linha real é criada).

Quando a produção ainda estiver no Render, é o site de lá que o cliente abre: o endereço alvo dos
links é `https://wplay-teste-4h.onrender.com/`, que vem do repo `fabiodkk/wplay-teste-4h` (cópia
local em `../repo`). A metade Python já está portada lá (commit local `4ddf087`, os mesmos
`telefone_do_link()` + bloco do formulário); publicar é `git push origin main` naquele repo, e o
Render refaz o build sozinho. Enquanto esse push não acontecer, nada quebra: o cliente só chega na
tela de sempre, com o campo vazio pedindo o número. A prova roda nos dois sites:

```bash
PEIXEIRO_SITE_DIR=../repo python tools/_prova_link.py site
```

## O clone do site em `Chatbot/` (o botão sem Render)

`https://kuttenc.github.io/2PEER/Chatbot/` é uma cópia estática do site do cliente
(`wplay-teste-4h.onrender.com`) — mesmo HTML, mesmo CSS, mesmo texto, sem Flask no meio. O
motivo é prático: o site do Render demora a acordar e o cliente desiste antes do botão. A página
aqui já vem pronta do Pages; o que falta de servidor cabe numa chamada.

- **A ação é `site_gerar`** e está em `SEM_SESSAO` (`index.ts`): qualquer um chama, sem token de
  painel, sem login. Ela faz o que o `gerar()` do `app.py` fazia — `POST /lines/test` no painel
  MC da conta do revendedor (`criarLinhaTeste` em `mcapi.ts`, pacote P2P/iptv e `testDuration: 4`
  iguais aos do site), grava o evento, registra em `usuarios_criados_ip` e, se
  `greenapi_config.send_photo` estiver ligado, manda a foto de geração pelo GreenAPI.
- **A régua é a mesma de antes, por IP**: reaproveita o acesso ainda ativo do IP → se o IP está
  em `ip_liberados`, sempre libera → senão no máximo **1 por dia e 2 por semana** contados em
  Brasília (`limitesDoIp`, mesma janela do `automate_mcapi.py`: `date_trunc` sobre
  `now() at time zone 'America/Sao_Paulo'`; a semana do Postgres começa segunda). Passou do
  limite, a resposta é HTTP 429 com o texto exatamente igual ao do site: *"Seu teste ja foi
  gerado recentemente..."*. Nada de "4 horas" mudou aqui.
- **O IP não é disfarçável**: o Supabase descarta um `x-forwarded-for` mandado do navegador e a
  função só enxerga o IP real de saída do cliente. O `dispositivo` (UUID que a página guarda em
  `localStorage["peixeiro_dispositivo"]`) só vira a chave quando a função não recebeu IP nenhum
  (`chaveDoIp`), que na prática não acontece.
- **Tabela nova: `public.site_acessos`** — criada sozinha na primeira chamada (`esquema()`):

  ```sql
  create table if not exists public.site_acessos (
    client_ip text primary key, username text not null default '', senha text not null default '',
    exp_date timestamptz, telefone text not null default '', atualizado_em timestamptz not null default now());
  ```

  Por que ela existe: no site do Render o "ainda tenho teste aberto?" saía da última resposta de
  `line_test` em `mcapi_events`, e lá tinha a senha. Aqui a senha **não** vai para o log de
  eventos (a página é pública, os logs ficam muito tempo), e a linha de teste do MC **não
  aparece no `GET /lines`** dessa conta (medido: 14 linhas listadas, busca pelo usuário do teste
  retorna `total 0`). Então o reuso precisa de um registro nosso: uma linha por IP, sobrescrita a
  cada geração, lida só enquanto `exp_date > now()` — venceu, some da leitura.

- Três desvios deliberados do site do Render, para não abrir um buraco novo:
  1. `ensure_first_allowed_ip` (o botão que colocava o primeiro visitante em `ip_liberados`) não
     foi portado. Numa página pública ele liberaria o primeiro cliente que chegar e derrubaria a
     régua para todos.
  2. A linha de teste **não** entra em `mc_linhas` (o espelho). Ela não existe no `GET /lines`, e
     uma linha que a API não devolve polui a contagem da aba Acessos.
  3. `mascararResposta` passou a recursionar nos objetos aninhados, então `password`/`token`
     somem do `response_payload` do evento em qualquer profundidade.
- **Telefone no link**: a página lê `?telefone=` (ou `?tel`) do mesmo jeito do site — aceita só
  10-13 dígitos, tira o `55` da frente, tranca o campo e grava em `localStorage` por 4 horas. Quem
  chama `site_gerar` manda o número do link, não o do formulário.
- **Apontar os links de recuperação para o clone** é uma chamada na aba Configuração (ação
  `links_padrao_salvar`, sem parâmetro de link = o destino padrão de todos):

  ```bash
  # destino padrão = o clone (as 42 linhas de painel_links da cópia estão com destino vazio,
  # então mexer no padrão move todos os links, inclusive os já enviados)
  curl -s -X POST https://bzgtptbwcvwpgnhbctjn.supabase.co/functions/v1/peixeiro \
    -H "authorization: Bearer <token de sessao do painel>" -H content-type: application/json \
    -d '{"action":"links_padrao_salvar","destino":"https://kuttenc.github.io/2PEER/Chatbot/"}'
  ```

  Voltar atrás é a mesma chamada com `https://wplay-teste-4h.onrender.com/`. O clique (`r/` →
  `links_destino`) continua colando `?telefone=<dígitos>` no que estiver gravado, então o número
  chega preenchido nos dois endereços.
- O que o clone **não** tem: a vitrine (`/api/...` de produtos) e nada de admin. É a tela de
  geração e o assistente de instalação, iguais.

## O guia do `Chatbot/` virou modal (e o vídeo de resgate saiu)

O pedido dele, em 17/11/2026: *"tira a imagem de fundo dessa pagina ... e deixa escuro o fundo mas
bonito e inteligente"*, *"a imagem ilustrado do guia interativo deve virar apartir de agora um modal
não sendo mais fixo na pagina para que o usuario consiga a todo momento interagir com o modal"*,
*"vamos tentar sempre deixar facil um botão pra ele pelo guia interativo clicar e ver o usuario e
senha apertando um botão"*, *"percebi que as letras tão pequenas ajuste para atender celular movel
pois tem idoso que nao enxerga"* e, depois de ver a primeira versão: *"deste modal aqui remova o
video e o seguinte texto"*, *"as letras ficaram enormes no guia interativo diminui um pouco mas nem
tanto"*. Tudo cabe num arquivo só: `Chatbot/index.html`.

- **Fundo.** `convocacao.png` saiu do CSS (o Pages não recebe mais nenhum pedido de imagem de
  fundo — provado abaixo). No lugar: `body::before` é uma grade de 46px com pontos de circuito de
  138px que deriva devagar (`@keyframes grade-deriva`), e `body::after` traz uma linha de varredura
  na diagonal com dois brilhos. `@keyframes slow-pan`, que existia para a foto, foi apagado.
- **O guia é `#guideModal`**, um overlay com `z-index: 36` (a oferta pop fica em 30, então o guia
  passa por cima), card de `max-height: 94vh` com o corpo em `overflow: auto`. Abre por três
  caminhos: o botão fixo `#guideFab` (esquina inferior esquerda, com pulso
  `@keyframes fab-brilho`), o auto-abrir na **primeira** visita (uma vez só, marcado em
  `localStorage["wplay_guide_aberto"]`) e `goToGenerateForm()` que, ao contrário, **fecha** o modal
  antes de rolar até o formulário. Fecha no **×**, no fundo escuro, no **Esc** — e enquanto aberto
  `body.guia-aberto` trava a rolagem da página.
- **Onde o guia morava** virou um cartão que aponta para o botão ("Toque no botao Guia de
  instalacao..."), porque o cliente precisa entender como voltar para o modal depois de fechar.
- **Usuário e senha a um toque.** `#guideCredsBtn` ("Ver meu usuario e senha") chama
  `mostrarAcesso()`, que desenha `#guideCred` dentro do próprio guia: usuário, senha e validade em
  caixas grandes, com **Copiar usuario** / **Copiar senha**. Sem acesso na sessão, o mesmo painel
  mostra o texto explicativo e um **Liberar teste agora** (que fecha o modal e foca o telefone). A
  fonte é o `TEST_ACCESS` que já existia; quem o preenche é `mostrar()` do `site_gerar`, que agora
  também chama `window.acessoChegouNoGuia()` — o painel se atualiza sozinho assim que o acesso
  chega, sem o cliente procurar. O `#guideFab` ganha a classe `com-acesso` (um ponto verde) para
  avisar que já dá para ver o acesso.
- **Nada de `innerHTML` com o que vem do servidor**: usuário e senha entram por `textContent` nas
  três caixas fixas do HTML. O painel é estático; só os valores e o `hidden` mudam.
  Detalhe que quebra sem olhar: `.guide-cred-list` é `display: grid`, e a regra do autor **vence** o
  `[hidden]` do navegador — por isso existe o bloco `.guide-cred-list[hidden] { display: none }`.
- **O vídeo foi embora junto com o texto dele.** Apagados o CSS `.video-rescue*`, o markup
  `#videoRescue` (com o "⚡ Espera! Antes de desistir..." e o "Assiste esse video e termina em 1
  minuto..."), e toda a JS em volta: `openVideoRescue`/`closeVideoRescue`,
  `videoRescueShownCount`, `registerGuideError`, o `setInterval` de 5s que vigiava ociosidade e as
  duas chamadas de `registerGuideError()` que havia em `showAdvancedHelp` e `tclCodeStep`. O
  `indexhtml.mp4` continua no repositório, só não é mais pedido.
- **Letras.** A página subiu (base 18px, `.btn` 18, `.status` 14, `.pill` 18, `.tiny` 15, `.badge`
  15 → 14 no celular, `.btn-pop` 13 → 16, `.chat` com `min-height: 220px`). O guia, que ficou grande
  demais na primeira versão, voltou um degrau: bolha e botões de escolha **17 → 16**, título do modal
  `clamp(1.45rem, 4.4vw, 1.85rem)` (media 23,2px, antes 31), modo avançado 19/16 → **17/15**, caixa
  do acesso 22 → **19** (título 24 → 20), voz 16/14 → **15/13**, botão flutuante **16**. O `.btn`
  comum ficou em 18 de propósito: é o "Gerar acesso 4 horas" e o "Copiar PIX", e para o idoso esses
  dois têm que continuar grandes.
- **No celular** o `#guideFab` vira uma barra larga (esquerda a direita) e a oferta pop sobe para
  `bottom: 78px` para não cobrir o botão; o rodapé do modal empilha em uma coluna abaixo de 640px.

Prova local (servindo o repositório com `python -m http.server` numa pasta que expõe a cópia como
`/2PEER/`): modal aberto sozinho na primeira visita, zero `<video>`, zero `.wizard-box` dentro de
`main`, fechar/abrir/Esc/backdrop funcionando, `body.guia-aberto` entrando e saindo, painel do
acesso nos dois estados (sem acesso: lista e cópias ocultas + "Liberar teste agora"; com acesso:
`rz999999999` / senha / validade nas caixas, ponto verde no botão) e os três scripts inline passando
por `new vm.Script` sem erro de sintaxe. Ao vivo, no commit `7c563fe` com o build do Pages em
`built`: `h2` do guia 23,2px, bolha 16px, `videos: 0`, `guiaNaPagina: 0`, os únicos pedidos de
imagem/JS da página são `sinal-logo.jpg` e `painel/config.js` — **nenhum** `convocacao.png` e
nenhum `.mp4` — e o console limpo.

## A aba "Não recuperados" (a fila por dentro)


O mesmo lote das abas Acessos e Clientes, visto linha por linha. Nada de novo é enviado por
ela: quem começa o envio continua sendo o "Não recuperados → Revisar e enviar".

- `lote_fila` devolve o plano congelado de `recuperar_todos` com a situação de cada posição
  (`fila` / `enviando` / `enviado` / `falhou` / `pulou` / `fora`) e os contadores. O resultado de cada
  tentativa fica em `estado.resultados` **no banco** (chave = número da linha no plano), então **quem
  falhou continua na tela depois que o lote acaba**, com o motivo que o GreenAPI deu. Desde
  18/11/2026 a resposta traz só uma **janela** de linhas em volta do envio, e o `resultados` não vai
  no `estado` que chega ao navegador — veja "A banda do plano grátis" no fim deste arquivo.
- `estado.enviando` guarda a posição que está no ar naquele instante. Por isso o "enviando…"
  aparece mesmo quando o envio foi começado em outra aba ou em outro aparelho; a tela se refaz
  sozinha a cada 4 s enquanto o lote corre.
- **Parar** chama `lote_parar` (manda a mensagem que estiver no ar terminar e desliga).
- **Retomar de onde parou** chama `lote_retomar`: continua o MESMO plano, na mesma posição, sem
  recontar ninguém — ninguém recebe duas vezes. Não precisa de conferência fresca (diferente do
  "Revisar e enviar", que exige os 15 minutos).
- **Selecionar → Tirar da fila** chama `lote_tirar` com os números escolhidos. Só marca
  `ignorado: true` no plano: não apaga nada no painel MC, não desfaz o que já foi enviado e o
  motor simplesmente pula essas linhas. Por segurança ela só funciona com o envio parado
  (`lote_rodando` no resto) e só pega linhas ainda não tentadas. A próxima conferência traz
  todos de volta.
- Remontar o plano (`lote_contagem`) com o lote andando foi travado na função: devolve
  `lote_rodando` antes de varrer o MC, para o envio não ser jogado para outra lista no meio.
- Acabou tudo? `lote_retomar` responde `fila_no_fim` em vez de mandar de novo.

## A aba "Chat" (o robô do WhatsApp + a prova de entrega)

A aba `#chat` é o único lugar que fala com o webhook do GreenAPI. Três tabelas novas, criadas
pelo `ESQUEMA` do `db.ts` na primeira conexão:

- `chat_regras` — gatilho (palavras separadas por vírgula), resposta, `prioridade` (menor ganha),
  `ativo`, `contagem`. Vieram quatro regras de fábrica (vence / pix / renovar / obrigado), e elas
  nascem **desligadas**: nada responde sozinho até ele ligar a chave daquele card na tela. O botão
  "Criar outro chat" (`chat_novo`) cria uma em branco com ordem 10, já ligada.
- `chat_mensagens` — a conversa, com `expira_em = criado_em + chat_dias` (90). Cada mensagem nova
  que chega apaga o que venceu, então a tabela não cresce sozinha. `chave` é o id do GreenAPI: a
  mesma mensagem entregue duas vezes não vira duas respostas.
- `chat_treino` — o par pergunta/resposta, sem prazo. É o arquivo que treina uma IA depois; o botão
  "Baixar o CSV de treino" (`chat_treino` action) devolve `Pergunta;Resposta;Regra;Cliente;Cadastrado;Quando`.

Como a resposta é escolhida: só quando `chat_ativo` está ligado **e** a chave daquele card está
ligada, o texto do cliente (sem acento, minúsculo) é comparado com cada gatilho; a regra que casar
com a menor `prioridade` responde. As variáveis `{{nome}} {{usuario}} {{telefone}} {{vence}}
{{expira}} {{expirou}} {{dias}} {{status}} {{pix}} {{data}} {{hora}}` são preenchidas na hora com o
espelho do MC daquele telefone. Quem não está na base de clientes só recebe resposta com a caixa
"responder também para quem não está na base" marcada — mas a conversa e o par de treino são
guardados do mesmo jeito.

Os três campos do vencimento não são a mesma coisa, e é isso que a frase precisa respeitar:

| campo | o que sai | para quem está no prazo | para quem já venceu |
|---|---|---|---|
| `{{expira}}` | só a data gravada | `12/12/2026 23:00` | `12/11/2026 23:00` |
| `{{expirou}}` | quanto tempo faz | `ainda não venceu (em 26 dias)` | `há 3 dias` |
| `{{vence}}` | a frase inteira, com o verbo certo | `vence em 12/12/2026 23:00` | `venceu em 12/11/2026 23:00` |

Escrever "vence em {{expira}}" mint para quem já perdeu o acesso, e foi o erro que as regras de
fábrica carregavam; o `ESQUEMA` troca o texto delas por `{{vence}}` na primeira conexão e desliga
essas regras de novo. Use `{{vence}}` nas respostas.

Cada card da tela tem uma chave ("este chat responde / está parado") que grava sozinha, pelo
`chat_ativar`, sem tocar no texto dos outros cards e sem desligar o robô — assim dá para editar um
chat e continuar interagindo com os outros. A conversa continua sendo guardada mesmo com a chave
desligada; o que para é a resposta. A tela se refresca sozinha a cada 6 segundos pelo `chat_fluxo`,
que devolve resumo + lista de telefones + a conversa aberta, e **não** chama o GreenAPI (só o
`chat_ver` lê a instância, para não bater na API a cada 6 segundos).

O webhook: `chat_ver` devolve `webhook` = `<endereço da função>?action=chat_webhook&token=<chat_token>`.
A chave vai na URL porque o corpo é a mensagem do cliente, e `chat_webhook` está em `SEM_SESSAO`.
Chave errada dá 401. Copie e cole no campo `webhookUrl` do GreenAPI, **ou** aperte
"Instalar na instância agora" (`chat_instalar`), que chama `setWebhookUrl` na instância armada na
aba Configuração. ⚠️ Esse botão muda o tráfego real da instância: enquanto a função publicada for a
da cópia, toda mensagem do WhatsApp cai no banco de teste. Na produção, só depois de publicar a
função de produção.

**Renovou a conta do GreenAPI? O webhook vai junto para o lixo.** A instância nova (`id_instance`
diferente, medida em 16/11/2026: `710722764101` → `710722804253`) nasce **sem `webhookUrl` nenhum**:
as credenciais novas funcionam (`getStateInstance` responde `authorized`, o `sendFileByUpload` devolve
200 com `idMessage` `3EB0…`), mas `whatsapp_status` e `chat_mensagens` ficam com **0 linhas**, então o
painel perde a prova de entrega e continua escrevendo "enviado" para mensagens que o WhatsApp jogou
fora depois de aceitar. É o motivo pelo qual duas mensagens de 20:45/20:46 aparecem enviadas e o
cliente não recebeu: sem webhook não há como saber, e `getMessageState` responde 404 nessa instância.
Depois de trocar credencial, o passo é abrir a aba Chat e apertar "Instalar na instância agora".

O mesmo endereço recebe o **status de entrega** (`type: messageStatus`, `eventType: 8`), que vai para
`whatsapp_status` (`id_message`, `status`, telefone, `arrivato`). É a única prova de que a mensagem
chegou no aparelho: o `POST` do GreenAPI responde 200 com `idMessage` quando **aceitou**, e o
`getMessageState` / `getChatHistory` desta instância respondem 404. Por isso a fila da aba
"Não recuperados" mostra agora o `entrega` de cada linha (via `lote_fila`): *sem confirmação do
WhatsApp* (webhook não instalado), *no servidor*, *entregue ao WhatsApp*, *chegou no celular*,
*lida*, *o WhatsApp recusou*.

## Provar sem mexer em cliente de verdade

- Deixe `PEIXEIRO_MODO_TESTE=1`. Assim nada sai no WhatsApp e nada é apagado no MC, mas todas
  as telas, contagens e progresso funcionam.
- Para testar o caminho que fala com o painel MC sem credencial real, apontou-se a função para
  um MC de mentira local: `MC_API_BASE=http://127.0.0.1:8099` mais `tools/mc_stub.ts`, um
  servidor Deno que devolve uma lista fixa de linhas com nome começando em `stub`. Esse
  endereço não é secret de produção: se estiver vazio, a função cai no
  `mcapi.knewcms.com:2087` de verdade. O comando dos dois lados está no cabeçalho do stub.
- O bearer devolvido pelo stub é falso e fica guardado em `mcapi_token_cache` por uma hora.
  Depois da brincadeira, apague a linha (`delete from public.mcapi_token_cache where id = 1`);
  com ela lá, o painel mostra as abas do MC como se estivesse logado e leva 401 em tudo. Uma
  resposta 401/403 do MC agora limpa essa linha sozinho.
- As linhas de teste desses dois modos entram em `mc_linhas`, `usuarios_criados_ip`,
  `painel_lote` e `mcapi_events`. Para limpar o banco da cópia, apague o que vier de `stub%`.
- A fila da aba "Não recuperados" foi provada com `tools/_probe_fila.py`: `install` grava seis
  linhas `stub01..stub06` direto em `recuperar_todos`, `show` imprime o plano com a marca de cada
  posição e `clean` apaga a fila e tudo o que saiu de `stub%`. Com `PEIXEIRO_MODO_TESTE=1` os
  `lote_item` simulam o envio, então dá para ver o "enviando…", parar, retomar e tirar da fila
  sem nenhum WhatsApp sair. **Nunca rode `lote_contagem` por fora com a fila de mentira montada**:
  ela é substituída pela varredura dos clientes de verdade (o travamento novo só impede isso
  enquanto o lote está no ar).

- O chat foi provado com `tools/_prova_chat.py`: 61 provas batendo no webhook com o payload no
  formato real do GreenAPI (mensagem de cliente, status de entrega, duplicado, grupo, mídia sem
  texto, botão respondido), mais ligar/desligar o robô, a chave de cada card, o refresco da tela,
  criar/editar/apagar regra, as três variáveis do vencimento, retenção e o CSV. Rode com a função
  local no ar (`deno run --allow-all --env-file=.env index.ts` com
  `PEIXEIRO_MODO_TESTE=1`): `python tools/_prova_chat.py` e, se precisar só limpar,
  `python tools/_prova_chat.py limpar`. Ela imprime tudo com os números mascarados e devolve o
  banco para `(0 mensagens, 0 treino, 0 status, 4 regras, robô desligado)`.

- O telefone que viaja no link foi provado com `tools/_prova_link.py` (16 provas): 7 no
  `links_destino` da função local, com linhas `stub-link-*` que somem no fim, e 9 no Flask do
  próprio `app.py`, com `generate_access_once` trocado por um carimbo — nenhum WhatsApp sai e
  nenhum acesso é criado. Os números da prova (`5511900000011` e vizinhos) são inventados e
  conferidos contra `mc_linhas` antes de entrar no arquivo.

- A lista do espelho no "Não recuperados" foi provada com `tools/_prova_lote.py` (30 provas, com o
  `PEIXEIRO_MODO_TESTE=1` local e as contas conferidas contra o banco). O comando está na seção
  "As duas listas do Não recuperados", mais adiante.

- A mensagem comum da aba Clientes foi provada com `tools/_prova_mensagem.py` (**38 provas**; eram 40
  enquanto sobrou gente na agenda — a bateria roda no grupo que tem alvo, `fora` ou `todos`): a conta
  conferida contra o banco, o plano congelado com o texto dentro de cada item, o `"todos"` que chama o
  espelho de volta, filtro, texto vazio, texto de 1300 caracteres, o envio de um cliente só, os três
  simulados, o registro com `exp_date=''`, a fila viva, parar, retomar e a prova de que o painel MC não
  foi aberto nenhuma vez. O comando está na seção "Mensagem comum para quem não está no MC".

- Antes de mexer no espelho (`mc_linhas`), salve o que está lá: `python tools/_exporta_espelho.py`
  traz as 980 linhas e `python tools/_exporta_espelho.py so-espelho` traz só as que nunca tiveram
  linha no painel MC (o filtro `linha_id` vazio). O arquivo cai em `../backup-espelho/`, fora do
  repositório de propósito — tem telefone de cliente dentro. É leitura pura, não apaga nada.

## Quando o "Sim, enviar para todos" não manda nada

Medido em 16/11/2026 com o bearer que já estava no cache (sem logar de novo no MC):

- O **lote só conhece quem existe no painel MC agora**. `varrerMc` varre as páginas do `/lines` e
  `recuperarContagem` conta em cima disso. Naquela conta o MC devolveu `total: 14`, `pagesQuantity: 1`
  — 14 linhas, 10 vencidas. Procurar um usuário que só existe no CSV devolve **0**, enquanto a busca
  de um usuário que está no MC devolve 1: não é filtro nem paginação quebrada, a linha não existe lá.
- O **espelho** (`mc_linhas`) tinha 980 usuários, 974 com telefone, todos criados no import do CSV das
  17:07. Import não cria linha no MC: ele preenche o espelho. Por isso o modal mostra
  "SÓ NO ESPELHO, SEM LINHA NO MC = 966" (980 − 14) e manda usar o botão recuperar da própria linha.
- `MARCADOS PARA PULAR` é o `localStorage["peixeiro_lote_pular"]` daquele navegador: as marcas
  **sobrevivem ao F5, à troca de aba e ao login**. Com 12 marcas e 10 vencidos, os 10 bateram nas
  marcas, `alvos` ficou 0 e a fila nunca nasceu — por isso a aba "Não recuperados" não tinha nada em
  "enviando". O botão **Desmarcar todos** (`#btnDesmarcar`, ao lado do iniciar do lote) limpa a lista
  inteira; sem ele o `lote_contagem` continua contando os mesmos pulados.
- O que fazer com os 966 era decisão dele, não bug. Ele respondeu em 16/11/2026: **são clientes que
  ficaram muito tempo sem usar e ele mesmo apagou da base do painel MC**. Ou seja, não havia o que
  recuperar — e o lote do espelho ia mandar 966 mensagens de "recupere seu acesso" para gente que não
  tem acesso nenhum. A limpeza está descrita na seção "Os 966 que só existiam no espelho", mais adiante.

## As duas listas do "Não recuperados" (`fonte`)

`lote_contagem` de `tipo: recuperar` aceita `fonte`. Sem o campo (ou `fonte: "mc"`) é o caminho de
sempre: `tokenDoPainel` + `varrerMc` sobre o `/lines`. Com `fonte: "espelho"` a lista sai do banco,
sem nenhuma chamada ao MC — `contagemDoEspelho` em `acoes.ts` lê `mc_linhas` com
`exp_date <= now()`, aplica o mesmo `q` da tela (`username ilike`), as mesmas marcas `pular`, o mesmo
bloqueio de 3 horas de `renovacao_avisos` e o mesmo telefone de `telefonesPorUsuario()` com fallback
para `mc_linhas.telefone`. Cada item do plano vai com `fonte: "espelho"`, e o
`recuperar_envio` do log registra `fonte_data: "espelho"` em vez de `"linha"`.

O `lote_fila` devolve a `fonte` do plano congelado, porque retomar de onde parou tem que deixar
claro de qual lista aquela fila nasceu.

Na tela, o seletor fica no modal (logo abaixo do título), com as opções
**"vencidos do espelho (aba Clientes)"** e **"vencidos do painel MC"**; trocar recomeça a contagem.
**A fonte padrão agora é o espelho** — com o MC em 14 linhas e o CSV no banco, varrer o MC é a exceção, e
pular a varredura também economiza o minuto que ela leva. A escolha fica em
`localStorage["peixeiro_lote_fonte"]` — o "Montar a fila do zero" da aba
Não recuperados usa a mesma, e a nota dele diz qual é. Os rótulos do modal trocam de texto:
"vencidos no painel MC" ↔ "vencidos no espelho" e "só no espelho, sem linha no MC" ↔
"desses, já têm linha no MC".

**E o modal não espera mais ele trocar (16/11/2026, `fonteTrocada` + `foraDoMC` em `painel/app.js`):** se a
fonte ainda é o painel MC e a varredura devolve **qualquer vencido só no espelho** (`so_no_espelho > 0`), o
modal grava `espelho`, troca o seletor na tela e refaz a conta sozinho, com a nota
"O modal trocou sozinho para os vencidos do espelho: a varredura do painel MC deixou N vencido(s) de fora…".
A primeira versão só pulava quando sobravam **0** para receber, e era o bug que ele viu: com 7 alvos no MC os
907 do CSV ficavam de fora e o botão continuava travado. Trocar na mão vale para aquela abertura (a troca
automática não briga com a escolha dele). Uma troca por modal aberto — a mesma trava existe no modal da
mensagem comum (`msTrocado`).

**Reimportado em 16/11/2026, depois da limpeza:** ele voltou a subir o CSV. O espelho da cópia está com
**921 linhas** (907 `r566…` sem `linha_id`, 14 do MC), **917 vencidas**, 918 com telefone, e a agenda
`usuarios_criados_ip` acompanhou com 919. Medido na função publicada, sem enviar nada:
`fonte: "espelho"` → **917 vencidos, 10 com linha no MC, 914 para receber**; `tipo: "mensagem"`,
`quem: "todos"` → **921 na lista, 913 alvos** (3 sem telefone, 5 marcados que eu tirei de amostra). Os
planos que essas duas conferências congelaram em `painel_lote` foram apagados em seguida.

Medido no banco da cópia em 16/11/2026, com `fonte: "espelho"`: **976 vencidos, 10 deles com linha
no MC, 6 sem telefone, 967 para receber** (com 1 marcado para pular) em 0,6 s — contra os 10 vencidos
que a varredura do MC achava. Nada disso toca o painel MC: nem login, nem `/lines`.

⚠️ 967 mensagens com pausa sorteada entre 4,5 s e 105 s dá **de 1 a 5 horas com o navegador aberto**.
O lote para sozinho no item em que o navegador fechou e retoma de lá, mas a janela de 15 minutos da
conferência vale só para abrir o envio.

Provar sem mandar WhatsApp nenhum:

```
cd supabase/functions/peixeiro
PEIXEIRO_MODO_TESTE=1 npx --yes deno run -A --env-file=../../../.env index.ts   # em outra janela
cd ../.. && python tools/_prova_lote.py
```

São 30 provas (contagem conferida linha por linha contra o banco, plano congelado, o marcado que não
entra, filtro, `lote_executar` sem confirmar, três envios simulados, o log, a fila, o parar) e a
limpeza apaga a fila, os `renovacao_avisos` e os `painel_links` que a bateria criou. Com
`PEIXEIRO_PROVA_URL=` apontando para a função publicada a bateria para antes do
`lote_executar` — ela prova a contagem no ar sem abrir envio nenhum.

## Os 966 que só existiam no espelho (medido e resolvido em 16/11/2026)

O painel MC (`mcapi.knewcms.com:2087`) é o único lugar onde o acesso do cliente existe de verdade;
`mc_linhas` é só o espelho daqui do banco. O CSV que virou o espelho tem **980 linhas**, e elas não
são todas do mesmo balaio:

- **963** começam com `r566`, e **960** dessas são exatamente `r566001` a `r566960` em ordem, sem
  buraco — nome sequencial assim não sai do gerador do MC (os outros 17 têm cara de sempre: `11zc083`,
  `3u432a1`). As 963 compartilham **uma data só** de expiração e trazem `xxxxxxxxxxx` na coluna do
  nome do cliente; os 963 telefones são distintos entre si.
- **17** têm nome no formato do MC. Dessas, **13** estão hoje no MC (com `linha_id`) e **4** não.

A explicação veio do dono em 16/11/2026: **são clientes que ficaram muito tempo sem usar e ele apagou
da base do painel MC**. O CSV é o retrato de antes dessa limpeza, e importar de novo não resolve nada:
o import escreve no espelho, ele não devolve linha para o MC.

As medidas que fecharam a pergunta, todas no mesmo dia:

- `POST /auth/login` → `201`; o `/lines` da conta devolve **14 linhas** numa página só (a varredura
  parou porque acabou, não por limite de tela), com **10 vencidas**.
- `generalSearch=r566` → **1** linha (`r5660a6`, a única que sobrou da série). `r566001`, `r566500` e
  `r566960` respondem **zero**.
- Os 1.000 eventos de renovação mais recentes (`line_test` / `line_test_reuse`) do banco de produção
  falam de 27 usuários e **nenhum** `r566` — depois de apagados, eles não renovam mesmo.
- `renovacao_avisos` e `painel_links` tinham **0** linhas apontando para os 966: nenhuma mensagem foi
  enviada para essa gente, então não havia nada desfazer.

**Feito no banco da cópia** (`bzgtptbwcvwpgnhbctjn`): backup antes com `python tools/_exporta_espelho.py`
(980) e `python tools/_exporta_espelho.py so-espelho` (966) — os dois arquivos em `../backup-espelho/`,
fora do git porque têm telefone de cliente dentro — e depois
`delete from public.mc_linhas where coalesce(linha_id, '') = ''`, que apagou **966**. O espelho ficou
com **14 linhas, todas com `linha_id`, 10 vencidas**, e a conferência linha por linha contra o MC deu
`so no MC: []`, `so no espelho: []`, `linha_id diferente: []`. Espelho e painel MC batem 100%.

**Apagado também em 16/11/2026, por decisão do dono.** Sobrava o rastro na agenda: `usuarios_criados_ip`
tinha **975** linhas, 963 delas dessa lista apagada (os `r566…`), e era de lá que a aba Clientes ainda
mostrava essa gente sem linha nenhuma no MC. Backup antes para
`../backup-espelho/usuarios_criados_ip-2026-11-16-so-agenda.csv` — 963 linhas, todas com telefone,
**nenhuma com `exp_date`** — e depois o mesmo critério aplicado à agenda:

```sql
delete from public.usuarios_criados_ip a
 where not exists (select 1 from public.mc_linhas m where m.username = a.username);
```

Foram **963** apagadas; a agenda ficou com **12** linhas (11 dos 14 usuários do espelho + `r5660a6`, que
continua no MC) e `mc_linhas` continua intocado com **14 / 10 vencidas**. Nada precisou ser desfeito em
outro lugar: `renovacao_avisos` e `painel_links` têm **0** linhas apontando para essa gente, e apaguei os
dois planos congelados que as minhas conferências deixaram em `painel_lote` (`recuperar_todos`,
`mensagem_lote`), porque conferência velha não serve para nada.

⚠️ Consequência direta, e foi isso que ele escolheu: a aba Clientes da cópia voltou a ter **14 linhas** e
o botão **"Mensagem pelo WhatsApp"** (`quem: "fora"` no padrão) ficou com **0 alvos** — a lista que ele tinha
pedido para messagear era exatamente essa gente. Quem sobra para mensagem é o `quem: "todos"`: **11** com
número, 3 sem. E o "Não recuperados" nunca alcançou os 963, com ou sem essa limpeza: aquele lote só conta
**vencidos**, e linha de agenda não tem data de expiração — não é bug, é o critério.

Na **produção** não havia o que limpar: `mc_linhas` lá está com **0 linhas** (medido por REST em
16/11/2026) — o import do CSV nunca rodou nesse banco.

## Mensagem comum para quem não está no MC (aba Clientes)

Mensagem de WhatsApp normal **não depende de existir linha no painel MC**: depende só de um número.
Depois da limpeza dos 966, essa gente toda continuou na `usuarios_criados_ip` — é de lá que o painel
tira o telefone (o fim dessa lista está em "Os 966 que só existiam no espelho"; o caminho abaixo continua
valendo para qualquer número que volte a existir só na agenda). Foi para isso que a aba Clientes ganhou o
caminho de mensagem, e ele não abre o MC, não cria link de recuperação e não manda foto:

- **`listarClientes()` = `listarEspelho()` + `listarSoAgenda()`**. A segunda metade são os usuários que
  têm telefone na agenda e **não** têm linha em `mc_linhas` (`distinct on (username)`, o mais recente
  vence). É por isso que a aba Clientes não ficou vazia depois do `delete`: ela perdeu as 966 linhas do
  espelho e ganhou os mesmos 963 números pela agenda. `clientes_ver` devolve `so_agenda` com essa
  contagem e o `#clResumo` mostra quem está "só na agenda".
- **`mensagem_um`** (uma linha, botão **mensagem** da tabela): texto livre, até `MAX_TEXTO = 1200`
  caracteres. O número vem do que foi digitado na tela → `telefonesPorUsuario()` → `mc_linhas.telefone`.
  Sem número em lugar nenhum, volta `sem_telefone` e nada sai.
- **`tipo: "mensagem"`** no lote: usa a mesma máquina dos outros dois (`painel_lote` com a chave
  `mensagem_lote`, congelamento, pausa sorteada, três falhas seguidas param, parar/retomar/tirar da
  fila). `quem: "fora"` (o padrão) é só quem não tem linha no MC; `quem: "todos"` é a lista inteira.
- O **texto vai dentro de cada item do plano**, porque `proximoItem` devolve só o item. É o que garante
  que a mensagem do "Sim, enviar" seja a que foi conferida, mesmo depois de um F5 no meio do lote.
- As variáveis são as do robô (`{{usuario}}`, `{{pix}}`, `{{site}}`, `{{vence}}`...). Quem não tem data
  recebe `{{vence}}` = **"não está no nosso sistema"** de propósito; quem ainda tem linha recebe a data
  do espelho, porque o item do plano carrega `expira`.
- As linhas que só existem na agenda também ganham a caixinha **pular** (ela aparece quando o botão
  "Não recuperados" está ligado), senão não haveria como tirar ninguém da lista de uma mensagem.
- A prova de entrega é a mesma cadeia do aviso de vencimento: `renovacao_avisos` com
  **`exp_date = ''`** e `via = 'mensagem'`, ligada ao `whatsapp_status` pelo `id_message`. A data vazia
  é o que separa a mensagem comum do aviso de vencimento do mesmo cliente. Cada envio também grava um
  `mcapi_events` `mensagem_envio` com `via: "avulso"|"lote"` e só os 160 primeiros caracteres do texto.

Medido no banco da cópia em 16/11/2026, com `PEIXEIRO_MODO_TESTE=1` local
(`python tools/_prova_mensagem.py`, **40/40 provas**): `na_lista` 977 = 14 do espelho + 963 da agenda,
`sem_linha_mc` 963, **962 na fila** com um marcado para pular, o `"todos"` sobe para 973 (os 11 do
espelho que têm número), filtro por usuário fecha em 1 alvo, texto vazio volta `sem_texto` e 1300
caracteres voltam `texto_grande` — e os `login_refresh` do MC ficam em 34 → 34 do começo ao fim da
bateria, com a contagem inteira em 0,1 s. Os três envios simulados saem registrados com `exp_date=''`,
nenhum `painel_links` nasce, e a pausa veio sorteada (65,9 s).

⚠️ 962 mensagens com a pausa sorteada entre 4,5 s e 105 s são **de 1 a 5 horas com o navegador aberto**.
A janela de 15 minutos da conferência vale só para abrir o envio, e na cópia publicada o modo teste está
**desligado** desde 16/11/2026 — botão apertado nele é WhatsApp de verdade.

Conferido no ar, no painel do Pages com a função já publicada (16/11/2026, nenhuma mensagem saiu): o
modal abriu em **977** na lista, **963** sem linha no MC, o texto de 39 caracteres liberou o botão com
"Sim, enviar para 963", e com duas marcas `pular` guardadas no navegador a conta caiu para **961** e o
botão leu "Sim, enviar para 961". Cada conferência congela o plano em `painel_lote` (chave
`mensagem_lote`) sem enviar nada — nada sai dali antes do `lote_executar`.

**Medido de novo depois da limpeza da agenda (mesmo dia):** a aba Clientes caiu de 977 para **14 linhas**
(`so_agenda` 0, 11 com número, 10 vencidas), `quem: "fora"` ficou com **0 alvos** e `quem: "todos"` com
**11**. As duas medições acima valem para o banco antes desse `delete`.

**E o botão passou a servir para a lista toda (decisão dele, 16/11/2026):** *"a aba cleintes deve poder
enviar mensagem para todos os cliente mesmo se esta no mc"* — com a agenda esvaziada, o `quem: "fora"` não
tem mais ninguém, então o botão da aba Clientes se chama **"Mensagem pelo WhatsApp"** (antes era
"Mensagem para fora do MC") e o seletor **"para quem vai"** mostra o tamanho de cada grupo na hora
("só quem NÃO está no painel MC (0 na lista)" / "a lista inteira da aba Clientes (14 na lista)" — os
números vêm do `lote_contagem`, só trocam depois da primeira conta). Se o grupo escolhido der conta em
zero e o outro tiver alvo, **o modal cai sozinho no outro** (`msTrocado` segura para não ficar pulando
entre os dois), em vez de deixar o botão morto com "? não" na tela. O motor já alcançava a lista inteira
(`contagemDeMensagem` com `quem: "todos"`), e a bateria `tools/_prova_mensagem.py` agora roda **no grupo que
tem alvo** — na cópia de hoje ela prova o `"todos"`: `na_lista` 14, `alvos` 11 → **10** com um marcado para
pular, `sem_linha_mc` 0, `esperando` 0, os três envios simulados saem de linhas que **têm `linha_id` no
painel MC**, cada uma registrada com `exp_date = ''` e `via = 'mensagem'`, nenhum `painel_links` nasce e
os `login_refresh` param em 35 → 35. São **38/38 provas** (eram 40; a que testava o grupo vazio saiu porque
não há mais para quem mandar).

## A lista colada com CPF (aba Clientes)

O pedido dele, dito em 17/11/2026: *"cria um campo na aba Clientes que eu consiga colar uma lista
de contatos neste formato, pois o CPF é usado para verificar se o usuario creditou o pix usando a
conta dele ou nao"*, *"deixo acima do campo Exportar e importar CSV"*, *"também deixa um modal que
abre e eu posso fechar ele abre mostrando quantos usuarios foram importados sem erro e os que deu
erro deixe sem importar mesmo, só mostre no modal qual a linha que deu erro"*, e
*"não quero que seja necessário colar 'Nome Dados Expira Status Telefone Usuário' só estou te explicando"*.

O campo é um `<textarea>` (`#clPixLista`) no card **"Colar lista com CPF"**, logo acima de
"Exportar e importar CSV", e a action é **`clientes_importar_pix`** (com sessão). O formato é o da
tabela do painel MC, separado por tab:

```
Nome	Dados	Expira	Status	Telefone	Usuário
Aderlane monteiro da Silva	dados+82071527291	15/10/26	23:00	5596992048213	r70000000007
```

- **Cabeçalho opcional.** `lerCsv` já pulava cabeçalho que começasse em `usuario`; aqui o parser
  também reconhece a linha que tem `dados` na segunda coluna e a descarta. Colar sem cabeçalho dá
  o mesmo resultado.
- **O separador agora procura tab antes de `;` e `,`** (`csv.ts`). Era `;` primeiro, e um nome com
  vírgula na primeira linha ("Silva, Aderson") faria a lista inteira ser dividida no lugar errado.
  O CSV de ponto e vírgula continua igual — provado no ar: `n: 1`, `status 1` e a nota gravada.
- **`Expira` aceita `15/10/26` (ano de dois dígitos)** e `05/12/2026 14:30`; `parseDataBr` ganhou os
  dois dígitos (2000+aa) e passou a recusar mês fora de 1-12 e dia fora de 1-31, porque
  `Date.UTC` rolava "32/13/26" sozinho para 2027.
- **O que entra:** `username`, `telefone` e `exp_date` em `mc_linhas`, o telefone também em
  `usuarios_criados_ip` (é de lá que o botão recuperar e o lote leem número), e
  `usuario/cpf/nome` em **`cliente_pix`**.
- **O `Status` colado NÃO é gravado.** Na tabela do MC aquela coluna é uma hora (`23:00`), não
  ativo/parado; escrever `parseStatus("23:00")` = 0 marcaria a lista inteira como parada.
- **O CPF mora fora de `mc_linhas` de propósito:** a varredura do MC reescreve aquela tabela e
  jogaria o CPF no lixo na primeira sincronização. `cliente_pix` é só daqui. Nada de CPF ou
  telefone vai para `mcapi_events` — o log guarda só as contagens.
- **Linha com erro não entra.** Voltam `{linha, texto, motivo}` com `sem usuário na última coluna`,
  `sem CPF na coluna Dados`, `telefone inválido ("551199")`, `data inválida ("32/13/26")` ou
  `faltam colunas (...)`. O modal (`#modalPix`, fecha no **Fechar** ou no **Esc**) traz
  "N usuários importados sem erro." + a lista. Texto colado sem nenhuma linha (ou só o cabeçalho)
  devolve `csv_vazio` (400).
- **Usuário repetido na mesma colagem:** vale a última linha (o mapa deduplica antes de gravar).
- **Velocidade:** a gravação vai em blocos de 200 com `unnest`, não um round-trip por linha — 912
  linhas coladas entram em **12,1 s** (o botão espera 300 s).

Prova: `npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_pix.ts` na pasta
`supabase/functions/peixeiro` — **22/22**, com a parte que escreve dentro de `begin`/`rollback` e a
conferência final de que não sobrou nenhuma linha `^zz(prova|mass)` em lugar nenhum. Nenhum envio é
chamado nela. Ao vivo, no painel do Pages com a função publicada (17/11/2026): colar 4 linhas
(duas boas `zzprova1`/`zzprova7` e duas quebradas) abriu o modal com
"2 usuários importados sem erro. 2 linha(s) ficaram de fora.", as duas linhas com número e motivo,
os dois clientes apareceram na tabela, o campo limpou, e Fechar/Esc fecharam o modal sem erro no
console. As três linhas de prova foram apagadas do banco da cópia depois.

A tabela nasce sozinha do DDL idempotente (`db.ts`), então **na produção não tem nada para criar
à mão**: o primeiro cold start da função depois do deploy já cria `cliente_pix`.

## A aba Clientes de 900 em 900, com busca em tudo (17/11/2026)

O pedido dele, dito em 17/11/2026: *"como tem mais de 4 mil contatos acho que a aba clientes agora
sobrecarregou e nem abre, coloca pra mostrar de 900 em 900 pra não forçar o navegador, coloca um
campo que eu consigo fazer pesquisa por CPF NOME telefone PALAVRA, o que tiver na base toda"*.

A causa era essa: `clientes_ver` devolvia a lista inteira e `carregarClientes` desenhava cada linha
em `<tr>`. Depois da colagem com CPF a base da cópia está em **17.304** no espelho, 17.301 com
telefone e 16.382 com CPF — o navegador não consegue montar 17 mil linhas e a aba não abre.

- **A página vem do banco**, não do navegador: `listarClientesPagina(pagina, termo)`
  (`banco.ts`) devolve `CLIENTES_POR_PAGINA = 900` linhas por vez com
  `order by exp_date desc nulls last, username` (a mesma ordem de antes, então a paginação é
  estável) e um segundo `select` só com os totais. A aba Acessos já fazia assim; aqui o front usa
  `#clBusca` / `#clBuscar` / `#clPaginacao` com `carregarClientes(pagina, busca)`.
- **A união pesquisada é a mesma lista da tela** — `mc_linhas` com `left join cliente_pix` (nome e
  CPF) em cima, e embaixo quem só tem telefone em `usuarios_criados_ip`. O `listarClientes()` de
  sempre continua existindo porque `lote_contagem` o usa para contar o lote.
- **Um campo só, duas réguas** (`FILTRO_CLIENTES`): se o termo **tem letra**, procura em
  `username`, `nome` e `notes` com `ilike` (não diferencia maiúscula); se o termo é **só número e
  pontuação**, procura em `cpf`, `telefone` e `username` como dígitos. Por isso
  `(96) 99204-8213`, `96992048213` e `5596992048213` acham a mesma linha, e `820.715.272-91` acha
  pelo CPF. Um nome com dígitos no meio não inunda a tela com quem tem aqueles dígitos no telefone.
- **O que não é busca:** campo vazio (ou só espaço, ou só `%`) devolve a base inteira, porque o
  termo vazio não é filtro. `%` e `_` são tirados do termo para não virarem curinga do `LIKE`.
- **O resumo do topo conta a base, não a página**: "N de 17304 clientes batem com "fulano" ·
  17301 com telefone · 1 só na agenda · última sincronização ...", e embaixo
  "página 3 de 20 · 17304 nesta busca · 900 por vez" com ‹ anterior / próxima ›.
- **A coluna nova "Nome e CPF"** veio junto porque sem ela a busca por nome achava linhas que não
  mostravam o nome achado. Quem não foi colado com PIX mostra `—`.

**Medido na cópia (17/11/2026, 17.304 linhas):** com o banco acordado a página custa
**~150-190 ms** e os totais **~64-190 ms** (roda de 3 vezes em cada forma — `explain analyze` da
busca por "silva" fecha em 84 ms: um `seq scan` de 17 mil linhas com hash join do `cliente_pix`,
sem índice nenhum envolvido). A primeira chamada depois de o container dormir paga o despertar do
banco e já foi medida em 10-13 s — o painel espera 120 s no `chamar` da aba, então o toque não
falha, só demora uma vez.

Prova: `npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_clientes_pagina.ts` na
pasta `supabase/functions/peixeiro` — **21/21**, só leitura (nada escreve, nada envia): 900 por
página, páginas sem sobreposição, última página com o resto, página além da última vazia, quem só
tem telefone na agenda cai no fim, e as réguas de busca acima.

Ao vivo, no painel do Pages com a função publicada (17/11/2026, nenhuma mensagem saiu): a aba abriu
com **900** linhas e "17304 clientes · 17301 com telefone · 1 só na agenda · última sincronização
17/11/2026 12:19"; `próxima ›` levou à página 2 (`r566948` no topo, 900 linhas); buscar
`82071527291` devolveu **1** linha com o nome e o CPF na coluna nova; `(96) 99204-8213` e
`ADERLANE` também acharam a mesma linha; `zzninguemnabase999` deixou a tabela vazia com o texto
"Ninguém na base bate com … — o campo procura usuário, nome, CPF, telefone e nota" e o resumo
continuou contando a base; **Limpar** voltou às 20 páginas. Console sem nenhuma mensagem.

## O que os logs do MC guardavam

`mcapi_events` é texto puro e o `login_refresh` gravava o corpo inteiro da chamada — **a senha do MC
aparecia literal** em cada login (34 das 61 linhas do banco da cópia em 16/11/2026), mais o bearer em
5. A senha não expira como o bearer, então aquele registro valia para sempre. Desde
`fc28c0c` (cópia) e `dd62cfd` (site do Render) o log guarda só o usuário e as chaves de acesso viram
`(oculto N chars)`; a limpeza do que já estava gravado é:

```sql
update public.mcapi_events
   set request_payload = request_payload - 'password'
 where request_payload ? 'password';
```

Rodar no banco da cópia já foi feito (34 linhas limpas, 0 sobras). Na produção é com ele.

## A mensagem do recuperar aceita as variáveis da aba Chat (18/11/2026)

O pedido dele: *"na aba não recuperados adicione as novas variaveis no texto que é enviado como
{nome} ... que voce adicionou da outra aba chat do chatbot"*, corrigido em seguida por *"perdão
corrija na aba recuperação"*. É a aba **Recuperação** — o texto que sai quando ele aperta
"recuperar" numa linha vencida, e o lote "Não recuperados".

**O que a mensagem conhece agora** (`variaveisMensagem` em `texto.ts`, os mesmos nomes da aba Chat):

| chave | sai |
|---|---|
| `{nome}` | o nome cadastrado (palavra de situação do MC nunca entra); sem nome, não escreve nada |
| `{usuario}` | o usuário do MC; sem usuário, o telefone |
| `{telefone}` | `(11) 99999-8888`, com o 55 já resolvido |
| `{vence}` | `vence em 02/12/2026 18:00` ou `venceu em 14/10/2026 18:00` |
| `{expira}` | só a data gravada |
| `{expirou}` | `há 1 mês e 4 dias` ou `ainda não venceu (em 15 dias)` |
| `{dias}` | o mesmo texto da tela Acessos |
| `{status}` | `ativo`, `parado` ou `sem cadastro` |
| `{pix}` | a chave da Configuração, ou `(chave ainda não cadastrada)` |
| `{site}` | o endereço do painel |
| `{data}` / `{hora}` | o agora em Brasília |
| `{link}` | o link curto daquele cliente (só existe no envio de verdade) |

- **Duas grafias, um resultado.** A aba Chat escreve `{{nome}}` e as mensagens do painel sempre
  escreveram `{nome}`. `preencherVariaveis` casa `\{\{?chave\}?\}` na mesma passada, então as duas
  valem nos dois lugares e `{{ nome }}` com espaço também. O que **não** é chave conhecida fica
  escrito no texto — ele vê o erro em vez de receber uma mensagem muda. `renderizar` da aba Chat
  continua igual a antes (só a dupla grafia), porque as regras de lá já foram provadas assim.
- **Avisos e renovação não mudaram.** `legendaAviso`/`legendaRenovacao` seguem no `preencher`
  velho, com `{dias}`, `{pix}` e `{link}` e uma chave só. Ele pediu a Recuperação; mexer na agenda
  das 6h sem pedido não.
- **De onde vem o `{nome}`.** Consulta nova `dadosDoCliente(username)` em `banco.ts`: primeiro o
  espelho do MC com `coalesce(nullif(trim(cliente_pix.nome),''), nullif(trim(mc_linhas.notes),''), '')`,
  e, para quem não está no espelho, o telefone da agenda (`usuarios_criados_ip`) sem data nem
  situação. A ordem nome-antes-de-nota é medida, não palpite: na cópia em 17/11/2026,
  **16.382** linhas têm nome em `cliente_pix`, **921** têm nota no espelho e **nenhuma** tem os
  dois — as notas são telefone mascarado (`Simone 129xxxx4466`), não nome. O mesmo `coalesce` foi
  levado para `clientePorTelefone` (`chat.ts`), assim o `{nome}` da aba Chat também passou a sair
  certo para essa multidão em vez de cair no usuário.
- **A forma da ficha nunca muda.** Quem não é encontrado recebe os cinco campos vazios
  (`nome: ""`, `status: null`, `expira: null`) e não faz consulta com string em branco. Com `status`
  nulo a mensagem diz `sem cadastro` e com `expira` nulo diz `não está no nosso sistema` — não
  inventa prazo.
- **O número para onde se manda não mudou.** Continua sendo o da agenda (`telefonesPorUsuario()`
  no botão de uma linha, o telefone do item na fila do lote); a ficha só entra no texto. O custo é
  uma consulta pelo `username` por envio: 11 ms com a conexão aquecida.
- **A tela explica na própria aba.** O campo da mensagem ganhou a lista de chaves, o aviso de que
  `vence` é a única que nunca mente para um vencido (não escrever `vence em {expira}`) e a nota de
  que o exemplo é um cliente de mentira — Maria da Silva, `r7000000007`, vencida há 1 mês e 4 dias.
  A Configuração (item 4) aponta para a mesma lista em vez de repetir a explicação.

Prova (nada saiu do banco da cópia, nenhum WhatsApp foi enviado):

```bash
# 37 checagens: as chaves, os três jeitos de falar do vencimento, as duas grafias,
# as fichas reais (nome do PIX, nota do MC, só-agenda, inexistente) e a prova de que
# a aba Chat e a Recuperação dizem exatamente a mesma coisa para o mesmo cliente
cd supabase/functions/peixeiro
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_recupera_variaveis.ts

# ao vivo: o Pages com a ajuda nova e a função deployada respondendo recuperacao_ver
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_recupera_live.ts
```

O `_prova_recupera_live.ts` assina um token de sessão em memória (o mesmo HMAC do painel, sem
imprimir nada) só para abrir a rota `recuperacao_ver` na cópia — a rota é leitura pura: o cliente do
exemplo é de mentira e o link também, então nenhum encurtador é chamado e nenhuma mensagem sai. Duas
checagens que falharam na primeira rodada e foram corrigidas antes de publicar: `{{banana}}` saía
com uma chave só (o colapso das duas grafias antes da substituição) e a ficha de usuário inexistente
vinha sem `status`/`expira`.

## `{primeiro}` e as variáveis do cliente também no aviso e na renovação (18/11/2026)

Ele perguntou se `{nome}` saía só com o primeiro nome; não sai (é o nome inteiro cadastrado). Ofereci
uma chave só para isso e ele respondeu *"pode criar essa variavel? em abas as abas que voce tinha
criado as demais?"* — ou seja: `{primeiro}` em **todas** as telas que montam mensagem, não só na
Recuperação.

**`{primeiro}`** (`primeiroNome` em `texto.ts`): pega a primeira palavra do nome e descarta o resto.
As regras que a base dele obriga:

- token com dígito não é nome — as notas do MC são telefone mascarado ("Simone 129xxxx4466" vira
  `Simone`, "129xxxxxx13" não vira nada);
- letra sozinha e partida do meio ("da", "de", "do", "dos", "das", "du", "e") não abrem o nome:
  "A da Silva" e "da Silva" dão `Silva`, "Aderlane monteiro da Silva" dá `Aderlane`;
- sem nada aproveitável **não sai nada** — nem `amigo(a)`, nem o código do usuário
  (`r7000000007`) no lugar de um nome. A frase se fecha sozinha no lugar do buraco; é a seção
  "A chave que não tem o que escrever" abaixo. O `{nome}` também não cai mais no usuário.

**Onde a chave vale** — os quatro lugares que montam texto com dado do cliente:

| onde | como escreve | o que mudou |
|---|---|---|
| aba Recuperação (botão e lote) | `{x}` ou `{{x}}` | + `{primeiro}` |
| aba Chat (regras) | `{{x}}` | + `{{primeiro}}` |
| modal "Mensagem avulsa" (aba Clientes) | `{{x}}` | + `{{primeiro}}` |
| aviso das 6h + renovação (Configuração, itens 3 e 4) | `{x}` ou `{{x}}` | antes só `{dias}` e `{pix}`; agora a ficha inteira |

- **A agenda das 6h passou a conhecer o cliente.** `legendaAviso`/`legendaRenovacao` ganharam o
  terceiro argumento (`cliente`) e hoje passam pelo mesmo `preencherVariaveis` da Recuperação; o
  `preencher` velho, que só trocava três chaves, foi apagado. `{dias}` continua sendo **o texto que o
  painel MC calcula** (`linha.texto_dias`), porque é ele que aparece na tela Avisos — as outras chaves
  vêm da ficha. Custo: uma consulta por envio, 10 ms com a conexão aquecida, na mesma fila que já
  escreve em `vencimentos_avisos`.
- **`fichaPara(username, exp_date, telefone)`** (`varredura.ts`) é o ponto único: telefone = o da
  agenda (é para lá que se manda, não o do espelho), data = a que o MC acabou de calcular (a do
  espelho pode estar velha), nome/situação = `dadosDoCliente`. A prévia da tela Avisos usa o primeiro
  da lista, então o nome que ele vê na prévia é o que sairia de verdade.
- **Duas mudanças de comportamento que ele precisa saber:**
  1. `{link}` no aviso e na renovação **não existe** (link curto só nasce no "recuperar"). Fica
     escrito na mensagem, para ele ver o erro em vez de sair um buraco — a ajuda da tela diz isso.
  2. Sem chave PIX cadastrada, `{pix}` agora escreve `(chave ainda não cadastrada)` em vez de vazio.
- **O que a aba Chat e o modal continuam de duas chaves só** (`renderizar`): quem escrever `{nome}`
  numa regra de chat vê a chave escrita, não trocada. A Recuperação, o aviso e a renovação aceitam as
  duas grafias. É a única diferença entre as telas, e está escrita em cada uma delas.

Prova (53 checagens, banco da cópia, nada enviado):

```bash
cd supabase/functions/peixeiro
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_recupera_variaveis.ts
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_recupera_live.ts
```

A bateria cobre `{primeiro}` nas notas mascaradas, o aviso/renovação com ficha e sem ficha, a régua de
`{dias}` vindo do MC, `{link}` sobrando no aviso e a ficha real montada por `fichaPara`. O teste ao
vivo acrescenta a checagem de que `{primeiro}` está nas telas certas do Pages publicado.

## A chave que não tem o que escrever fecha a frase (18/11/2026)

O pedido dele: *"na fila que está sendo enviada Fila do 'Não recuperados' ao inves de ir o nome
quando não tem o primeiro nome esta indo a Mensagem com a variavel ativo ... corrija para caso não
tenha primeiro nome não pule tabelas só não envie nada no lugar da variavel a mensagem que estaria o
'Olá, {primeiro} tem' ficaria Apenas 'Olá, tem'"*.

Duas coisas erradas na mesma mensagem do número `15996201142`:

1. **de onde vinha o `ativo`.** Na base dele a coluna que vira nome às vezes traz a palavra de
   situação do painel MC. `nomeAproveitavel` (`texto.ts`) agora joga fora o que é uma das palavras da
   coluna (`PALAVRAS_DE_SITUACAO`) antes de qualquer coisa: `ativo`, `parado`, `vencido`, `expirado`,
   `inativo`, `sem cadastro`, `bloqueado`, `ativo(a)`, `parado(a)` e `vencido(a)`. `{nome}`,
   `{primeiro}`, a lista de Bloqueados e o `{nome}` da aba Chat passam todos por ela, e nenhum deles
   cai mais no código do usuário quando não há nome.
2. **o que saía no lugar do nome.** Uma chave conhecida com valor vazio deixava sobrar pontuação e
   espaço duplo. `trocar()` — o motor que `preencherVariaveis` (`{x}` e `{{x}}`) e `renderizar` da aba
   Chat (`{{x}}`) compartilham — troca a chave vazia por um marcador invisível (`\u0001`) **segurando
   o espaço que estava colado nela** e depois fecha o buraco:

   | a frase escrita | sem `{primeiro}` sai |
   |---|---|
   | `Olá, {primeiro} tem` | `Olá, tem` |
   | `Olá! {primeiro}, tem interesse` | `Olá! tem interesse` |
   | `Bom dia, {primeiro}` | `Bom dia,` |
   | `Oi!\n\n{primeiro}, temos uma oferta` | `Oi!\n\ntemos uma oferta` |
   | `{primeiro} {nome} {usuario}` | `r7000000007` |

   A regra das três pontuações: se antes já havia pausa (`!`, `?`, `:`) a vírgula que era do nome
   morre; se depois vem sinal de fim de frase a vírgula de antes morre; nas beiradas do texto o
   marcador simplesmente some. **O `\n` nunca é tocado** — é por isso que a linha em branco entre dois
   parágrafos sobrevive ao buraco, que era o "não pule tabelas" do pedido.

Não existe mais `amigo(a)` em lugar nenhum, e o `{nome}` não cai no usuário: quem não tem nome
simplesmente não recebe nome.

```bash
cd supabase/functions/peixeiro
# 66 checagens: as chaves, as fichas reais e as cinco frases acima nas duas grafias
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_recupera_variaveis.ts
```

## Aba Bloqueados: quem responde "não" sai de toda fila (18/11/2026)

O pedido dele: *"cria uma aba chamada bloqueados, na aba chat faça o chatbot responder a primeira
resposta do usuario for apenas não ... na aba bloqueados vamos criar um botão para cada usuario para
que possa ser desbloqueado ... adicione um campo de pesquisa por numero nome palavra letra oque tiver
na nossa base toda, assim como ja devia ter um campo de busca na aba clientes e na aba acessos"*.

**A tabela.** `public.clientes_bloqueados (telefone text primary key, usuario, nome, motivo,
criado_em)` + RLS + índice por `criado_em`, tudo dentro do `ESQUEMA` de `db.ts` — instala sozinha no
cold start, não existe arquivo de migração neste repositório. A chave é o telefone **normalizado** por
`normalizarWhatsapp`, então `(11) 90000-0001`, `11900000001` e `55 11 90000-0001` são a mesma linha: é
o que amarra o número que chega do webhook, o que está no item congelado da fila e o que a agenda
guarda.

**O "não" no chat.** `respondeuNao` (`chat.ts`) roda **antes** das regras: normaliza o texto e aceita
só `nao` ou `n` sozinho — "não quero" continua caindo nas regras de venda, porque ali o "não" é
objeção, não pedido para sair. O primeiro "não" bloqueia e manda a resposta; o segundo do mesmo número
não manda nada (`bloquear` devolve `false`), então a pessoa não recebe "ok, você saiu da base" duas
vezes. O texto é configurável no campo `chat_nao_legenda` da aba Chat e sai por `preencherVariaveis`,
com o `{primeiro}` funcionando exatamente como na Recuperação. O padrão, gravado pelo `ESQUEMA`:

```
Tudo bem, {primeiro}! Você foi removido da nossa base e não recebe mais nenhuma mensagem nossa.
Obrigado por fazer parte do O Peixeiro.
Qualquer coisa é só chamar aqui neste número que a gente te adiciona de novo.
```

Sem nada escrito no campo, o "não" não bloqueia nem responde — desligar a tela desliga o recurso.

**Onde o bloqueio trava a mensagem** (são seis pontos, e é isso que evita o bloqueio do WhatsApp):

| onde | o que faz |
|---|---|
| montar a fila — `loteContagem`, nos dois ramos (Não recuperados e mensagem em massa) | `telefonesBloqueados()` (uma consulta) tira da lista antes de congelar o plano |
| enviar um item da fila — `loteItem` | `estaBloqueado` antes de chamar o GreenAPI; a linha volta `{ ok: true, marca: "bloqueado" }`. É o que pega o "não" que chegou **depois** de o lote começar |
| botão "recuperar" de uma linha e mensagem avulsa — `recuperarUm`, `mensagemUm` | `travaBloqueado` nas duas actions: 409 `bloqueado` com o telefone na resposta |
| agenda das 6h e a varredura de renovação — `avisarVencimentos`, `avisarRenovacao` | `telefonesBloqueados()` filtra a lista antes de subir |

O `marca: "bloqueado"` com `ok: true` é proposital: falha counted no lote para o lote sozinho depois de
três seguidas (`PARADA_ERROS`), e um número bloqueado não é erro de rede — sem isso, uma fila com
muitos bloqueados parava no meio sozinha. A tela mostra a palavra `bloqueado` na linha e o pulo de
contagem segue normal.

**A aba.** `Bloqueados` na barra, com o total, a busca (telefone, nome, usuário ou motivo, com as
três grafias do número) e um botão **desbloquear** por linha — sem modal de confirmação, porque
desbloquear é a ação que ele quer rápida: o botão se desabilita, escreve "tirando…", chama
`bloqueados_desbloquear` (que grava `cliente_desbloqueado` em `mcapi_events`), devolve o telefone
formatado e recarrega a lista. Clicar duas vezes no mesmo número volta 409, sem quebrar a tela.
Desbloquear devolve o número para todo plano montado **depois** do clique; a fila já congelada não é
refeita — para aquela pessoa voltar a receber é o próximo "Não recuperados". A busca **vazia** é o caso que quebrou na primeira rodada: as
cinco condições `ilike` montavam a `where` com `$1` e, sem palavra para procurar, a consulta ia para o
banco com um parâmetro sobrando — `bind message supplies 1 parameters, but prepared statement requires
0`. Hoje o `where` e os argumentos só existem quando há busca.

Os campos de busca que ele pediu nas outras duas telas já estavam lá (`#acBusca` na Acessos,
`#clBusca` na Clientes, ambos procurando usuário, nome, CPF, telefone e nota, com Enter e "Limpar"); a
aba Bloqueados ganhou o mesmo desenho.

```bash
cd supabase/functions/peixeiro
# 21 checagens com dois números de teste (55 11 90000-00xx) que a prova apaga no fim
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_bloqueados.ts
```

Nenhum WhatsApp é enviado pela prova: ela fala com `bloquear`/`desbloquear`/`listarBloqueados` e com as
duas actions da tela, não com o GreenAPI.

## Pular envios na fila que está rodando (18/11/2026)

O pedido dele: *"na fila atual eu quero poder pular uma quantidade que esta sendo enviado coloque um
campo que eu consigo alterar uma quantidade finita que eu desejo pular de envios que estao sendo
enviados pode por na aba nao recuperados em cima da fila do não recuperados para facilitar
vizualização"*.

**`pularEnvios(tipo, quantos)`** (`lote.ts`) marca as próximas `quantos` linhas do plano congelado com
`ignorado: true, pulado: true`. É a mesma marca do "tirar da fila" — `proximoPosicao()` pula o que está
marcado e a numeração das linhas não muda, porque o número é o progresso do lote. Remarcar é o único
jeito de pular sem quebrar o `estado.resultados` nem o navegador que está pedindo item por item.

As três regras que a tela precisa que ele acredite:

- **o item que está no ar não é pulado.** Com `estado.enviando = k`, o pulo começa em `k + 1`; sem nada
  no ar, começa na posição em que a fila está. A nota embaixo do campo diz isso ("não conta o que está
  no ar agora").
- **quem ele já tinha tirado da fila não gasta a quota.** `foraDaFila()` é chegado dentro da passada,
  então pedir 3 com uma linha `ignorado` no meio pega três linhas de verdade.
- **pular o resto termina o lote.** Se depois do pulo não sobra ninguém, o `rodando` vai a `false` com
  `motivo: "pulou_restou"`. Sem isso o lote ficaria "rodando" para sempre e o próximo "Não recuperados"
  travava em `lote_rodando`.

`lote_pular` (action) valida `quantos` inteiro entre 1 e 2000 — fora disso devolve
`quantidade_invalida`/`muita_marca` sem tocar no plano — grava o evento `..._pular` em `mcapi_events`
com quanto ele pediu e quantos saíram, e devolve o resumo novo. `lote_fila` ganhou `pulados` no resumo
e a situação `pulou` por linha; a barra de progresso tira os pulados do denominador, para "12 de 40"
continuar querendo dizer "12 dos 40 que ainda podiam sair".

Na tela, a caixa `Pular envios` fica entre o resumo e a lista da fila do Não recuperados: um número
(1 a 2000), o botão **Pular agora** e a nota com quantos faltam. Ela se esconde sozinha quando a fila
está vazia ou acabou, o botão fica desabilitado enquanto o pedido está no ar (duplo clique não pula o
dobro) e Enter no campo faz o mesmo que o botão. As telas de Acessos e Clientes ficaram sem a caixa de
propósito: elas não acompanham o lote vivo, então o campo nasceria mentindo — quem pula é sempre a
aba Não recuperados, seja qual for a fila.

```bash
cd supabase/functions/peixeiro
# 18 checagens. Trabalha na chave do lote de apagada, tira um retrato da linha e devolve
# exatamente do mesmo jeito no fim — mesmo se der erro no meio. Nada manda WhatsApp.
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_pular_envios.ts
```

## A banda do plano grátis: a fila passou a vir em janela (18/11/2026)

Ele mandou a tela de uso do plano — `painel-2peer` **9,88 GB** contra "5 GB incluídos" — e pediu
*"tira tudo que não for necessario desses 9 gb que voce ta usando no supabase preciso de pelo menos
apague 6gb"*.

Primeiro a medida, porque a resposta depende dela:

| o que é | tamanho medido |
|---|---|
| banco inteiro (`pg_database_size`) | **25 MB** |
| Storage (`storage.objects`) | **0 objetos · 0 bytes** |
| maior tabela (`usuarios_criados_ip`) | 3,6 MB |
| `painel_lote` (o plano de 17.286 linhas congelado) | 752 kB |
| `lote_fila` de uma vez, antes da janela | **2,45 MB por chamada** |
| `acessos_ver` (uma página de 900) | 0,51 MB |
| `clientes_ver` (uma página de 900) | 0,25 MB |

**Não existem 9 GB para apagar.** O que estourou é **banda (egress)**: os 5 GB incluídos do plano
grátis são tráfego que já saiu do projeto, e o contador não volta quando se apaga linha — ele zera no
fim do ciclo de cobrança. As saídas reais são três: esperar virar o ciclo, desligar o spend cap (e
pagar o excedente) ou ir para plano de uso. A quarta é **cortar o tráfego**, e é a que depende de
código. Foi por aí que eu fui.

**A máquina era a tela do Não recuperados.** Enquanto o lote roda, `frProgramar` refaz a fila a cada
4 segundos, e `rodarLote` refaz a cada item enviado. Com 2,45 MB por resposta, são ~36 MB por minuto e
~2,2 GB por hora de aba aberta — os 9,88 GB batem com dois dias de fila rodando com a aba na tela
(o projeto é de 16/11). Parte desse tráfego também veio das minhas provas, que puxam tabela real pelo
pooler IPv4.

**O corte** (`loteFila` em `acoes.ts`, `carregarFila`/`desenharFila` em `painel/app.js`):

- a resposta vem com uma **janela** de `janela` linhas (padrão 150, teto 400) centrada em volta do item
  que está no ar: um terço de histórico para trás, o resto à frente. A tela nunca desenhou mais do que
  200 linhas (`FR_TOPO`) — ela só não sabia que estava pagando para baixar 17.286.
- as contagens (`na_fila`, `fora`, `pulados`, `bloqueados`, `total`, `mostraveis`) continuam do plano
  inteiro, e o corpo devolve `desde`/`ate` para a linha do topo não mentir. Ela agora diz "a fila anda
  sozinha para onde o envio está".
- `so_erro: true` filtra **na função**. Antes o "Ver só os com erro" baixava os 17.286 nomes no
  navegador para filtrar dois.
- `entregasPorUsuario` recebe só os nomes da janela; antes era uma cláusula `in` com 17.286 valores a
  cada poll.
- `estado.resultados` não vai mais na resposta: é uma marca por linha tentada, então cresceria junto
  com o lote até virar mais de 1 MB por poll. A tela já recebia o que aconteceu dentro de `itens`.

Depois do corte, medido ao vivo na fila real: **22 KB por poll** (150 linhas) contra os 2,45 MB de
antes — ~111× menos, e o teto de 400 linhas pesa 58 KB.

```bash
cd supabase/functions/peixeiro
# 13 checagens na chave do lote de apagada, com retrato da linha e restauração no fim
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_fila_janela.ts
# ao vivo: a função deployada e o Pages publicado devolvendo a janela
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_live_fila.ts
```

**O que eu não apaguei de propósito:** não havia o que apagar. O banco tem 25 MB, o Storage está
vazio, e o que existe é a fila congelada e o espelho do MC — dados do painel, não lixo. Se ele quiser
mesmo, dá para esvaziar o `plano` dos 17.286 itens (a tela volta para "nenhuma fila montada ainda"),
mas isso não devolve banda nenhuma e joga fora o progresso de quem já saiu.

## Os três ajustes publicados na cópia (18/11/2026)

`supabase functions deploy peixeiro --no-verify-jwt --yes --project-ref bzgtptbwcvwpgnhbctjn`
(binário de `C:/Users/ps4la/bin/supabase.exe`, token `sbp_` do `.env`). A produção
`suipuquznkksgrkchqrv` continua com o que estava: nada deste dia foi para lá.

```bash
cd supabase/functions/peixeiro
# ao vivo: as rotas novas no build deployado + as telas novas no Pages publicado
npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_live_fila.ts
```

A checagem mais útil é a que não escreve nada: o `index.ts` devolve `404 acao_inexistente` **antes** de
olhar o token, então `lote_pular`, `bloqueados_ver` e `bloqueados_desbloquear` chamados sem sessão
voltando `401 sem_sessao` prova que a rota está no build lá de cima, sem precisar montar fila, bloquear
número nem disparar envio.

## A virada para o projeto do Urtador (18/11/2026)

O painel saiu do projeto `bzgtptbwcvwpgnhbctjn` (a cópia, que comeu os 9,88 GB de banda) e
passou a rodar em `ggufcvrwctieacvbbwim`. Feito tudo no servidor, sem baixar dump nenhum na
máquina dele (900 MB livres): uma ponte `postgres_fdw` dentro do projeto novo lê o banco da
cópia, e o `insert ... select` atravessa os dados por lá.

Os arquivos do caminho, todos em `tools/`, são a receita completa:

1. `_novo_role.sql` — cria o papel `peixeiro_2peer` (dono das 20 tabelas do painel) e dá
   `grant peixeiro_2peer to postgres` para conseguir fazer `set role` dentro de uma chamada.
   Criar papel em vez de resetar a senha do `postgres` de propósito: o `kutt-short-links` do
   Urtador usa a senha antiga, e resetar quebraria o encurtador dele.
2. `_novo_fdw.sql` — sobe o `postgres_fdw`, o server `copia_2peer` apontando para o pooler da
   cópia (`aws-0-sa-east-1.pooler.supabase.com:5432`, `sslmode require`) e o schema `mig` com
   `import foreign schema public`. A senha da ponte vem do `DATABASE_URL` do `.env`; user
   mapping para `postgres` **e** para `peixeiro_2peer`.
3. `_novo_esquema.sql` (gerado, não guardado) — o `ESQUEMA` de
   `supabase/functions/peixeiro/db.ts` executado como `peixeiro_2peer`:
   `{ printf 'set role peixeiro_2peer;\n'; sed -n '118,446p' supabase/functions/peixeiro/db.ts; } > tools/_novo_esquema.sql`
   (as linhas exatas mudam quando o `ESQUEMA` cresce — confira onde começa e termina o
   template literal). Mais o `create table if not exists site_acessos`, que o `site.ts` já
   cria sozinho na primeira chamada.
4. `_novo_diff.sql` — compara **coluna por coluna** `information_schema.columns` de `public`
   com `mig` (as 20 tabelas). Tem que voltar `[]`. Se a cópia tiver coluna que o esquema do
   arquivo não cria, é aqui que aparece.
5. `_novo_reload.sql` — a carga: `truncate` das 20 tabelas + `insert into public.X select *
   from mig.X` + o `setval` de toda sequência acima do maior id copiado. **Rode de novo
   imediatamente antes de virar o `config.js`** e outra vez ao voltar para a cópia: é o que
   traz as linhas escritas na cópia depois da última carga. Sem o `setval`, o primeiro insert
   novo bate em chave duplicada.
6. `_novo_conferencia.sql` — `count(*)` de cada tabela no novo contra o `mig`. Igual é o
   esperado.
7. `_novo_secrets.js` — os 6 secrets do painel no projeto novo (o `DATABASE_URL` do papel,
   MC, Urtador base, origens, assets). A API de secrets **não tem `PUT`** e devolve só hash,
   então não dá para conferir valor: confira o `http 200` e a lista de nomes
   (`_novo_secretnames.js` faz o conjunto diferença com a cópia).

Deploy + prova (nada de envio, nada de login com senha adivinhada — errar `entrar` trava o
IP dele nas tentativas):

```bash
cd 2peer
C:/Users/ps4la/bin/supabase.exe functions deploy peixeiro --no-verify-jwt --yes --project-ref ggufcvrwctieacvbbwim
node tools/_prova_novo_live.js
```

A prova (`_prova_novo_live.js`) usa só actions que não mandam nada: `ping`, uma ação que não
existe (404 antes do 401, o que confere o build), as rotas novas sem sessão (401 `sem_sessao`)
e `links_destino` com uma linha de teste criada **e apagada** no banco novo — o slug
`prova-migracao-novo` não é de cliente nenhum, então nenhum clique cai nele. Ela também
confere que a função da cópia **não** vê essa linha: cada uma está presa no seu banco.

O que a virada **não** levou, porque a API de secrets não devolve valor de secret nenhum
(só o nome e um hash):

- `URTADOR_TOKEN` — a sessão do login por WhatsApp no Urtador, que estava gravada como secret
  da cópia. Sem ele o painel funciona, mas o link de recuperação sai sem encurtar na conta
  dele (ou sai comprido, se o `create` recusar visita). Para repor:

  ```bash
  cd 2peer && export SUPABASE_ACCESS_TOKEN=$(grep -oE 'SUPABASE_TOKEN_NOVO=.*' .env | cut -d= -f2 | tr -d '\r')
  npx supabase secrets set URTADOR_TOKEN=<token> --project-ref ggufcvrwctieacvbbwim
  ```

`PAINEL_FUNCAO_URL` já foi gravado no projeto novo
(`https://ggufcvrwctieacvbbwim.supabase.co/functions/v1/peixeiro`), porque o valor é público:
é o endereço que o `chat_instalar` entrega para o GreenAPI chamar de volta. Sem ele, ao
religar o webhook do robô (tarefa do chat) a chamada continuaria caindo na cópia.

Roda de volta: o banco e a função da cópia continuam inteiros e no ar, parados no ponto da
última carga. Voltar é trocar uma linha — `painel/config.js` de novo para
`https://bzgtptbwcvwpgnhbctjn.supabase.co/functions/v1/peixeiro` — e dar push; se tiver
ficado mexendo no painel novo nesse meio tempo, o caminho inverso do `_novo_reload.sql`
(troque `public` por `mig` e vice-versa, com a ponte apontada para o projeto novo) traz as
linhas de volta.

## Quando for para a produção

Nada aqui está pronto para produção enquanto você não decidir. A ordem segura é:

1. Criar a função no projeto **de produção** com os secrets de lá (`DATABASE_URL` do banco bom,
   `MC_USERNAME`/`MC_PASSWORD`, GreenAPI, `URTADOR_TOKEN`) e **sem** `PEIXEIRO_MODO_TESTE`.
2. Apontar `painel/config.js` para a função de produção e publicar o Pages.
3. Testar Início/Configuração/Clientes, depois Acessos, e só então um aviso para um número seu.
4. Trocar a agenda das 6h: hoje o workflow chama o endereço do Render; com a função no ar, a
   chamada passa a ser `POST` na função com `{"action":"aviso_cron","token":"<aviso_token>"}`.
5. Só depois de ver a agenda rodar uma vez, desligar o serviço do Render.

Roda de volta: o `painel_web.py` e o `render.yaml` continuam no repositório. Apontar o
`config.js` de novo para o Render, ou manter os dois no ar um tempo, é o caminho mais curto
se algo aqui desaguar.
