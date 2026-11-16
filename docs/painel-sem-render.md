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
npx supabase secrets set --yes --remote=bzgtptbwcvwpgnhbctjn PEIXEIRO_MODO_TESTE=1
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
