// Prova da aba Clientes paginada (900 por vez) com o campo que pesquisa em tudo.
//
//   npx --yes deno run -A --env-file=../../../.env ../../../tools/_prova_clientes_pagina.ts
//
// Lê o banco da cópia e não escreve nada: nenhuma linha muda e nenhum WhatsApp sai daqui.
import { listarClientesPagina } from "../supabase/functions/peixeiro/banco.ts";
import { consultar } from "../supabase/functions/peixeiro/db.ts";

let falhas = 0;
function checar(rotulo: string, verdadeiro: unknown, detalhe = "") {
  if (!verdadeiro) falhas++;
  console.log(`${verdadeiro ? "OK  " : "FAIL"} ${rotulo}${detalhe ? "  → " + detalhe : ""}`);
}

// A primeira chamada abre a conexão e roda o esquema inteiro, então o tempo real da tela é o
// da segunda em diante.
await listarClientesPagina(1, "");
const inicio = Date.now();
const p1 = await listarClientesPagina(1, "");
console.log(`carga aquecida da primeira página: ${Date.now() - inicio}ms · ${p1.info.na_base} na base`);

checar("a tela recebe 900 linhas, não a base inteira", p1.linhas.length === 900, `${p1.linhas.length}`);
checar("o resumo continua contando a base toda", p1.info.na_base > 900, JSON.stringify(p1.info));
checar("as páginas cobrem a busca de 900 em 900",
  p1.info.paginas === Math.ceil(p1.info.encontrados / 900), `${p1.info.paginas} páginas`);
checar("as duas consultas cabem em um toque de aba", Date.now() - inicio < 3000, `${Date.now() - inicio}ms`);

const dois = await listarClientesPagina(2, "");
checar("a segunda página é outra gente",
  !dois.linhas.some((l) => p1.linhas.some((o) => o.username === l.username)), `${dois.linhas.length} linhas`);

const ultima = await listarClientesPagina(p1.info.paginas, "");
checar("a última página vem com o resto", ultima.info.pagina === p1.info.paginas && ultima.linhas.length > 0,
  `${ultima.linhas.length} linhas`);
checar("a página depois da última vem vazia sem quebrar o resumo",
  (await listarClientesPagina(p1.info.paginas + 1, "")).info.na_base === p1.info.na_base);
checar("quem só tem telefone na agenda cai no fim da lista",
  !p1.info.so_agenda || ultima.linhas.slice(-p1.info.so_agenda).every((l) => l.so_agenda),
  `${p1.info.so_agenda} só na agenda`);

// Quem tem CPF veio da lista colada e mora mais fundo na ordenação por vencimento, então o alvo
// da busca é lido direto da base em vez de ser pescada na primeira página.
const amostra = await consultar(
  `select m.username, m.telefone, p.cpf, p.nome
     from public.cliente_pix p
     join public.mc_linhas m on m.username = p.usuario
    where coalesce(p.cpf, '') <> '' and coalesce(p.nome, '') <> ''
      and coalesce(m.telefone, '') <> ''
    limit 1`,
);
const alvo = (amostra.rows[0] || {}) as { username: string; telefone: string; cpf: string; nome: string };
checar("há na base alguém com CPF, nome e telefone para medir", Boolean(alvo.username), String(alvo.username));

const peloCpf = await listarClientesPagina(1, alvo.cpf);
checar("o CPF sozinho acha a linha dele",
  peloCpf.linhas.some((l) => l.username === alvo.username), `${peloCpf.info.encontrados} achados`);
checar("o CPF digitado com ponto e traço acha do mesmo jeito",
  (await listarClientesPagina(1, alvo.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")))
    .linhas.some((l) => l.username === alvo.username));

const peloTelefone = await listarClientesPagina(1, alvo.telefone);
checar("o telefone acha a linha",
  peloTelefone.linhas.some((l) => l.username === alvo.username), `${peloTelefone.info.encontrados} achados`);
checar("o telefone sem o 55 da frente acha do mesmo jeito",
  (await listarClientesPagina(1, alvo.telefone.replace(/^55/, ""))).info.encontrados >= 1);
if (alvo.telefone.length >= 12) {
  const d = alvo.telefone.slice(2);
  const mascarado = `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  checar("o telefone com a máscara da tela acha do mesmo jeito",
    (await listarClientesPagina(1, mascarado)).linhas.some((l) => l.username === alvo.username), mascarado);
}

const peloUsuario = await listarClientesPagina(1, alvo.username);
checar("o usuário acha a linha",
  peloUsuario.linhas.some((l) => l.username === alvo.username), `${peloUsuario.info.encontrados} achados`);

const palavra = (alvo.nome.split(" ")[0] || "").trim();
const peloNome = await listarClientesPagina(1, palavra);
const achou = (l: { nome: string; username: string; notes: string }) => {
  const p = palavra.toLowerCase();
  return (l.nome || "").toLowerCase().includes(p) ||
    (l.username || "").toLowerCase().includes(p) ||
    (l.notes || "").toLowerCase().includes(p);
};
checar(`uma palavra do nome ("${palavra}") só devolve quem tem essa palavra`,
  peloNome.info.encontrados >= 1 && peloNome.linhas.every(achou),
  `${peloNome.info.encontrados} achados`);
checar("a busca não diferencia maiúscula de minúscula",
  (await listarClientesPagina(1, palavra.toUpperCase())).info.encontrados === peloNome.info.encontrados);

const comNota = await listarClientesPagina(1, alvo.username + "%");
checar("o % do termo não vira curinga do LIKE",
  comNota.info.encontrados === peloUsuario.info.encontrados,
  `${comNota.info.encontrados} contra ${peloUsuario.info.encontrados}`);

const inventado = await listarClientesPagina(1, "zzninguemnabase999");
checar("busca sem resultado devolve zero e o resumo continua na base",
  inventado.linhas.length === 0 && inventado.info.encontrados === 0 &&
    inventado.info.na_base === p1.info.na_base && inventado.info.paginas === 1,
  JSON.stringify(inventado.info));

const tudo = await listarClientesPagina(1, "   ");
checar("espaço em branco no campo é o mesmo que não buscar nada",
  tudo.linhas.length === 900 && tudo.info.encontrados === p1.info.na_base);

console.log(`\n${falhas ? falhas + " FALHA(S)" : "todas as provas passaram"}`);
Deno.exit(falhas ? 1 : 0);
