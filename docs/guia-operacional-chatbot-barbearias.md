# Guia operacional — chatbot de barbearias e painel

Este guia registra os fluxos encontrados no código do 2PEER e os resultados recentes. Use o
código e as migrations deste checkout como fonte final: notas antigas podem descrever mudanças
que ficaram locais ou foram feitas em outro checkout.

## 1. Escopo e arquitetura

- O robô de barbearias usa tabelas `barber_*`, separadas das tabelas do Peixeiro e dos outros
  produtos. A chave da conta da barbearia é o telefone cadastrado do responsável.
- A página pública é HTML estático publicado no GitHub Pages em
  `https://kuttenc.github.io/estabelecimentos/<slug>/`. A Edge Function monta a página e a
  publica; as rotas `estab_*` servem disponibilidade, agendamento e cancelamento.
- O painel principal tem as áreas **Chat Barbearias** e **Clientes Barbearia**. O painel privado
  de cada estabelecimento é outro recurso, protegido por uma chave longa na URL.
- Não compartilhar nem colocar em documentação links privados de painel, tokens, telefones
  completos, valores de `.env` ou chaves de provedor. Não misturar o projeto Supabase 2PEER com
  O Peixeiro, salões independentes ou o projeto de backup.

Arquivos principais:

- `supabase/functions/peixeiro/barbearia.ts`: conversas, comandos, agenda, pagamentos e mensagens.
- `supabase/functions/peixeiro/estabelecimento.ts`: página pública, painel privado e agenda web.
- `supabase/functions/peixeiro/acoes.ts` e `index.ts`: ações administrativas e roteamento.
- `painel/app.js`: interface do painel principal.
- `tools/`: migrations e esquemas SQL; aplicar migrations somente no projeto correto.

## 2. Cadastro e configuração da página

Contatos desconhecidos recebem uma triagem:

1. Quero cadastrar um estabelecimento.
2. Trabalho em um estabelecimento e quero pedir acesso.
3. Sou cliente e quero consultar ou mudar meu horário.
4. Quero conhecer o menu de controle.

Pedidos de acesso de funcionários ficam para conferência; não concedem permissão automaticamente.
Clientes só consultam ou alteram horários vinculados ao mesmo número do WhatsApp.

O barbeiro pode digitar `SITE`, `/menu pagina` ou `EDITAR` para receber o endereço e os comandos
da página. Exemplos de configuração:

- `EDITAR NOME ...`
- `EDITAR ENDERECO ...`
- `EDITAR HORARIO segunda 10 as 19, domingo fechado`
- `ALMOCO segunda a sexta 12 as 13`
- `EDITAR AGENDAMENTO SIM` ou `EDITAR AGENDAMENTO NÃO`
- `EDITAR PAGAMENTO dinheiro, pix, cartão`
- `EDITAR TELEFONE ...`
- `FUNCIONARIO Nome DDD...`
- `FOTO`, `FOTO DO Nome` ou `SEM FOTOS`
- `BARBEIRO SIM`

Endereço, fotos, produtos e profissionais são complementos. Para a página ser considerada pronta
para agendamento, o sistema exige: nome, contato público (ou telefone da conta), agendamento
online habilitado, pelo menos um serviço ativo, um horário de abertura e fechamento válido e uma
forma de pagamento.

### Orientação automática para WhatsApp Business

Depois que a página completa for publicada com sucesso, o sistema envia ao WhatsApp cadastrado do
responsável uma única mensagem com o link **público** e estas instruções:

1. Abrir o WhatsApp Business.
2. Acessar **Ferramentas comerciais** (ou **Ferramentas**).
3. Abrir **Perfil comercial**.
4. Tocar em **Site**.
5. Colar o link público enviado pelo robô.
6. Salvar.

O envio é marcado somente quando o provedor aceita uma mensagem real; simulação não conta como
entrega. Uma tentativa em andamento pode ser retomada após 15 minutos. Falha de envio é informada
no resultado do salvamento/publicação e pode ser tentada novamente ao salvar ou publicar a página.
O link privado do painel nunca deve ser usado como link do perfil.

## 3. Menus e comandos do barbeiro

- `/menu` ou `AJUDA`: menu geral.
- `/menu contabilidade`: lançamentos, preços e relatórios.
- `/menu pagina` ou `/menu site`: comandos da página.
- `/menu agenda`: agenda e ações sobre agendamentos.
- `/menu funcionario`: agenda de quem trabalha no estabelecimento.

