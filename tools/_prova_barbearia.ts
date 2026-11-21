// Prova do robô das barbearias, no banco da cópia e em modo de teste: nenhuma mensagem sai
// de verdade, o que se prova aqui é o entendimento das frases, a gravação nas tabelas certas
// e — o ponto que segura o ecossistema inteiro — o fato de as duas bases nunca se cruzarem.
//
//   cd 2peer/supabase/functions/peixeiro
//   PEIXEIRO_MODO_TESTE=1 npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_barbearia.ts
//
// Sem o PEIXEIRO_MODO_TESTE=1 a prova se recusa a rodar: os números de barbearia dela são de
// teste, mas o envio real ia bater no WhatsApp de alguém.
import {
  adicionarBarbeiro,
  apagarBarbeiro,
  contaDeTelefone,
  catalogo,
  clientesDoBarbeiro,
  obterTextos,
  enviarParaBarbeiro,
  lerQuando,
  lembretesDoDia,
  listarBarbeiros,
  responder,
  rotearWebhook,
} from "../supabase/functions/peixeiro/barbearia.ts";
import { obterConfig } from "../supabase/functions/peixeiro/banco.ts";
import { consultar } from "../supabase/functions/peixeiro/db.ts";
import { modoTeste } from "../supabase/functions/peixeiro/mcapi.ts";
import { tokenChat } from "../supabase/functions/peixeiro/chat.ts";
import { semAcento } from "../supabase/functions/peixeiro/texto.ts";

if (!modoTeste()) {
  console.log("PEIXEIRO_MODO_TESTE desligado — a prova não roda, porque ela manda mensagem.");
  Deno.exit(1);
}

let falhas = 0;
function checar(rotulo: string, verdadeiro: unknown, detalhe = "") {
  if (!verdadeiro) falhas++;
  console.log(`${verdadeiro ? "OK  " : "FAIL"} ${rotulo}${detalhe ? "  → " + String(detalhe).slice(0, 120) : ""}`);
}

// 09:00 de Brasília de uma sexta-feira conhecida: é com esta régua que as datas são cobradas.
const AGORA = new Date("2026-11-20T12:00:00Z");
const BARBERIA = "5511900000031";
const OUTRA = "5511900000032";
const CLIENTE = "11999998888";
const NAO_BARBERIA = "5511900000033";

const conf = await obterConfig();
if (!conf) {
  console.log("sem greenapi_config no banco da cópia");
  Deno.exit(1);
}
const textos = await obterTextos();
const chave = await tokenChat();

const limpar = async () => {
  for (const telefone of [BARBERIA, OUTRA, NAO_BARBERIA]) {
    await apagarBarbeiro(telefone);
    await consultar(`delete from public.chat_mensagens where telefone = $1`, [telefone]);
    await consultar(`delete from public.chat_treino where telefone = $1`, [telefone]);
  }
};
await limpar();

// ----------------------------------------------------------------- 1) dia e hora

const umDia = (d: Date) => Math.round(d.getTime() / 86_400_000);
const esperado = (iso: string) => new Date(iso).getTime();

const q1 = lerQuando("João amanhã 14h", AGORA);
checar("amanhã 14h vira sábado 21/11 às 14:00 de Brasília",
  q1.instant?.getTime() === esperado("2026-11-21T17:00:00Z"), q1.rotulo);
checar("a sobra de amanhã 14h é só o nome", semAcento(q1.sobra.toLowerCase()) === "joao", q1.sobra);

const q2 = lerQuando("terça 9h30", AGORA);
checar("terça 9h30 cai na terça seguinte, 09:30",
  q2.instant?.getTime() === esperado("2026-11-24T12:30:00Z"), q2.rotulo);

const q3 = lerQuando("quarta 9e20", AGORA);
checar("quarta 9e20 (o jeito que ele digita) é 09:20",
  q3.instant?.getTime() === esperado("2026-11-25T12:20:00Z"), q3.rotulo);

const q4 = lerQuando("15h", AGORA);
checar("só a hora vale para hoje, quando ainda não passou",
  q4.instant?.getTime() === esperado("2026-11-20T18:00:00Z"), q4.rotulo);

