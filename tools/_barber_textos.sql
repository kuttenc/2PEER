-- Os textos do robô das barbearias. É aqui que mora o que ele diz; a lógica fica em
-- barbearia.ts e só lê estas linhas. Rodar de novo não amassa o que ele editou na tela:
-- cada UPDATE abaixo só toca na coluna que ainda está em branco.
--
-- {primeiro} é a variável que o painel já usa em toda mensagem. O menu fala com o barbeiro,
-- e o aviso_cliente fala com o cliente dele — por isso os dois têm nomes diferentes.
update public.barber_config set menu = $menu$✂️ Controle da sua barbearia

NOVO corte 30,00 — lançar um serviço que você fez
SAIDA aluguel 800,00 — lançar uma despesa do salão
PRECO SERVICO corte 30,00 — cadastrar ou atualizar um serviço
PRECO PRODUTO pomada 25,00 — cadastrar ou atualizar um produto
CATALOGO — ver seus serviços e produtos
PACOTES — ver seus pacotes
RESUMO — entradas, saídas e saldo do mês
PDF SEMANA / PDF MES — gerar o relatório
AJUDA — mostrar este menu de novo

AGENDA — marcar horário de cliente
Escreva na mesma mensagem: cliente, telefone, nome, dia e hora.
  AGENDA 11999998888 João sábado 15h
Ele também entende do jeito que se fala:
  AGENDA João amanhã 14h
  AGENDA Maria terça 9h30
  AGENDA José quarta 9e20
A gente confirma antes de salvar. No dia, de manhã, chega a lista da sua agenda.
Se você não puder atender, responde com o número que aparece na lista:
  AVISA 2 — o bot avisa o cliente por você
  REMARCAR 2 sexta 16h — remarca e avisa o cliente
  FEITO 2 — lança o corte como entrada na sua contabilidade
  CANCELAR 2 — cancela o horário

O catálogo é particular da sua barbearia e começa vazio. Nada é gravado sem o seu OK.$menu$
where id = 1 and coalesce(menu, '') = '';

update public.barber_config set abordagem = $ab$✂️ Fala {primeiro}, tudo certo?

Pergunta rápida: você sabe quanto entrou de corte, quanto entrou de produto e quanto você gastou essa semana?

A maioria das barbearia não tem sistema nenhum. A conta é de cabeça, no caderno, ou no fim do mês "acho que deu".

Eu monto um assistente no seu WhatsApp que faz isso por você. Ele funciona igual você falando com um funcionário:

"corte 30,00"
"gel 15,00"
"energia 220"
"resumo do mês"

Ele confirma cada lançamento antes de salvar. Nada é automático às escondidas. O catálogo é seu e particular, começa vazio e ninguém mais enxerga.

✂️ Controle da sua barbearia

NOVO — registrar um serviço prestado
SAIDA — registrar uma despesa
PRECO SERVICO corte 30,00 — cadastrar/atualizar um serviço
PRECO PRODUTO pomada 25,00 — cadastrar/atualizar um produto
CATALOGO — consultar seus serviços e produtos
PACOTES — consultar pacotes cadastrados
RESUMO — entradas, saídas e saldo do mês
PDF SEMANA / PDF MES — gerar relatório
AJUDA — mostrar este menu novamente

Sem app pra baixar, sem cadastro, sem tela de gerente. Você usa no WhatsApp que já está no seu bolso o dia inteiro.

Responde CONTROLE que eu ativo o seu número agora e você testa na sua própria conversa, sem pagar nada.$ab$
where id = 1 and coalesce(abordagem, '') = '';

update public.barber_config set boas_vindas = $bv$✂️ Bem-vindo, {primeiro}! Seu teste já está valendo.

Você tem {dias} de teste e não precisa cadastrar cartão: {vence}.
Gostou? No dia seguinte você fecha e o número continua sendo o seu sistema.

Escreva MENU quando quiser ver o que ele entende. Comece assim:
  PRECO SERVICO corte 30,00
  NOVO corte 30,00
  AGENDA João amanhã 15h
  RESUMO$bv$
where id = 1 and coalesce(boas_vindas, '') = '';

update public.barber_config set lembrete = $lb$✂️ {primeiro}, sua agenda de {data}:

{agenda}

Se algum desses você não puder atender, responda com o número da linha:
  AVISA 1 — o bot avisa o cliente por você
  REMARCAR 1 sexta 16h — remarca e avisa o cliente
  FEITO 1 — entra como serviço feito no seu resumo$lb$
where id = 1 and coalesce(lembrete, '') = '';

update public.barber_config set aviso_cliente = $ac$Olá {nome_cliente}, aqui é do {barbearia}.

Passando para falar do seu horário de {servico}: {situacao}.
{novo}$ac$
where id = 1 and coalesce(aviso_cliente, '') = '';

update public.barber_config set msg_interesse = $mi$Boa, {primeiro}! Anotei aqui.

Em instantes alguém ativa o seu número e te manda o menu com o passo a passo. Enquanto isso, se quiser adiantar, me diz só o nome da sua barbearia.$mi$
where id = 1 and coalesce(msg_interesse, '') = '';

update public.barber_config set msg_vencido = $mv$⚠️ {primeiro}, seu teste venceu {dias}.

Seus lançamentos, seu catálogo e seus horários continuam todos guardados — nada foi apagado. Fechando, o número volta a responder igual, com o histórico inteiro.$mv$
where id = 1 and coalesce(msg_vencido, '') = '';
