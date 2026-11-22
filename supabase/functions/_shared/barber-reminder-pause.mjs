function diaEmMilissegundos(valor) {
  const dia = String(valor || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;
  const instante = Date.parse(`${dia}T00:00:00.000Z`);
  if (!Number.isFinite(instante) || new Date(instante).toISOString().slice(0, 10) !== dia) return null;
  return instante;
}

export function diasConsecutivosEntregues(dias) {
  const ordenados = [...new Set((dias || []).map(diaEmMilissegundos).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  return ordenados.some((dia, indice) => indice > 0 && dia - ordenados[indice - 1] === 86_400_000);
}