const q5 = lerQuando("8h", AGORA);
checar("uma hora que já passou hoje cai em amanhã, e o rótulo diz amanhã",
  q5.instant?.getTime() === esperado("2026-11-21T11:00:00Z") && /amanh/.test(q5.rotulo), q5.rotulo);

const q8 = lerQuando("22h", AGORA);
checar("22h de uma sexta às 9h da manhã continua sendo hoje",
  q8.instant?.getTime() === esperado("2026-11-21T01:00:00Z") && /hoje/.test(q8.rotulo), q8.rotulo);

const q6 = lerQuando("sábado", AGORA);
checar("dia sem hora pergunta a hora, em vez de marcar de qualquer jeito",
  q6.instant === null && q6.faltando === "hora", q6.faltando);

const q7 = lerQuando("25/12 20:00", AGORA);
checar("data escrita por extenso funciona",
  q7.instant?.getTime() === esperado("2026-12-25T23:00:00Z"), q7.rotulo);

// ------------------------------------------------------------- 2) a conta e o teste

const criada = await adicionarBarbeiro(BARBERIA, "Barbearia do Prova", "teste automatizado");
checar("telefone e nome bastam para criar a barbearia", criada.ok && Boolean(criada.conta));
const ficha = await contaDeTelefone(BARBERIA);
checar("o teste de um dia começa agora, no instante do cadastro",
  !!ficha?.expira && umDia(new Date(ficha.expira.getTime() - AGORA.getTime() * 0)) === umDia(new Date(Date.now() + 86_400_000)),
  ficha?.expira ? ficha.expira.toISOString() : "sem expira");
checar("a barra de telefone aceita máscara", (await adicionarBarbeiro("(11) 90000-0032", "Barbearia Outra")).ok);

const lista = await listarBarbeiros(1, "Prova");
checar("a busca por nome acha a barbearia", (lista.linhas as Record<string, unknown>[]).some((l) => l.telefone === BARBERIA),
  JSON.stringify(lista.info));
const porNumero = await listarBarbeiros(1, "11 90000-0031");
checar("a busca por número acha com ponto, traço ou sem o 55",
  porNumero.info.encontrados === 1, JSON.stringify(porNumero.info));

// ------------------------------------------------------------------ 3) o dinheiro

const r = async (frase: string, conta = BARBERIA) =>
  responder((await contaDeTelefone(conta))!, frase, textos, conf, AGORA);

const precocorte = await r("PRECO SERVICO corte 30,00");
checar("PRECO SERVICO cadastra o serviço com o nome certo", /Salvei/.test(precocorte.texto), precocorte.texto);
await r("PRECO SERVICO barba 20");
await r("PRECO PRODUTO pomada 25,50");
const cat = await catalogo(BARBERIA);
checar("o catálogo guarda serviço e produto separados",
  cat.servicos.length === 2 && cat.produtos.length === 1, JSON.stringify(cat));

const catalogoTexto = await r("CATALOGO");
checar("CATALOGO mostra os dois com o preço dele", /corte/.test(catalogoTexto.texto) && /pomada/.test(catalogoTexto.texto));

const confirma = await r("NOVO corte 30,00");
checar("NOVO sem confirmação não grava nada", confirma.tipo === "confirma", confirma.texto);
checar("nada foi lançado antes do SIM",
  Number((await consultar(`select count(*)::int as n from public.barber_lancamento where telefone = $1`, [BARBERIA])).rows[0].n) === 0);
const gravado = await r("SIM");
checar("depois do SIM o lançamento entra, com o resumo do mês junto",
  gravado.tipo === "gravado" && /Gravado/.test(gravado.texto) && /30,00/.test(gravado.texto), gravado.texto);

const semValor = await r("NOVO café");
checar("NOVO sem valor pergunta quanto foi", /Quanto foi\?/.test(semValor.texto), semValor.texto);
const comNumero = await r("8,00");
checar("o número solto responde a pergunta e pede confirmação", comNumero.tipo === "confirma" && /café/.test(comNumero.texto));
await r("SIM");

