# Painel online (`/painel`)

As telas do painel rodam dentro deste próprio app no Render, então dá para abrir
do celular sem instalar nada. Nada de chave aparece no navegador: o navegador só
manda o cookie de sessão.

## Endereços

| Tela | URL | Para que serve |
| --- | --- | --- |
| Entrar | `/painel/entrar` | senha única do dono |
| Início | `/painel/` | estado do WhatsApp, foto guardada, nº de telefones, botão de varrer |
| Configuração | `/painel/config` | trocar instância GreenAPI, foto, legenda e todos os textos do aviso |
| Avisos | `/painel/avisos` | quem está vencendo e envio manual |
| Acessos | `/painel/acessos` | lista do painel MC, busca, telefone, mesclar, recuperar, lote "Não recuperados" e apagar linha |
| Recuperação | `/painel/recuperacao` | texto e foto que saem em todo clique no botão recuperar |
| Clientes | `/painel/clientes` | espelho do Supabase, baixar e importar CSV, recuperar linha e lote "Não recuperados" |
| Deletar | `/painel/deletar` | apagar uma faixa de usuários (prefixo + de/até) com contagem no modal e a palavra `deletar` |
| Links | `/painel/links` | encurtar um endereço no serviço de links dele |
| Senha | `/painel/senha` | trocar a senha do painel |

## Aba Links (encurtador)

`/painel/links` encurta um endereço no mesmo serviço que o site de encurtar usa, pela
Edge Function `kutt-short-links`. A chamada sai do servidor (`encurtador.py`), então a
chave nunca aparece no navegador, e o `POST /painel/links/encurtar` está atrás do login
como todas as outras rotas. Se o serviço estiver fora, a tela mostra o erro e nada mais
quebra. Ver `docs/copia-2peer.md` para os limites por minuto e para o `URTADOR_TOKEN`.

## Como a senha funciona

- O hash PBKDF2-SHA256 (200 mil iterações) fica em `greenapi_config.painel_senha_hash`.
- `ensure_schema()` cria a coluna e semeia o hash na primeira conexão com o banco.
- Login grava o cookie `painel_sessao` = `<unix expira>.<hmac do hash da senha>`,
  HttpOnly, Secure, SameSite=Lax, 30 dias. Trocar a senha derruba todas as sessões.
- Senha errada: 8 tentativas por 10 minutos por IP (contagem em memória — vale o
  worker único do `gunicorn --threads 8`).
- A senha inicial foi entregue por mensagem e deve ser trocada em `/painel/senha`.
- O campo aceita a senha com espaços de ponta (ela é desbastada antes de conferir) e
  os três campos de senha têm `autocapitalize="none"`/`autocorrect="off"`, porque o
  teclado do celular costuma colocar maiúscula no primeiro caractere.

## Escrever na configuração

`/painel/config` grava direto na linha 1 de `greenapi_config` com
`atualizar_greenapi_config()`. É a mesma linha que o webhook `/webhook/config` e a
agenda das 6h leem, então o `.exe` antigo continua compatível: o último que salvar
manda.

- `idInstance` e `apiTokenInstance` aparecem travados. Só entram na gravação quando o
  formulário vem com `editar_instancia=1`, ou seja, depois de clicar em
  **Editar variáveis**. Assim um "Gravar" distraído não apaga a instância.
- O link do QR nunca é digitado: `_qr_link()` monta
  `https://qr.green-api.com/waInstance<idInstance>/<apiTokenInstance>` e o texto
  acompanha o que estiver nos campos, no Início e na Configuração.
- O `getStateInstance` (pill de estado) é chamado com timeout de 12 s e a resposta
  fica guardada por 3 minutos por instância, porque no plano free a chamada podia
  estourar os ~38 s e o Render devolvia `503` na abertura da tela.
  `?estado=1` força uma checagem nova.

- Sem foto guardada, `send_photo` é desligado sozinho na gravação.
- A foto é lida em base64 pelo fluxo de aviso; o `.exe` também sobe por aqui.
- Trocar `idInstance`/`apiTokenInstance` vale para o site inteiro, mas os hosts são
  corrigidos na gravação e o `qr_url` salvo é zerado para o link ser remontado — ver
  "Erro 403 do nginx".

## Avisos

- Botão de varrer chama `avisar_vencimentos()` — o mesmo caminho da agenda das 6h.
- Envio manual marca `vencimento_avisos` (`_registrar_aviso`), então a agenda não
  reenvia para quem já recebeu pelo painel.
