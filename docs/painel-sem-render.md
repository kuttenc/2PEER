# Painel sem Render: Pages + Edge Function

Este documento cobre a cópia de testes (`kuttenc.github.io/2PEER`). Nada aqui mexe no
serviço do Render nem no banco de produção: enquanto você não trocar o `config.js` e os
secrets da função, o site principal continua exatamente como está hoje.

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

## Como publicar de novo (cópia)

```bash
cd 2peer
# o token (sbp_...) fica no .env como SUPABASE_PROJECT_2peer; o CLI só aceita no formato sbp_
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

## A aba "Não recuperados" (a fila por dentro)

O mesmo lote das abas Acessos e Clientes, visto linha por linha. Nada de novo é enviado por
ela: quem começa o envio continua sendo o "Não recuperados → Revisar e enviar".

- `lote_fila` devolve o plano congelado de `recuperar_todos` com a situação de cada posição
  (`fila` / `enviando` / `enviado` / `falhou` / `fora`) e os contadores. O resultado de cada
  tentativa fica em `estado.resultados` (chave = número da linha no plano), então **quem falhou
  continua na tela depois que o lote acaba**, com o motivo que o GreenAPI deu.
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