const despesa = await r("SAIDA energia 220");
checar("SAIDA lança como despesa depois do SIM", despesa.tipo === "confirma");
await r("SIM");
const resumo = await r("RESUMO MES");
checar("RESUMO soma as entradas e as saídas do mês", /38,00/.test(resumo.texto) && /220,00/.test(resumo.texto), resumo.texto);

const nao = await r("NOVO teste fantasma 1.000,00");
checar("NÃO descarta o lançamento", /Deixei para lá/.test((await r("NAO")).texto), nao.tipo);
checar("o que foi descartado não aparece no banco",
  Number((await consultar(`select count(*)::int as n from public.barber_lancamento where telefone = $1 and descricao like '%fantasma%'`, [BARBERIA])).rows[0].n) === 0);

// ------------------------------------------------------------- 4) pacotes e agenda

const pacote = await r("PACOTE 10 cortes 250,00");
checar("PACOTE entende a quantidade e acha o serviço pelo nome", /Salvei o pacote/.test(pacote.texto), pacote.texto);

const agenda1 = await r(`AGENDA João ${CLIENTE} sábado 15h corte`);
checar("AGENDA com nome, telefone, dia e serviço pede confirmação", agenda1.tipo === "confirma");
checar("o nome sai com as letras que ele digitou, não em minúsculo", /Cliente: João/.test(agenda1.texto), agenda1.texto);
checar("o telefone do cliente é lido com o 55 na frente", /\(11\) 99999-8888/.test(agenda1.texto), agenda1.texto);
checar("o serviço cadastrado aparece na confirmação, com o preço dele", /corte/.test(agenda1.texto) && /30,00/.test(agenda1.texto), agenda1.texto);
const criado = await r("SIM");
const numero = Number(/horário (\d+)/.exec(criado.texto)?.[1] || 0);
checar("SIM grava o horário e devolve o número curto", numero > 0, criado.texto);

const agenda2 = await r("AGENDA Maria terça 9h30");
checar("o dia da semana sozinho também marca", agenda2.tipo === "confirma" && /terça/.test(agenda2.texto), agenda2.texto);
await r("SIM");

const feito = await r(`FEITO ${numero}`);
checar("FEITO lança o serviço pelo preço do catálogo", /Serviço feito e lançado/.test(feito.texto) && /R\$ 30,00/.test(feito.texto), feito.texto);

const aviso = await r(`AVISA ${numero}`);
checar("AVISA manda o recado ao cliente pelo número dele", /Avisado/.test(aviso.texto), aviso.texto);
const noCelularDoCliente = await consultar(
  `select texto from public.barber_mensagens where telefone = $1 and direcao = 'saida' order by id desc limit 1`,
  ["55" + CLIENTE],
);
checar("o aviso ao cliente fica guardado na conversa dele", /corte|horário|não vou poder|aviso/i.test(String(noCelularDoCliente.rows[0]?.texto || "")),
  String(noCelularDoCliente.rows[0]?.texto || "").slice(0, 80));

const remarcar = await r(`REMARCAR ${numero} sexta 10h`);
checar("REMARCAR pede confirmação antes de mexer no horário", remarcar.tipo === "confirma", remarcar.texto);
await r("SIM");
const listaAgenda = await r("AGENDA SEMANA");
checar("a lista dos próximos dias mostra o horário remarcado, com o nome e o serviço",
  /27\/11/.test(listaAgenda.texto) && /João/.test(listaAgenda.texto) && /corte/.test(listaAgenda.texto), listaAgenda.texto);

const semEntender = await r("asdkjhasd ççç");
checar("o que ele não entende vira fila de treino", semEntender.tipo === "sem_regra");
checar("a frase sem regra foi guardada para ele treinar depois",
  Number((await consultar(`select count(*)::int as n from public.barber_treino where telefone = $1`, [BARBERIA])).rows[0].n) > 0);

// -------------------------------------------------------- 5) os clientes da agenda

