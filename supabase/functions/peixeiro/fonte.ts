// Fonte TTF lida direto dos bytes: métricas (como o PIL media) e contornos (para desenhar
// o ladrilho azul sem depender de font nenhuma dentro da Edge Function).
// Tabelas usadas: head, hhea, maxp, cmap, hmtx, loca, glyf.

export type Ponto = { x: number; y: number; on: boolean };

export type MetricasLinha = { largura: number; tinta_topo: number; tinta_fundo: number };

// Flags do contorno simples. Com o delta curto ligado o bit de "positivo" é o sinal; com ele
// desligado o mesmo bit quer dizer "repete a coordenada anterior" (e não gasta byte nenhum).
const ON_CURVE = 1, X_CURTO = 2, Y_CURTO = 4, REPETE = 8, X_POSITIVO = 16, Y_POSITIVO = 32;
// Flags do glifo composto.
const ARG_PALAVRAS = 1, ARG_XY = 2, UM_ESCALA = 8, ESCALA_XY = 64, ESCALA_2X2 = 128, TEM_MAIS = 32;

export class FonteTTF {
  private avanco!: Int32Array;
  private ymax!: Int32Array;
  private ymin!: Int32Array;
  private mapa!: Map<number, number>;
  private v!: DataView;
  private inicioGlyf = 0;
  private enderecoLoca!: (g: number) => number;
  private cache = new Map<number, Ponto[][]>();

  readonly upem!: number;
  readonly ascensora!: number;
  readonly descendente!: number;

  private constructor(base: {
    avanco: Int32Array; ymax: Int32Array; ymin: Int32Array; mapa: Map<number, number>;
    upem: number; ascensora: number; descendente: number; v: DataView; inicioGlyf: number;
    enderecoLoca: (g: number) => number;
  }) {
    Object.assign(this, base);
  }

  static carregar(bytes: Uint8Array): FonteTTF {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tabelas = new Map<string, [number, number]>();
    const numTabelas = v.getUint16(4);
    for (let i = 0; i < numTabelas; i++) {
      const base = 12 + i * 16;
      const nome = String.fromCharCode(v.getUint8(base), v.getUint8(base + 1), v.getUint8(base + 2), v.getUint8(base + 3));
      tabelas.set(nome, [v.getUint32(base + 8), v.getUint32(base + 12)]);
    }
    const preciso = (nome: string): [number, number] => {
      const t = tabelas.get(nome);
      if (!t) throw new Error(`fonte sem a tabela ${nome}`);
      return t;
    };

    const [headOf] = preciso("head");
    const upem = v.getUint16(headOf + 18);
    const formatoLoca = v.getInt16(headOf + 50);

    const [hheaOf] = preciso("hhea");
    const ascensora = v.getInt16(hheaOf + 4);
    const descendente = v.getInt16(hheaOf + 6);
    const numHMetrics = v.getUint16(hheaOf + 34);

    const [maxpOf] = preciso("maxp");
    const numGlifos = v.getUint16(maxpOf + 4);

    const avanco = new Int32Array(numGlifos);
    {
      const [of] = preciso("hmtx");
      for (let g = 0; g < numGlifos; g++) avanco[g] = v.getUint16(of + Math.min(g, numHMetrics - 1) * 4);
    }

    const mapa = lerCmap(v, preciso("cmap"));

    const ymax = new Int32Array(numGlifos);
    const ymin = new Int32Array(numGlifos);
    const [locaOf] = preciso("loca");
    const [inicioGlyf] = preciso("glyf");
    const enderecoLoca = (g: number) => (formatoLoca === 0 ? v.getUint16(locaOf + g * 2) * 2 : v.getUint32(locaOf + g * 4));
    for (let g = 0; g < numGlifos; g++) {
      const inicio = enderecoLoca(g), fim = enderecoLoca(g + 1);
      if (inicio >= fim) continue;
      ymin[g] = v.getInt16(inicioGlyf + inicio + 4);
      ymax[g] = v.getInt16(inicioGlyf + inicio + 8);
    }

    return new FonteTTF({
      avanco, ymax, ymin, mapa, upem, ascensora, descendente, v, inicioGlyf, enderecoLoca,
    });
  }

  private glifo(codigo: number): number {
    return this.mapa.get(codigo) ?? 0;
  }

  asc(tamanho: number): number {
    return Math.round((this.ascensora / this.upem) * tamanho);
  }

  largura(texto: string, tamanho: number): number {
    // O PIL soma o avanço de cada glifo já arredondado em pixels; somar tudo e arredondar no
    // fim dá 1 a 2 pixels a mais e muda onde a linha quebra.
    let soma = 0;
    for (const ch of texto) soma += Math.round(((this.avanco[this.glifo(ch.codePointAt(0) ?? 0)] || 0) * tamanho) / this.upem);
    return soma;
  }