Contabilidade e catálogo:

- `NOVO corte 30,00` ou `SAIDA energia 220`: registrar entrada/saída; quando falta o valor,
  o bot pergunta; antes de gravar, pede `SIM` ou `NÃO`.
- `PRECO SERVICO corte 30,00` e `PRECO PRODUTO pomada 25,00`: cadastrar ou atualizar preço.
- `CATALOGO` e `PACOTES`: consultar itens cadastrados.
- `RESUMO`, `SALDO`, `QUANTO ...`, `PDF SEMANA` e `PDF MES`: relatórios.

O preço digitado pelo WhatsApp é associado pelo nome do item. No código deste checkout, a
atualização no banco usa conflito por nome em minúsculas; o reconhecimento de serviços em frases
aceita variações simples de plural, mas não cobre toda grafia parecida. Exemplo importante:
`Selagem` pode não corresponder ao item cadastrado como `Selage` e criar um segundo registro.
Nesses casos, conferir `CATALOGO` e editar o item existente pelo painel, que usa o ID real.
Não usar correspondência aproximada ampla sem garantir que serviços diferentes não sejam
confundidos.

## 4. Agenda e acompanhamento pós-serviço

Comandos do barbeiro:

- `AGENDA` ou `PROXIMOS`: próximos horários.
- `AGENDA hoje`, `LISTA` ou `VER AGENDAMENTOS`: horários de hoje.
- `AGENDA semana` ou `VER AGENDAMENTOS SEMANAL`: próximos sete dias.
- `AGENDA Nome DDD... sábado 15h`: criar horário.
- `AVISA 1`, `REMARCAR 1 sexta 16h`, `FEITO 1` e `CANCELAR 1`: agir sobre o número exibido na
  lista.
- Funcionários podem usar `MINHA AGENDA`, `LIVRE amanhã` e `AGENDAR Nome DDD... sábado 15h`.

O cliente agenda pela página pública, que valida novamente a disponibilidade no servidor. O
cancelamento online confirma o número, data e horário com um código de uso único enviado ao número
já vinculado; não revela se há ou não um agendamento antes da confirmação.

### Retorno de pagamento

Após o horário final previsto do serviço (início + duração cadastrada) e mais 40 minutos, o cron
pergunta ao responsável se o cliente pagou com PIX, cartão ou não compareceu. O barbeiro responde
`PIX`, `CARTÃO` ou `NÃO VEIO`; a resposta é gravada no agendamento e aparece nas listas. Há no
máximo uma pergunta sem resposta por estabelecimento, para que respostas curtas não sejam
associadas ao atendimento errado. Agendamentos anteriores à ativação não entram na fila.

A busca roda a cada cinco minutos. A migration de feedback, o deploy da Edge Function e o job
cron constam como publicados/aplicados no status técnico. O retorno não lança receita
automaticamente na contabilidade.

### Lembrete diário

O cron das 8h de Brasília também envia a agenda do dia ao responsável, mas não envia mensagem se
não há agendamentos elegíveis. O job precisa continuar diário, pois também processa os lembretes.
O código deste checkout deduplica o bom-dia por estabelecimento e dia. Um pedido anterior para
limitar o bom-dia a uma vez a cada sete dias não está implementado no código aqui; não afirmar
que essa frequência semanal está ativa.

Para evitar excesso de mensagens, os lembretes recorrentes de bom-dia e agenda são pausados
quando a Green API confirmar entregas em dois dias consecutivos sem uma nova mensagem do
responsável. Uma mensagem recebida do responsável reinicia o ciclo. Essa pausa não bloqueia
respostas ao responsável, envios manuais do administrador, nem avisos transacionais de novos
agendamentos/cancelamentos ou a pergunta individual de pagamento pós-serviço. A regra depende do
webhook de status da Green API; um `200` de envio, sozinho, não conta como confirmação de entrega.

## 5. Painel administrativo e catálogo

**Clientes Barbearia** permite consultar estabelecimentos, interessados e solicitações e abrir
detalhes de cadastro, catálogo, lançamentos, agenda, clientes, conversas, funcionários, horários,
formas de pagamento e fotos. Abrir a tela não envia mensagens. Boas-vindas e mensagens manuais
exigem ação explícita; exclusão de conta exige confirmação digitada.

Na aba **Bloquear**, o administrador pode pesquisar a lista de bloqueios e registrar um telefone,
nome opcional e motivo. O bloqueio usa `clientes_bloqueados`: o webhook não responde a esse número
e os envios de texto/arquivo passam pela mesma checagem central antes de chamar a GreenAPI. A ação
exige confirmação na tela; desbloquear restaura o recebimento de respostas e mensagens automáticas.

