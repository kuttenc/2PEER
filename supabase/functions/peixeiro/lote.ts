// Lote de envios/apagadas sem servidor com memória: o plano fica congelado no banco e o
// navegador pede um item por vez, então fechar a aba no meio não deixa metade do trabalho feito.
import { consultar, consultar1 } from "./db.ts";

export type TipoLote = "recuperar" | "apagar" | "mensagem";

export type Item = Record<string, unknown>;

/** O que aconteceu com cada posição da fila, guardado pelo número dela no plano. */
export type MarcaLote = { ok: boolean; erro: string };

export type EstadoLote = {
  rodando: boolean;
  enviados: number;
  falhas: number;
  erros: string[];
  indice: number;
  total: number;
  /** Falhas seguidas do item atual: três em fila param o lote. */
  seguidas: number;
  motivo?: string;
  /** Resultado de cada item já tentado — é o que deixa o erro visível depois do lote acabar. */
  resultados?: Record<string, MarcaLote>;
  /** Posição sendo enviada agora; enquanto estiver preenchido a tela mostra "enviando…". */
  enviando?: number | null;
};

const CHAVE: Record<TipoLote, string> = {
  recuperar: "recuperar_todos",
  apagar: "deletar_lote",
  // A fila de mensagem comum divide a mesma tabela e a mesma máquina do "Não recuperados":
  // parar, retomar e tirar da linha do meio funcionam igualzinheiro, e o que muda é só o texto.
  mensagem: "mensagem_lote",
};
const VALIDAR: Record<TipoLote, number> = { recuperar: 900, apagar: 600, mensagem: 900 };

export async function gravarPlano(tipo: TipoLote, plano: Item[], aviso = ""): Promise<void> {
  // O estado vai junto no update: contagem nova é plano novo, e o progresso velho deixaria
  // `fresco` falso para sempre (total ≠ plano.length) travando o "A conferência venceu".
  await consultar(
    `insert into public.painel_lote (chave, tipo, plano, estado)
     values ($1, $2, $3::jsonb, $4::jsonb)
     on conflict (chave) do update
        set tipo = excluded.tipo, plano = excluded.plano, estado = excluded.estado,
            aviso = $5, atualizado_em = now()`,
    [CHAVE[tipo], tipo, JSON.stringify(plano), JSON.stringify(estadoVazio(plano.length)), aviso],
  );
}

export function estadoVazio(total: number): EstadoLote {
  return { rodando: false, enviados: 0, falhas: 0, erros: [], indice: 0, total, seguidas: 0, resultados: {} };
}

async function linha(tipo: TipoLote) {
  return await consultar1(
    "select plano, estado, aviso, tipo, atualizado_em from public.painel_lote where chave = $1",
    [CHAVE[tipo]],
  );
}

function decodifica(valor: unknown, padrao: unknown) {
  if (valor === null || valor === undefined) return padrao;
  if (typeof valor === "string") {
    try {
      return JSON.parse(valor);
    } catch {
      return padrao;
    }
  }
  return valor;
}

export type VistaLote = {
  plano: Item[];
  estado: EstadoLote;
  aviso: string;
  fresco: boolean;
  idade: number;
};

export async function verLote(tipo: TipoLote): Promise<VistaLote | null> {
  const r = await linha(tipo);
  if (!r) return null;
  const plano = (decodifica(r.plano, []) as Item[]) || [];
  const estado = decodifica(r.estado, estadoVazio(plano.length)) as EstadoLote;
  // Lote começado antes desta versão não tem os campos novos no json salvo.
  if (!estado.resultados) estado.resultados = {};
  if (estado.enviando === undefined) estado.enviando = null;
  const atualizado = r.atualizado_em ? new Date(String(r.atualizado_em)).getTime() : 0;
  const idade = atualizado ? (Date.now() - atualizado) / 1000 : Infinity;
  return {
    plano,
    estado,
    aviso: String(r.aviso || ""),
    fresco: idade < VALIDAR[tipo] && plano.length === estado.total,
    idade,
  };
}

export async function salvarEstado(tipo: TipoLote, estado: EstadoLote): Promise<void> {
  await consultar(
    "update public.painel_lote set estado = $2::jsonb, atualizado_em = now() where chave = $1",
    [CHAVE[tipo], JSON.stringify(estado)],
  );
}

/** Quem sai da fila fica no plano com a marca `ignorado`: numerar de novo quebraria o
 *  progresso, então o motor só pula essas linhas quando procura o próximo. */
export function foraDaFila(item: Item): boolean {
  return item.ignorado === true;
}

function proximoPosicao(plano: Item[], indice: number): number {
  let alvo = indice;
  while (alvo < plano.length && foraDaFila(plano[alvo])) alvo += 1;
  return alvo;
}

/** O navegador pede o item seguinte; devolve null quando o lote acabou ou está parado. */
export async function proximoItem(
  tipo: TipoLote,
): Promise<{ item: Item; indice: number; total: number } | null> {
  const vista = await verLote(tipo);
  if (!vista || !vista.estado.rodando) return null;
  const { plano, estado } = vista;
  const indice = proximoPosicao(plano, estado.indice);
  if (indice >= plano.length) return null;
  estado.indice = indice;
  estado.enviando = indice;
  await salvarEstado(tipo, estado);
  return { item: plano[indice], indice, total: plano.length };
}

