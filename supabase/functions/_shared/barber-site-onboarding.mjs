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

function escaparHtml(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function paginaPublicadaCompleta(html, pagina) {
  const conteudo = String(html || "");
  if (!paginaProntaParaAgendamento(pagina) || !preenchido(pagina.endereco)) return false;
  if (conteudo.length < 500 || !/<!doctype html/i.test(conteudo)) return false;
  if (!conteudo.includes(`<h1>${escaparHtml(pagina.nome)}</h1>`)) return false;
  if (!conteudo.includes(escaparHtml(pagina.endereco))) return false;
  for (const trecho of [
    '<section id="agendar">',
    'id="servicos-escolha"',
    'id="dias"',
    'id="horas"',
    'id="gravar"',
    '<script id="dados" type="application/json">',
    "<h2>Serviços</h2>",
    "<h2>Horários de atendimento</h2>",
    "<h2>Formas de pagamento</h2>",
  ]) {
    if (!conteudo.includes(trecho)) return false;
  }
  if ((conteudo.match(/<script\b/gi) || []).length < 2) return false;
  return pagina.servicos.some((servico) =>
    conteudo.includes(`<b>${escaparHtml(servico.nome)}</b>`)
  ) && pagina.pagamentos.some((pagamento) =>
    conteudo.includes(`<span class="chip">${escaparHtml(pagamento)}</span>`)
  );
}

export function parseComandoBoasVindas(texto) {
  const comando = String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/^\/+/, "")
    .replace(/[.!?]/g, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ");
  return comando === "enviar boasvindas" || comando === "enviar boas vindas";
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
