export function parseComandoRenovacao(texto) {
  const match = String(texto || "").trim().match(/^renovar(?:\s+(.+))?$/i);
  if (!match) return null;
  const bruto = String(match[1] || "").trim();
  if (bruto && !/^[+\d\s().-]+$/.test(bruto)) return null;
  return { telefone: bruto.replace(/\D/g, "") };
}
