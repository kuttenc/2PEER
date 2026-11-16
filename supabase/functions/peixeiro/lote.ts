// Lote de envios/apagadas sem servidor com memória: o plano fica congelado no banco e o
// navegador pede um item por vez, então fechar a aba no meio não deixa metade do trabalho feito.
import { consultar, consultar1 } from "./db.ts";

export type TipoLote = "recuperar" | "apagar";

export type Item = Record<string, unknown>;

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
};

const CHAVE: Record<TipoLote, string> = { recuperar: "recuperar_todos", apagar: "deletar_lote" };
const VALIDAR: Record<TipoLote, number> = { recuperar: 900, apagar: 600 };

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
  return { rodando: false, enviados: 0, falhas: 0, erros: [], indice: 0, total, seguidas: 0 };
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

/** O navegador pede o item seguinte; devolve null quando o lote acabou ou está parado. */
export async function proximoItem(
  tipo: TipoLote,
): Promise<{ item: Item; indice: number; total: number } | null> {
  const vista = await verLote(tipo);
  if (!vista) return null;
  const { plano, estado } = vista;
  if (!estado.rodando || estado.indice >= plano.length) return null;
  return { item: plano[estado.indice], indice: estado.indice, total: plano.length };
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
  if (resultado.ok) {
    estado.enviados += 1;
    estado.seguidas = 0;
  } else {
    estado.falhas += 1;
    estado.seguidas = (estado.seguidas || 0) + 1;
    if (resultado.erro && estado.erros.length < 20) estado.erros.push(String(resultado.erro).slice(0, 160));
  }
  estado.indice += 1;
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
  const estado = { ...vista.estado, rodando: false, motivo: "parou_manual" };
  await salvarEstado(tipo, estado);
  return estado;
}

export async function resumoLote(tipo: TipoLote): Promise<EstadoLote & { total: number }> {
  const vista = await verLote(tipo);
  if (!vista) return { ...estadoVazio(0) };
  return { ...vista.estado, total: vista.plano.length };
}