Os detalhes também mostram a agenda futura e o link público para copiar. Quando não houver
agendamento, a área deve orientar o cliente a marcar pelo link público. Não confundir o link da
página com o acesso privado do barbeiro.

O painel privado salva serviços/produtos por ID e valida que o item pertença à conta; não deve
exibir sucesso quando o banco não atualizou o registro. Criar, editar ou excluir um serviço ou
produto envia uma confirmação ao WhatsApp do barbeiro com o item e os dados da operação. Se a
alteração já foi salva mas o provedor não aceitou o aviso, a resposta informa `salvo: true` junto
do erro de envio. Alterações de perfil, expediente e pagamento não usam essa notificação de
catálogo.

O editor de expediente precisa manter separados dias fechados, abertura/fechamento e intervalo
de almoço. Antes de assumir que uma função de aplicar o mesmo horário a vários dias está
publicada, verificar a interface e a action no branch atual.

## 6. Estado recente e cuidados de publicação

Conforme o status técnico do checkout:

- A correção de salvamento de preços do painel foi publicada; os preços do Jailton foram
  conferidos na action autenticada e na página pública.
- A confirmação automática de mudanças no catálogo também consta como publicada. A separação
  entre `nome` do serviço e `nome` público da conta evita renomear o estabelecimento ao editar
  um item.
- Em 22/11/2026, foi perguntado individualmente a 30 barbeiros ativos, incluindo Jailton, se
  vendem produtos (por exemplo, gel, pomada ou shampoo) e querem incluí-los na página. O provedor
  aceitou os 30 envios. Nenhum produto foi cadastrado antes da confirmação e do preço.
- O comando de agenda e o retorno pós-serviço, incluindo o cron de cinco minutos, constam como
  publicados. Não foi enviada mensagem de teste desse retorno.
- O bom-dia de 8h está descrito como diário; a alteração para sete dias precisa ser conferida.
- Os requisitos da Vision Barber 00 (preço por dia/feriado, promoção com pré-pagamento e marcação
  de assinatura) aparecem no histórico da conversa, mas não há helper ou migration Vision neste
  checkout. Tratar como pendente até localizar e validar a implementação correta; não anunciar
  nem publicar esses preços por suposição.
- O envio único das instruções do WhatsApp Business foi publicado em 22/11/2026. A migration
  `tools/20261122_barber_site_whatsapp_instrucoes.sql` foi aplicada no projeto
  `ggufcvrwctieacvbbwim`, e a Edge Function `peixeiro` está na versão 34. `healthz` e `ping`
  responderam com sucesso; nenhum WhatsApp real foi enviado durante a validação.
- A pausa dos lembretes recorrentes após entregas em dois dias consecutivos foi publicada em
  22/11/2026. A migration `tools/20261122_barber_reminder_delivery_pause.sql` foi aplicada no
  projeto `ggufcvrwctieacvbbwim`, e a Edge Function `peixeiro` está na versão 37. O webhook de
  status estava recebendo eventos recentes; `healthz` respondeu com sucesso. Nenhuma mensagem
  real foi enviada durante a validação.
- A aba antiga **Bloqueados** está sendo ampliada para **Bloquear**, com cadastro manual e
  pesquisa da lista. O envio GreenAPI de texto e arquivo também passa a consultar o bloqueio
  global antes de enviar. A aba foi publicada pelo commit `95d3637`; a Edge Function `peixeiro`
  está na versão 35 do projeto `ggufcvrwctieacvbbwim`. O telefone solicitado foi confirmado como
  cadastro da Barbearia Zamonelli e está na lista global de bloqueio; a leitura de verificação
  confirmou a linha. Nenhuma mensagem de teste foi enviada.

Antes de qualquer deploy:

1. Confirmar o branch e os arquivos alterados; há mudanças locais antigas e não relacionadas.
2. Revisar a migration e aplicá-la somente no Supabase do 2PEER.
3. Publicar apenas a Edge Function revisada, sem incluir alterações não relacionadas.
4. Validar o painel/página pública e consultar os logs sem registrar segredos ou telefones
   completos.
5. Fazer testes automatizados antes de qualquer mensagem real; não enviar mensagem de teste sem
   autorização específica.

Validação local recomendada:

```powershell
node --test --test-reporter=dot
git diff --check
```