- `{dias}` e `{pix}` são trocados por `legenda_aviso()`, que não quebra se o texto
  tiver outra chave entre chaves.

## Renovação de quem já venceu

A agenda das 6h (o mesmo `/webhook/vencimentos`) roda três coisas na ordem:
`avisar_vencimentos()` → `sincronizar_linhas()` → `avisar_renovacao()`.

- `avisar_renovacao()` pega as linhas **já vencidas** dentro de
  `renova_janela_dias` (padrão 30) e manda só texto, pelo `sendMessage` do GreenAPI,
  com o texto de `renova_legenda` (usa `{pix}`; o PIX é a mesma `aviso_pix_key`).
- O controle fica em `renovacao_avisos` (chave `username` + `exp_date`): a mesma
  pessoa só recebe de novo depois de `renova_dias` dias (padrão 3). O claim é um
  `INSERT ... ON CONFLICT DO UPDATE ... WHERE updated_at < corte RETURNING`, então
  duas execuções no mesmo dia não duplicam. Se o envio falhar, a linha volta atrás e
  tenta no dia seguinte.
- `reenviar=1` força, ignorando o intervalo.
- O botão **recuperar** da tela Acessos usa `recupera_legenda` (`{dias}` vira
  "há 1 mês e 4 dias" por `texto_vencido()`) e grava `via='painel'` na mesma tabela —
  por isso a agenda não reenvia logo em seguida. Sem telefone a tela avisa para
  digitar o número na caixinha da linha e não envia nada.

## Telefone do cliente

- Cada linha das telas **Acessos** e **Clientes** tem uma caixinha com o telefone e o
  botão **salvar**. A máscara (`(11) 98934-6164`) é só visual: o banco guarda apenas os
  dígitos, com o `55` do Brasil acrescentado por `normalize_whatsapp()` quando falta.
- `POST /painel/telefone` chama `salvar_telefone()`, que atualiza **todas** as linhas de
  `usuarios_criados_ip` daquele usuário (o mesmo nome pode existir em vários IPs), cria
  uma linha com `client_ip = 'painel'` se o cliente ainda não estava lá, atualiza o
  `telefone` do espelho `mc_linhas` e registra o evento `painel_telefone`.
- Número incompleto volta com "Telefone incompleto: digite o DDD e os 8 ou 9 numeros";
  são aceitos 10/11 dígitos (DDD + fixo/celular) ou 12/13 começando em 55.
- Quando a linha não tem número, a caixinha fica destacada em vermelho com o aviso
  "sem telefone" — é por ela que se cadastra antes de usar o recuperar.
- A tela **Clientes** tem "Telefone avulso" (usuário + número) para quem não aparece na
  lista do `/lines`, como as linhas de teste de 4 horas e os acessos antigos.
- **Mesclar** (botão ao lado de Buscar, na tela Acessos) transforma todas as linhas em
  checkboxes, sem filtro de status — os parados entram junto. Só aceita 2: o primeiro
  empresta, o segundo recebe. "Revisar e confirmar" abre um modal com usuário, nota,
  status, vencimento e telefone dos dois (e avisa se o segundo já tinha número);
  confirmar faz `POST /painel/mesclar` com `origem`, `destino` e `q`.
- `mesclar_telefones()` não apaga nada: lê o número da origem em
  `usuarios_criados_ip` e chama `salvar_telefone()` para o destino. Se a origem não tem
  número a tela responde "Quem vai emprestar o telefone está sem número"; escolher o
  mesmo usuário duas vezes dá "Escolha dois usuários diferentes".
- `salvar_telefone()` passou a fazer upsert em `mc_linhas`, então cadastrar o número de
  um usuário que ainda não está no espelho cria a linha só para guardar o telefone.
- `telefones_por_usuario()` passou a ler por `updated_at desc` mantendo o primeiro valor
  por usuário, então o cadastro mais recente é o que vale na tela e no envio.

## Espelho de clientes e CSV

- `mc_linhas` guarda `username, linha_id, telefone, exp_date, status, notes, synced_at`.
  Ela é escrita em três momentos: cada página da tela Acessos, o botão
  "Sincronizar agora do painel MC" e a agenda das 6h.
- `/painel/clientes` mostra o espelho e oferece `clientes.csv` com as colunas
  `Usuário;Telefone;Expira;Status;Nota` (ponto e vírgula + BOM, abre direto no Excel
  em português).
