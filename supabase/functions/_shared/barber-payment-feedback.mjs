function normalizarResposta(frase) {
  return String(frase || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function interpretarRetornoPagamento(frase) {
  const resposta = normalizarResposta(frase);
  if (resposta === "pix") return "pix";
  if (resposta === "cartao" || resposta === "cartao de credito") return "cartao";
  if (resposta === "nao veio" || resposta === "nao compareceu") return "nao_veio";
  return null;
}