export type ResultadoItem = {
  ok: boolean;
  erro?: string;
  parar?: string;
  /** Com N falhas em fila o lote para sozinho ("seguidas" em estado.motivo). */
  limiteSeguidas?: number;
};

/** Registra o resultado de um item e decide se o lote continua. */
export async function registrarItem(tipo: TipoLote, resultado: ResultadoItem): Promise<EstadoLote> {
  const vista = await verLote(tipo);
  if (!vista) throw new Error("lote não existe");
  const estado = vista.estado;
  const tentativa = proximoPosicao(vista.plano, estado.indice);
  estado.resultados = estado.resultados || {};
  estado.resultados[String(tentativa)] = {
    ok: resultado.ok,
    erro: resultado.erro ? String(resultado.erro).slice(0, 160) : "",
  };
  if (resultado.ok) {
    estado.enviados += 1;
    estado.seguidas = 0;
  } else {
    estado.falhas += 1;
    estado.seguidas = (estado.seguidas || 0) + 1;
    if (resultado.erro && estado.erros.length < 20) estado.erros.push(String(resultado.erro).slice(0, 160));
  }
  estado.enviando = null;
  estado.indice = proximoPosicao(vista.plano, tentativa + 1);
  const emFila = resultado.limiteSeguidas && estado.seguidas >= resultado.limiteSeguidas;
  if (resultado.parar || emFila) {
    estado.rodando = false;
    estado.motivo = resultado.parar || "seguidas";
  } else if (estado.indice >= vista.plano.length) {
    // Último item registrado: sem isto o rodando ficava true para sempre e o próximo
    // lote travava em "já existe um lote rodando" — no Flask o finally fazia esse desligar.
    estado.rodando = false;
  }
  await salvarEstado(tipo, estado);
  return estado;
}

export async function iniciarLote(tipo: TipoLote): Promise<{ ok: boolean; erro?: string; estado?: EstadoLote }> {
  const vista = await verLote(tipo);
  if (!vista || !vista.plano.length) return { ok: false, erro: "plano_venceu" };
  if (vista.estado.rodando) return { ok: false, erro: "lote_rodando" };
  const estado = { ...estadoVazio(vista.plano.length), rodando: true };
  await salvarEstado(tipo, estado);
  return { ok: true, estado };
}

export async function pararLote(tipo: TipoLote): Promise<EstadoLote> {
  const vista = await verLote(tipo);
  if (!vista) return estadoVazio(0);
  const estado = { ...vista.estado, rodando: false, enviando: null, motivo: "parou_manual" };
  await salvarEstado(tipo, estado);
  return estado;
}

/** Retoma o mesmo plano congelado, exatamente da posição em que parou: nada é recontado
 *  e ninguém recebe a mensagem duas vezes. */
export async function retomarLote(
  tipo: TipoLote,
): Promise<{ ok: boolean; erro?: string; estado?: EstadoLote }> {
  const vista = await verLote(tipo);
  if (!vista || !vista.plano.length) return { ok: false, erro: "plano_vazio" };
  if (vista.estado.rodando) return { ok: false, erro: "lote_rodando" };
  const estado = vista.estado;
  estado.indice = proximoPosicao(vista.plano, estado.indice);
  if (estado.indice >= vista.plano.length) return { ok: false, erro: "fila_no_fim" };
  estado.rodando = true;
  estado.seguidas = 0;
  estado.enviando = null;
  delete estado.motivo;
  await salvarEstado(tipo, estado);
  return { ok: true, estado };
}

/** Marca quem ainda não foi enviado como `ignorado` no plano. Não apaga ninguém no painel
 *  MC e não mexe no que já saiu: só tira da fila que o motor ainda vai percorrer. */
export async function tirarDaFila(
  tipo: TipoLote,
  indices: number[],
): Promise<{ ok: boolean; erro?: string; fora?: number }> {
  const vista = await verLote(tipo);
  if (!vista || !vista.plano.length) return { ok: false, erro: "plano_vazio" };
  if (vista.estado.rodando) return { ok: false, erro: "lote_rodando" };
  const quero = new Set(indices.filter((n) => Number.isFinite(n)).map((n) => Math.trunc(n)));
  let fora = 0;
  const plano = vista.plano.map((item, i) => {
    // O que já foi tentado fica como está: a linha é o histórico do envio.
    if (i < vista.estado.indice || !quero.has(i) || foraDaFila(item)) return item;
    fora += 1;
    return { ...item, ignorado: true };
  });
  if (!fora) return { ok: true, fora: 0 };
  await consultar(
    "update public.painel_lote set plano = $2::jsonb, atualizado_em = now() where chave = $1",
    [CHAVE[tipo], JSON.stringify(plano)],
  );
  return { ok: true, fora };
}

export async function resumoLote(tipo: TipoLote): Promise<EstadoLote & { total: number }> {
  const vista = await verLote(tipo);
  if (!vista) return { ...estadoVazio(0) };
  return { ...vista.estado, total: vista.plano.length };
}
