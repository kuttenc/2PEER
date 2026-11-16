// O ladrilho azul 1080x1080 do aviso de vencimento: o mesmo miolo do gerar_imagem_aviso()
// do site (títulos, quebra-linhas, a linha grande que encolhe até caber), desenhado com os
// contornos da própria fonte e rasterizado pelo resvg. Não existe PIL na Edge Function.
import { Resvg, initWasm } from "npm:@resvg/resvg-wasm@2.6.2";
import { FonteTTF } from "./fonte.ts";
import { bytesParaB64 } from "./texto.ts";

const LARGURA = 1080;
const ALTURA = 1080;
const UTILIZAVEL = ALTURA - 150;
const AZUL = "#124aa8";
const AMARELO = "#ffd60a";
const BRANCO = "#ffffff";
const TAMANHOS = [104, 90, 78, 66, 56, 48];

type Conf = {
  aviso_titulo?: string;
  aviso_rodape?: string;
  aviso_pix_mascara?: string;
  aviso_pix_key?: string;
  updated_at?: string;
};

type Bloco = { texto: string; tamanho: number; espaco: number; altura: number };

let pronta: Promise<FonteTTF> | null = null;
const cache = new Map<string, Uint8Array>();

async function carregarBytes(nome: string): Promise<Uint8Array> {
  // Localmente: 2peer/assets/ (../../../). No deploy, se o binario for empacotado dentro
  // da funcao, fica em ./assets/. O ultimo recurso e o proprio GitHub Pages.
  const candidatos = [`../../../assets/${nome}`, `./assets/${nome}`];
  for (const caminho of candidatos) {
    try {
      return await Deno.readFile(new URL(caminho, import.meta.url));
    } catch (erro) {
      if ((erro as { code?: string }).code !== "NotFound") throw erro;
    }
  }
  const base = (Deno.env.get("PAINEL_ASSETS_URL") || "https://kuttenc.github.io/2PEER/assets").replace(/\/+$/, "");
  const resp = await fetch(`${base}/${nome}`, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`${nome} indisponível (${resp.status})`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function preparar(): Promise<FonteTTF> {
  if (!pronta) {
    pronta = (async () => {
      const wasm = await carregarBytes("resvg_bg.wasm");
      await initWasm(wasm as unknown as ArrayBuffer);
      return FonteTTF.carregar(await carregarBytes("DejaVuSans-Bold.ttf"));
    })();
  }
  return pronta;
}

/** Quebra nas palavras, no mesmo limite do PIL (1080 - 110), medindo o avanço como ele mede. */
function quebrar(f: FonteTTF, texto: string, tamanho: number, maxima = LARGURA - 110): string[] {
  const linhas: string[] = [];
  let atual = "";
  for (const palavra of (texto || "").split(/\s+/).filter(Boolean)) {
    const teste = (atual ? atual + " " : "") + palavra;
    if (f.largura(teste, tamanho) > maxima && atual) {
      linhas.push(atual);
      atual = palavra;
    } else {
      atual = teste;
    }
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [""];
}

function montar(f: FonteTTF, conf: Conf, textoDias: string, tamanhoGrande: number): Bloco[] {
  const grupos: [string, number, number][] = [
    [String(conf.aviso_titulo || "ATENCAO: SEU PLANO VAI VENCER"), 70, 0],
    [`Faltam ${textoDias}`, tamanhoGrande, 46],
    ["para o seu plano expirar", 58, 24],
    [String(conf.aviso_rodape || "Para renovar, pague pelo PIX:"), 50, 54],
    ["PIX CNPJ", 58, 24],
    [String(conf.aviso_pix_mascara || conf.aviso_pix_key || ""), 86, 14],
  ];
  const blocos: Bloco[] = [];
  for (const [texto, tamanho, espacoGrupo] of grupos) {
    quebrar(f, texto, tamanho).forEach((linha, indice) => {
      const medida = f.medir(linha, tamanho);
      blocos.push({
        texto: linha,
        tamanho,
        espaco: indice === 0 ? espacoGrupo : 10,
        altura: medida.tinta_fundo - medida.tinta_topo,
      });
    });
  }
  return blocos;
}

export async function gerarImagemAviso(conf: Conf, textoDias: string): Promise<Uint8Array> {
  const chave = [
    textoDias,
    conf.aviso_titulo || "",
    conf.aviso_rodape || "",
    conf.aviso_pix_mascara || "",
    conf.aviso_pix_key || "",
    conf.updated_at || "",
  ].join("|");
  const guardada = cache.get(chave);
  if (guardada) return guardada;

  const f = await preparar();
  let blocos: Bloco[] = [];
  let total = Infinity;
  for (const tamanho of TAMANHOS) {
    blocos = montar(f, conf, textoDias, tamanho);
    total = blocos.reduce((soma, b) => soma + b.altura + b.espaco, 0);
    if (total <= UTILIZAVEL) break;
  }

  let topo = 75 + Math.max(0, (UTILIZAVEL - total) / 2);
  const partes: string[] = [];
  for (const bloco of blocos) {
    topo += bloco.espaco;
    const medida = f.medir(bloco.texto, bloco.tamanho);
    const x = (LARGURA - medida.largura) / 2;
    const linhaBase = topo + f.asc(bloco.tamanho);
    partes.push(
      `<path transform="translate(${round2(x)} ${round2(linhaBase)})" d="${f.tracos(bloco.texto, bloco.tamanho)}"/>`,
    );
    topo += bloco.altura;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGURA}" height="${ALTURA}">` +
    `<rect width="${LARGURA}" height="${ALTURA}" fill="${AZUL}"/>` +
    `<g fill="${BRANCO}">${partes.join("")}</g>` +
    `<rect x="0" y="0" width="${LARGURA}" height="12" fill="${AMARELO}"/>` +
    `<rect x="0" y="${ALTURA - 12}" width="${LARGURA}" height="12" fill="${AMARELO}"/>` +
    `</svg>`;

  const png = new Uint8Array(new Resvg(svg, { fitTo: { mode: "width", value: LARGURA } }).render().asPng());
  if (cache.size > 40) cache.clear();
  cache.set(chave, png);
  return png;
}

export async function previaAvisoEmB64(conf: Conf, textoDias: string): Promise<string> {
  try {
    return "data:image/png;base64," + bytesParaB64(await gerarImagemAviso(conf, textoDias));
  } catch {
    return "";
  }
}

function round2(valor: number): number {
  return Math.round(valor * 100) / 100;
}