  /** Caixa de tinta contada da linha de ascensão, igual ao textbbox do PIL. */
  medir(texto: string, tamanho: number): MetricasLinha {
    const escala = tamanho / this.upem;
    let maior = 0, menor = 0;
    for (const ch of texto) {
      const g = this.glifo(ch.codePointAt(0) ?? 0);
      if (this.ymax[g] > maior) maior = this.ymax[g];
      if (this.ymin[g] < menor) menor = this.ymin[g];
    }
    const asc = this.asc(tamanho);
    return {
      largura: this.largura(texto, tamanho),
      tinta_topo: Math.round(asc - maior * escala),
      tinta_fundo: Math.round(asc - menor * escala),
    };
  }

  /** Contornos da string em pixels: linha de base em y=0, y para baixo, como o SVG desenha. */
  tracos(texto: string, tamanho: number, xInicial = 0): string {
    const escala = tamanho / this.upem;
    const partes: string[] = [];
    let x = xInicial;
    for (const ch of texto) {
      const gid = this.glifo(ch.codePointAt(0) ?? 0);
      const base = x;
      for (const contorno of this.contornos(gid)) {
        partes.push(caminhoDeContorno(contorno, (px, py) => [round2(base + px * escala), round2(-py * escala)]));
      }
      x += Math.round(((this.avanco[gid] || 0) * tamanho) / this.upem);
    }
    return partes.join("");
  }

  private contornos(gid: number): Ponto[][] {
    const guardado = this.cache.get(gid);
    if (guardado) return guardado;
    const saida = this.lerContornos(gid, [1, 0, 0, 1, 0, 0], 0);
    this.cache.set(gid, saida);
    return saida;
  }

  private lerContornos(gid: number, matriz: number[], profundidade: number): Ponto[][] {
    if (profundidade > 8 || gid >= this.avanco.length) return [];
    const inicio = this.inicioGlyf + this.enderecoLoca(gid);
    const fim = this.inicioGlyf + this.enderecoLoca(gid + 1);
    if (inicio >= fim) return [];
    const v = this.v;
    const numContornos = v.getInt16(inicio);

    if (numContornos >= 0) return contornosSimples(v, inicio, numContornos).map((p) => aplicar(p, matriz));

    const saida: Ponto[][] = [];
    let p = inicio + 10;
    for (;;) {
      const flags = v.getUint16(p);
      const gid2 = v.getUint16(p + 2);
      p += 4;
      let dx = 0, dy = 0;
      if (!(flags & ARG_XY)) {
        // componentes amarrados por ponto de controle: só andamos o ponteiro
        p += flags & ARG_PALAVRAS ? 4 : 2;
      } else if (flags & ARG_PALAVRAS) {
        dx = v.getInt16(p);
        dy = v.getInt16(p + 2);
        p += 4;
      } else {
        dx = v.getInt8(p);
        dy = v.getInt8(p + 1);
        p += 2;
      }
      let [a, b, c, d] = [1, 0, 0, 1];
      if (flags & UM_ESCALA) {
        a = d = v.getInt16(p) / 16384;
        p += 2;
      } else if (flags & ESCALA_XY) {
        a = v.getInt16(p) / 16384;
        d = v.getInt16(p + 2) / 16384;
        p += 4;
      } else if (flags & ESCALA_2X2) {
        a = v.getInt16(p) / 16384;
        b = v.getInt16(p + 2) / 16384;
        c = v.getInt16(p + 4) / 16384;
        d = v.getInt16(p + 6) / 16384;
        p += 8;
      }
      const composta = [
        matriz[0] * a + matriz[2] * b,
        matriz[1] * a + matriz[3] * b,
        matriz[0] * c + matriz[2] * d,
        matriz[1] * c + matriz[3] * d,
        matriz[0] * dx + matriz[2] * dy + matriz[4],
        matriz[1] * dx + matriz[3] * dy + matriz[5],
      ];
      for (const contorno of this.lerContornos(gid2, composta, profundidade + 1)) saida.push(contorno);
      if (!(flags & TEM_MAIS)) break;
    }
    return saida;
  }
}

function aplicar(pontos: Ponto[], m: number[]): Ponto[] {
  return pontos.map((p) => ({
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
    on: p.on,
  }));
}

