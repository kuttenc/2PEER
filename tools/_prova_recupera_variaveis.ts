// Prova da aba Recuperação com as variáveis da aba Chat.
//
//   npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_recupera_variaveis.ts
//
// Só lê o banco da cópia. Nenhum WhatsApp sai daqui: nem enviarRecuperacao, nem o botão
// recuperar, nem o lote — quem aperta isso é ele, na tela.
import { consultar } from "../supabase/functions/peixeiro/db.ts";
import { dadosDoCliente } from "../supabase/functions/peixeiro/banco.ts";
import { legendaRecuperar, normalizarWhatsapp, preencherVariaveis, variaveisMensagem } from "../supabase/functions/peixeiro/texto.ts";
import { clientePorTelefone, renderizar, variaveis } from "../supabase/functions/peixeiro/chat.ts";

let falhas = 0;
function checar(rotulo: string, verdadeiro: unknown, detalhe = "") {
  if (!verdadeiro) falhas++;
  console.log(`${verdadeiro ? "OK  " : "FAIL"} ${rotulo}${detalhe ? "  → " + detalhe : ""}`);
}

const conf = { aviso_pix_key: "12.345.678/0001-99" };
const agora = new Date("2026-11-17T15:00:00-03:00");
const dias = (n: number) => new Date(agora.getTime() + n * 86_400_000);

const vencido = {
  usuario: "r7000000007", nome: "Maria da Silva", telefone: "11999998888",
  status: 0, expira: dias(-34),
};
const noPrazo = { ...vencido, status: 1, expira: dias(15) };
const semData = { ...vencido, expira: null };

// ---------------------------------------------------------------- os nomes
const v = variaveisMensagem(conf, vencido, { link: "https://x/r/abc" }, agora);
const esperadas = ["nome", "usuario", "telefone", "vence", "expira", "expirou", "dias", "status",
  "pix", "site", "data", "hora", "link"];
checar("a Recuperação conhece exatamente os nomes da aba Chat",
  esperadas.every((k) => k in v) && Object.keys(v).filter((k) => !esperadas.includes(k)).length === 0,
  Object.keys(v).join(" "));

checar("{nome} sai do nome cadastrado", v.nome === "Maria da Silva", v.nome);
checar("{telefone} sai mascarado", v.telefone === "(11) 99999-8888", v.telefone);
checar("{status} vira palavra, não número", v.status === "parado", v.status);
checar("{pix} vem da Configuração", v.pix === "12.345.678/0001-99", v.pix);
checar("{data} e {hora} são o agora em Brasília", v.data === "17/11/2026" && /^\d{2}:\d{2}$/.test(v.hora),
  `${v.data} ${v.hora}`);
