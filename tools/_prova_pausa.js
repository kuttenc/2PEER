/** Prova do relógio do lote: o ritmo comparado à hora sobrevive à aba congelada.
 *
 *  Nada aqui toca o banco nem o GreenAPI — as funções de ritmo são recortadas do texto real
 *  de `painel/app.js` e rodadas num relógio falso, com o navegador simulado em três situações:
 *  ticking normal, aba em segundo plano (Chrome dispara o timer 1x por minuto) e aba
 *  congelada (nada roda, o relógio anda sozinho).
 *
 *    node tools/_prova_pausa.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FONTE = fs.readFileSync(path.join(__dirname, "..", "painel", "app.js"), "utf8");

/** Recorta `function nome(...) { ... }` pelo recuo de dois espaços, igual ao arquivo. */
function recorta(nome) {
  const inicio = FONTE.indexOf("\n  function " + nome + "(");
  if (inicio < 0) throw new Error("não achei " + nome + " no app.js");
  const fim = FONTE.indexOf("\n  }\n", inicio) + 4;
  return FONTE.slice(inicio + 1, fim);
}

const BLOCO = ["esperar", "vigiar", "zelar", "escreverPausa", "pararTemporizador"].map(recorta).join("\n");

function novoMotor() {
  const rel = { agora: 0, disparos: 0, pausas: [], intervalos: [], vigia: null };
  const lote = { rodando: true, limite: 0, vigia: null, tela: null, passo: null };
  const caixa = (v) => { if (v) rel.pausas.push(v); };
  const sandbox = {
    lote,
    Date: { now: () => rel.agora },
    setInterval: (fn) => { rel.intervalos.push(fn); return rel.intervalos.length; },
    clearInterval: () => {},
    // escreverPausa escreve nos três ids da tela; um gravador por chamada basta para a prova
    $: () => ({ set textContent(v) { caixa(v); }, set hidden(_) {} }),
    navigator: {},
    console,
  };
  sandbox.lote.passo = () => { rel.disparos += 1; };
  vm.createContext(sandbox);
  vm.runInContext(BLOCO, sandbox);
  rel.esperar = sandbox.esperar;
  rel.zelar = sandbox.zelar;
  rel.vigiar = sandbox.vigiar;
  rel.tique = (segundos) => { rel.agora += segundos * 1000; rel.zelar(); };
  return rel;
}

/** O código antigo: contava para trás a cada tick, então um tick atrasado valia um segundo. */
function motorAntigo(segundos) {
  const rel = { agora: 0, disparos: 0 };
  let restante = Math.ceil(segundos);
  rel.tique = (delta) => {
    rel.agora += delta * 1000;
    restante -= 1;
    if (restante <= 0) rel.disparos += 1;
  };
  return rel;
}

const resultados = [];
function checar(rotulo, ok, detalhe) {
  resultados.push([!!ok, rotulo]);
  console.log((ok ? "OK   " : "FAIL ") + rotulo.padEnd(58) + (detalhe || ""));
}

// 1) aba na frente: um tick por segundo, o item sai no segundo combinado e uma única vez
const vivo = novoMotor();
vivo.vigiar();
vivo.esperar(50);
for (let i = 0; i < 60; i++) vivo.tique(1);
checar("novo: dispara no prazo (50s) e uma vez só", vivo.disparos === 1, "disparos=" + vivo.disparos);
const contagem = vivo.pausas
  .map((v) => Number(String(v).replace(/\D+/g, "")))
  .filter((v, i, a) => i === 0 || v !== a[i - 1]);
checar("novo: a contagem na tela desceu de 49 até 1", contagem.length === 49 &&
       contagem[0] === 49 && contagem[48] === 1, "primeiros=" + contagem.slice(0, 3) + "…");

// 2) aba em segundo plano: o Chrome só deixa o timer rodar 1x por minuto
const lento = novoMotor();
lento.vigiar();
lento.esperar(50);
for (let i = 0; i < 3; i++) lento.tique(60);
const velho = motorAntigo(50);
for (let i = 0; i < 3; i++) velho.tique(60);
checar("novo: segundo plano atrasa no máximo um tick", lento.disparos === 1, "disparos=" + lento.disparos);
checar("antigo: 3 ticks de 1 min não cobriam 50s de pausa", velho.disparos === 0,
       "o ritmo de 50s virava 50 minutos");

// 3) aba congelada (tela apagada): nada roda, o relógio anda; ao acordar o item sai na hora
const morta = novoMotor();
morta.vigiar();
morta.esperar(50);
morta.agora += 400 * 1000; // 6 min e meio sem um único tick
checar("congelada: nenhum disparo enquanto a aba dorme", morta.disparos === 0, "disparos=" + morta.disparos);
morta.tique(0);
checar("congelada: no primeiro tick depois de acordar o item sai", morta.disparos === 1, "disparos=" + morta.disparos);

// 4) pausa zero (lote de apagar) não pode virar espera infinita nem esperar 1000s
const rapido = novoMotor();
rapido.vigiar();
rapido.esperar(0.12);
rapido.tique(1);
checar("sem pausa: dispara no tick seguinte", rapido.disparos === 1, "disparos=" + rapido.disparos);

const falhas = resultados.filter(([ok]) => !ok).map(([, r]) => r);
console.log("%d/%d provas passaram", resultados.length - falhas.length, resultados.length);
if (falhas.length) { console.log("falharam:", falhas); process.exit(1); }