function contornosSimples(v: DataView, inicio: number, numContornos: number): Ponto[][] {
  const ends: number[] = [];
  for (let i = 0; i < numContornos; i++) ends.push(v.getUint16(inicio + 10 + i * 2));
  const total = (ends[ends.length - 1] || 0) + 1;
  let p = inicio + 10 + numContornos * 2;
  p += v.getUint16(p) + 2; // instructions

  const flags: number[] = [];
  while (flags.length < total) {
    const f = v.getUint8(p);
    p += 1;
    flags.push(f);
    if (f & REPETE) {
      const repeticoes = v.getUint8(p);
      p += 1;
      for (let i = 0; i < repeticoes; i++) flags.push(f);
    }
  }

  const xs: number[] = [];
  let x = 0;
  for (const f of flags) {
    if (f & X_CURTO) {
      const delta = v.getUint8(p);
      p += 1;
      x += f & X_POSITIVO ? delta : -delta;
    } else if (!(f & X_POSITIVO)) {
      x += v.getInt16(p);
      p += 2;
    }
    xs.push(x);
  }

  const ys: number[] = [];
  let y = 0;
  for (const f of flags) {
    if (f & Y_CURTO) {
      const delta = v.getUint8(p);
      p += 1;
      y += f & Y_POSITIVO ? delta : -delta;
    } else if (!(f & Y_POSITIVO)) {
      y += v.getInt16(p);
      p += 2;
    }
    ys.push(y);
  }

  const todos: Ponto[] = xs.map((xp, i) => ({ x: xp, y: ys[i], on: (flags[i] & ON_CURVE) !== 0 }));
  const contornos: Ponto[][] = [];
  let anterior = 0;
  for (const fim of ends) {
    contornos.push(todos.slice(anterior, fim + 1));
    anterior = fim + 1;
  }
  return contornos;
}

/** Curvas quadráticas do TrueType viram Q do SVG; ponto implícito entre dois off-curve. */
function caminhoDeContorno(pontosOriginais: Ponto[], transforma: (x: number, y: number) => number[]): string {
  const pontos = pontosOriginais.slice();
  if (!pontos.length) return "";
  if (pontos.every((p) => !p.on)) {
    const a = pontos[pontos.length - 1], b = pontos[0];
    pontos.unshift({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
  } else {
    while (!pontos[0].on) pontos.push(pontos.shift()!);
  }
  const n = pontos.length;
  const [x0, y0] = transforma(pontos[0].x, pontos[0].y);
  let d = `M${x0} ${y0}`;
  let i = 1;
  while (i < n) {
    if (pontos[i].on) {
      const [x, y] = transforma(pontos[i].x, pontos[i].y);
      d += `L${x} ${y}`;
      i += 1;
    } else {
      const ctrl = pontos[i];
      const prox = pontos[i + 1] || pontos[0];
      const alvo = prox.on ? prox : { x: (ctrl.x + prox.x) / 2, y: (ctrl.y + prox.y) / 2, on: true };
      const [cx, cy] = transforma(ctrl.x, ctrl.y);
      const [ax, ay] = transforma(alvo.x, alvo.y);
      d += `Q${cx} ${cy} ${ax} ${ay}`;
      i += prox.on ? 2 : 1;
    }
  }
  return d + "Z";
}

function round2(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function lerCmap(v: DataView, [of]: [number, number]): Map<number, number> {
  const saida = new Map<number, number>();
  const numero = v.getUint16(of + 2);
  let melhor = -1;
  for (let i = 0; i < numero; i++) {
    const base = of + 4 + i * 8;
    const plataforma = v.getUint16(base);
    const especifico = v.getUint16(base + 2);
    const ponteiro = v.getUint32(base + 4);
    const nota = plataforma === 3 && (especifico === 10 || especifico === 1) ? 2 : plataforma === 0 ? 1 : 0;
    if (nota > melhor) {
      melhor = nota;
      try {
        lerSubtabela(v, of + ponteiro, saida);
      } catch {
        /* subtabela que não usamos */
      }
    }
  }
  if (!saida.size && numero > 0) lerSubtabela(v, of + v.getUint32(of + 8), saida);
  return saida;
}

function lerSubtabela(v: DataView, base: number, saida: Map<number, number>) {
  const formato = v.getUint16(base);
  if (formato === 4) {
    const segmentosX2 = v.getUint16(base + 6);
    const fimInicio = base + 14;
    const inicio = fimInicio + segmentosX2 + 2;
    const desplaz = inicio + segmentosX2;
    const deslOffset = desplaz + segmentosX2;
    for (let s = 0; s < segmentosX2 / 2; s++) {
      const fimSeg = v.getUint16(fimInicio + s * 2);
      const iniSeg = v.getUint16(inicio + s * 2);
      const delta = v.getUint16(desplaz + s * 2);
      const offset = v.getUint16(deslOffset + s * 2);
      for (let c = iniSeg; c <= fimSeg && c !== 0xffff; c++) {
        let g = 0;
        if (offset === 0) {
          g = (c + delta) & 0xffff;
        } else {
          const endereco = deslOffset + s * 2 + offset + (c - iniSeg) * 2;
          if (endereco + 1 >= v.byteLength) continue;
          g = v.getUint16(endereco);
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) saida.set(c, g);
      }
    }
  } else if (formato === 12) {
    const grupos = v.getUint32(base + 12);
    for (let i = 0; i < grupos; i++) {
      const g = base + 16 + i * 12;
      const ini = v.getUint32(g), fim = v.getUint32(g + 4), inicioGlifo = v.getUint32(g + 8);
      for (let c = ini; c <= fim; c++) saida.set(c, (inicioGlifo + (c - ini)) & 0xffff);
    }
  }
}