- A importação aceita `;`, `,` ou tab, ignora cabeçalho e linha vazia, e só mexe no
  telefone quando o CSV traz um número (o vazio mantém o que está no banco). Quando há
  telefone, o mesmo valor é gravado em `usuarios_criados_ip` com
  `client_ip = 'csv'`, que é de onde os envios leem número.
- Datas aceitas na importação: `dd/mm/aaaa HH:MM`, `dd/mm/aaaa` e ISO; são lidas como
  horário de Brasília e gravadas em UTC.

## Erro 466 do GreenAPI (cota do mês)

- Quando o aviso, a renovação ou o recuperar devolvem
  `invokeStatus: {method: sendmessage, used: N, total: 0, description: "Monthly quota has
  been exceeded"}` a falha é de cobrança no GreenAPI, não do site: o plano da instância
  ficou sem saldo de chamadas/mensagens no mês. O plano gratuito **Developer** só permite
  interagir com 3 conversas (e 1 instância); acima disso é preciso trocar o tariff no
  painel do GreenAPI ([docs](https://green-api.com/en/docs/api/466-error-example-body/)).
- `cota_esgotada()` detecta esse corpo. As rotas mostram a frase em português
  (`erro=cota`) em vez do JSON, e as varreduras (`avisar_vencimentos` e
  `avisar_renovacao`) **param o lote no primeiro 466** em vez de bater em todo mundo.
- Nada que falhou fica queimado: o claim de `vencimento_avisos` e o de
  `renovacao_avisos` é apagado na falha, então ao voltar o saldo é só rodar
  "Varrer agora" (ou esperar as 6h) que os mesmos clientes são avisados.
- A parte que não usa WhatsApp continua funcionando normalmente com o plano travado:
  cadastro de telefone, mesclar, espelho `mc_linhas`, CSV e senha gravam só no Supabase.

## Erro 403 do nginx (URL colada no campo errado)

Trocar de instância costuma vir com `https://NNNN.media.greenapi.com` colado nos dois
campos, porque o site do GreenAPI mostra os dois endereços parecidos. Aí o
`sendFileByUpload` vai para o host de mídia e o nginx devolve um HTML de `403 Forbidden`
em vez de JSON, que aparecia no painel como `{'raw': '<html>...'}`.

- Cada servidor tem **dois** hosts: `https://NNNN.api.greenapi.com` para chamar a API
  (mandar mensagem, postar arquivo, estado) e `https://NNNN.media.greenapi.com` só para
  baixar mídia que alguém enviou.
- `hosts_greenapi()` reconstrói o par a partir do número do servidor, não importa em que
  campo ele foi colado; se nenhum campo tiver URL reconhecível, o número é lido dos
  quatro primeiros dígitos do `idInstance`. `atualizar_greenapi_config()` chama isso
  antes de gravar, então clicar em **Gravar no banco agora** conserta os dois endereços e
  avisa na tela ("apiUrl corrigida para ...").
- `api_base_greenapi()` é a rede de proteção na hora de chamar: mesmo que uma linha
  antiga do banco ainda tenha o host de mídia em `api_url`, a chamada sobe para `.api`.
  `greenapi_send_file`, `greenapi_send_text`, `_estado_instancia` e `greenapi_get_settings`
  passam por ela.
- `host_errado_greenapi()` transforma o 403/404 em HTML na frase de ação correta, em vez
  de despejar o `<html>` cru no painel.
- O cartão **"O que o site vai usar de verdade"** na Configuração pergunta `getSettings`
  na própria instância e mostra: as duas URLs que o site vai montar, o `idInstance`,
  o estado, o número de WhatsApp realmente conectado (para comparar com
  `owner_phone`, que pode ter ficado da instância velha) e o `webhookUrl` que existe
  dentro do GreenAPI — se vier vazio, as mensagens *recebidas* não chegam no site, e isso
  só se arruma no console.green-api.com. O `getSettings` tem teto de 6 s e resposta
  guardada por 3 minutos (o mesmo `?estado=1` do link "verificar agora" força os dois);
  se a instância estiver acordando, o cartão mostra "não respondeu" em vez de travar a
  tela.

## Erro 400 "Validation failed" no sendMessage

O corpo que o painel mandava tinha `parseMode: "PLAIN"`. Nas instâncias mais novas o
GreenAPI não aceita esse campo e devolve, **antes** de olhar a cota:

```
{"statusCode":400,"path":"/waInstance.../sendMessage/...","message":"Validation failed. Details: 'parseMode' is not allowed"}
```

- `greenapi_send_text()` agora manda só `chatId` e `message` (prova: `200` com
  `idMessage` usando um número de teste que não existe no WhatsApp; nenhum cliente
  recebeu nada).
- O mesmo 400 com `'chatId': invalid phone number` significa número guardado errado — a
  tela agora diz para corrigir na caixinha da linha em vez de mostrar o JSON.
- `validacao_greenapi()` + o ramo em `falha_greenapi()` traduzem qualquer
  `Validation failed` em frase acionável, e o `message` do corpo passou a ser lido no
  texto genérico (antes só `description`, por isso a tela mostrava o dict cru).
- Mensagem vazia não é mais enviada: volta `skipped` e a agenda trata como "sem o que
  enviar", sem queimar chamada.
- Número com menos de 10 dígitos (linha antiga sem DDD) também não sai: os dois envios
  devolvem `telefone_invalido` antes de bater na API e a tela explica para corrigir na
  caixinha, em vez do 400 cru do GreenAPI.

### Onde mais a instância mora no banco

A identidade do GreenAPI está **só** na linha 1 de `greenapi_config` (`api_url`,
`media_url`, `id_instance`, `api_token`, `instance_name`, `owner_phone`, `qr_url`). Não
existe variável de ambiente `GREENAPI_*` nem outra tabela com token, então não há "outro
banco" para trocar. O que envelhece numa troca são `instance_name`, `owner_phone` e
`qr_url`, e a cota de mensagens é contada na **conta** do GreenAPI, não na instância:
trocar de instância não zera o contador (1944 → 1946 entre as duas).

## A foto que vai junto de cada recuperação

Aba **Recuperação** (`/painel/recuperacao`) — a única tela que decide o que o botão
`recuperar` manda. Não mexe na foto do fluxo "gerar" (`photo_base64`) nem nos avisos de
vencimento.

- Colunas novas em `greenapi_config`, criadas por `ensure_schema()`:
  `recupera_photo_base64`, `recupera_photo_name`, `recupera_send_photo`.
- `mc.greenapi_send_recuperacao(conf, telefone, texto)` escolhe o caminho sozinho: com a
  chave ligada **e** foto guardada, sobe o arquivo por `sendFileByUpload` com a legenda no
  `caption`; sem foto, ou com a chave desligada, cai no `sendMessage` de sempre. Por isso o
  clique nunca falha por falta de imagem.
- A foto é lida do banco no momento do envio — nada de URL pública no HTML. A prévia da aba
  vem de `/painel/recuperacao/foto`, rota protegida pelo mesmo `before_request` do painel,
  que devolve os bytes com `Cache-Control: no-store` (404 quando não há foto).
- Limite de 1,5 MB no upload (`LIMITE_FOTO`), o mesmo da foto do aviso. Marcar
  **Apagar a foto guardada** zera o base64, o nome e desliga a chave numa gravação só.
- Ligar a chave sem ter foto guardada grava o resto, desliga a chave e avisa
  (`erro=sem_foto_recupera`) — mesma regra do `send_photo` da Configuração.
- **Escolher o arquivo já liga o envio**: o upload força `recupera_send_photo = true` na
  mesma gravação. Antes, selecionar a foto e esquecer a caixinha salvava a foto com a chave
  desligada — e era exatamente isso que aparecia depois como "só texto".
- A chave ganhou botão próprio no cartão "Foto guardada hoje": um `POST` com `alternar=1`
  inverte `recupera_send_photo` a partir do que está no banco e escreve **só** esse campo
  (não apaga a foto nem mexe na legenda). Se não houver foto, o botão devolve
  `erro=sem_foto_recupera` sem gravar nada.
- Quando existe foto e a chave está desligada, a aba abre com um alerta vermelho dizendo que
  o último clique saiu só texto e apontando o botão.
- O redirect do clique ganhou `&foto=`, com três estados — `1` (saiu com a imagem),
  `desligada` (foto no banco, chave off) e `sem_foto` (nenhuma foto guardada) — e o quadro de
  Acessos escreve o motivo em vermelho em vez de uma frase ambígua, então dá para ver o que
  saiu sem precisar abrir o WhatsApp.
- `mcapi_events` (`recuperar_envio`) agora registra `com_foto` no `request_payload`, e o
  `save_event` da gravação guarda só os **nomes** dos campos: o base64 nunca vai para o log.
- A rota `/painel/config` continua sem tocar nessas três colunas (a prova no smoke confere);
  o que ela ainda escreve é a `recupera_legenda`, que agora também aparece editável na aba
  nova — use a aba, que é onde está a prévia.

## Os dias da mensagem de recuperação

`recuperar` montava a frase com a data achada em dois lugares e, quando a data da linha
passava longe, o cliente lia "há 2 dias" em uma linha vencida há 14 meses:

- A data usada é sempre a **mesma da coluna Faltam** do quadro: `_listar_linhas()` monta
  `exp_iso` (UTC, `datetime.isoformat()`) e o formulário devolve esse valor. É o que o
  `parse_exp_date(exp_iso)` usa primeiro, com `fonte_data = "linha"`.
- Sò se `exp_iso` vier vazio ou inválido é que o painel usa o espelho
  (`_expira_do_espelho`), e agora essa consulta exige `linha_id <> ''` e
  `synced_at > now() - interval '2 days'`: linha criada pela importação de CSV ou pela
  caixinha de telefone não tem `linha_id` e pode carregar data velha, que era justamente
  o que aparecia na mensagem.
- Sem nenhuma data, `horas = 0` vira "há menos de 24 horas" e o `fonte_data` da hora é
  `"nenhuma data encontrada"` em vez de uma data falsa.
- O resultado do clique mostra a frase exata que saiu: o redirect leva
  `?ok=recuperado&q=<usuario>&dias=há 14 meses&data=linha` e o quadro imprime
  "texto enviado: 'há 14 meses' (data tirada da linha do MC)".
- `mcapi_events` (`recuperar_envio`) agora guarda `dias`, `fonte_data` e `exp_iso`, então
  dá para auditar depois qual data alimentou cada mensagem.
- `texto_vencido()` não tem teto: 420 dias viram "há 14 meses" (o `divmod(dias, 30)` só
  omite os dias quando a sobra é zero, e é isso que se quer para um mês cheio).

## Lote "Não recuperados": recuperar todo mundo de uma vez

Botão **Não recuperados** — está nas duas telas, **Acessos** e **Clientes**, e é o mesmo
código: `templates/_lote_recuperados.html` (barra + modal + JavaScript), incluído nas duas.
Abre a coluna **pular**: a caixinha aparece só nas linhas vencidas e marcar significa **não
mandar** para aquele cliente. O envio vai para todos os vencidos, menos os marcados.

- A tela **Clientes** ganhou também o botão **recuperar** por linha, ao lado da Nota. É a
  mesma rota `/painel/recuperar` com `destino=clientes`: manda a mensagem e a foto da aba
  Recuperação, grava o claim com `via="painel"` e volta para a tela Clientes com o mesmo
  cartaz de "texto enviado / com foto" que a tela Acessos mostra (o `data=espelho` do
  cartaz vem da data do espelho, porque foi de lá que a linha saiu).
- **As duas telas usam a mesma fonte: o painel MC ao vivo.** Na tela Clientes a tabela é o
  espelho do Supabase, que é backup e nunca apaga linha, então o lote ignora quem não existe
  mais no MC e mostra quantos são (`só no espelho, sem linha no MC`) com os primeiros nomes no
  modal — para esses o único caminho é o botão recuperar da própria linha. O número fica em
  zero quando a varredura do MC quebrou no meio, porque aí a lista de vistos não é confiável.

- **A lista nunca sai da tela.** `painel_web._vencidos_do_mc()` varre o painel MC página por
  página (`quantityPerPage=200`, até `LOTE_PAGINAS`), então quem está na página 7 é enviado
  mesmo que ele nunca tenha aberto a página 7. Se o MC devolver menos linhas do que foi
  pedido (corte do servidor), o tamanho real da primeira página passa a ser a referência de
  "página cheia" — assim uma página cortada não encerra a varredura cedo. Para no fim quando
  o `count` do MC bate com o que já foi visto, e devolve `aviso` se uma página falhar no meio.
- **Sem filtro = todas as páginas; com filtro, só o que bate no filtro.** A busca ativa (`q`)
  é respeitada na varredura, e o modal avisa em qual dos dois casos ele está.
- Duas rotas JSON, separadas de propósito: `POST /painel/recuperar_todos/contagem` (aceita
  `pular` repetido ou `pular=a,b` na query string) monta o plano, guarda em memória e devolve
  `vencidos / marcados / alvos / sem_telefone / pulados / esperando / foto / aviso / primeiros`;
  `POST /painel/recuperar_todos` com `confirmar=sim` executa **exatamente** o plano conferido.
- O plano é congelado na conferência e **morre no fim do envio** (`revisado=False`,
  `plano=None`) e também depois de `LOTE_VALIDAR` (15 min). Um segundo clique em enviar
  responde "A conferência venceu" em vez de repetir mensagens — é a defesa contra o
  disparo duplo, que é o erro caro desse recurso.
- `esperando` é a janela `LOTE_JANELA` (3 h) lida de `renovacao_avisos`: cliente que acabou de
  receber fica de fora sozinho, então o lote pode ser clicado duas vezes no mesmo dia sem
  spammar ninguém. `sem_telefone` nunca entra na lista (não há para onde mandar).
- O envio roda em `threading.Thread` daemon (`_lote_rodar`) com estado em `LOTE`, porque o
  gunicorn do Render corta em 120 s: o navegador faz `GET /painel/recuperar_todos/status` a
  cada 1,5 s e mostra a barra de progresso. Fechar a aba não cancela — o servidor continua.
- Para a mesma mensagem e as mesmas regras do botão linha a linha:
  `mc.greenapi_send_recuperacao()` (foto da aba Recuperação quando a chave está ligada),
  `mc.legenda_recuperar()` e o claim `_registrar_renovacao(..., via="lote")`, que é o que
  alimenta a janela de 3 h e impede a agenda das 6 h de repetir.
- Duas paradas de segurança: cota do GreenAPI (`mc.cota_esgotada`) encerra na hora com o
  motivo no modal, e `LOTE_PARADA_ERROS` (3 falhas seguidas) derruba o lote — se o problema é
  sistêmico, não adianta queimar os outros duzentos números. `POST /painel/recuperar_todos/parar`
  é o botão **Parar de enviar**: a próxima iteração do laço vê `LOTE["parou"]` e sai.
- Um único `mcapi_events` por lote (`event_type="recuperar_lote"`) com alvos, enviados,
  falhas, sem telefone, esperando e o motivo do fim; os erros individuais aparecem no modal
  (até 5) sem virar poluição no banco.
- As marcações de "pular" ficam no `localStorage` do celular (`peixeiro_lote_pular`), então
  ele pode marcar um cliente na página 1, outro na página 4, e os dois continuam fora. O
  contador da barra fixa separa "marcado nesta página" de "marcado em outra página". A chave é
  a mesma nas duas telas: o que ele marca em Clientes vale na Acessos, e ao contrário.
- O smoke (`_smoke_painel.py`) finge 250 linhas em várias páginas, inclusive com o MC
  devolvendo só 100 por página, e confere que os alvos batem com a conta esperada, que os
  marcados/sem telefone/recentes **não** recebem, que a página quebrada gera `aviso` e desliga
  a contagem do espelho, que as linhas só-no-espelho ficam fora, que repetir o envio não manda
  nada de novo e que cota/erros seguidos/parar derrubam o lote. As duas telas são conferidas
  uma por uma: o botão, a coluna e o modal existem na Acessos **e** na Clientes, e o clique em recuperar
  na Clientes volta para `/painel/clientes` com `data=espelho`.

## O 500 que vinha depois de enviar

Depois de o GreenAPI aceitar a mensagem, o painel grava o claim em
`renovacao_avisos`, cuja coluna `response` é `jsonb`. O código passava
`str(corpo)[:400]`, ou seja, o **repr do Python** (`{'idMessage': 'ABC', ...}` com aspas
simples), que não é JSON. O Postgres rejeitava com `invalid input syntax for type json`
e a requisição morria em 500 depois de a mensagem já ter saído — o cliente recebia o PIX
e o claim nunca era gravado, então a agenda das 6h podia repetir. Agora é
`json.dumps(corpo, default=str)`, e a prova no smoke lê o parâmetro gravado com
`json.loads`. O caminho da agenda nunca teve o problema (usa o adaptador `Json` do
psycopg2), e o `exp_date` que ela grava — `expira_em.isoformat()`, UTC — é o mesmo formato
que o painel escreve, então as duas rotas dividem o claim `(username, exp_date)` e não
disparam o PIX duas vezes para o mesmo cliente.

## Apagar acesso

`apagar/<id>` manda `DELETE https://mcapi.knewcms.com:2087/lines/<id>` com o bearer
compartilhado e grava `mcapi_events` (`painel_online_delete`). Precisa marcar a
caixa de confirmação. Antes de apagar, a tela mostra dono, expiração e se a linha está
parada: o `generalSearch` do MC não acha pelo id, então `_linha_por_id()` varre as
páginas de `/lines` até bater o número.

Testado com um id inexistente: o MC respondeu `500 Internal server error`, ou seja,
o token foi aceito para DELETE (não houve `401`/`403`). A exclusão de uma linha real
depende do dono escolher qual linha morre — por isso o botão exige a caixa marcada e
fica em `/painel/apagar/<id>`. Se algum dia vier `401`/`403`, o código tenta de novo
com a variável `MC_PANEL_KEY` (chave `wz_...`) — basta criar essa env var no Render.

## Lote "Deletar": apagar uma faixa inteira de usuários

Aba `/painel/deletar` para o caso "apague do `r566001` até o `r566100`".

- Ele escreve **prefixo** (`r`), **de** e **até**. O intervalo conta as duas pontas:
  566001→566100 são **100** nomes. `_numero_do_nome()` tira o prefixo e o número do
  usuário do MC, então `r0566050` (zero na frente) também cai dentro do intervalo.
- **Nada é apagado antes do modal.** O botão chama `/painel/deletar/contagem`, que varre
  **todas** as páginas do MC (`_varrer_mc`, a mesma varrida do lote) e devolve `qtd`,
  `no_mc`, `vencidos`, `ativos`, `faltando` (números do intervalo que não existem),
  `mc_total` e a lista completa com id, telefone formatado, nota e quem ainda está ativo.
- O modal congela o plano (`APAGAR["plano"]`, `APAGAR_VALIDAR` = 10 min). Se qualquer
  contagem depois falhar (número trocado, intervalo acima do limite, MC sem resposta),
  o plano é **invalidado** na hora — não dá para confirmar uma lista antiga.
- Dentro do modal: `marcar para manter` por linha e a caixa "apagar também quem ainda
  está ativo". Os dois só **diminuem** a lista congelada (`_apagar_filtrada`); o botão
  libera quando a pessoa escreveu exatamente a palavra **`deletar`**
  (sem maiúscula/espaço de ponta) e sobrou alguém.
- O servidor confere a palavra de novo (`MSG_ERRO["sem_palavra"]`) antes de ligar a
  thread `_apagar_rodar`, que faz um `DELETE /lines/<id>` por vez e grava
  `mcapi_events` (`painel_online_batch_delete`, `via: "lote"`) linha por linha.
- Paradas de segurança: 3 respostas ruins seguidas, ou qualquer `401`/`403` (aí o motivo
  diz que a chave foi recusada), param o resto. O botão **Parar de apagar** só impede as
  que ainda não saíram — o que já foi apagado não volta.
- A caixa "tirar também do espelho" apaga a linha de `public.mc_linhas` **depois** do
  `2xx` do MC. Desligada (padrão), o telefone/nota ficam guardados e a linha vira
  "só no espelho": o lote "Não recuperados" nunca manda mensagem nelas.
- Limite por lote: `APAGAR_MAX` = 300 nomes (o MC também é lido no máximo por
  `LOTE_PAGINAS` × `LOTE_POR_PAGINA`).
- `/painel/deletar/executar` e `/painel/deletar/status` são JSON e caem no
  `_exige_login()`; um lote de exclusão não roda junto de um lote de envio.
- O smoke cobre: os quatro erros de validação, contagem 100/87/70/17/13 batendo com o
  universo falso, apagar sem a palavra / com a palavra errada / sem conferir (0 chamadas),
  os 70 vencidos apagados com os 17 ativos intactos, `espelho=1` limpando as 70 linhas do
  `mc_linhas`, `manter` poupando os marcados, `ativos=1` apagando o intervalo todo, a
  segunda rodada negada, o Parar antes de qualquer DELETE, 500×3 e 403 parando, e o aviso
  `painel_inteiro` quando o intervalo pega todas as linhas do MC.

## Deploy

Push na `main` → Render faz deploy sozinho. O serviço free fica parado quando não
tem tráfego: a primeira chamada pode demorar ~90s e devolver `503` com corpo vazio.
