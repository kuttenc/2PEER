// Prova da lista colada com CPF (aba Clientes). Roda na cópia, com o banco do .env:
//
//   npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_pix.ts
//
// A parte que escreve acontece dentro de begin/rollback: nada fica no banco. Nenhum WhatsApp
// sai daqui — o import só grava linha, e nada nesta bateria chama envio.
import { parsearPix, gravarPix } from "../supabase/functions/peixeiro/pix.ts";
import { consultar } from "../supabase/functions/peixeiro/db.ts";

const COLADA = [
  "Nome\tDados\tExpira\tStatus\tTelefone\tUsuário",
  "Aderlane monteiro da Silva\tdados+82071527291\t15/10/26\t23:00\t5596992048213\tr70000000007",
  "Adriano Thadeu B B de Melo\tdados+00955986427\t15/10/26\t23:00\t5584991938911\tr70000000008",
  "Adriano Vicente de lima\tdados+38357031889\t15/10/26\t23:00\t5519996076465\tr70000000009",
].join("\r\n");

const QUEBRADA = [
  "Maria da Silva\tdados+12345678901\t15/10/26\t23:00\t5511999000111\tzzprova1",
  "Sem usuário aqui\tdados+12345678901\t15/10/26\t23:00\t5511999000222\t",
  "Sem CPF\tdados+\t15/10/26\t23:00\t5511999000333\tzzprova3",
  "Telefone errado\tdados+12345678901\t15/10/26\t23:00\t551199\tzzprova4",
  "Data errada\tdados+12345678901\t32/13/26\t23:00\t5511999000555\tzzprova5",
  "Faltam colunas\tdados+12345678901\t15/10/26",
  "José Carlos\tdados+99887766554\t05/12/2026 14:30\tnormal\t(11) 99900-0666\tzzprova7",
].join("\n");

let falhas = 0;
function checar(rotulo: string, verdadeiro: unknown, detalhe = "") {
  if (!verdadeiro) falhas++;
  console.log(`${verdadeiro ? "OK  " : "FAIL"} ${rotulo}${detalhe ? "  → " + detalhe : ""}`);
}

const boa = parsearPix(COLADA);
checar("as três linhas boas entram e nenhuma vira erro",
  boa.erros.length === 0 && boa.linhas.length === 3,
  `${boa.linhas.length} linhas, ${boa.erros.length} erros`);
checar("o cabeçalho não virou cliente", boa.linhas[0]?.usuario === "r70000000007",
  String(boa.linhas[0]?.usuario));
checar("o CPF sai do dados+",
  boa.linhas.map((l) => l.cpf).join(",") === "82071527291,00955986427,38357031889",
  boa.linhas.map((l) => l.cpf).join(","));
checar("o CPF com zeros na frente não encolhe", boa.linhas[1]?.cpf === "00955986427",
  String(boa.linhas[1]?.cpf));
checar("o telefone vai para a lista de envios intacto", boa.linhas[0]?.telefone === "5596992048213",
  String(boa.linhas[0]?.telefone));
checar("15/10/26 é 2026 e vale o dia 15 em Brasília",
  boa.linhas[0]?.expira?.toISOString() === "2026-10-14T21:00:00.000Z",
  String(boa.linhas[0]?.expira));

const semCabecalho = parsearPix(COLADA.split("\r\n").slice(1).join("\r\n"));
checar("colar sem a linha de cabeçalho dá o mesmo resultado",
  semCabecalho.linhas.length === 3 && semCabecalho.erros.length === 0,
  `${semCabecalho.linhas.length} linhas`);

const ruim = parsearPix(QUEBRADA);
checar("só as duas linhas inteiras entram", ruim.linhas.length === 2,
  `${ruim.linhas.length} entraram: ${ruim.linhas.map((l) => l.usuario).join(",")}`);
checar("as cinco quebradas voltam no modal", ruim.erros.length === 5, `${ruim.erros.length} erros`);
checar("o número da linha é o da lista colada", ruim.erros.map((e) => e.linha).join(",") === "2,3,4,5,6",
  ruim.erros.map((e) => e.linha).join(","));
checar("cada erro diz o motivo",
  ["sem usuário", "sem CPF", "telefone inválido", "data inválida", "faltam colunas"].every(
    (m, i) => (ruim.erros[i]?.motivo || "").includes(m)),
  ruim.erros.map((e) => e.motivo).join(" | "));
checar("o texto da linha volta para você achar na tabela",
  (ruim.erros[0]?.texto || "").includes("Sem usuário aqui"), ruim.erros[0]?.texto);
