function preenchido(valor) {
  return String(valor || "").trim().length > 0;
}

export function paginaProntaParaAgendamento(pagina) {
  return Boolean(
    pagina &&
    pagina.aceita_agendamento === true &&
    preenchido(pagina.nome) &&
    preenchido(pagina.telefone_publico || pagina.telefone) &&
    Array.isArray(pagina.servicos) &&
    pagina.servicos.some((servico) => preenchido(servico?.nome)) &&
    Array.isArray(pagina.horarios) &&
    pagina.horarios.some((horario) =>
      /^\d{2}:\d{2}$/.test(String(horario?.abre || "")) &&
      /^\d{2}:\d{2}$/.test(String(horario?.fecha || ""))
    ) &&
    Array.isArray(pagina.pagamentos) &&
    pagina.pagamentos.some(preenchido)
  );
}

export function mensagemPerfilWhatsApp(url) {
  const pagina = String(url || "").trim().replace(/\/+$/, "");
  if (!pagina) throw new Error("A URL pública da página é obrigatória.");

  const link = `${pagina}/`;
  return `Sua página pública está pronta para receber agendamentos:\n${link}\n\n` +
    `Para deixar o link visível no seu WhatsApp Business:\n` +
    `1. Abra o WhatsApp Business.\n` +
    `2. Toque em Ferramentas comerciais (ou Ferramentas).\n` +
    `3. Abra Perfil comercial.\n` +
    `4. Toque em Site.\n` +
    `5. Cole este link:\n${link}\n` +
    `6. Salve.\n\n` +
    `Assim, seus clientes podem abrir a página e solicitar um agendamento.`;
}
