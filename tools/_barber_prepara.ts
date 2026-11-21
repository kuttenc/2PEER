// Põe o esquema e os textos das barbearias no banco da cópia, que é onde o robô pode ser
// provado sem mandar WhatsApp nenhum.
//
//   cd 2peer/supabase/functions/peixeiro
//   PEIXEIRO_MODO_TESTE=1 npx --yes deno run -A --env-file=../../../.env ../../../tools/_barber_prepara.ts
//
// Os arquivos são os mesmos que subiram na produção, só que com o `set role` de fora: aqui
// quem conecta é o usuário do painel, e as tabelas já nascem dele. O texto vai inteiro em uma
// chamada só, porque as frases têm ponto e vírgula dentro e não se pode dividir às cegas.
import { consultar } from "../supabase/functions/peixeiro/db.ts";

async function arquivo(nome: string): Promise<string> {
  const bruto = await Deno.readTextFile(new URL(`./${nome}`, import.meta.url));
  return bruto
    .split(/\r?\n/)
    .filter((linha) => !/^\s*(set|reset) role\b/i.test(linha))
    .join("\n");
}

// Os arquivos podem ser trocados na linha de comando: sem argumento, são os três de sempre.
const PADRAO = ["_barber_schema.sql", "_barber_textos.sql", "_barber_estabelecimento.sql"];
for (const nome of (Deno.args.length ? Deno.args : PADRAO)) {
  try {
    await consultar(await arquivo(nome));
    console.log(`aplicado: ${nome}`);
  } catch (exc) {
    console.log(`FALHOU ${nome}: ${String(exc instanceof Error ? exc.message : exc).slice(0, 300)}`);
    Deno.exit(1);
  }
}

const tabelas = await consultar(
  `select table_name from information_schema.tables
    where table_schema = 'public' and table_name like 'barber_%' order by table_name`,
);
console.log(`${tabelas.rows.length} tabelas barber_ na cópia`);

const textos = await consultar(
  `select ativo, trial_dias, lembrete_hora, length(menu) as menu, length(abordagem) as abordagem,
          length(boas_vindas) as boas_vindas, length(lembrete) as lembrete,
          length(aviso_cliente) as aviso_cliente, length(msg_interesse) as msg_interesse
     from public.barber_config where id = 1`,
);
console.log(`config: ${JSON.stringify(textos.rows[0] || {})}`);
Deno.exit(0);
