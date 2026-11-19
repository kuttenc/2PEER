// Prova ao vivo do projeto NOVO sem precisar da senha do painel (que é sua, não minha).
// O que ela conclui: o build deployado é este, as rotas novas estão registradas, e a função
// lê o banco NOVO (não a cópia) — isso é mostrado com um destino troque-troque numa linha
// de teste da própria tabela migrada, revertida no fim. Nenhuma action que envia mensagem
// ou apaga linha é chamada.
const fs = require("fs");

const env = fs.readFileSync(".env", "utf8");
const pega = (k) => { const m = env.match(new RegExp(k + "=([^\\r\\n]*)")); return m ? m[1].trim() : ""; };

const REF = "ggufcvrwctieacvbbwim";
const TOKEN = pega("SUPABASE_TOKEN_NOVO");
const NOVO = `https://${REF}.supabase.co/functions/v1/peixeiro`;
const COPIA = "https://bzgtptbwcvwpgnhbctjn.supabase.co/functions/v1/peixeiro";

let falhas = 0;
const chamadas = [];

function prova(nome, ok, detalhe) {
  console.log((ok ? "OK   " : "FALHA ") + nome + (detalhe ? `  → ${detalhe}` : ""));
  if (!ok) falhas++;
}

async function chamar(url, acao, dados) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: acao, ...(dados || {}) }),
  });
  const texto = await r.text();
  chamadas.push(acao);
  let corpo;
  try { corpo = JSON.parse(texto); } catch (e) { corpo = { bruto: texto.slice(0, 160) }; }
  return { status: r.status, corpo, ms: Date.now() - t0, bytes: texto.length };
}

/** Literal SQL seguro para o valor virar texto no banco sem quebrar a aspa. */
const lit = (v) => `'${String(v == null ? "" : v).replace(/'/g, "''")}'`;

async function sql(ref, consulta) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: consulta }),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { erro: t.slice(0, 200) }; }
}

(async () => {
  const p = await chamar(NOVO, "ping", {});
  prova("a função do projeto novo está no ar", p.status === 200 && p.corpo.ok === true, `${p.status} · ${JSON.stringify(p.corpo)} · ${p.ms} ms (fria)`);
  prova("modo teste desligado, igual à cópia", p.corpo.modo_teste === false, `modo_teste=${p.corpo.modo_teste}`);

  const x = await chamar(NOVO, "rota_que_eu_nao_escrevi_zz", {});
  prova("ação que não foi escrita dá 404 (o build deployado é este)", x.status === 404 && x.corpo.erro === "acao_inexistente", `${x.status} ${JSON.stringify(x.corpo)}`);

  for (const [nome, acao] of [["a rota da fila em janela", "lote_fila"], ["a rota de pular envios", "lote_pular"], ["a rota da aba Bloqueados", "bloqueados_ver"]]) {
    const s = await chamar(NOVO, acao, { tipo: "recuperar" });
    prova(`${nome} existe no projeto novo`, s.status === 401 && s.corpo.erro === "sem_sessao", `${s.status} ${JSON.stringify(s.corpo)}`);
  }

  // A função tem que alcançar o banco novo com o usuário peixeiro_2peer. Se o pooler recusar,
  // links_destino devolve erro de banco — e é isso que esta parte procura.
  // Faço uma linha de teste minha (slug que nenhum cliente tem) em vez de mexer num link real:
  // assim nenhum clique cai no destino trocado. Apago a linha no fim.
  const SLUG = "prova-migracao-novo";
  const SENTINELA = "https://kuttenc.github.io/2PEER/painel/?prova=novo";
  await sql(REF, `delete from public.painel_links where slug = ${lit(SLUG)}`);
  try {
    const criada = await sql(REF, `insert into public.painel_links (slug, destino, usuario, telefone)
                                   values (${lit(SLUG)}, ${lit(SENTINELA)}, 'prova', '')`);
    if (criada.erro) prova("consegui criar a linha de teste no banco novo", false, JSON.stringify(criada).slice(0, 160));
    else {
      const noNovo = await chamar(NOVO, "links_destino", { slug: SLUG });
      prova("a função nova lê o banco novo (devolve o destino da linha que criei lá)",
        noNovo.status === 200 && String(noNovo.corpo.destino || "").includes("prova=novo"),
        `${noNovo.status} · ${JSON.stringify(noNovo.corpo).slice(0, 140)} · ${noNovo.ms} ms`);

      const naCopia = await chamar(COPIA, "links_destino", { slug: SLUG });
      prova("a função da cópia NÃO vê essa linha (cada uma está presa no seu banco)",
        !String(naCopia.corpo.destino || "").includes("prova=novo"),
        `${naCopia.status} · ${JSON.stringify(naCopia.corpo).slice(0, 140)}`);

      // E o caminho inverso: uma linha que já existia na cópia tem que estar no banco novo com
      // os mesmos dados. Comparo pela tabela estrangeira `mig` (a ponte fdw aponta para a cópia) —
      // o token novo não alcança o banco da cópia pela API de gerenciamento.
      // Nenhum link da cópia tem destino próprio (os 262 seguem o padrão), então o que prova que a
      // linha é a mesma é o telefone gravado nela.
      const emCopia = await sql(REF, "select slug, telefone from mig.painel_links where telefone <> '' order by atualizado_em desc limit 1");
      if (Array.isArray(emCopia) && emCopia.length) {
        const real = await chamar(NOVO, "links_destino", { slug: emCopia[0].slug });
        prova("os links migrados respondem no banco novo (mesmo telefone da linha da cópia)",
          real.status === 200 && String(real.corpo.telefone || "") === String(emCopia[0].telefone || ""),
          `${real.status} · telefone novo: ${String(real.corpo.telefone).replace(/\d(?=\d{4})/g, "·")} · cópia: ${String(emCopia[0].telefone).replace(/\d(?=\d{4})/g, "·")}`);
      } else {
        prova("a cópia tem alguma linha para eu conferir a migração", false, JSON.stringify(emCopia).slice(0, 160));
      }

      // Slug que ninguém tem: as duas funções caem no destino padrão gravado no banco.
      const fantasma = { slug: "este-slug-nao-existe-zz" };
      const padraoNovo = await chamar(NOVO, "links_destino", fantasma);
      const padraoCopia = await chamar(COPIA, "links_destino", fantasma);
      prova("o destino padrão é o mesmo nos dois projetos",
        padraoNovo.corpo.destino === padraoCopia.corpo.destino,
        `novo: ${String(padraoNovo.corpo.destino).slice(0, 60)} · cópia: ${String(padraoCopia.corpo.destino).slice(0, 60)}`);
    }
  } finally {
    await sql(REF, `delete from public.painel_links where slug = ${lit(SLUG)}`);
    const sobrou = await sql(REF, `select count(*) as n from public.painel_links where slug = ${lit(SLUG)}`);
    prova("apaguei a linha de teste do banco novo", Array.isArray(sobrou) && Number(sobrou[0].n) === 0, JSON.stringify(sobrou).slice(0, 80));
  }

  console.log("\nactions chamadas nesta prova:", [...new Set(chamadas)].join(", "));
  console.log(falhas === 0 ? "\ntodas as provas passaram" : `\n${falhas} prova(s) com falha`);
  process.exit(falhas === 0 ? 0 : 1);
})();