checar("{site} é o endereço do painel", /^https:\/\//.test(v.site), v.site);
checar("{dias} continua igual ao que a tela Acessos mostra", v.dias === "há 1 mês e 4 dias", v.dias);

// ---------------------------------------------------------------- as três de vencimento
checar("{vence} troca o verbo para quem venceu", v.vence === `venceu em ${v.expira}`, v.vence);
checar("{expira} é só a data gravada", /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(v.expira), v.expira);
checar("{expirou} diz há quanto tempo", v.expirou === "há 1 mês e 4 dias", v.expirou);
const d = variaveisMensagem(conf, noPrazo, {}, agora);
checar("para quem está no prazo {vence} usa o futuro", /^vence em \d{2}\/\d{2}\/\d{4}/.test(d.vence), d.vence);
checar("para quem está no prazo {expirou} avisa que não venceu", /^ainda não venceu \(em /.test(d.expirou), d.expirou);
checar("para quem está no prazo {status} diz ativo", d.status === "ativo", d.status);
const s = variaveisMensagem(conf, semData, {}, agora);
checar("sem data de vencimento não inventa prazo",
  s.vence === "não está no nosso sistema" && s.expira === "não está no nosso sistema" &&
    s.expirou === "não está no nosso sistema" && s.dias === "sem data de vencimento",
  `${s.vence} | ${s.dias}`);
checar("sem situação diz sem cadastro",
  variaveisMensagem(conf, { ...vencido, status: null }, {}, agora).status === "sem cadastro");
checar("{nome} sem nome cadastrado cai no usuário e depois em amigo(a)",
  variaveisMensagem(conf, { ...vencido, nome: "" }, {}, agora).nome === "r7000000007" &&
    variaveisMensagem(conf, {}, {}, agora).nome === "amigo(a)");
checar("sem chave PIX cadastrada não sai mensagem muda",
  variaveisMensagem({}, vencido, {}, agora).pix.includes("não cadastrada"),
  variaveisMensagem({}, vencido, {}, agora).pix);

// ---------------------------------------------------------------- as duas grafias
const modelo = "Oi {nome}, {vence}. Seu número é {telefone} e o link é {link}.";
const duplo = "Oi {{nome}}, {{vence}}. Seu número é {{telefone}} e o link é {{link}}.";
const cheio = variaveisMensagem(conf, vencido, { link: "L" }, agora);
checar("com uma chave e com duas dá no mesmo texto",
  preencherVariaveis(modelo, cheio) ===
    "Oi Maria da Silva, venceu em " + cheio.expira +
    ". Seu número é (11) 99999-8888 e o link é L.",
  preencherVariaveis(modelo, cheio));
checar("a grafia da aba Chat funciona na Recuperação",
  preencherVariaveis(duplo, cheio) === preencherVariaveis(modelo, cheio));
checar("chave com espaço dentro da dupla grafia também vale",
  preencherVariaveis("{{ nome }}", cheio) === "Maria da Silva");
checar("maiúscula e minúscula não fazem diferença",
  preencherVariaveis("{NOME} {Data}", cheio) === "Maria da Silva " + cheio.data);
checar("o que não é variável fica escrito, para ele ver o erro",
  preencherVariaveis("Oi {banana}, {nome}", cheio) === "Oi {banana}, Maria da Silva");
checar("{{banana}} com as duas chaves também fica escrito",
  preencherVariaveis("Oi {{banana}}", cheio) === "Oi {{banana}}");
checar("o renderizar da aba Chat não muda de comportamento",
  renderizar("{{nome}} {nome}", cheio) === "Maria da Silva {nome}",
  renderizar("{{nome}} {nome}", cheio));

// ---------------------------------------------------------------- a mensagem salva
const padrão = legendaRecuperar({}, vencido, "https://x/r/abc", agora);
checar("a legenda padrão continua sem sobra de chave",
  !/\{[a-z_]+\}/i.test(padrão) && padrão.includes("há 1 mês e 4 dias") &&
    padrão.includes("https://x/r/abc"), padrão.replace(/\n/g, " ⏎ "));
checar("uma legenda toda nova usa tudo",
  legendaRecuperar({ recupera_legenda: "{nome} · {usuario} · {status} · {data} {hora} · {site}",
    aviso_pix_key: "" }, noPrazo, "", agora) ===
    `Maria da Silva · r7000000007 · ativo · ${d.data} ${d.hora} · ${d.site}`);

// ---------------------------------------------------------------- a ficha real (só leitura)
const com = (sql: string, params: unknown[] = []) =>
  consultar(sql, params).then((r) => r.rows as Record<string, string>[]);
const doPix = (await com(`select p.usuario as username, p.nome
  from public.cliente_pix p join public.mc_linhas m on m.username = p.usuario
  where coalesce(nullif(trim(p.nome),''),'') <> '' and coalesce(nullif(trim(m.notes),''),'') = ''
    and coalesce(nullif(m.telefone,''),'') <> ''
  limit 1`))[0];
if (doPix) {
  const f = await dadosDoCliente(doPix.username);
  checar("o {nome} de quem só tem nome no PIX sai de lá",
    f.nome === doPix.nome && f.telefone !== "", JSON.stringify(f));
} else checar("áchado nome só no cliente_pix", false, "nenhum na base da cópia");

const soNota = (await com(`select username, notes from public.mc_linhas
  where coalesce(nullif(trim(notes),''),'') <> '' limit 1`))[0];
if (soNota) {
  const f = await dadosDoCliente(soNota.username);
  const esperado = (await com(`select coalesce(nullif(trim(p.nome),''), nullif(trim(m.notes),''), '') as n
    from public.mc_linhas m left join public.cliente_pix p on p.usuario = m.username
    where m.username = $1`, [soNota.username]))[0].n;
  checar("quem tem nome no PIX tem prioridade sobre a nota do MC", f.nome === esperado,
    `${f.nome} | nota: ${soNota.notes}`);
} else checar("achado alguém com nota no MC", false, "nenhum na base da cópia");

const soAgenda = (await com(`select u.username, u.telefone from public.usuarios_criados_ip u
  where coalesce(u.telefone,'') <> '' and not exists (select 1 from public.mc_linhas m where m.username = u.username)
  limit 1`))[0];
if (soAgenda) {
  const f = await dadosDoCliente(soAgenda.username);
  checar("quem não está no MC ainda sai com telefone da agenda",
    f.telefone === soAgenda.telefone && f.status === null && f.expira === null, JSON.stringify(f));
} else console.log("     (sem caso de telefone só na agenda na cópia hoje)");

const fantasma = await dadosDoCliente("zzninguemnabase999");
checar("usuário inexistente devolve ficha vazia sem quebrar",
  fantasma.usuario === "zzninguemnabase999" && !fantasma.nome && !fantasma.telefone &&
    fantasma.expira === null && fantasma.status === null, JSON.stringify(fantasma));
const vazio = await dadosDoCliente("   ");
checar("usuário em branco tem a mesma forma e não consulta o banco",
  JSON.stringify({ ...vazio, usuario: fantasma.usuario }) === JSON.stringify(fantasma),
  JSON.stringify(vazio));

const tempo = Date.now();
await dadosDoCliente(doPix ? doPix.username : "r7000000007");
checar("a ficha não atrasa o envio de cada linha", Date.now() - tempo < 1500, `${Date.now() - tempo}ms`);

// ---------------------------------------------------------------- as duas abas dizem o mesmo
const comTelefone = (await com(`select m.telefone, m.username from public.mc_linhas m
  join public.cliente_pix p on p.usuario = m.username
  where coalesce(nullif(trim(p.nome),''),'') <> '' and coalesce(nullif(m.telefone,''),'') <> ''
  limit 1`))[0];
if (comTelefone) {
  const cliente = await clientePorTelefone(normalizarWhatsapp(comTelefone.telefone));
  const doChat = variaveis(cliente, conf as never, comTelefone.telefone);
  const daRecuperacao = variaveisMensagem(conf, await dadosDoCliente(comTelefone.username), {}, new Date());
  const nomes = ["nome", "usuario", "telefone", "status", "pix", "site"];
  checar("a aba Chat e a Recuperação usam os mesmos nomes e os mesmos valores",
    Boolean(cliente) && nomes.every((k) => doChat[k] === daRecuperacao[k]),
    nomes.map((k) => `${k}: ${doChat[k]} | ${daRecuperacao[k]}`).join(" · "));
  const vencimento = ["vence", "expira", "expirou", "dias"];
  checar("as quatro de vencimento batem nas duas abas",
    vencimento.every((k) => doChat[k] === daRecuperacao[k]),
    vencimento.map((k) => `${k}: ${doChat[k]}`).join(" · "));
  checar("o {nome} do chat sai do cadastro e não do usuário",
    Boolean(cliente) && cliente!.nota !== cliente!.usuario && doChat.nome === cliente!.nota,
    `${doChat.nome} (${cliente ? cliente.usuario : "-"})`);
} else checar("achado um cliente com nome e telefone na cópia", false, "nenhum");

console.log(`\n${falhas ? falhas + " FALHA(S)" : "todas as provas passaram"}`);
Deno.exit(falhas ? 1 : 0);