checar("linha com menos colunas dá erro, não cliente pela metade",
  parsearPix("fulano\tdados+12345678901").erros.length === 1, "");
checar("a data com hora e o telefone mascarado são aceitos",
  ruim.linhas[1]?.telefone === "5511999000666" &&
  ruim.linhas[1]?.expira?.toISOString() === "2026-12-05T11:30:00.000Z",
  `${ruim.linhas[1]?.telefone} ${ruim.linhas[1]?.expira?.toISOString()}`);

// ---------------------------------------------------------------- o que escreve
const nomes = ["zzprova1", "zzprova7"];
// O padrão é casado de propósito (zzprova/zzmass): um usuário real que comece com "zz" não sai
// apagado por aqui.
const DE_PROVA = "^zz(prova|mass)";
async function limpaZZ() {
  for (const [tabela, coluna] of [["cliente_pix", "usuario"], ["mc_linhas", "username"],
    ["usuarios_criados_ip", "username"]] as [string, string][]) {
    await consultar(`delete from public.${tabela} where ${coluna} ~ $1`, [DE_PROVA]);
  }
}
await limpaZZ();
await consultar("begin");
try {
  // zzprova1 entra como ativo: o Status colado (23:00) é uma hora, não pode virar parado.
  await consultar(
    `insert into public.mc_linhas (username, status) values ('zzprova1', 1)
     on conflict (username) do update set status = 1`,
  );
  const repetida = parsearPix(QUEBRADA + "\nzz duplicado\tdados+11122233344\t15/10/26\t23:00\t5511999000999\tzzprova1");
  const gravados = await gravarPix(repetida.linhas);
  checar("as linhas boas entram e o usuário repetido conta uma vez", gravados === 2, String(gravados));

  const espelho = await consultar(
    `select username, telefone, to_char(exp_date at time zone 'UTC','YYYY-MM-DD HH24:MI') as expira, status
       from public.mc_linhas where username = any($1::text[]) order by username`, [nomes]);
  checar("o mc_linhas recebeu telefone e expiração", espelho.rowCount === 2 &&
    espelho.rows[0]?.expira === "2026-10-14 21:00", JSON.stringify(espelho.rows));
  checar("o usuário colado duas vezes fica com a última linha",
    espelho.rows[0]?.telefone === "5511999000999", String(espelho.rows[0]?.telefone));
  checar("o Status colado não mexeu no ativo/parado",
    Number(espelho.rows[0]?.status) === 1, JSON.stringify(espelho.rows.map((l) => l.status)));

  const cpf = await consultar(
    `select usuario, cpf, nome from public.cliente_pix where usuario = any($1::text[]) order by usuario`,
    [nomes]);
  checar("o CPF ficou na tabela dele, com o nome", cpf.rowCount === 2 &&
    cpf.rows[1]?.cpf === "99887766554" && cpf.rows[1]?.nome === "José Carlos",
    JSON.stringify(cpf.rows));

  const telefones = await consultar(
    `select username, telefone from public.usuarios_criados_ip
      where username = any($1::text[]) and telefone <> ''`, [nomes]);
  checar("o telefone também foi para a lista de envios", telefones.rowCount === 2,
    JSON.stringify(telefones.rows));

  // Uma lista do tamanho da dele precisa caber no prazo do botão: é por isso que a gravação
  // vai em blocos de 200 em vez de um round-trip por linha.
  const massa: string[] = [];
  for (let i = 0; i < 912; i++) {
    massa.push(`Cliente ${i}\tdados+1234567890${i % 10}\t15/10/26\t23:00\t5511999${10000 + i}\tzzmass${i}`);
  }
  const t0 = Date.now();
  const muitas = await gravarPix(parsearPix(massa.join("\n")).linhas);
  const seg = (Date.now() - t0) / 1000;
  checar("912 linhas coladas entram em uma chamada só", muitas === 912,
    `${muitas} em ${seg.toFixed(1)}s`);
} finally {
  await consultar("rollback");
  await limpaZZ();
}

const depois = await consultar(
  `select (select count(*) from public.cliente_pix where usuario ~ $1)::int as cpf,
          (select count(*) from public.mc_linhas where username ~ $1)::int as espelho,
          (select count(*) from public.usuarios_criados_ip where username ~ $1)::int as envios`,
  [DE_PROVA]);
const sobra = depois.rows[0] || {};
checar("a bateria não deixou rastro nenhum no banco",
  sobra.cpf === 0 && sobra.espelho === 0 && sobra.envios === 0, JSON.stringify(sobra));

console.log(falhas ? `\n${falhas} prova(s) falharam` : "\ntodas as provas passaram");
Deno.exit(falhas ? 1 : 0);
