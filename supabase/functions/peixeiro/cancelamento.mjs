const BRASIL_OFFSET_MS = 3 * 60 * 60 * 1000;

/** @returns {string} */
export function novoCodigoCancelamento() {
  const limite = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const valor = new Uint32Array(1);
  do {
    crypto.getRandomValues(valor);
  } while (valor[0] >= limite);
  return String(valor[0] % 1_000_000).padStart(6, "0");
}

/**
 * @param {string} codigo
 * @param {string} salt
 * @param {string} segredo
 * @returns {Promise<string>}
 */
export async function hashCodigoCancelamento(codigo, salt, segredo) {
  if (!/^\d{6}$/.test(codigo) || !salt || !segredo) {
    throw new Error("Dados inválidos para validar o código.");
  }
  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinatura = await crypto.subtle.sign(
    "HMAC",
    chave,
    new TextEncoder().encode(`${salt}:${codigo}`),
  );
  return [...new Uint8Array(assinatura)]
    .map((parte) => parte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @param {string} dia
 * @param {string} hora
 * @param {number} [agora]
 * @returns {string | null}
 */
export function instanteDoAgendamento(dia, hora, agora = Date.now()) {
  const data = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dia || ""));
  const horario = /^(\d{2}):(\d{2})$/.exec(String(hora || ""));
  if (!data || !horario) return null;

  const ano = Number(data[1]);
  const mes = Number(data[2]);
  const diaDoMes = Number(data[3]);
  const horas = Number(horario[1]);
  const minutos = Number(horario[2]);
  const calendario = new Date(Date.UTC(ano, mes - 1, diaDoMes));
  if (
    calendario.getUTCFullYear() !== ano ||
    calendario.getUTCMonth() !== mes - 1 ||
    calendario.getUTCDate() !== diaDoMes ||
    horas > 23 ||
    minutos > 59
  ) {
    return null;
  }

  const instante = new Date(
    Date.UTC(ano, mes - 1, diaDoMes, horas, minutos) + BRASIL_OFFSET_MS,
  );
  return instante.getTime() > agora ? instante.toISOString() : null;
}