const clientes = await clientesDoBarbeiro(BARBERIA, 50);
checar("os clientes do barbeiro saem da própria agenda dele",
  clientes.some((c) => c.nome === "João"), JSON.stringify(clientes.slice(0, 2)));

// ------------------------------------------------------- 6) as variáveis conhecidas

const comVariaveis = await enviarParaBarbeiro(BARBERIA, "Oi {primeiro}, vence {vence} ({dias}), status {status}.");
checar("{primeiro}, {vence}, {dias} e {status} valem também na barbearia",
  /Barbearia|vence|dias|ativo/.test(comVariaveis.texto) && !/\{/.test(comVariaveis.texto), comVariaveis.texto);
checar("o envio da tela é simulado enquanto o modo de teste estiver ligado", comVariaveis.simulado === true);

// --------------------------------------------------------- 7) o lembrete das 8 horas

// 08:30 de terça, 24/11: a terça é o dia do horário da Maria, criado lá em cima.
const manhaDoDia = new Date("2026-11-24T11:30:00Z");
const primeiro = await lembretesDoDia(false, manhaDoDia);
checar("o lembrete do dia sai para quem tem horário hoje", Number(primeiro.enviados) >= 1, JSON.stringify(primeiro));
const segundo = await lembretesDoDia(false, manhaDoDia);
checar("a segunda chamada do mesmo dia não repete mensagem nenhuma",
  Number(segundo.enviados) === 0, JSON.stringify(segundo));
const forcado = await lembretesDoDia(true, manhaDoDia);
checar("o botão do painel pode forçar de novo, quando ele pedir", Number(forcado.enviados) >= 1, JSON.stringify(forcado));

// --------------------------------------------------- 8) a porta única das duas bases

const webhookBarbearia = await rotearWebhook(
  { chatId: `${BARBERIA}@c.us`, body: "MENU", idMessage: `prova-menu-${Date.now()}`, messageType: "text" }, chave);
checar("quem é barbearia conversa com o robô das barbearias",
  String((webhookBarbearia.dados as Record<string, unknown>).barbearia || "") === BARBERIA, JSON.stringify(webhookBarbearia.dados));
checar("a resposta é simulada em modo de teste",
  (webhookBarbearia.dados as Record<string, unknown>).simulado === true);

const webhookFora = await rotearWebhook(
  { chatId: `${NAO_BARBERIA}@c.us`, body: "oi", idMessage: `prova-fora-${Date.now()}`, messageType: "text" }, chave);
checar("quem não é barbearia cai no robô de sempre, sem chave nenhuma de barbearia na resposta",
  !("barbearia" in (webhookFora.dados as Record<string, unknown>)), JSON.stringify(webhookFora.dados));

const cruzadas = await consultar(
  `select (select count(*) from public.chat_mensagens where telefone = $1)::int as no_chat,
          (select count(*) from public.barber_mensagens where telefone = $2)::int as na_barbearia`,
  [BARBERIA, NAO_BARBERIA],
);
checar("a conversa da barbearia não entra na tabela do Peixeiro", Number(cruzadas.rows[0].no_chat) === 0, JSON.stringify(cruzadas.rows[0]));
checar("a conversa do Peixeiro não entra na tabela da barbearia", Number(cruzadas.rows[0].na_barbearia) === 0);

const espelho = await consultar(`select count(*)::int as n from public.mc_linhas where telefone like '551190000003%'`);
checar("nenhum número de teste entrou no espelho do painel MC", Number(espelho.rows[0].n) === 0);

await limpar();
const sobrou = await consultar(
  `select (select count(*) from public.barber_contas where telefone like '55119000000%')::int as contas,
          (select count(*) from public.barber_lancamento where telefone like '55119000000%')::int as lancamentos,
          (select count(*) from public.barber_agendamento where telefone like '55119000000%')::int as agenda`,
);
checar("a prova não deixou rastro no banco", JSON.stringify(sobrou.rows[0]) === '{"contas":0,"lancamentos":0,"agenda":0}', JSON.stringify(sobrou.rows[0]));

console.log(falhas ? `\n${falhas} prova(s) falharam` : "\ntudo certo");
Deno.exit(falhas ? 1 : 0);
