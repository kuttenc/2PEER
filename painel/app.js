/* O painel sem Render: tudo que o navegador faz é chamar a Edge Function com {"action": ...}
   e o token da sessão no Authorization. Nenhuma chave de banco ou senha do MC passa por aqui. */
(function () {
  "use strict";

  var FUNCAO = (window.PEIXEIRO || {}).funcao || "";
  var CHAVE_SESSAO = "peixeiro_sessao";
  var CHAVE_PULAR = "peixeiro_lote_pular";
  var CHAVE_FONTE = "peixeiro_lote_fonte";
  var QR_BASE = "https://qr.green-api.com/waInstance";

  var MSG_OK = {
    gravado: "Gravado no banco. O site e a agenda das 6h já usam esses valores.",
    enviado: "Aviso(s) enviado(s) e registrado no controle do site (não vai repetir).",
    varrido: "Varredura rodou agora.",
    apagado: "Acesso apagado do painel MC.",
    recuperado: "Mensagem enviada e guardada no Supabase (a agenda das 6h só repete depois dos dias configurados).",
    sincronizado: "Espelho do MC atualizado no Supabase.",
    importado: "CSV lido e gravado no Supabase (telefone também foi para a lista de envios).",
    telefone: "Telefone guardado no banco. Já dá para usar o botão recuperar.",
    mesclado: "Telefone copiado de um usuário para o outro (nada foi apagado).",
    senha: "Senha trocada. Faça login de novo com a senha nova.",
    foto: "Foto nova gravada no banco.",
    foto_removida: "Foto removida do banco.",
    recupera_gravado: "Salvo. Todo clique em recuperar agora sai com essa mensagem.",
    recupera_foto: "Foto da recuperação gravada no banco.",
    recupera_foto_removida: "Foto da recuperação removida. O recuperar volta a mandar só texto.",
    recupera_foto_ligado: "Envio da foto LIGADO. Todo clique em recuperar agora sai com essa imagem junto.",
    recupera_foto_desligado: "Envio da foto desligado. O recuperar manda só o texto, mas a foto continua guardada.",
    link_padrao: "Endereço padrão salvo. Todo link de recuperação sem endereço próprio abre nele agora.",
    link_destino: "Endereço salvo para este link. Quem clicar já cai no novo, mesmo em mensagem antiga.",
    lote_terminado: "Lote terminado.",
    fila_tirar: "Tirados da fila: nada foi apagado no painel MC e nada do que já saiu mudou.",
    fila_pulou: "Envios pulados: ninguém recebeu mensagem e a fila continua no próximo que falta.",
    fila_retomou: "O envio voltou do ponto em que parou.",
    fila_montada: "Fila nova montada com a varredura do painel MC. Nada foi enviado.",
    chat_gravado: "Chat gravado. A próxima mensagem com essas palavras sai com essa resposta.",
    chat_novo: "Chat novo criado. Preencha as palavras, a resposta e toque em Salvar este chat.",
    chat_apagado: "Chat apagado. As conversas que ele já respondeu continuam guardadas.",
    chat_ligado: "Robô ligado. Toda mensagem que chegar recebe a resposta que casar.",
    chat_desligado: "Robô desligado. As mensagens continuam guardadas, mas nada é respondido sozinho.",
    chat_dias: "Retenção salva. O que for mais velho que isso sai do banco na próxima mensagem.",
    chat_ajuste: "Ajuste salvo.",
    chat_instalado: "Webhook instalado: o GreenAPI agora manda para cá o que chega e o que foi entregue.",
    chat_exportado: "Arquivo de treino baixado.",
    mensagem_enviada: "Mensagem enviada pelo WhatsApp (sem link e sem painel MC no meio).",
    chat_nao_salvo: "Resposta do \u201cnão\u201d salva. Na primeira vez que o cliente escrever só isso, ele sai das filas.",
    chat_nao_desligado: "Resposta do \u201cnão\u201d desligada. Ninguém mais é bloqueado por responder isso.",
    bloqueado_manual: "Bloqueio salvo. O chatbot e os envios pela GreenAPI serão desviados deste telefone.",
    desbloqueado: "Desbloqueado: o telefone volta a poder receber respostas e mensagens pela GreenAPI.",
  };

  var MSG_ERRO = {
    senha: "Senha errada.",
    senha_atual: "A senha atual não confere.",
    senha_curta: "A senha nova precisa de pelo menos 8 caracteres.",
    muitas: "Muitas tentativas seguidas. Espere uns 10 minutos e tente de novo.",
    gravado: "O banco recusou a gravação.",
    obrigatorio: "Faltou apiUrl, mediaUrl, idInstance ou apiToken.",
    numero: "Os campos de dias precisam ser um número (pode usar vírgula).",
    foto_grande: "Foto maior que 1,5 MB. Escolha uma menor.",
    sem_foto: "Você ligou o envio automático, mas não há foto guardada. O envio ficou desligado.",
    sem_foto_recupera: "Você ligou a foto da recuperação, mas ainda não há foto guardada aqui. Escolha o arquivo e salve de novo.",
    enviar: "Nenhum aviso conseguiu ser enviado.",
    cota: "O GreenAPI está sem saldo de mensagens do mês. Nenhum WhatsApp saiu.",
    apagar: "O painel MC recusou a exclusão.",
    sem_confirmar: "Marque a caixa de confirmação para apagar.",
    sem_palavra: "Escreva a palavra deletar para liberar o botão.",
    banco: "O site não conseguiu falar com o banco agora. Tente de novo em um minuto.",
    mc_login: "O site não conseguiu logar no painel MC (MC_USERNAME/MC_PASSWORD).",
    sem_destino: "Nenhum destinatário selecionado (ou ninguém com telefone).",
    sem_telefone: "Este acesso está sem telefone: digite o número na caixinha da linha e salve, depois use o recuperar.",
    telefone_invalido: "Telefone incompleto: digite o DDD e os 8 ou 9 números, como (11) 91234-5678.",
    origem_sem_telefone: "Quem vai emprestar o telefone está sem número: cadastre primeiro na caixinha da linha.",
    mesmo_usuario: "Escolha dois usuários diferentes para mesclar.",
    csv_vazio: "O CSV ou a lista colada não veio, ou não tem nenhuma linha com usuário.",
    csv_cabecalho: "Use as colunas Usuário, Telefone, Expira, Status, Nota (na ordem ou no cabeçalho).",
    sem_lista: "Cole a lista primeiro: Nome, dados+CPF, Expira, Status, Telefone, Usuário.",
    varrer: "A varredura não conseguiu rodar agora.",
    sem_sessao: "A sessão expirou. Entre de novo.",
    sem_sobra: "Ninguém sobrou para enviar. Desmarque alguém ou cadastre o telefone.",
    sem_sobra_apagar: "Ninguém sobrou para apagar. Desmarque alguém ou ligue o item de quem está ativo.",
    conferencia_venceu: "A conferência venceu. Abra o modal de novo para contar outra vez.",
    lote_rodando: "Já existe um lote rodando. Pare o envio antes de mexer na fila.",
    fila_no_fim: "A fila já terminou: não sobrou ninguém para retomar.",
    plano_vazio: "Ainda não há fila montada. Abra o Não recuperados na aba Acessos e revise a contagem.",
    sem_marca: "Ninguém marcado: toque Selecionar e marque as linhas da fila.",
    quantidade_invalida: "Escreva na caixinha quantos envios você quer pular (1 ou mais).",
    muita_marca: "São no máximo 2.000 por vez — pule em duas tacadas.",
    prefixo_ruim: "Prefixo demais: até 24 letras, sem espaço.",
    intervalo_obrigatorio: "Preencha o de e o até com números.",
    intervalo_invertido: "O \u201caté\u201d precisa ser maior que o \u201cde\u201d.",
    intervalo_grande: "Intervalo grande demais para um lote só.",
    acao_inexistente: "Esta versão do painel não conhece essa ação.",
    interna: "A função respondeu errado. Abra de novo ou veja os logs dela.",
    sem_resposta: "A função não respondeu. Confira a conexão e tente de novo.",
    url: "Escreva o endereço inteiro, começando por https:// (ou deixe vazio para seguir o padrão).",
    sem_slug: "Este link não está na lista. Use recuperar para ele aparecer aqui.",
    chat_gatilho: "Faltou escrever as palavras que o cliente manda.",
    chat_resposta: "Faltou escrever o que responder.",
    sem_regra: "Este chat não existe mais. Abra a aba de novo.",
    nada_gravar: "Não havia nada para mudar.",
    webhook: "A instância recusou o webhook. Confira a chave na Configuração e tente de novo.",
    sem_texto: "Escreva a mensagem antes de contar ou enviar.",
    texto_grande: "Texto grande demais: são até 1200 caracteres.",
    bloqueado: "Este número está na aba Bloqueados (respondeu \u201cnão\u201d). Desbloqueie lá para mandar de novo.",
    ja_bloqueado: "Este telefone já está bloqueado.",
    bloqueio_falhou: "Não consegui salvar o bloqueio. Tente novamente.",
    nao_esta_bloqueado: "Este número já não estava bloqueado.",
    url_appbarber: "Use o endereço público completo de um site AppBarber.",
    pagina_inacessivel: "Não consegui abrir a página atual agora. Confira o endereço e tente novamente.",
  };

  // ------------------------------------------------------------------ utilidades

  function $(id) { return document.getElementById(id); }

  function texto(valor) { return valor === null || valor === undefined ? "" : String(valor); }

  function limpar(alvo) { while (alvo.firstChild) alvo.removeChild(alvo.firstChild); return alvo; }

  function criar(tag, classe, conteudo) {
    var n = document.createElement(tag);
    if (classe) n.className = classe;
    if (conteudo !== undefined && conteudo !== null) n.textContent = conteudo;
    return n;
  }

  function copiarTexto(valor) {
    if (!valor) return;
    if (navigator.clipboard) { navigator.clipboard.writeText(valor); return; }
    var campo = document.createElement("textarea");
    campo.value = valor;
    document.body.appendChild(campo);
    campo.select();
    document.execCommand("copy");
    document.body.removeChild(campo);
  }

  function pilula(ativo, ligado, desligado) {
    var p = criar("span", "pill" + (ativo ? " on" : ""), ativo ? ligado : desligado);
    return p;
  }

  function recado(codigo, extra) {
    var caixa = $("recado");
    limpar(caixa);
    // Sem código é "esqueça o recado": no Flask cada pedido já chegava com a caixa limpa
    // pela query string, e aqui o modal novo precisa apagar o aviso que ficou da vez passada.
    if (!codigo) return;
    var mensagem = MSG_OK[codigo] || MSG_ERRO[codigo] || codigo;
    var div = criar("div", MSG_OK[codigo] ? "ok" : "erro", mensagem);
    if (extra) div.appendChild(criar("span", "muted", " " + extra));
    caixa.appendChild(div);
    if (codigo) window.scrollTo(0, 0);
  }

  function mensagemDetalhada(d) {
    var base = MSG_ERRO[d.erro] || texto(d.erro) || "não conseguiu agora.";
    if (d.detalhe) base += " " + d.detalhe;
    if (d.qtd) base += " (" + d.qtd + " nomes, limite " + d.limite + ")";
    return base;
  }

  function mascaraTelefone(campo) {
    var d = campo.value.replace(/\D/g, "");
    if (d.length > 11 && d.substring(0, 2) === "55") d = d.substring(2);
    d = d.substring(0, 11);
    var v;
    if (d.length === 0) v = "";
    else if (d.length <= 2) v = "(" + d;
    else if (d.length <= 6) v = "(" + d.substring(0, 2) + ") " + d.substring(2);
    else if (d.length <= 10) v = "(" + d.substring(0, 2) + ") " + d.substring(2, 6) + "-" + d.substring(6);
    else v = "(" + d.substring(0, 2) + ") " + d.substring(2, 7) + "-" + d.substring(7);
    if (v !== campo.value) campo.value = v;
  }

  function telefoneBr(valor) {
    var d = texto(valor).replace(/\D/g, "");
    if (!d) return "";
    if (d.length >= 12 && d.substring(0, 2) === "55") d = d.substring(2);
    if (d.length < 7) return d;
    var meio = d.length === 11 ? 5 : 4;
    return "(" + d.substring(0, 2) + ") " + d.substring(2, meio + 2) + "-" + d.substring(meio + 2);
  }

  document.addEventListener("input", function (evento) {
    var alvo = evento.target;
    if (alvo && alvo.classList && alvo.classList.contains("maq")) mascaraTelefone(alvo);
  });

  function lerArquivo(arquivo, como) {
    return new Promise(function (resolve, reject) {
      if (!arquivo) return resolve(null);
      var leitor = new FileReader();
      leitor.onload = function () { resolve(leitor.result); };
      leitor.onerror = function () { reject(new Error("não consegui ler o arquivo")); };
      if (como === "texto") leitor.readAsText(arquivo); else leitor.readAsDataURL(arquivo);
    });
  }

  // ------------------------------------------------------------------ chamada da função

  function token() {
    try { return localStorage.getItem(CHAVE_SESSAO) || ""; } catch (e) { return ""; }
  }

  function guardarToken(valor) {
    try {
      if (valor) localStorage.setItem(CHAVE_SESSAO, valor); else localStorage.removeItem(CHAVE_SESSAO);
    } catch (e) { /* aparelho sem localStorage: o painel vira só-leitura de sessão */ }
  }

  function chamar(acao, dados, segundos) {
    var corpo = { action: acao };
    Object.keys(dados || {}).forEach(function (chave) { corpo[chave] = dados[chave]; });
    var controlador = new AbortController();
    var prazo = setTimeout(function () { controlador.abort(); }, (segundos || 45) * 1000);
    return fetch(FUNCAO, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token() ? "Bearer " + token() : "" },
      body: JSON.stringify(corpo),
      signal: controlador.signal,
    }).then(function (resposta) {
      return resposta.json().catch(function () { return { ok: false, erro: "interna", http: resposta.status }; });
    }).then(function (d) {
      if (d && d.erro === "sem_sessao" && acao !== "entrar") {
        guardarToken("");
        mostrarLogin(MSG_ERRO.sem_sessao);
      }
      return d;
    }).catch(function () {
      return { ok: false, erro: "sem_resposta" };
    }).finally(function () { clearTimeout(prazo); });
  }

  // ------------------------------------------------------------------ login

  function mostrarLogin(erro) {
    $("site").hidden = true;
    $("tela-login").hidden = false;
    var caixa = $("loginErro");
    caixa.textContent = erro || "";
    caixa.hidden = !erro;
    $("loginSenha").value = "";
  }

  function mostrarPainel() {
    $("tela-login").hidden = true;
    $("site").hidden = false;
    irPara(location.hash || "#inicio");
  }

  $("formLogin").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var botao = evento.target.querySelector("button");
    botao.disabled = true;
    botao.textContent = "conferindo…";
    chamar("entrar", { senha: $("loginSenha").value }, 30).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Entrar";
      if (!d.ok) { mostrarLogin(mensagemDetalhada(d)); return; }
      guardarToken(d.token);
      mostrarPainel();
    });
  });

  // ------------------------------------------------------------------ rotas

  var TELAS = ["inicio", "config", "avisos", "acessos", "fila", "recuperacao", "clientes", "deletar", "links", "chat", "chatbarbearia", "clientesbarbearia", "bloqueados", "senha", "apagar"];
  var CARREGA = {};
  var TELA_ATUAL = "inicio";

  function irPara(hash) {
    var partes = (hash || "#inicio").replace(/^#/, "").split("?");
    var tela = partes[0] || "inicio";
    var parametros = {};
    (partes[1] || "").split("&").forEach(function (par) {
      if (!par) return;
      var k = par.split("=")[0], v = par.split("=").slice(1).join("=");
      parametros[k] = decodeURIComponent(v || "");
    });
    if (tela === "sair") return sair();
    if (TELAS.indexOf(tela) < 0) tela = "inicio";
    TELA_ATUAL = tela;

    document.body.classList.remove("mesclar", "lote");
    limpar($("recado"));
    TELAS.forEach(function (nome) {
      var seletor = document.querySelector('[data-pagina="' + nome + '"]');
      if (seletor) seletor.hidden = nome !== tela;
    });
    Array.prototype.forEach.call(document.querySelectorAll("#nav a"), function (a) {
      var alvo = a.getAttribute("data-tela");
      a.classList.toggle("on", alvo === tela || (tela === "apagar" && alvo === "acessos"));
    });
    if (tela === "acessos") { $("mesclaBarra").hidden = true; atualizarBarraLote(); }
    if (CARREGA[tela]) CARREGA[tela](parametros);
  }

  window.addEventListener("hashchange", function () { irPara(location.hash); });

  function sair() {
    chamar("sair", {}, 15).then(function () {
      guardarToken("");
      mostrarLogin("");
    });
  }

  // ------------------------------------------------------------------ INÍCIO

  CARREGA.inicio = function (parametros) { carregarInicio(parametros && parametros.estado === "1"); };

  function carregarInicio(recarregar) {
    chamar("inicio", recarregar ? { estado: "1" } : {}, 60).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var faixa = $("faixaTeste");
      faixa.hidden = !d.modo_teste;
      if (d.modo_teste) faixa.textContent = "MODO DE TESTE: nada é enviado nem apagado de verdade.";

      var conf = d.conf || {}, estado = d.estado || {};
      var pill = $("iniEstado");
      pill.textContent = texto(estado.state);
      pill.className = "pill" + (estado.ok && estado.state === "AUTHORIZED" ? " on" : "");
      $("iniEstadoDetalhe").textContent = estado.ok ? "" : texto(estado.error || estado.status_code || "");
      $("iniInstancia").textContent = conf.id_instance || "(vazio)";
      $("iniTelefone").textContent = conf.owner_phone || "(vazio)";
      $("iniToken").textContent = conf.api_token ? "preenchido" : "VAZIO — preencha na Configuração";
      $("iniQrLinha").style.display = d.qr_link ? "" : "none";
      $("iniQr").href = d.qr_link || "#";
      $("iniQrTexto").textContent = d.qr_link || "";

      var agenda = $("iniAgenda");
      agenda.textContent = conf.aviso_ativo ? "LIGADO" : "desligado";
      agenda.className = "pill" + (conf.aviso_ativo ? " on" : "");
      $("iniAntecedencia").textContent = conf.aviso_dias + " dia(s)";
      $("iniPix").textContent = conf.aviso_pix_key;
      $("iniFoto").textContent = (d.tem_foto ? "guardada (" + d.foto_kb + " KB)" : "nenhuma") +
        " · envio automático " + (conf.send_photo ? "ligado" : "desligado");
      $("iniTelefones").textContent = d.total_telefones;
      $("iniAvisados").textContent = d.total_avisados;
    });
  }

  $("iniVerificar").addEventListener("click", function () { carregarInicio(true); });
  $("iniVarrer").addEventListener("click", function () {
    var botao = $("iniVarrer");
    botao.disabled = true;
    botao.textContent = "varrendo…";
    chamar("avisos_varrer", { reenviar: $("iniReenviar").checked ? "1" : "" }, 180).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Varrer e enviar";
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      recado("varrido", d.enviados + " enviado(s) de " + d.avaliados + " vencendo, " +
        d.sem_telefone + " sem telefone. Renovação: " + d.renova_enviados + " enviada(s) de " +
        d.renova_avaliados + ", " + d.renova_esperando + " ainda no intervalo. Espelho: " + d.espelho + " cliente(s).");
      if (d.cota) recado("cota");
    });
  });

  // ------------------------------------------------------------------ CONFIGURAÇÃO

  CARREGA.config = function (parametros) { carregarConfig(parametros && (parametros.estado === "1" || parametros.conferir === "1")); };

  function preencherConfig(conf) {
    $("cfApiUrl").value = texto(conf.api_url);
    $("cfMediaUrl").value = texto(conf.media_url);
    $("cfIdInstance").value = texto(conf.id_instance);
    $("cfApiToken").value = texto(conf.api_token);
    $("cfNome").value = texto(conf.instance_name);
    $("cfOwner").value = texto(conf.owner_phone);
    $("cfLegenda").value = texto(conf.caption);
    $("cfSendFoto").checked = Boolean(conf.send_photo);
    $("cfAvisoAtivo").checked = Boolean(conf.aviso_ativo);
    $("cfAvisoDias").value = texto(conf.aviso_dias);
    $("cfPixKey").value = texto(conf.aviso_pix_key);
    $("cfPixMascara").value = texto(conf.aviso_pix_mascara);
    $("cfTitulo").value = texto(conf.aviso_titulo);
    $("cfRodape").value = texto(conf.aviso_rodape);
    $("cfLegendaAviso").value = texto(conf.aviso_legenda);
    $("cfTokenAgenda").value = texto(conf.aviso_token);
    $("cfRenovaAtivo").checked = Boolean(conf.renova_ativo);
    $("cfRenovaDias").value = texto(conf.renova_dias);
    $("cfRenovaJanela").value = texto(conf.renova_janela_dias);
    $("cfRenovaLegenda").value = texto(conf.renova_legenda);
    $("cfRecuperaLegenda").value = texto(conf.recupera_legenda);
    $("cfPausaMin").value = texto(conf.recupera_pausa_min);
    $("cfPausaMax").value = texto(conf.recupera_pausa_max);
    desenharPausa();
    $("cfRenovaDiasTexto").textContent = texto(conf.renova_dias);
    $("cfHoje").textContent = "Hoje: " + (conf.photo_present
      ? (texto(conf.photo_name) || "arquivo") + " · " + conf.photo_kb + " KB"
      : "nenhuma foto guardada");
    atualizarQr();
  }

  /** A régua do "Não recuperados": o resumo em horas é o que ele precisa ver antes de
   *  apertar o botão com 300 ou 900 clientes na lista. */
  function desenharPausa() {
    var caixa = $("cfPausaResumo");
    if (!caixa) return;
    var min = Number($("cfPausaMin").value), max = Number($("cfPausaMax").value);
    if (!isFinite(min) || !isFinite(max) || max <= min) {
      caixa.textContent = "a espera máxima precisa ser maior que a mínima.";
      return;
    }
    var media = (min + max) / 2;
    caixa.textContent = "sorteia entre " + min + "s e " + max + "s para cada mensagem · na média, " +
      "300 clientes levam " + emHoras(300 * media) + " e 900 levam " + emHoras(900 * media) +
      ". O painel tem de ficar aberto esse tempo todo.";
  }

  function emHoras(segundos) {
    var h = Math.floor(segundos / 3600), m = Math.round((segundos - h * 3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    return h ? h + "h" + (m ? " " + m + "min" : "") : m + "min";
  }

  ["cfPausaMin", "cfPausaMax"].forEach(function (id) {
    $(id).addEventListener("input", desenharPausa);
  });

  function escreverEstado(pill, estado) {
    pill.textContent = texto(estado.state);
    pill.className = "pill" + (estado.ok && estado.state === "AUTHORIZED" ? " on" : "");
  }

  function carregarConfig(recarregar) {
    var promessas = [chamar("config_ver", {}, 45), chamar("inicio", recarregar ? { estado: "1" } : {}, 60)];
    Promise.all(promessas).then(function (saida) {
      var d = saida[0], i = saida[1];
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      preencherConfig(d.conf);
      var estado = i.estado || {};
      escreverEstado($("cfEstado"), estado);
      escreverEstado($("cfUsaEstado"), estado);
      $("cfEstadoDetalhe").textContent = estado.ok ? "" : texto(estado.error || estado.status_code || "");
      $("cfUsaApi").textContent = texto(d.conf.api_url);
      $("cfUsaMedia").textContent = texto(d.conf.media_url);
      $("cfUsaInstancia").textContent = texto(d.conf.id_instance);
      var infos = (i && i.ok && i.infos) || {};
      var corpo = limpar($("cfInfos"));
      if (infos.ok) {
        corpo.appendChild(tr("WhatsApp conectado na instância", telefoneBr(infos.numero) +
          " (o campo \"Telefone da instância\" acima está como " + (texto(d.conf.owner_phone) || "vazio") + ")"));
        var webhook = criar("td");
        if (infos.webhook_url) webhook.appendChild(criar("code", "", infos.webhook_url));
        else { webhook.className = "verm"; webhook.textContent = "nenhum — as mensagens recebidas não chegam no site"; }
        webhook.appendChild(criar("span", "muted", " incomingWebhook: " + (infos.incoming_webhook || "no")));
        corpo.appendChild(tr("webhook dentro do GreenAPI", "", webhook));
      } else {
        var td = criar("td", "verm", "não respondeu" + (infos.error ? " · " + infos.error : ""));
        corpo.appendChild(tr("instância", "", td));
      }
    });
  }

  function tr(rotulo, valor, celula) {
    var linha = document.createElement("tr");
    var th = document.createElement("th");
    th.textContent = rotulo;
    linha.appendChild(th);
    if (!celula) { celula = document.createElement("td"); celula.textContent = valor; }
    linha.appendChild(celula);
    return linha;
  }

  function atualizarQr() {
    var i = $("cfIdInstance").value.trim(), t = $("cfApiToken").value.trim();
    var a = $("qrlink");
    var url = (i && t) ? QR_BASE + i + "/" + t : "";
    a.textContent = url || "sem instância configurada";
    a.href = url || "#";
  }

  $("cfIdInstance").addEventListener("input", atualizarQr);
  $("cfApiToken").addEventListener("input", atualizarQr);

  $("btnvar").addEventListener("click", function () {
    var travado = $("cfIdInstance").readOnly;
    $("cfIdInstance").readOnly = !travado;
    $("cfApiToken").readOnly = !travado;
    $("btnvar").textContent = travado ? "Travar variáveis" : "Editar variáveis";
    $("varaviso").textContent = travado
      ? "editando — só muda no banco se você clicar em Gravar"
      : "travado para não perder a instância sem querer";
    $("btnvar").dataset.editando = travado ? "1" : "";
    atualizarQr();
  });

  $("cfVerificar").addEventListener("click", function () { carregarConfig(true); });
  $("cfAtualizarConferencia").addEventListener("click", function () { carregarConfig(true); });

  $("formConfig").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var botao = evento.target.querySelector("button.prim");
    botao.disabled = true;
    botao.textContent = "gravando…";
    var arquivo = $("cfFoto").files && $("cfFoto").files[0];
    lerArquivo(arquivo, "data").then(function (dataUrl) {
      return chamar("config_salvar", {
        api_url: $("cfApiUrl").value.trim(),
        media_url: $("cfMediaUrl").value.trim(),
        id_instance: $("cfIdInstance").value.trim(),
        api_token: $("cfApiToken").value.trim(),
        instance_name: $("cfNome").value.trim(),
        owner_phone: $("cfOwner").value.trim(),
        caption: $("cfLegenda").value,
        send_photo: $("cfSendFoto").checked,
        limpar_foto: $("cfLimparFoto").checked ? "1" : "",
        aviso_ativo: $("cfAvisoAtivo").checked,
        aviso_dias: $("cfAvisoDias").value,
        aviso_pix_key: $("cfPixKey").value.trim(),
        aviso_pix_mascara: $("cfPixMascara").value.trim(),
        aviso_titulo: $("cfTitulo").value.trim(),
        aviso_rodape: $("cfRodape").value.trim(),
        aviso_legenda: $("cfLegendaAviso").value,
        aviso_token: $("cfTokenAgenda").value.trim(),
        renova_ativo: $("cfRenovaAtivo").checked,
        renova_dias: $("cfRenovaDias").value,
        renova_janela_dias: $("cfRenovaJanela").value,
        renova_legenda: $("cfRenovaLegenda").value,
        recupera_legenda: $("cfRecuperaLegenda").value,
        recupera_pausa_min: $("cfPausaMin").value,
        recupera_pausa_max: $("cfPausaMax").value,
        editar_instancia: $("btnvar").dataset.editando || "",
        foto_base64: dataUrl || "",
        foto_nome: arquivo ? arquivo.name : "",
      }, 90);
    }).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Gravar no banco agora";
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      if (d.aviso) recado(d.aviso); else recado("gravado", d.ajuste ? " " + d.ajuste : "");
      $("cfFoto").value = "";
      $("cfLimparFoto").checked = false;
      carregarConfig(false);
    });
  });

  // ------------------------------------------------------------------ AVISOS

  CARREGA.avisos = function (p) { carregarAvisos(p || {}); };
  var avisosMostrarTodos = false;

  function carregarAvisos(p) {
    var dias = p.dias !== undefined ? p.dias : undefined;
    if (p.todos !== undefined) avisosMostrarTodos = p.todos === "1";
    var corpo = { todos: avisosMostrarTodos ? "1" : "" };
    if (dias !== undefined) corpo.dias = dias;
    chamar("avisos_ver", corpo, 90).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      $("avTitulo").textContent = "Quem vence em até " + d.limite + " dia(s)";
      var erro = $("avErro");
      erro.hidden = !d.sem_token;
      if (d.sem_token) erro.textContent = "O site não conseguiu logar no painel MC.";
      var corpo2 = limpar($("avLinhas"));
      (d.itens || []).forEach(function (i) {
        var linha = document.createElement("tr");
        var tdCheck = document.createElement("td");
        if (i.telefone) {
          var caixa = document.createElement("input");
          caixa.type = "checkbox";
          caixa.className = "aviso";
          caixa.value = i.username;
          caixa.checked = !i.ja_enviado;
          tdCheck.appendChild(caixa);
        }
        var tdNome = document.createElement("td");
        tdNome.appendChild(criar("b", "", i.username));
        if (i.ja_enviado) tdNome.appendChild(criar("span", "pill on", "já avisado"));
        var tdVence = document.createElement("td");
        tdVence.appendChild(document.createTextNode(i.expira_brasilia));
        tdVence.appendChild(criar("br"));
        tdVence.appendChild(criar("span", "muted", i.texto_dias));
        var tdTel = criar("td", "", i.telefone || "sem telefone");
        linha.appendChild(tdCheck); linha.appendChild(tdNome); linha.appendChild(tdVence); linha.appendChild(tdTel);
        corpo2.appendChild(linha);
      });
      $("avVazio").hidden = Boolean((d.itens || []).length);
      $("avAlternar").textContent = avisosMostrarTodos ? "esconder já avisados" : "mostrar já avisados";
      $("avAlternar").href = "#avisos?dias=" + d.limite + "&todos=" + (avisosMostrarTodos ? "" : "1");

      var imagem = $("avPrevia"), legenda = $("avPreviaLegenda"), semPrevia = $("avPreviaErro");
      if (d.previa) {
        imagem.src = d.previa;
        imagem.hidden = false;
        legenda.hidden = false;
        semPrevia.hidden = true;
        legenda.textContent = "A legenda enviada: " + texto(d.previa_legenda);
      } else {
        imagem.hidden = true; legenda.hidden = true; semPrevia.hidden = false;
      }
    });
  }

  $("avAlternar").addEventListener("click", function (evento) { evento.stopPropagation(); });

  function enviarAvisos(todos) {
    var marcados = Array.prototype.filter.call(document.querySelectorAll("input.aviso"), function (c) {
      return c.checked;
    }).map(function (c) { return c.value; });
    var botao = todos ? $("avTodos") : $("avMarcados");
    var original = botao.textContent;
    botao.disabled = true;
    botao.textContent = "enviando…";
    chamar("avisos_enviar", { usernames: marcados, todos: todos ? "1" : "" }, 180).then(function (d) {
      botao.disabled = false;
      botao.textContent = original;
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      recado("enviado", d.enviados + " enviado(s).");
      carregarAvisos({});
    });
  }

  $("avMarcados").addEventListener("click", function () { enviarAvisos(false); });
  $("avTodos").addEventListener("click", function () { enviarAvisos(true); });

  // ------------------------------------------------------------------ ACESSOS

  CARREGA.acessos = function () { carregarAcessos(acPagina, acBusca); };
  var acPagina = 1, acBusca = "", acTelefones = {};

  function carregarAcessos(pagina, busca) {
    acPagina = pagina || 1;
    acBusca = busca === undefined ? acBusca : busca;
    chamar("acessos_ver", { pagina: acPagina, q: acBusca }, 90).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var erro = $("acErro");
      erro.hidden = !d.sem_token;
      if (d.sem_token) erro.textContent = "O site não conseguiu logar no painel MC.";
      acTelefones = d.telefones || {};
      $("acNotaBusca").hidden = d.fonte !== "espelho";
      var corpo = limpar($("acLinhas"));
      (d.linhas || []).forEach(function (l) { corpo.appendChild(linhaAcesso(l)); });

      var info = d.info || {}, paginacao = $("acPaginacao");
      limpar(paginacao);
      if (info.paginas) {
        if (acPagina > 1) paginacao.appendChild(linkPagina(acPagina - 1, "‹ anterior"));
        paginacao.appendChild(criar("span", "muted", " página " + info.pagina + " de " + info.paginas +
          " · " + info.total + " registros" + (info.exato ? "" : " nesta página") + " "));
        if (acPagina < info.paginas) paginacao.appendChild(linkPagina(acPagina + 1, "próxima ›"));
      }
      aplicarMarcasPular();
      atualizarBarraLote();
    });
  }

  function linkPagina(pagina, rotulo) {
    var a = criar("a", "", rotulo);
    a.href = "#acessos";
    a.addEventListener("click", function (evento) {
      evento.preventDefault();
      carregarAcessos(pagina, acBusca);
    });
    return a;
  }

  function linhaAcesso(l) {
    var telefone = acTelefones[l.username] || "";
    var linha = document.createElement("tr");

    var tdChk = criar("td", "chk");
    var mescla = document.createElement("input");
    mescla.type = "checkbox";
    mescla.className = "mescla";
    mescla.value = l.username;
    mescla.dataset.usuario = l.username;
    mescla.dataset.nota = texto(l.notes);
    mescla.dataset.telefone = telefoneBr(telefone);
    mescla.dataset.status = Number(l.status) === 1 ? "ativo" : "parado";
    mescla.dataset.expira = l.expira || "—";
    mescla.setAttribute("aria-label", "escolher " + l.username);
    tdChk.appendChild(mescla);

    var tdLote = criar("td", "lote");
    if (l.vencido) {
      var pula = document.createElement("input");
      pula.type = "checkbox";
      pula.className = "pula";
      pula.value = l.username;
      pula.dataset.usuario = l.username;
      pula.dataset.nota = texto(l.notes);
      pula.dataset.dias = l.texto_dias || "—";
      pula.dataset.telefone = telefoneBr(telefone);
      pula.setAttribute("aria-label", "não mandar para " + l.username);
      tdLote.appendChild(pula);
    } else tdLote.appendChild(criar("span", "muted", "—"));

    var tdNome = criar("td");
    tdNome.appendChild(criar("b", "", l.username));
    tdNome.appendChild(criar("br"));
    tdNome.appendChild(criar("span", "muted", l.senha));

    var tdTel = criar("td");
    var form = document.createElement("form");
    form.className = "tel";
    var campo = document.createElement("input");
    campo.type = "tel";
    campo.className = "maq";
    campo.autocomplete = "off";
    campo.placeholder = "(11) 91234-5678";
    campo.value = telefoneBr(telefone);
    campo.setAttribute("aria-label", "telefone de " + l.username);
    var salvar = criar("button", "mini" + (telefone ? "" : " alerta"), "salvar");
    salvar.type = "submit";
    form.appendChild(campo);
    form.appendChild(salvar);
    form.addEventListener("submit", function (evento) {
      evento.preventDefault();
      salvar.disabled = true;
      chamar("telefone_salvar", { username: l.username, telefone: campo.value }, 45).then(function (d) {
        salvar.disabled = false;
        if (!d.ok) { recado(d.erro, d.detalhe); return; }
        acTelefones[l.username] = d.telefone;
        campo.value = telefoneBr(d.telefone);
        recado("telefone");
      });
    });
    tdTel.appendChild(form);
    if (!telefone) tdTel.appendChild(criar("span", "verm muted", "sem telefone"));

    var tdExpira = criar("td", l.vencido ? "muted" : "", l.expira || "—");
    var tdFaltam = criar("td", l.vencido ? "verm" : "", l.texto_dias || "—");
    var tdStatus = criar("td");
    tdStatus.appendChild(pilula(Number(l.status) === 1, "ativo", "parado"));
    var tdNota = criar("td", "muted", texto(l.notes));

    var tdAccoes = criar("td", "linha");
    tdAccoes.style.gap = "6px";
    if (l.vencido) {
      var recuperar = criar("button", "verde", "recuperar");
      recuperar.type = "button";
      recuperar.title = telefone || "sem telefone cadastrado";
      recuperar.addEventListener("click", function () {
        recuperar.disabled = true;
        recuperar.textContent = "enviando…";
        chamar("recuperar_um", { username: l.username, exp_iso: l.exp_iso }, 90).then(function (d) {
          recuperar.disabled = false;
          recuperar.textContent = "recuperar";
          if (!d.ok) { recado(d.erro, d.detalhe); return; }
          recado("recuperado", detalheRecuperacao(d));
        });
      });
      tdAccoes.appendChild(recuperar);
    }
    var apagar = criar("a", "pill", "apagar");
    apagar.href = "#apagar?linha_id=" + encodeURIComponent(l.id || "");
    tdAccoes.appendChild(apagar);

    [tdChk, tdLote, tdNome, tdTel, tdExpira, tdFaltam, tdStatus, tdNota, tdAccoes].forEach(function (c) {
      linha.appendChild(c);
    });
    return linha;
  }

  function detalheRecuperacao(d) {
    var foto = d.foto === "1" ? "com a foto da aba Recuperação"
      : d.foto === "desligada" ? "só texto: a foto está guardada, mas o envio dela está desligado — ligue no botão da aba Recuperação"
      : d.foto === "sem_foto" ? "só texto: ainda não há foto guardada na aba Recuperação" : "";
    return "texto enviado: \u201c" + d.dias + "\u201d (data tirada da " +
      (d.data === "linha" ? "linha do MC" : d.data === "espelho" ? "tabela espelho" : "nenhuma data encontrada") +
      ")" + (foto ? " · " + foto : "");
  }

  $("acBuscar").addEventListener("click", function () { carregarAcessos(1, $("acBusca").value.trim()); });
  $("acBusca").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); carregarAcessos(1, $("acBusca").value.trim()); } });

  // ------------------------------------------------------------------ MESCLAR

  var ordem = [];

  function dadosDaCaixa(caixa) {
    return {
      usuario: caixa.dataset.usuario, nota: caixa.dataset.nota, telefone: caixa.dataset.telefone,
      status: caixa.dataset.status, expira: caixa.dataset.expira,
    };
  }

  function escreverBloco(alvo, dados) {
    limpar(alvo);
    alvo.appendChild(criar("b", "", dados.usuario));
    alvo.appendChild(criar("div", "muted", "nota: " + (dados.nota || "(vazia)")));
    alvo.appendChild(criar("div", "muted", dados.status + " · vence " + dados.expira + " · " + (dados.telefone || "sem telefone")));
  }

  function atualizarBarraMescla() {
    var barra = $("mesclaBarra");
    barra.hidden = !document.body.classList.contains("mesclar");
    var textos = ["escolha 2 usuários", "falta 1 usuário", "2 escolhidos: o primeiro empresta para o segundo"];
    $("mesclaContagem").textContent = textos[ordem.length] || textos[0];
    $("btnConfirmar").disabled = ordem.length !== 2;
  }

  function sairMesclar() {
    ordem.forEach(function (c) { c.checked = false; });
    ordem = [];
    document.body.classList.remove("mesclar");
    $("btnMesclar").textContent = "Mesclar";
    $("modalMescla").hidden = true;
    atualizarBarraMescla();
  }

  $("btnMesclar").addEventListener("click", function () {
    if (document.body.classList.contains("mesclar")) return sairMesclar();
    document.body.classList.add("mesclar");
    $("btnMesclar").textContent = "Sair da mesclagem";
    atualizarBarraMescla();
  });

  document.addEventListener("change", function (evento) {
    var alvo = evento.target;
    if (!alvo.classList) return;
    if (alvo.classList.contains("mescla")) {
      if (alvo.checked) {
        if (ordem.length >= 2) {
          alvo.checked = false;
          $("mesclaContagem").textContent = "vale só 2 de cada vez";
          return;
        }
        ordem.push(alvo);
      } else ordem = ordem.filter(function (c) { return c !== alvo; });
      atualizarBarraMescla();
    }
    if (alvo.classList.contains("pula")) {
      if (alvo.checked) pular.add(alvo.value); else pular.delete(alvo.value);
      guardarPular();
      atualizarBarraLote();
    }
  });

  $("btnSairMesclar").addEventListener("click", sairMesclar);
  $("mdVoltar").addEventListener("click", function () { $("modalMescla").hidden = true; });

  $("btnConfirmar").addEventListener("click", function () {
    if (ordem.length !== 2) return;
    var origem = dadosDaCaixa(ordem[0]), destino = dadosDaCaixa(ordem[1]);
    escreverBloco($("mdOrigem"), origem);
    escreverBloco($("mdDestino"), destino);
    var aviso = $("mdAviso");
    if (!origem.telefone) {
      aviso.textContent = "Atenção: " + origem.usuario + " está sem telefone. Cadastre na caixinha dele antes de mesclar.";
    } else if (destino.telefone && destino.telefone !== origem.telefone) {
      aviso.textContent = "Atenção: " + destino.usuario + " já tem " + destino.telefone +
        " e vai passar a ter " + origem.telefone + ".";
    } else aviso.textContent = "Os dois vão ficar com o telefone " + origem.telefone + ".";
    $("modalMescla").hidden = false;
  });

  $("mdConfirmar").addEventListener("click", function () {
    if (ordem.length !== 2) return;
    var botao = $("mdConfirmar");
    botao.disabled = true;
    chamar("telefones_mesclar", { origem: ordem[0].value, destino: ordem[1].value }, 60).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      sairMesclar();
      recado("mesclado", "de " + d.de + " para " + d.para + " · telefone " + telefoneBr(d.tel));
      carregarAcessos(acPagina, acBusca);
    });
  });

  // ------------------------------------------------------------------ LOTE "não recuperados"

  var pular = carregarPular();

  function carregarPular() {
    try { return new Set(JSON.parse(localStorage.getItem(CHAVE_PULAR) || "[]")); } catch (e) { return new Set(); }
  }

  function guardarPular() {
    try { localStorage.setItem(CHAVE_PULAR, JSON.stringify(Array.from(pular))); } catch (e) { /* ignora */ }
  }

  function caixasPular() {
    return Array.prototype.slice.call(document.querySelectorAll("input.pula"));
  }

  function aplicarMarcasPular() {
    caixasPular().forEach(function (c) { c.checked = pular.has(c.value); });
  }

  function atualizarBarraLote() {
    var barra = $("loteBarra");
    if (barra) barra.hidden = !document.body.classList.contains("lote");
    var nestaPagina = caixasPular().filter(function (c) { return c.checked; }).length;
    var partes = [];
    if (!pular.size) partes.push("nenhum marcado: vai para TODOS os vencidos");
    else {
      if (nestaPagina) partes.push(nestaPagina + " marcado nesta página");
      if (pular.size > nestaPagina) partes.push((pular.size - nestaPagina) + " marcado em outra página");
    }
    var texto_ = $("loteContagem");
    if (texto_) texto_.textContent = partes.join(" · ");
  }

  function alternarLote() {
    if (document.body.classList.contains("lote")) return sairLote();
    sairMesclar();
    document.body.classList.add("lote");
    $("btnLote").textContent = "Sair dos não recuperados";
    $("btnLoteClientes").textContent = "Sair dos não recuperados";
    aplicarMarcasPular();
    atualizarBarraLote();
  }

  function sairLote() {
    document.body.classList.remove("lote");
    $("btnLote").textContent = "Não recuperados";
    $("btnLoteClientes").textContent = "Não recuperados";
    atualizarBarraLote();
  }

  $("btnLote").addEventListener("click", alternarLote);
  $("btnLoteClientes").addEventListener("click", alternarLote);
  $("btnSairLote").addEventListener("click", sairLote);
  $("btnDesmarcar").addEventListener("click", function () {
    pular.clear();
    guardarPular();
    caixasPular().forEach(function (c) { c.checked = false; });
    atualizarBarraLote();
  });

  // ------------------------------------------------------------------ motor dos lotes

  var lote = { tipo: "recuperar", rodando: false, limite: 0, vigia: null, tela: null, terminou: false, passo: null };

  /** Os três lotes (recuperação, exclusão, mensagem) andam no mesmo motor; o que muda é só onde
   *  cada peça está na tela. "p" é o prefixo dos ids do progresso. */
  function maquina(tipo) {
    if (tipo === "apagar") {
      return { p: "ap", revisar: "maRevisar", progresso: "maProgresso", modal: "modalApagar",
               faixa: "apAndamento", verbo: "apagados", parar: "Parar de apagar" };
    }
    if (tipo === "mensagem") {
      return { p: "mg", revisar: "mmRevisar", progresso: "mmProgresso", modal: "modalMensagem",
               faixa: "msAndamento", verbo: "enviados", parar: "Parar de enviar" };
    }
    return { p: "lp", revisar: "mlRevisar", progresso: "mlProgresso", modal: "modalLote",
             faixa: "loteAndamento", verbo: "enviados", parar: "Parar de enviar" };
  }

  function desenharProgresso(tipo, estado) {
    var total = estado.total || 0;
    var feitos = (estado.enviados || 0) + (estado.falhas || 0);
    var prefixo = maquina(tipo).p;
    var barra = $(prefixo + "Barra"), textoBotao = $(prefixo + "Texto");
    if (barra) barra.style.width = (total ? Math.round(100 * feitos / total) : 0) + "%";
    var erros = $(prefixo + "Erros");
    if (erros) {
      limpar(erros);
      (estado.erros || []).forEach(function (e) { erros.appendChild(criar("span", "", texto(e))); });
    }
    return { feitos: feitos, total: total, texto: textoBotao };
  }

  function motivoParada(codigo) {
    return {
      cota: "O GreenAPI está sem saldo de mensagens do mês: o lote parou.",
      chave_recusada: "O painel MC recusou a chave: o lote parou.",
      mc_login: "Não deu para logar no painel MC: o lote parou.",
      sem_texto: "A mensagem sumiu da lista congelada: o lote parou.",
      seguidas: "Três falhas seguidas: o lote parou para você conferir.",
      parou_manual: "Você parou o lote.",
      pulou_restou: "Você pulou o que faltava: a fila terminou sem enviar mais nada.",
    }[codigo] || "";
  }

  function rodarLote(tipo) {
    lote.tipo = tipo;
    lote.rodando = true;
    lote.terminou = false;
    lote.limite = 0;
    pedirTela();
    vigiar();
    lote.passo = function () {
      if (!lote.rodando) return;
      chamar("lote_item", { tipo: tipo }, 120).then(function (d) {
        if (!lote.rodando) return;
        if (!d.ok) {
          // O banco continua dizendo "rodando" enquanto o navegador desistiu: sem o lote_parar
          // a faixa fica acesa para sempre e o próximo lote trava em "já existe um lote rodando".
          pararLocal(tipo);
          chamar("lote_parar", { tipo: tipo }, 30).catch(function () {});
          recado(d.erro, d.detalhe);
          return;
        }
        var estado = d.estado || {};
        mostrarEstado(tipo, estado);
        // A aba da fila é o mesmo lote visto por dentro: atualiza junto, sem esperar o relógio.
        if (tipo === "recuperar" && TELA_ATUAL === "fila") carregarFila(false);
        if (d.terminado || !estado.rodando) {
          terminarLote(tipo, estado);
          return;
        }
        // Outro navegador com a mesma conta (celular e PC abertos) está com um item em mão:
        // o servidor devolve em_envio em vez de entregar o mesmo cliente duas vezes.
        esperar(Number(d.em_envio ? (d.esperar || 8) : (d.esperar || 0)) || 0.12);
      });
    };
    lote.passo();
  }

  /** A função devolve quantos segundos esperar antes do próximo item (0 = sem espera,
   *  como no lote de apagar). O que segura o lote vivo é o prazo, não o relógio da aba:
   *  o navegador congela a página em segundo plano e o setTimeout dorme junto — o vigia de
   *  um segundo só compara a hora, então ao acordar o prazo já venceu e o item sai na hora. */
  function esperar(segundos) {
    lote.limite = Date.now() + Math.max(0, Number(segundos || 0)) * 1000;
  }

  function vigiar() {
    if (lote.vigia) return;
    lote.vigia = setInterval(zelar, 1000);
  }

  function zelar() {
    if (!lote.rodando) {
      if (lote.vigia) { clearInterval(lote.vigia); lote.vigia = null; }
      return;
    }
    if (!lote.limite) { escreverPausa(0); return; }
    var falta = Math.ceil((lote.limite - Date.now()) / 1000);
    if (falta > 0) { escreverPausa(falta); return; }
    var passo = lote.passo;
    lote.limite = 0;
    escreverPausa(0);
    if (passo) passo();
  }

  /** Tela ligada = aba viva. No celular é isto que impede o navegador de congelar o lote
   *  quando a tela apaga; sem a API (ou negada) o resto do conserto continua valendo. */
  function pedirTela() {
    if (!navigator.wakeLock || !lote.rodando || document.hidden) return;
    navigator.wakeLock.request("screen").then(function (trava) {
      lote.tela = trava;
      trava.addEventListener("release", function () { if (lote.tela === trava) lote.tela = null; });
    }).catch(function () {});
  }

  function soltarTela() {
    if (!lote.tela) return;
    var trava = lote.tela;
    lote.tela = null;
    try { trava.release(); } catch (e) { /* já solta pelo navegador */ }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { lote.tela = null; return; }
    pedirTela();
    zelar();
  });

  function escreverPausa(segundos) {
    var valor = segundos ? "próxima mensagem em " + segundos + "s" : "";
    ["lpPausa", "mgPausa", "frPausa"].forEach(function (id) {
      var alvo = $(id);
      if (!alvo) return;
      alvo.hidden = !valor;
      alvo.textContent = valor;
    });
  }

  function pararTemporizador() {
    lote.limite = 0;
    escreverPausa(0);
  }

  /** Desliga o motor deste navegador sem encostar no banco. */
  function pararLocal(tipo) {
    lote.rodando = false;
    lote.limite = 0;
    if (lote.vigia) { clearInterval(lote.vigia); lote.vigia = null; }
    escreverPausa(0);
    soltarTela();
    var botao = $(maquina(tipo).p + "Parar");
    if (botao) { botao.hidden = true; botao.disabled = false; }
  }

  function mostrarEstado(tipo, estado) {
    var m = maquina(tipo);
    var apagar = m.verbo === "apagados";
    var desenhado = desenharProgresso(tipo, estado);
    var alvo = $(m.p + "Texto");
    if (alvo) {
      alvo.textContent = (estado.enviados || 0) + (apagar ? " apagados de " : " enviados de ") +
        desenhado.total + " · " + (estado.falhas || 0) + " com erro";
    }
    var faixa = $(m.faixa);
    if (faixa) {
      faixa.hidden = !estado.rodando;
      var textoFaixa = $(m.faixa + "Texto");
      if (textoFaixa) {
        textoFaixa.textContent = (estado.enviados || 0) + " de " + desenhado.total +
          (apagar ? " apagados" : " enviados");
      }
    }
  }

  function terminarLote(tipo, estado) {
    pararTemporizador();
    lote.rodando = false;
    if (lote.vigia) { clearInterval(lote.vigia); lote.vigia = null; }
    soltarTela();
    lote.terminou = true;
    var m = maquina(tipo);
    mostrarEstado(tipo, estado);
    var alvo = $(m.p + "Texto");
    if (alvo) {
      alvo.textContent = "terminou: " + (estado.enviados || 0) +
        (m.verbo === "apagados" ? " apagados, " : " enviados, ") + (estado.falhas || 0) + " com erro";
    }
    var parar = $(m.p + "Parar");
    if (parar) parar.hidden = true;
    if (estado.motivo) {
      var motivo = $(m.p + "Motivo");
      if (motivo) { motivo.textContent = motivoParada(estado.motivo); motivo.hidden = false; }
    }
    $(m.faixa).hidden = true;
  }

  function abrirProgresso(tipo, total) {
    var m = maquina(tipo);
    var revisar = $(m.revisar);
    var progresso = $(m.progresso);
    var modal = $(m.modal);
    if (revisar) revisar.hidden = true;
    if (progresso) progresso.hidden = false;
    if (modal) modal.hidden = false;
    var parar = $(m.p + "Parar");
    if (parar) { parar.hidden = false; parar.disabled = false; }
    var motivo = $(m.p + "Motivo");
    if (motivo) motivo.hidden = true;
    desenharProgresso(tipo, { total: total, enviados: 0, falhas: 0, erros: [] });
    rodarLote(tipo);
  }

  function pararLote(tipo) {
    var m = maquina(tipo);
    var botao = $(m.p + "Parar");
    if (botao) { botao.disabled = true; botao.textContent = "parando…"; }
    return chamar("lote_parar", { tipo: tipo }, 30).then(function () {
      pararTemporizador();
      lote.rodando = false;
      soltarTela();
      if (botao) { botao.disabled = false; botao.textContent = m.parar; }
    });
  }

  $("lpParar").addEventListener("click", function () { pararLote("recuperar"); });
  $("apParar").addEventListener("click", function () { pararLote("apagar"); });
  $("mgParar").addEventListener("click", function () { pararLote("mensagem"); });

  function fecharLote(tipo) {
    var modal = $(maquina(tipo).modal);
    if (modal) modal.hidden = true;
    if (lote.terminou) {
      lote.terminou = false;
      if (tipo === "apagar") irPara("#deletar");
      else if (tipo === "mensagem") carregarClientes();
      else carregarAcessos(acPagina, acBusca);
    }
  }

  $("lpFechar").addEventListener("click", function () { fecharLote("recuperar"); });
  $("mlVoltar").addEventListener("click", function () { $("modalLote").hidden = true; });
  $("apFechar").addEventListener("click", function () { fecharLote("apagar"); });
  $("maVoltar").addEventListener("click", function () { $("modalApagar").hidden = true; });
  $("mgFechar").addEventListener("click", function () { fecharLote("mensagem"); });
  $("mpFechar").addEventListener("click", function () { $("modalPix").hidden = true; });
  $("msVoltar").addEventListener("click", function () { $("modalMensagem").hidden = true; });
  $("btnVerEnvio").addEventListener("click", function () { $("modalLote").hidden = false; });
  $("btnVerExclusao").addEventListener("click", function () { $("modalApagar").hidden = false; });
  $("btnVerMensagem").addEventListener("click", function () { $("modalMensagem").hidden = false; });

  document.addEventListener("keydown", function (evento) {
    if (evento.key !== "Escape") return;
    $("modalMescla").hidden = true;
    $("modalPix").hidden = true;
    if (!$("modalLote").hidden) fecharLote("recuperar");
    if (!$("modalApagar").hidden) fecharLote("apagar");
    if (!$("modalMensagem").hidden) fecharLote("mensagem");
  });

  // ------------------------------------------------------------------ lote RECUPERAR

  /** O recado do modal fica dentro dele, como no painel antigo — a contagem é longa e
   *  a mensagem do topo da página se perderia quando o modal estiver aberto. */
  function avisoLote(mensagem) {
    var caixa = $("mlAviso");
    caixa.textContent = mensagem || "";
    caixa.hidden = !mensagem;
  }

  $("btnRevisarLote").addEventListener("click", function () {
    $("mlRevisar").hidden = false;
    $("mlProgresso").hidden = true;
    $("mlAviso").hidden = true;
    fonteTrocada = false;
    foraDoMC = 0;
    $("mlFonte").value = fonteLote();
    desenharFonteLote();
    $("modalLote").hidden = false;
    contarRecuperar();
  });

  $("mlFonte").addEventListener("change", function () {
    guardarFonteLote($("mlFonte").value);
    // Escolheu ele, não o modal: nesta abertura não troco mais a fonte sozinho.
    fonteTrocada = true;
    desenharFonteLote();
    contarRecuperar();
  });

  /** O painel MC tem 14 linhas e os clientes importados por CSV só existem no espelho, então a
   *  lista maior é o banco: quem nunca escolheu cai no espelho e nem espera a varrida do MC. A
   *  escolha fica guardada porque a conferência e a fila do zero precisam sair da mesma lista. */
  function fonteLote() {
    try { return localStorage.getItem(CHAVE_FONTE) === "mc" ? "mc" : "espelho"; } catch (e) { return "espelho"; }
  }

  var fonteTrocada = false;   // se este modal já pulou sozinho ou se ele escolheu a fonte à mão
  var foraDoMC = 0;           // quantos vencidos a varrida do painel MC deixou de fora

  function guardarFonteLote(valor) {
    try { localStorage.setItem(CHAVE_FONTE, valor === "espelho" ? "espelho" : "mc"); } catch (e) { /* ignora */ }
  }

  function desenharFonteLote() {
    var espelho = fonteLote() === "espelho";
    var nota = $("mlFonteNota");
    if (nota) {
      nota.textContent = espelho
        ? "A lista sai do banco, da aba Clientes, sem abrir o painel MC: entra todo vencido que tem telefone guardado, inclusive quem nunca teve linha no MC."
        : "A função abre o painel MC página por página e pega quem está vencido lá, como sempre fez.";
    }
    var rótulo = $("frMontarNota");
    if (rótulo) {
      rótulo.textContent = espelho
        ? "refaz a fila com os vencidos do espelho (aba Clientes) e as marcas \u201cpular\u201d \u2014 não envia nada"
        : "varre o painel MC de novo, com as marcas \u201cpular\u201d \u2014 não envia nada";
    }
  }

  function contarRecuperar() {
    $("mlEnviar").disabled = true;
    $("mlAlvos").textContent = "…";
    $("mlVencidos").textContent = "…";
    recado("");
    chamar("lote_contagem", {
      tipo: "recuperar", q: acBusca, pular: Array.from(pular), fonte: fonteLote(),
    }, 180).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var espelho = d.fonte === "espelho";
      $("mlRotVencidos").textContent = espelho ? "vencidos no espelho" : "vencidos no painel MC";
      $("mlRotFora").textContent = espelho ? "desses, já têm linha no MC" : "só no espelho, sem linha no MC";
      $("mlAlvos").textContent = d.alvos;
      $("mlVencidos").textContent = d.vencidos;
      $("mlPulados").textContent = d.pulados;
      $("mlSemTelefone").textContent = d.sem_telefone;
      $("mlEsperando").textContent = d.esperando;
      $("mlBloqueados").textContent = d.bloqueados || 0;
      $("mlForaMC").textContent = espelho ? d.com_linha_mc : d.so_no_espelho;
      $("mlFoto").textContent = d.foto ? "sim, a foto da aba Recuperação" : "não — vai só o texto";
      $("mlBusca").textContent = (d.busca
        ? "Filtro \u201c" + d.busca + "\u201d ativo: só entra na conta quem bate nesse filtro."
        : espelho
          ? "Sem filtro: todos os vencidos guardados no banco (aba Clientes)."
          : "Sem filtro: a varrida pega todas as páginas do painel MC.") +
        (d.marcados > d.pulados ? " " + (d.marcados - d.pulados) + " marcado(s) não estavam entre os vencidos." : "");
      var fora = $("mlFora");
      fora.hidden = !d.so_no_espelho;
      fora.textContent = d.so_no_espelho
        ? ("Ficam de fora porque a linha não existe mais no painel MC (só no espelho): " +
          (d.fora_do_mc || []).join(", ") +
          (d.so_no_espelho > (d.fora_do_mc || []).length ? "…" : "") +
          " — troque para \u201cvencidos do espelho\u201d acima para enviar também para eles.")
        : "";
      // A varredura do painel MC deixa de fora todo vencido cuja linha foi apagada de lá (ou nunca
      // existiu): se sobrou gente fora e ele não escolheu a fonte à mão, o modal refaz a conta com
      // o espelho, que é a lista da aba Clientes.
      if (!fonteTrocada && d.fonte === "mc" && d.so_no_espelho) {
        fonteTrocada = true;
        foraDoMC = d.so_no_espelho;
        guardarFonteLote("espelho");
        $("mlFonte").value = "espelho";
        desenharFonteLote();
        contarRecuperar();
        return;
      }
      var nomes = limpar($("mlNomes"));
      (d.primeiros || []).forEach(function (n) { nomes.appendChild(criar("span", "", n)); });
      var enviar = $("mlEnviar");
      enviar.disabled = !d.alvos;
      if (!d.alvos) avisoLote("Ninguém sobrou para enviar. Desmarque alguém na coluna pular ou salve o telefone na linha.");
      else if (d.aviso) avisoLote("A varrida parou antes do fim: " + d.aviso);
      else avisoLote("");
      if (foraDoMC) {
        $("mlBusca").textContent = "O modal trocou sozinho para os vencidos do espelho: a varredura do " +
          "painel MC deixou " + foraDoMC + " vencido(s) de fora. " + $("mlBusca").textContent;
      }
    });
  }

  $("mlEnviar").addEventListener("click", function () {
    var botao = $("mlEnviar");
    botao.disabled = true;
    botao.textContent = "abrindo o envio…";
    chamar("lote_executar", { tipo: "recuperar", confirmar: "sim" }, 60).then(function (d) {
      botao.textContent = "Sim, enviar para todos";
      if (!d.ok) { botao.disabled = false; recado(d.erro, d.detalhe); return; }
      abrirProgresso("recuperar", d.total);
    });
  });

  // ------------------------------------------------------------------ NÃO RECUPERADOS: fila viva

  var frDados = null;          // última resposta de lote_fila
  var frMarcados = [];         // posições escolhidas para tirar da fila
  var frSelecionando = false;
  var frArmado = false;        // "tirar da fila" precisa de dois toques
  var frSoErro = false;
  var frPulando = false;       // um "pular agora" por vez
  var frTemporizador = null;
  var FR_TOPO = 200;           // lista longa demais travaria o celular no meio do envio

  CARREGA.fila = function () {
    desenharFonteLote();
    frLimparSelecao();
    carregarFila(true);
  };

  function frPill(situacao) {
    if (situacao === "enviado") return criar("span", "pill on", "enviado");
    if (situacao === "falhou") return criar("span", "pill", "falhou");
    if (situacao === "enviando") return criar("span", "pill", "enviando…");
    if (situacao === "fora") return criar("span", "muted", "fora da fila");
    if (situacao === "pulou") return criar("span", "muted", "pulou (você mandou pular)");
    if (situacao === "bloqueado") return criar("span", "muted", "bloqueou (respondeu não)");
    return criar("span", "muted", "na fila");
  }

  /** O GreenAPI responde "aceitei" na hora; a única prova de que chegou ao aparelho do
   *  cliente é o status que chega pelo webhook. Sem ele, "enviado" quer dizer "saiu daqui". */
  function frEntrega(item) {
    if (item.situacao !== "enviado") return "";
    var bruto = String(item.entrega || "");
    if (!bruto) return "sem confirmação do WhatsApp";
    var espaco = bruto.indexOf(" ");
    var codigo = espaco < 0 ? bruto : bruto.slice(0, espaco);
    var resto = espaco < 0 ? "" : bruto.slice(espaco);
    if (codigo === "PENDING") return "no servidor do WhatsApp" + resto;
    if (codigo === "SERVER_ACK") return "entregue ao WhatsApp" + resto;
    if (codigo === "DELIVERY_ACK") return "chegou no celular" + resto;
    if (codigo === "READ") return "lida pelo cliente" + resto;
    if (codigo === "FAILED") return "o WhatsApp recusou" + resto;
    return bruto;
  }

  function frEscolhido(item) {
    return frSelecionando && item.situacao === "fila";
  }

  function desenharFila() {
    var d = frDados;
    if (!d) return;
    var estado = d.estado || {}, itens = d.itens || [];
    var total = Number(d.total || 0), fora = Number(d.fora || 0), pulados = Number(d.pulados || 0);
    var feitos = (estado.enviados || 0) + (estado.falhas || 0);
    var alvo = Math.round(100 * feitos / Math.max(1, total - fora - pulados));
    $("frBarra").style.width = Math.min(100, Math.max(0, alvo)) + "%";

    var partes = [];
    if (!d.vazia) {
      partes.push(d.fonte === "espelho" ? "lista do espelho (Clientes)" : "lista do painel MC");
      partes.push(d.na_fila + " na fila");
      partes.push((estado.enviados || 0) + " enviados");
      partes.push((estado.falhas || 0) + " com erro");
      if (fora) partes.push(fora + " fora da fila");
      if (pulados) partes.push(pulados + " pulados por você");
      if (d.bloqueados) partes.push(d.bloqueados + " bloquearam (responderam não)");
      partes.push(total + " no total");
    }
    $("frResumo").textContent = d.vazia ? "nenhuma fila montada ainda" : partes.join(" · ");

    var vivo = $("frVivo"), atual = estado.enviando === null || estado.enviando === undefined
      ? null : itens.find(function (i) { return Number(i.i) === estado.enviando; });
    vivo.hidden = true;
    if (estado.rodando && atual) {
      vivo.hidden = false;
      vivo.textContent = "enviando agora para " + atual.usuario + " (#" + (atual.i + 1) + " de " + total + ")";
    } else if (estado.rodando) {
      vivo.hidden = false;
      vivo.textContent = "o envio está rodando neste momento";
    } else if (!d.vazia && estado.motivo) {
      vivo.hidden = false;
      vivo.textContent = motivoParada(estado.motivo) || "o lote está parado.";
    }

    // A função já devolve a janela certa (com os erros, quando ele pede só eles): aqui é só desenho.
    var caixa = limpar($("frLista"));
    itens.slice(0, FR_TOPO).forEach(function (item) {
      var linha = criar("label", "item" +
        (item.situacao === "fora" || item.situacao === "pulou" || item.situacao === "bloqueado" ? " fora" : ""));
      if (frEscolhido(item)) {
        var marca = document.createElement("input");
        marca.type = "checkbox";
        marca.value = String(item.i);
        marca.checked = frMarcados.indexOf(item.i) >= 0;
        marca.setAttribute("aria-label", "tirar " + item.usuario + " da fila");
        marca.addEventListener("change", function () {
          var posicao = frMarcados.indexOf(item.i);
          if (marca.checked && posicao < 0) frMarcados.push(item.i);
          if (!marca.checked && posicao >= 0) frMarcados.splice(posicao, 1);
          frArmado = false;
          atualizarFrBarra();
        });
        linha.appendChild(marca);
      }
      linha.appendChild(criar("b", "", "#" + (item.i + 1) + " " + item.usuario));
      linha.appendChild(frPill(item.situacao));
      linha.appendChild(criar("span", "muted",
        (item.telefone || "sem telefone") + (item.vencido ? " · " + item.vencido : "")));
      var entrega = frEntrega(item);
      if (entrega) {
        linha.appendChild(criar("span", "muted" + (entrega.indexOf("recusou") >= 0 ? " verm" : ""), entrega));
      }
      if (item.erro) linha.appendChild(criar("span", "muted verm", item.erro));
      caixa.appendChild(linha);
    });

    var topo = $("frTopo"), visiveis = Number(d.mostraveis || 0);
    topo.hidden = itens.length >= visiveis;
    if (!topo.hidden) {
      topo.textContent = frSoErro
        ? "mostrando " + itens.length + " dos " + visiveis + " com erro — os outros continuam no mesmo lugar."
        : "mostrando as linhas " + (Number(d.desde || 0) + 1) + " a " + d.ate + " de " + total +
          " — a fila anda sozinha para onde o envio está.";
    }
    var vazia = $("frVazia");
    vazia.hidden = !d.vazia;
    if (d.vazia) {
      vazia.textContent = "A fila aparece aqui depois que você aperta Não recuperados na aba Acessos " +
        "ou Clientes e revise a contagem. Ela é a mesma lista, vista por dentro.";
    }
    if (frSoErro && !d.vazia && !itens.length) {
      limpar(caixa).appendChild(criar("p", "muted", "ninguém com erro até agora — todo envio conseguiu."));
    }

    $("frBarraAccoes").hidden = Boolean(d.vazia);
    frPularEstado();
    $("frParar").hidden = !estado.rodando;
    $("frRetomar").hidden = Boolean(estado.rodando) || !d.na_fila;
    $("frSelecionar").hidden = Boolean(estado.rodando);
    $("frTirar").hidden = !(frSelecionando && !estado.rodando);
    $("frFiltro").textContent = frSoErro ? "Ver a fila toda" : "Ver só os com erro";
    $("frMontar").disabled = Boolean(estado.rodando);
    atualizarFrBarra();
    frProgramar();
  }

  function atualizarFrBarra() {
    var marcados = $("frMarcados");
    marcados.hidden = !frSelecionando;
    if (frSelecionando) {
      marcados.textContent = frMarcados.length
        ? frMarcados.length + " linha(s) marcada(s) para sair da fila."
        : "Marque quem não deve receber mais nada nesta fila.";
    }
    var botao = $("frTirar");
    if (!frArmado) botao.textContent = "Tirar da fila";
  }

  /** O campo "pular envios" mora acima da fila, justamente para não precisar rolar a tela no
   *  celular no meio do envio. Ele só existe enquanto há alguém para sair, e o número vale para
   *  os próximos: quem está no ar neste instante já saiu e não entra na conta. */
  function frPularEstado() {
    var d = frDados;
    var restam = d ? Number(d.na_fila || 0) : 0;
    var botao = $("frPular");
    $("frPularCaixa").hidden = !d || Boolean(d.vazia) || restam <= 0;
    botao.disabled = frPulando || restam <= 0;
    botao.textContent = frPulando ? "pulando…" : "Pular agora";
    $("frPularNota").textContent = restam && !frPulando
      ? "faltam " + restam + " para sair · não conta o que está no ar agora"
      : "";
  }

  function frLimparSelecao() {
    frSelecionando = false;
    frArmado = false;
    frMarcados = [];
    $("frSelecionar").textContent = "Selecionar";
  }

  function carregarFila(mostrarErro) {
    return chamar("lote_fila", { tipo: "recuperar", so_erro: frSoErro, janela: FR_TOPO }, 60).then(function (d) {
      if (!d.ok) {
        if (mostrarErro) recado(d.erro, d.detalhe);
        return;
      }
      frDados = d;
      desenharFila();
    });
  }

  /** Enquanto o lote corre, a tela se refaz sozinha: assim o "enviando…" aparece mesmo
   *  quando o envio foi começado em outra aba ou em outro aparelho. */
  function frProgramar() {
    if (frTemporizador) { clearTimeout(frTemporizador); frTemporizador = null; }
    var d = frDados;
    if (!d || TELA_ATUAL !== "fila") return;
    if (!(d.estado || {}).rodando && !lote.rodando) return;
    frTemporizador = setTimeout(function () {
      frTemporizador = null;
      carregarFila(false);
    }, 4000);
  }

  $("frAtualizar").addEventListener("click", function () {
    var botao = $("frAtualizar");
    botao.disabled = true;
    carregarFila(true).then(function () { botao.disabled = false; });
  });

  $("frFiltro").addEventListener("click", function () {
    frSoErro = !frSoErro;
    // Quem procura os erros agora é a função, para a tela não ter de baixar a fila inteira
    // só para filtrar: sem isso o "Ver só os com erro" continuaria pedindo os 17.000 nomes.
    carregarFila(false);
  });

  $("frSelecionar").addEventListener("click", function () {
    frSelecionando = !frSelecionando;
    if (!frSelecionando) { frMarcados = []; frArmado = false; }
    $("frSelecionar").textContent = frSelecionando ? "Parar de selecionar" : "Selecionar";
    desenharFila();
  });

  $("frParar").addEventListener("click", function () {
    var botao = $("frParar");
    botao.disabled = true;
    botao.textContent = "parando…";
    pararLote("recuperar").then(function () {
      botao.disabled = false;
      botao.textContent = "Parar o envio";
      return carregarFila(false);
    });
  });

  $("frRetomar").addEventListener("click", function () {
    var botao = $("frRetomar");
    botao.disabled = true;
    botao.textContent = "retomando…";
    chamar("lote_retomar", { tipo: "recuperar" }, 45).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Retomar de onde parou";
      if (!d.ok) { recado(d.erro, d.detalhe); carregarFila(false); return; }
      recado("fila_retomou");
      if (!lote.rodando) rodarLote("recuperar");
      carregarFila(false);
    });
  });

  $("frTirar").addEventListener("click", function () {
    var botao = $("frTirar");
    if (!frMarcados.length) { recado("sem_marca"); return; }
    if (!frArmado) {
      frArmado = true;
      botao.textContent = "Confirmar: tirar " + frMarcados.length + " da fila";
      return;
    }
    frArmado = false;
    botao.disabled = true;
    botao.textContent = "tirando…";
    chamar("lote_tirar", { tipo: "recuperar", indices: frMarcados }, 60).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Tirar da fila";
      if (!d.ok) { recado(d.erro, d.detalhe); carregarFila(false); return; }
      recado("fila_tirar", d.fora + " cliente(s) saíram da fila.");
      frMarcados = [];
      carregarFila(false);
    });
  });

  function pularEnviosDaFila() {
    if (frPulando) return;
    var quantos = Math.trunc(Number($("frPularQtd").value));
    if (!quantos || quantos < 1) { recado("quantidade_invalida"); return; }
    frPulando = true;
    frPularEstado();
    chamar("lote_pular", { tipo: "recuperar", quantos: quantos }, 45).then(function (d) {
      frPulando = false;
      if (!d.ok) { recado(d.erro, d.detalhe); frPularEstado(); return; }
      recado("fila_pulou", d.pulados + " de " + quantos + " pulados.");
      $("frPularQtd").value = "";
      carregarFila(false);
    });
  }

  $("frPular").addEventListener("click", pularEnviosDaFila);
  $("frPularQtd").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    pularEnviosDaFila();
  });

  $("frMontar").addEventListener("click", function () {
    var botao = $("frMontar");
    botao.disabled = true;
    botao.textContent = "refazendo a fila…";
    $("frMontarNota").textContent = "isso só monta a lista: nenhuma mensagem sai";
    chamar("lote_contagem", { tipo: "recuperar", pular: Array.from(pular), fonte: fonteLote() }, 180).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Montar a fila do zero";
      if (!d.ok) { recado(d.erro, d.detalhe); desenharFonteLote(); return; }
      recado("fila_montada", d.alvos + " na fila, " + d.pulados + " pulados, " + d.sem_telefone + " sem telefone.");
      frSoErro = false;
      carregarFila(false);
    });
  });

  // ------------------------------------------------------------------ clientes

  CARREGA.clientes = function () { carregarClientes(1, clBusca); };
  var clPagina = 1, clBusca = "";

  function carregarClientes(pagina, busca) {
    clPagina = pagina || clPagina;
    clBusca = busca === undefined ? clBusca : busca;
    chamar("clientes_ver", { pagina: clPagina, q: clBusca }, 120).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var linhas = d.linhas || [], info = d.info || {};
      var naBase = info.na_base || 0;
      $("clResumo").textContent = (clBusca
        ? info.encontrados + " de " + naBase + " clientes batem com \u201c" + clBusca + "\u201d"
        : naBase + " clientes") +
        " · " + info.com_telefone + " com telefone" +
        (info.so_agenda ? " · " + info.so_agenda + " só na agenda" : "") +
        (info.sincronizado ? " · última sincronização " + info.sincronizado : "");
      $("clAvisoLista").textContent = linhas.length
        ? "Corrija ou cadastre o número na caixinha e toque salvar — a máscara já formata (DDD) nnnnn-nnnn e o 55 entra sozinho."
        : "";
      $("clBarraLote").hidden = !naBase;
      var corpo = limpar($("clLinhas"));
      if (!linhas.length) {
        corpo.appendChild(criar("p", "muted", clBusca
          ? "Ninguém na base bate com \u201c" + clBusca + "\u201d — o campo procura usuário, nome, CPF, telefone e nota."
          : "Nada no espelho ainda. Use \"Sincronizar agora\" ou abra a tela Acessos — cada página aberta já grava aqui."));
      }
      linhas.forEach(function (c) { corpo.appendChild(linhaCliente(c)); });
      paginarClientes(info);
      aplicarMarcasPular();
      atualizarBarraLote();
    });
  }

  /** A lista inteira na tela travava o navegador, então a página vem do banco de 900 em 900. */
  function paginarClientes(info) {
    var caixa = limpar($("clPaginacao"));
    if ((info.paginas || 1) <= 1 && !clBusca) return;
    if (clPagina > 1) caixa.appendChild(linkPaginaClientes(clPagina - 1, "‹ anterior"));
    caixa.appendChild(criar("span", "muted", " página " + info.pagina + " de " + info.paginas +
      " · " + info.encontrados + " nesta busca · " + info.por_pagina + " por vez "));
    if (clPagina < info.paginas) caixa.appendChild(linkPaginaClientes(clPagina + 1, "próxima ›"));
  }

  function linkPaginaClientes(pagina, rotulo) {
    var a = criar("a", "", rotulo);
    a.href = "#clientes";
    a.addEventListener("click", function (evento) {
      evento.preventDefault();
      carregarClientes(pagina, clBusca);
    });
    return a;
  }

  $("clBuscar").addEventListener("click", function () { carregarClientes(1, $("clBusca").value.trim()); });
  $("clBusca").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); carregarClientes(1, $("clBusca").value.trim()); }
  });
  $("clLimpar").addEventListener("click", function () {
    $("clBusca").value = "";
    carregarClientes(1, "");
  });

  function linhaCliente(c) {
    var linha = document.createElement("tr");
    var tdLote = criar("td", "lote");
    // O vencido entra na marcação pelo lote de recuperação; quem só tem telefone na agenda entra
    // pela mensagem comum — sem essa caixinha ele não teria como ficar de fora.
    if (c.vencido || !c.linha_id) {
      var pula = document.createElement("input");
      pula.type = "checkbox";
      pula.className = "pula";
      pula.value = c.username;
      pula.dataset.usuario = c.username;
      pula.setAttribute("aria-label", "não mandar para " + c.username);
      tdLote.appendChild(pula);
    } else tdLote.appendChild(criar("span", "muted", "—"));

    var tdNome = criar("td");
    tdNome.appendChild(criar("b", "", c.username));

    // O nome e o CPF vêm da lista colada com PIX (cliente_pix), não do painel MC: sem esta
    // coluna a busca por nome ou CPF acharia linhas que não mostram o que foram achar.
    var tdPix = criar("td");
    if (c.nome || c.cpf) {
      tdPix.appendChild(criar("span", "", texto(c.nome || "—")));
      if (c.cpf) {
        tdPix.appendChild(document.createElement("br"));
        tdPix.appendChild(criar("span", "muted", c.cpf));
      }
    } else tdPix.appendChild(criar("span", "muted", "—"));

    var tdTel = criar("td");
    var form = document.createElement("form");
    form.className = "tel";
    var campo = document.createElement("input");
    campo.type = "tel";
    campo.className = "maq";
    campo.autocomplete = "off";
    campo.placeholder = "(11) 91234-5678";
    campo.value = telefoneBr(c.telefone);
    campo.setAttribute("aria-label", "telefone de " + c.username);
    var salvar = criar("button", "mini" + (c.telefone ? "" : " alerta"), "salvar");
    salvar.type = "submit";
    form.appendChild(campo); form.appendChild(salvar);
    form.addEventListener("submit", function (evento) {
      evento.preventDefault();
      salvar.disabled = true;
      chamar("telefone_salvar", { username: c.username, telefone: campo.value }, 45).then(function (d) {
        salvar.disabled = false;
        if (!d.ok) { recado(d.erro, d.detalhe); return; }
        campo.value = telefoneBr(d.telefone);
        recado("telefone");
      });
    });
    tdTel.appendChild(form);
    if (!c.telefone) tdTel.appendChild(criar("span", "verm muted", "sem telefone"));

    var tdExpira = criar("td", "", c.expira || "—");
    var tdFaltam = criar("td", c.vencido ? "verm" : "", c.texto_dias || "—");
    var tdStatus = criar("td");
    tdStatus.appendChild(pilula(Boolean(c.ativo), "ativo", "parado"));
    var tdNota = criar("td", "muted", texto(c.notes));
    var tdAccoes = criar("td", "linha");
    tdAccoes.style.gap = "6px";
    if (c.vencido) {
      var recuperar = criar("button", "verde", "recuperar");
      recuperar.type = "button";
      recuperar.title = telefoneBr(c.telefone) || "sem telefone cadastrado";
      recuperar.addEventListener("click", function () {
        recuperar.disabled = true;
        recuperar.textContent = "enviando…";
        chamar("recuperar_um", { username: c.username, exp_iso: c.exp_iso, destino: "clientes" }, 90).then(function (d) {
          recuperar.disabled = false;
          recuperar.textContent = "recuperar";
          if (!d.ok) { recado(d.erro, d.detalhe); return; }
          recado("recuperado", detalheRecuperacao(d));
        });
      });
      tdAccoes.appendChild(recuperar);
    }
    var mensagem = criar("button", "mini", "mensagem");
    mensagem.type = "button";
    mensagem.title = telefoneBr(c.telefone) || "sem telefone cadastrado";
    mensagem.addEventListener("click", function () { abrirMensagem(c); });
    tdAccoes.appendChild(mensagem);
    [tdLote, tdNome, tdPix, tdTel, tdExpira, tdFaltam, tdStatus, tdNota, tdAccoes].forEach(function (c2) {
      linha.appendChild(c2);
    });
    return linha;
  }

  // ---------------------------------------------------------- mensagem avulsa (sem painel MC)

  var msModo = "lote";      // "lote" = a lista da aba; "um" = só o cliente do botão da linha
  var msAlvo = null;        // a linha da tabela quando msModo === "um"
  var msEspera = null;      // o tempo entre digitar e contar no servidor
  var msTrocado = false;    // se este modal já pulo sozinho para "a lista inteira"

  function msCorpo() { return $("msCorpo").value.trim(); }

  function msAviso(mensagem) {
    var caixa = $("msAviso");
    caixa.textContent = mensagem || "";
    caixa.hidden = !mensagem;
  }

  function msLimparConta() {
    ["msAlvos", "msNaLista", "msSemLinha", "msPulados", "msSemTelefone", "msEsperando", "msBloqueados"].forEach(function (id) {
      $(id).textContent = "?";
    });
    limpar($("msNomes"));
  }

  function msDesenhar() {
    var um = msModo === "um";
    $("msEscolha").hidden = um;
    $("msNumeros").hidden = um;
    $("msParNomes").hidden = um;
    $("msParaUm").hidden = !um;
    $("msContagem").textContent = $("msCorpo").value.length;
    if (um) {
      $("msTitulo").textContent = "Mensagem para " + msAlvo.username;
      $("msParaUm").textContent = "Vai receber: " + msAlvo.username + " no número " +
        (telefoneBr(msAlvo.telefone) || "que ainda não está cadastrado");
      $("msEnviar").disabled = !msCorpo();
    } else {
      $("msTitulo").textContent = "Mensagem em massa pelo WhatsApp";
      $("msEnviar").textContent = "Sim, enviar";
    }
  }

  function msQuemNota() {
    $("msQuemNota").textContent = $("msQuem").value === "todos"
      ? "Todo mundo que aparece na aba Clientes com telefone guardado, inclusive quem ainda tem linha no painel MC."
      : "Só quem aparece na aba Clientes sem linha no painel MC \u2014 a lista dos que foram apagados de lá. " +
        "O número vem da agenda de telefones, então o painel MC não é consultado em nada.";
  }

  /** A conta é sempre no servidor, com a lista que a aba Clientes mostra e as marcas "pular"
   *  deste navegador. Ela também congela o plano do lote, então o texto digitado é o que sai. */
  function msContar() {
    if (msEspera) clearTimeout(msEspera);
    if (msModo === "um") return;
    var corpo = msCorpo();
    $("msEnviar").disabled = true;
    if (!corpo) { msLimparConta(); msAviso(""); return; }
    msEspera = setTimeout(function () {
      msEspera = null;
      chamar("lote_contagem", { tipo: "mensagem", texto: corpo, quem: $("msQuem").value, pular: Array.from(pular) }, 180)
        .then(function (d) {
          // Ele pode ter continuado digitando enquanto a conta vinha: resposta velha é jogada fora.
          if (msCorpo() !== corpo || msModo !== "lote") return;
          if (!d.ok) { msLimparConta(); msAviso(mensagemDetalhada(d)); return; }
          $("msAlvos").textContent = d.alvos;
          $("msNaLista").textContent = d.na_lista;
          $("msSemLinha").textContent = d.sem_linha_mc;
          $("msPulados").textContent = d.pulados;
          $("msSemTelefone").textContent = d.sem_telefone;
          $("msEsperando").textContent = d.esperando;
          $("msBloqueados").textContent = d.bloqueados || 0;
          // Os dois grupos da lista aparecem no seletor já com o tamanho de cada um.
          var opcoes = $("msQuem").options;
          opcoes[0].textContent = "só quem NÃO está no painel MC (" + d.sem_linha_mc + " na lista)";
          opcoes[1].textContent = "a lista inteira da aba Clientes (" + d.na_lista + " na lista)";
          // Não sobrou ninguém fora do MC: a única lista que ainda tem alvo é a inteira, e o modal
          // cai nela sozinho em vez de deixar o botão morto com a conta em zero.
          if (!msTrocado && $("msQuem").value === "fora" && !d.alvos && !d.sem_linha_mc && d.na_lista) {
            msTrocado = true;
            $("msQuem").value = "todos";
            msQuemNota();
            msContar();
            return;
          }
          var nomes = limpar($("msNomes"));
          (d.primeiros || []).forEach(function (n) { nomes.appendChild(criar("span", "", n)); });
          var enviar = $("msEnviar");
          enviar.textContent = "Sim, enviar para " + d.alvos;
          enviar.disabled = !d.alvos;
          msAviso(d.alvos ? "" : "Ninguém sobrou para enviar: desmarque alguém na coluna pular ou salve o " +
            "telefone na linha — embaixo de \"para quem vai\" dá para trocar para a lista inteira.");
        });
    }, 600);
  }

  function abrirMensagem(alvo) {
    msAlvo = alvo || null;
    msModo = alvo ? "um" : "lote";
    msTrocado = false;
    $("mmRevisar").hidden = false;
    $("mmProgresso").hidden = true;
    msAviso("");
    msQuemNota();
    $("modalMensagem").hidden = false;
    msDesenhar();
    msContar();
  }

  $("btnMensagemLote").addEventListener("click", function () { abrirMensagem(null); });
  $("msCorpo").addEventListener("input", function () { msDesenhar(); msContar(); });
  $("msQuem").addEventListener("change", function () { msQuemNota(); msContar(); });

  $("msEnviar").addEventListener("click", function () {
    var botao = $("msEnviar");
    var corpo = msCorpo();
    if (!corpo) { msAviso("Escreva a mensagem antes de enviar."); return; }
    botao.disabled = true;
    if (msModo === "um") {
      botao.textContent = "enviando…";
      chamar("mensagem_um", {
        username: msAlvo.username, telefone: texto(msAlvo.telefone), exp_iso: texto(msAlvo.exp_iso), texto: corpo,
      }, 90).then(function (d) {
        botao.textContent = "Sim, enviar";
        if (!d.ok) { botao.disabled = false; msAviso(mensagemDetalhada(d)); return; }
        $("modalMensagem").hidden = true;
        recado("mensagem_enviada", telefoneBr(d.telefone) + " · " + d.caracteres + " caracteres");
      });
      return;
    }
    botao.textContent = "abrindo o envio…";
    chamar("lote_executar", { tipo: "mensagem", confirmar: "sim" }, 60).then(function (d) {
      botao.textContent = "Sim, enviar para " + $("msAlvos").textContent;
      if (!d.ok) { botao.disabled = false; msAviso(mensagemDetalhada(d)); return; }
      abrirProgresso("mensagem", d.total);
    });
  });

  $("clSincronizar").addEventListener("click", function () {
    var botao = $("clSincronizar");
    botao.disabled = true;
    botao.textContent = "sincronizando…";
    chamar("clientes_sincronizar", {}, 180).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Sincronizar agora do painel MC";
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      recado("sincronizado");
      carregarClientes();
    });
  });

  $("formAvulso").addEventListener("submit", function (evento) {
    evento.preventDefault();
    chamar("telefone_salvar", {
      username: $("clAvulsoUsuario").value.trim(), telefone: $("clAvulsoTelefone").value,
    }, 45).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      recado("telefone");
      $("clAvulsoTelefone").value = telefoneBr(d.telefone);
    });
  });

  $("clExportar").addEventListener("click", function () {
    chamar("clientes_exportar", {}, 60).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var blob = new Blob([d.csv], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = d.nome || "clientes.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  });

  $("clImportar").addEventListener("click", function () {
    var arquivo = $("clCsv").files && $("clCsv").files[0];
    if (!arquivo) { recado("csv_vazio"); return; }
    var botao = $("clImportar");
    botao.disabled = true;
    botao.textContent = "importando…";
    lerArquivo(arquivo, "texto").then(function (textoCsv) {
      return chamar("clientes_importar", { texto: textoCsv, nome_arquivo: arquivo.name }, 180);
    }).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Importar para o banco";
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      recado("importado", "(" + d.n + " linhas)");
      $("clCsv").value = "";
      carregarClientes();
    });
  });

  // A lista colada com CPF: o resultado todo vai para o modal, não para o recado do topo —
  // é ele que tem que dizer quais linhas ficaram de fora.
  $("clImportarPix").addEventListener("click", function () {
    var colada = $("clPixLista").value;
    if (!colada.trim()) { recado("sem_lista"); return; }
    var botao = $("clImportarPix");
    botao.disabled = true;
    botao.textContent = "importando…";
    chamar("clientes_importar_pix", { texto: colada }, 300).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Importar lista com CPF";
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var erros = d.erros || [];
      $("mpResumo").textContent = d.importados + " usuários importados sem erro." +
        (erros.length ? " " + erros.length + " linha(s) ficaram de fora." : " O CPF de cada um está guardado.");
      $("mpErros").textContent = erros.map(function (e) {
        return "linha " + e.linha + " · " + e.motivo + "\n  " + e.texto;
      }).join("\n\n");
      $("mpErrosWrap").hidden = !erros.length;
      $("modalPix").hidden = false;
      $("clPixLista").value = "";
      carregarClientes();
    });
  });

  // ------------------------------------------------------------------ RECUPERAÇÃO

  CARREGA.recuperacao = function () { carregarRecuperacao(); };

  function carregarRecuperacao() {
    chamar("recuperacao_ver", {}, 45).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      $("rcLegenda").value = texto(d.conf.recupera_legenda);
      $("rcSendFoto").checked = Boolean(d.send_photo);
      $("rcExemplo").textContent = d.exemplo;
      var temFoto = Boolean(d.tem_foto);
      $("rcTemFoto").hidden = !temFoto;
      $("rcSemFoto").hidden = temFoto;
      $("rcErroFoto").hidden = !temFoto || Boolean(d.send_photo);
      if (temFoto) {
        $("rcInfoFoto").textContent = (d.foto_nome || "arquivo") + " · " + d.foto_kb + " KB no banco";
        var pill = $("rcPillFoto");
        pill.textContent = d.send_photo ? "ligado" : "desligado";
        pill.className = "pill" + (d.send_photo ? " on" : "");
        var botao = $("rcAlternar");
        botao.className = d.send_photo ? "segundo" : "verde";
        botao.textContent = d.send_photo ? "Desligar: recuperar manda só o texto" : "Ligar: mandar essa foto em todo recuperar";
        chamar("recuperacao_foto", {}, 60).then(function (f) {
          if (f.ok) $("rcImg").src = "data:image/png;base64," + f.foto_base64;
        });
      }
    });
  }

  $("rcAlternar").addEventListener("click", function () {
    var botao = $("rcAlternar");
    botao.disabled = true;
    chamar("recuperacao_alternar", {}, 45).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      recado(d.send_photo ? "recupera_foto_ligado" : "recupera_foto_desligado");
      carregarRecuperacao();
    });
  });

  $("formRecuperacao").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var botao = evento.target.querySelector("button.prim");
    var arquivo = $("rcFoto").files && $("rcFoto").files[0];
    botao.disabled = true;
    botao.textContent = "salvando…";
    lerArquivo(arquivo, "data").then(function (dataUrl) {
      return chamar("recuperacao_salvar", {
        recupera_legenda: $("rcLegenda").value,
        recupera_send_photo: $("rcSendFoto").checked,
        limpar_foto: $("rcLimparFoto").checked ? "1" : "",
        foto_base64: dataUrl || "",
        foto_nome: arquivo ? arquivo.name : "",
      }, 90);
    }).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Salvar";
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      recado(d.aviso || "recupera_gravado");
      $("rcFoto").value = "";
      $("rcLimparFoto").checked = false;
      carregarRecuperacao();
    });
  });

  // ------------------------------------------------------------------ DELETAR (intervalo)

  CARREGA.deletar = function () { verificarAndamento("apagar"); };

  $("btnApagar").addEventListener("click", function () {
    $("maRevisar").hidden = false;
    $("maProgresso").hidden = true;
    $("maAviso").hidden = true;
    $("maPalavra").value = "";
    $("maAtivosCb").checked = false;
    $("maEspelho").checked = false;
    $("maConfirmar").disabled = true;
    $("maAlvos").textContent = "…";
    $("maLista").textContent = "procurando no painel MC…";
    $("modalApagar").hidden = false;
    recado("");
    chamar("lote_contagem", {
      tipo: "apagar", prefixo: $("apPrefixo").value.trim(),
      de: $("apDe").value.trim(), ate: $("apAte").value.trim(),
    }, 180).then(function (d) {
      if (!d.ok) {
        $("maLista").textContent = "";
        $("maAlvos").textContent = "0";
        $("maQtd").textContent = $("maNoMc").textContent = $("maFaltando").textContent = "0";
        var aviso = $("maAviso");
        aviso.textContent = mensagemDetalhada(d);
        aviso.hidden = false;
        return;
      }
      escreverPlanoApagar(d);
      atualizarContaApagar();
    });
  });

  var linhasApagar = [];

  function escreverPlanoApagar(d) {
    linhasApagar = d.linhas || [];
    $("apLimite").textContent = d.limite || 300;
    var ponta = d.prefixo ? (d.prefixo + d.de + " até " + d.prefixo + d.ate) : (d.de + " até " + d.ate);
    $("maIntervalo").textContent = "Intervalo " + ponta + " — " + d.qtd +
      " nomes conferidos linha por linha no painel MC.";
    $("maQtd").textContent = d.qtd;
    $("maNoMc").textContent = d.no_mc;
    $("maFaltando").textContent = d.faltando;
    $("maAtivos").textContent = d.ativos;
    var lista = limpar($("maLista"));
    if (!linhasApagar.length) {
      lista.appendChild(criar("p", "muted", "Nenhum usuário do intervalo existe no painel MC."));
    }
    linhasApagar.forEach(function (l) {
      var item = criar("div", "item");
      var caixa = document.createElement("input");
      caixa.type = "checkbox";
      caixa.className = "mantem";
      caixa.value = l.usuario;
      caixa.title = "marque para MANTER " + l.usuario + " (não apagar)";
      item.appendChild(caixa);
      item.appendChild(criar("b", "", l.usuario));
      item.appendChild(criar("span", "muted", (l.telefone || "sem telefone") + " · " +
        (l.expira ? "expira " + l.expira : "sem data") + (l.nota ? " · " + l.nota : "") +
        (l.vencido ? "" : " · ATIVO")));
      lista.appendChild(item);
    });
    var tudo = $("maTudo");
    tudo.hidden = !d.painel_inteiro;
    tudo.textContent = d.painel_inteiro
      ? "Atenção: este intervalo pega TODAS as " + d.no_mc + " linhas que existem no painel MC." : "";
    var aviso = $("maAviso");
    aviso.hidden = !d.aviso;
    if (d.aviso) aviso.textContent = "A varrida parou antes do fim: " + d.aviso;
  }

  function mantidos() {
    return new Set(Array.prototype.filter.call(document.querySelectorAll("input.mantem"), function (c) {
      return c.checked;
    }).map(function (c) { return c.value; }));
  }

  function alvosDoDia() {
    var ativos = $("maAtivosCb").checked;
    var guardar = mantidos();
    return linhasApagar.filter(function (l) { return !guardar.has(l.usuario) && (ativos || l.vencido) && l.id; });
  }

  function atualizarContaApagar() {
    var alvos = alvosDoDia();
    var nomes = new Set(alvos.map(function (l) { return l.usuario; }));
    $("maAlvos").textContent = alvos.length;
    $("maMantidos").textContent = document.querySelectorAll("input.mantem:checked").length;
    Array.prototype.forEach.call(document.querySelectorAll("input.mantem"), function (c) {
      c.parentNode.classList.toggle("fora", !nomes.has(c.value));
    });
    var botao = $("maConfirmar");
    var palavraOk = $("maPalavra").value.trim().toLowerCase() === "deletar";
    botao.disabled = !(palavraOk && alvos.length);
    botao.textContent = alvos.length ? "Sim, apagar " + alvos.length + " acesso(s)" : "Ninguém sobrou para apagar";
  }

  $("maPalavra").addEventListener("input", atualizarContaApagar);
  $("maAtivosCb").addEventListener("change", atualizarContaApagar);
  $("maLista").addEventListener("change", atualizarContaApagar);

  $("maConfirmar").addEventListener("click", function () {
    var botao = $("maConfirmar");
    botao.disabled = true;
    botao.textContent = "abrindo a exclusão…";
    chamar("lote_executar", {
      tipo: "apagar", confirmar: "sim", palavra: $("maPalavra").value.trim(),
      ativos: $("maAtivosCb").checked ? "1" : "",
      espelho: $("maEspelho").checked ? "1" : "",
      manter: Array.from(mantidos()),
    }, 60).then(function (d) {
      if (!d.ok) {
        botao.textContent = "Confirmar e apagar";
        var aviso = $("maAviso");
        aviso.textContent = mensagemDetalhada(d);
        aviso.hidden = false;
        if (!d.rodando) botao.disabled = false;
        return;
      }
      atualizarContaApagar();
      abrirProgresso("apagar", d.total);
    });
  });

  // ------------------------------------------------------------------ APAGAR UMA LINHA

  CARREGA.apagar = function (p) { carregarApagarLinha(p.linha_id || ""); };

  function carregarApagarLinha(linhaId) {
    $("alId").textContent = linhaId;
    $("alBotao").textContent = "Sim, apagar " + linhaId;
    $("alConfirmar").checked = false;
    chamar("apagar_linha_ver", { linha_id: linhaId }, 60).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var alvo = d.alvo || {};
      $("alUsuario").textContent = alvo.username || "(não encontrei nos primeiros resultados)";
      $("alTelefone").textContent = d.telefone || "—";
      var expira = $("alExpira");
      limpar(expira);
      expira.appendChild(document.createTextNode(alvo.expira || "—"));
      if (alvo.parado) expira.appendChild(pilula(false, "ativo", "parado"));
      $("alNota").textContent = alvo.notes || "—";
    });
  }

  $("formApagarLinha").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var botao = $("alBotao");
    botao.disabled = true;
    botao.textContent = "apagando…";
    chamar("apagar_linha_fazer", { linha_id: $("alId").textContent, confirmar: $("alConfirmar").checked ? "sim" : "" }, 60)
      .then(function (d) {
        botao.disabled = false;
        botao.textContent = "Sim, apagar " + $("alId").textContent;
        if (!d.ok) { recado(d.erro, d.detalhe); return; }
        recado("apagado");
        location.hash = "#acessos";
      });
  });

  // ------------------------------------------------------------------ LINKS

  CARREGA.links = function () {
    $("lkPadraoErro").hidden = true;
    $("lkListaErro").hidden = true;
    $("lkPadraoEstado").textContent = "";
    chamar("links_ver", {}, 30).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      $("lkBase").textContent = d.base;
      $("lkLogado").textContent = d.logado
        ? "Como você: limite de 30 por minuto."
        : "Como visita: limite de 10 por minuto por IP. Para o link ficar na sua conta, configure URTADOR_TOKEN.";
      $("lkPadrao").value = texto(d.padrao);
      desenharLinks(d);
    });
  };

  function desenharLinks(d) {
    var caixa = limpar($("lkLista"));
    var itens = d.itens || [];
    $("lkVazio").hidden = itens.length > 0;
    itens.forEach(function (l) { caixa.appendChild(blocoLink(d, l)); });
  }

  /** Um bloco por cliente: o final do link é o que já está no WhatsApp e não muda; o que se
   *  edita aqui é só o endereço que ele abre, e isso valeria até para mensagem de ontem. */
  function blocoLink(d, l) {
    var curto = d.base + "/" + l.slug;
    var bloco = criar("div", "card");
    bloco.style.margin = "12px 0 0";
    bloco.style.padding = "12px";

    var topo = criar("div", "linha");
    topo.style.justifyContent = "space-between";
    topo.appendChild(criar("b", "", l.usuario || "(sem nome)"));
    topo.appendChild(criar("span", "muted", telefoneBr(l.telefone) || "sem telefone"));
    bloco.appendChild(topo);

    var final = criar("p", "muted", "no WhatsApp do cliente: " + curto);
    final.style.overflowWrap = "anywhere";
    final.style.margin = "4px 0 6px";
    bloco.appendChild(final);

    var campo = document.createElement("input");
    campo.type = "url";
    campo.autocomplete = "off";
    campo.autocapitalize = "off";
    campo.spellcheck = false;
    campo.placeholder = "segue o padrão";
    campo.value = texto(l.destino);
    campo.style.flex = "1";
    campo.style.minWidth = "0";

    var linha = criar("div", "linha");
    linha.style.marginTop = "2px";
    linha.appendChild(campo);
    var salvar = criar("button", "verde", "salvar");
    salvar.type = "button";
    linha.appendChild(salvar);
    bloco.appendChild(linha);

    var estado = criar("span", "muted", (l.destino ? "endereço próprio" : "seguindo o padrão") +
      (l.atualizado_em ? " · " + l.atualizado_em : ""));
    var rodape = criar("div", "linha");
    rodape.style.marginTop = "8px";
    rodape.appendChild(estado);
    var padrao = criar("button", "segundo", "usar o padrão");
    padrao.type = "button";
    rodape.appendChild(padrao);
    var copiar = criar("button", "segundo", "copiar link");
    copiar.type = "button";
    rodape.appendChild(copiar);
    var abrir = criar("a", "", "abrir");
    abrir.href = curto;
    abrir.target = "_blank";
    abrir.rel = "noopener";
    rodape.appendChild(abrir);
    bloco.appendChild(rodape);

    var erro = criar("p", "erro");
    erro.hidden = true;
    bloco.appendChild(erro);

    function gravar(valor, botao) {
      botao.disabled = true;
      chamar("links_destino_salvar", { slug: l.slug, destino: valor }, 40).then(function (r) {
        botao.disabled = false;
        if (!r.ok) {
          erro.textContent = mensagemDetalhada(r);
          erro.hidden = false;
          return;
        }
        erro.hidden = true;
        l.destino = texto(r.destino);
        campo.value = l.destino;
        estado.textContent = (l.destino ? "endereço próprio" : "seguindo o padrão") + " · salvo agora";
        recado("link_destino");
      });
    }

    salvar.addEventListener("click", function () { gravar(campo.value.trim(), salvar); });
    padrao.addEventListener("click", function () { gravar("", padrao); });
    copiar.addEventListener("click", function () { copiarTexto(curto); });
    return bloco;
  }

  $("lkPadraoBotao").addEventListener("click", function () {
    var botao = $("lkPadraoBotao"), caixa = $("lkPadraoErro");
    var valor = $("lkPadrao").value.trim();
    botao.disabled = true;
    botao.textContent = "salvando…";
    chamar("links_padrao_salvar", { destino: valor }, 40).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Salvar o padrão";
      if (!d.ok) {
        caixa.textContent = mensagemDetalhada(d);
        caixa.hidden = false;
        return;
      }
      caixa.hidden = true;
      $("lkPadraoEstado").textContent = d.destino
        ? "abre em: " + d.destino
        : "abre no painel deste endereço";
      recado("link_padrao");
    });
  });

  var ultimoLink = "";

  function erroLink(texto_) {
    var caixa = $("lkErro");
    caixa.textContent = texto_;
    caixa.hidden = !texto_;
    $("lkResultado").hidden = !texto_;
  }

  $("lkBotao").addEventListener("click", function () {
    var url = $("lkUrl").value.trim();
    if (!url) { erroLink("Escreva o endereço que vai virar link curto."); return; }
    var botao = $("lkBotao");
    botao.disabled = true;
    botao.textContent = "encurtando…";
    chamar("links_encurtar", { url: url, slug: $("lkSlug").value.trim(), titulo: $("lkTitulo").value.trim() }, 45)
      .then(function (d) {
        botao.disabled = false;
        botao.textContent = "Encurtar";
        if (!d.ok) { erroLink(d.erro || "o encurtador não devolveu o link."); return; }
        ultimoLink = d.curto;
        $("lkErro").hidden = true;
        $("lkCurto").textContent = d.curto;
        $("lkAbrir").href = d.curto;
        $("lkResultado").hidden = false;
      });
  });

  $("lkCopiar").addEventListener("click", function () { copiarTexto(ultimoLink); });

  // ------------------------------------------------------------------ CHAT (robô do WhatsApp)

  var CHAT = { ativo: false, dias: 90, desconhecido: false, regras: [], nao: "", bloqueados: 0 };
  // Quantas gravações de chat estão no ar: o refresco da tela espera, para não mostrar o banco
  // no meio de um Salvar e desfazer o que ele acabou de escrever.
  var CHAT_GRAVANDO = 0;

  CARREGA.chat = function () { carregarChat(); };

  function desenharPillRobo() {
    var pill = $("chPill");
    pill.textContent = CHAT.ativo ? "ligado" : "desligado";
    pill.className = "pill" + (CHAT.ativo ? " on" : "");
    var botao = $("chLigar");
    botao.textContent = CHAT.ativo ? "Desligar o robô" : "Ligar o robô";
    botao.className = CHAT.ativo ? "verm" : "verde";
  }

  /** A caixa da resposta do "não". O refresco da tela viva nunca toca aqui: é texto dele. */
  function desenharRespostaNao() {
    $("chNao").value = CHAT.nao;
    $("chNaoEstado").textContent = CHAT.nao
      ? "ligada (" + CHAT.nao.length + " caracteres)"
      : "desligada: responder \u201cnão\u201d não tira ninguém da base";
  }

  function desenharContadorBloqueados() {
    $("chBloqueados").textContent = CHAT.bloqueados
      ? CHAT.bloqueados + " número(s) fora de toda fila"
      : "ninguém";
  }

  function carregarChat() {
    $("chRegrasEstado").textContent = "carregando…";
    chamar("chat_ver", {}, 45).then(function (d) {
      $("chRegrasEstado").textContent = "";
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      CHAT.ativo = Boolean(d.ativo);
      CHAT.dias = Number(d.dias || 90);
      CHAT.desconhecido = Boolean(d.desconhecido);
      CHAT.nao = texto(d.nao_legenda);
      CHAT.bloqueados = Number(d.bloqueados || 0);
      CHAT.regras = d.regras || [];

      desenharPillRobo();

      var inst = d.instancia || {};
      $("chNumero").textContent = (inst.numero ? telefoneBr(inst.numero) : "(a instância não respondeu)") +
        (d.telefone_diferente ? " — na Configuração está outro número" : "");
      var hook = $("chWebhook");
      hook.textContent = d.webhook_ok ? "sim" : "não";
      hook.className = "pill" + (d.webhook_ok ? " on" : "");
      $("chWebhookDetalhe").textContent = d.webhook_ok ? "" :
        (inst.error ? texto(inst.error).slice(0, 90)
                   : "hoje o GreenAPI manda para " + (inst.webhook_url || "nada"));
      $("chUrl").value = d.webhook || "";
      $("chDesconhecido").checked = CHAT.desconhecido;
      desenharRespostaNao();
      desenharContadorBloqueados();
      $("chDias").value = CHAT.dias;
      $("chRetencao").textContent = CHAT.dias;
      $("chConversas").textContent = Number(d.mensagens || 0) + " mensagens (" +
        Number(d.entradas || 0) + " dos clientes)";
      $("chTreino").textContent = Number(d.treino || 0);
      $("chSemResposta").textContent = Number(d.sem_resposta || 0);
      desenharRegras(CHAT.regras);
      desenharTelefones(d.conversas || []);
    });
  }

  function campo(tipo, classe, valor, atributo) {
    var n = document.createElement(tipo === "textarea" ? "textarea" : "input");
    if (tipo === "textarea") n.rows = 3; else n.type = tipo;
    n.value = valor === undefined || valor === null ? "" : String(valor);
    if (classe) n.className = classe;
    if (atributo) n.setAttribute("data-" + atributo, "1");
    n.setAttribute("autocapitalize", "sentences");
    n.setAttribute("spellcheck", "false");
    return n;
  }

  /** Um card por chat, desenhado sozinho. Salvar ou apagar troca só o card daquele id: assim o
   *  que ele está digitando em outro chat não some quando a tela se refaz. */
  function desenharRegra(r) {
    var bloco = criar("div", "card");
    bloco.style.marginBottom = "10px";
    // O card novo cai no meio da lista (a ordem dele é a mesma da regra 1), então o foco
    // depois de "criar outro chat" precisa procurar pelo id, não pelo último filho.
    bloco.setAttribute("data-chat", String(r.id));
    bloco.appendChild(criar("p", "rotulo", textoRegra(r)));

    bloco.appendChild(criar("label", null, "Palavras que o cliente escreve (separe por vírgula)"));
    bloco.appendChild(campo("text", null, r.gatilho, "gatilho"));

    bloco.appendChild(criar("label", null,
      "O que responder (para o vencimento use {{vence}}; {{expira}} é só a data, {{expirou}} é quanto faz)"));
    bloco.appendChild(campo("textarea", null, r.resposta, "resposta"));

    var rodape = criar("div", "linha");
    var ordem = campo("number", "maq", r.prioridade, "prioridade");
    ordem.style.width = "70px";
    ordem.min = "1";
    ordem.max = "999";
    rodape.appendChild(criar("span", "muted", "ordem"));
    rodape.appendChild(ordem);

    var marca = document.createElement("input");
    marca.type = "checkbox";
    marca.checked = Boolean(r.ativo);
    marca.setAttribute("data-ativo", "1");
    // A chave vale sozinha, na hora: ele desliga uma resposta e continua editando as outras
    // com o robô ligado, sem precisar de "Salvar este chat" nem de desligar o bot inteiro.
    marca.addEventListener("change", function () { chavearRegra(bloco, r.id, marca); });
    var cb = criar("label", "cb");
    cb.appendChild(marca);
    cb.appendChild(criar("span", null, "respondendo"));
    rodape.appendChild(cb);

    var salvar = criar("button", "prim", "Salvar este chat");
    salvar.type = "button";
    salvar.addEventListener("click", function () { salvarRegra(bloco, r.id, salvar); });
    rodape.appendChild(salvar);

    var apagar = criar("button", "verm", "Apagar");
    apagar.type = "button";
    apagar.addEventListener("click", function () { apagarRegra(r.id, apagar); });
    rodape.appendChild(apagar);

    bloco.appendChild(rodape);
    return bloco;
  }

  function regraNaTela(id) {
    return $("chRegras").querySelector('.card[data-chat="' + id + '"]');
  }

  function trocarRegra(r) {
    var velho = regraNaTela(r.id);
    var novo = desenharRegra(r);
    if (velho) velho.parentNode.replaceChild(novo, velho);
    else $("chRegras").appendChild(novo);
    $("chRegrasVazio").hidden = ($("chRegras").children.length || 0) > 0;
    return novo;
  }

  function desenharRegras(regras) {
    var alvo = limpar($("chRegras"));
    $("chRegrasVazio").hidden = regras.length > 0;
    regras.forEach(function (r) { alvo.appendChild(desenharRegra(r)); });
  }

  function estadoRegras(texto) { $("chRegrasEstado").textContent = texto || ""; }

  /** Só a chave ativo, gravada sem tocar no que ele está escrevendo nos outros campos. */
  function chavearRegra(bloco, id, marca) {
    var iaResponder = marca.checked;
    var rotulo = bloco.querySelector("p");
    marca.disabled = true;
    CHAT_GRAVANDO += 1;
    chamar("chat_ativar", { id: id, ativo: iaResponder }, 20).then(function (d) {
      CHAT_GRAVANDO -= 1;
      marca.disabled = false;
      if (!d.ok) { marca.checked = !iaResponder; recado(d.erro, d.detalhe); return; }
      CHAT.regras = d.regras || CHAT.regras;
      var r = regraPorId(id);
      rotulo.textContent = textoRegra(r || { id: id, contagem: 0, ativo: iaResponder });
      estadoRegras(iaResponder
        ? "Este chat voltou a responder. As palavras dele valem de novo."
        : "Este chat está parado. Os outros continuam respondendo normalmente.");
    });
  }

  function regraPorId(id) {
    var achada = null;
    (CHAT.regras || []).forEach(function (r) { if (Number(r.id) === Number(id)) achada = r; });
    return achada;
  }

  function textoRegra(r) {
    return "chat " + r.id + " · respondeu " + Number(r.contagem || 0) + " vezes" +
      (r.ativo ? "" : " · parado") + " · atualizado " + (r.atualizado_em || "");
  }

  function salvarRegra(bloco, id, botao) {
    botao.disabled = true;
    estadoRegras("gravando…");
    CHAT_GRAVANDO += 1;
    chamar("chat_salvar", {
      id: id,
      gatilho: bloco.querySelector("[data-gatilho]").value,
      resposta: bloco.querySelector("[data-resposta]").value,
      prioridade: bloco.querySelector("[data-prioridade]").value,
      ativo: bloco.querySelector("[data-ativo]").checked,
    }, 30).then(function (d) {
      CHAT_GRAVANDO -= 1;
      botao.disabled = false;
      estadoRegras("");
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      CHAT.regras = d.regras || [];
      var salva = regraPorId(id);
      if (salva) trocarRegra(salva);
      estadoRegras(MSG_OK.chat_gravado);
    });
  }

  function apagarRegra(id, botao) {
    if (!window.confirm("Apagar o chat " + id + "? As conversas já guardadas continuam no banco.")) return;
    botao.disabled = true;
    CHAT_GRAVANDO += 1;
    chamar("chat_apagar", { id: id }, 30).then(function (d) {
      CHAT_GRAVANDO -= 1;
      botao.disabled = false;
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      CHAT.regras = d.regras || [];
      var velho = regraNaTela(id);
      if (velho) velho.parentNode.removeChild(velho);
      $("chRegrasVazio").hidden = CHAT.regras.length > 0;
      estadoRegras(MSG_OK.chat_apagado);
    });
  }

  $("chNovo").addEventListener("click", function () {
    var botao = $("chNovo");
    botao.disabled = true;
    estadoRegras("criando…");
    CHAT_GRAVANDO += 1;
    chamar("chat_novo", {}, 30).then(function (d) {
      CHAT_GRAVANDO -= 1;
      botao.disabled = false;
      estadoRegras("");
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      CHAT.regras = d.regras || [];
      var criado = regraPorId(d.id);
      var card = criado ? trocarRegra(criado) : null;
      var gatilho = card && card.querySelector("[data-gatilho]");
      if (gatilho) {
        gatilho.focus();
        if (gatilho.scrollIntoView) gatilho.scrollIntoView({ block: "center" });
      }
      estadoRegras(MSG_OK.chat_novo);
    });
  });

  $("chLigar").addEventListener("click", function () {
    var botao = $("chLigar");
    botao.disabled = true;
    chamar("chat_ligar", { ativo: !CHAT.ativo }, 30).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      recado(CHAT.ativo ? "chat_desligado" : "chat_ligado");
      carregarChat();
    });
  });

  $("chDesconhecido").addEventListener("change", function (evento) {
    chamar("chat_ligar", { desconhecido: evento.target.checked }, 30).then(function (d) {
      if (!d.ok) { evento.target.checked = !CHAT.desconhecido; recado(d.erro, d.detalhe); return; }
      CHAT.desconhecido = evento.target.checked;
      recado("chat_ajuste");
    });
  });

  $("chDiasSalvar").addEventListener("click", function () {
    var botao = $("chDiasSalvar");
    botao.disabled = true;
    chamar("chat_ligar", { dias: $("chDias").value }, 30).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      CHAT.dias = Number($("chDias").value || CHAT.dias);
      $("chRetencao").textContent = CHAT.dias;
      recado("chat_dias", "(" + CHAT.dias + " dias)");
    });
  });

  $("chCopiarUrl").addEventListener("click", function () { copiarTexto($("chUrl").value); });

  $("chInstalar").addEventListener("click", function () {
    var botao = $("chInstalar");
    botao.disabled = true;
    botao.textContent = "instalando…";
    chamar("chat_instalar", {}, 45).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Instalar na instância agora";
      if (!d.ok) { recado(d.error || d.erro || "webhook", texto(d.status_code || "")); return; }
      recado("chat_instalado");
      carregarChat();
    });
  });

  function desenharTelefones(conversas) {
    var alvo = limpar($("chTelefones"));
    $("chTelefonesVazio").hidden = conversas.length > 0;
    conversas.forEach(function (c) {
      var item = criar("div", "item");
      var link = criar("a", null, telefoneBr(c.telefone) + (c.usuario ? " · " + c.usuario : ""));
      link.href = "#chat";
      item.appendChild(link);
      item.appendChild(criar("span", "muted", Number(c.quantidade || 0) + " mensagens · " + c.ultima));
      link.addEventListener("click", function (evento) {
        evento.preventDefault();
        abrirConversa(c.telefone, (c.usuario ? " · " + c.usuario : ""));
      });
      alvo.appendChild(item);
    });
  }

  function abrirConversa(telefone, sufixo) {
    CHAT_ABERTA = telefone;
    $("chJanela").hidden = false;
    $("chJanelaTitulo").textContent = "Conversa de " + telefoneBr(telefone) + (sufixo || "");
    var alvo = limpar($("chMensagens"));
    alvo.appendChild(criar("div", "item", "carregando…"));
    chamar("chat_conversas", { telefone: telefone }, 30).then(function (d) {
      if (CHAT_ABERTA !== telefone) return;
      if (!d.ok) { limpar(alvo); alvo.appendChild(criar("div", "item", mensagemDetalhada(d))); return; }
      desenharConversa(telefone, d.mensagens || []);
    });
  }

  function desenharConversa(telefone, mensagens) {
    if (CHAT_ABERTA !== telefone) return;
    var alvo = limpar($("chMensagens"));
    if (!mensagens.length) { alvo.appendChild(criar("div", "item", "nada nesta conversa")); return; }
    mensagens.forEach(function (m) {
      var item = criar("div", "item");
      item.appendChild(criar("b", "rotulo", m.direcao === "saida" ? "robô · " : "cliente · "));
      item.appendChild(criar("span", null, m.texto));
      item.appendChild(criar("span", "muted", m.criado_em));
      alvo.appendChild(item);
    });
  }

  $("chFecharJanela").addEventListener("click", function () {
    CHAT_ABERTA = "";
    $("chJanela").hidden = true;
  });

  // ------------------------------------------------------ a tela viva, com o robô ligado
  //
  // Ele não precisa desligar o bot para mexer: esta é a parte que continua se refazendo
  // sozinha enquanto a aba está aberta. O refresco só toca nos rótulos, nas contagens e na
  // conversa aberta — nunca nas caixas de texto, para não desfazer o que ele está escrevendo.

  var CHAT_ABERTA = "";

  function atualizarChatVivo(d) {
    CHAT.regras = d.regras || CHAT.regras;
    CHAT.bloqueados = Number(d.bloqueados || 0);
    desenharContadorBloqueados();

    var ligado = Boolean(d.ativo);
    if (ligado !== CHAT.ativo && !$("chLigar").disabled) {
      CHAT.ativo = ligado;
      desenharPillRobo();
    }

    $("chConversas").textContent = Number(d.mensagens || 0) + " mensagens (" +
      Number(d.entradas || 0) + " dos clientes)";
    $("chTreino").textContent = Number(d.treino || 0);
    $("chSemResposta").textContent = Number(d.sem_resposta || 0);

    (CHAT.regras || []).forEach(function (r) {
      var bloco = $("chRegras").querySelector('.card[data-chat="' + r.id + '"]');
      if (!bloco) return;
      var marca = bloco.querySelector("[data-ativo]");
      if (marca && marca.disabled) return;   // a chave dele está no ar: não puxar o rótulo de volta
      var rotulo = bloco.querySelector("p");
      if (rotulo) rotulo.textContent = textoRegra(r);
    });

    desenharTelefones(d.conversas || []);

    var aberta = d.conversa || {};
    if (aberta.telefone && ! $("chJanela").hidden) desenharConversa(aberta.telefone, aberta.mensagens || []);
  }

  var CHAT_BUSCANDO = false;

  setInterval(function () {
    if (TELA_ATUAL !== "chat" || !token() || CHAT_GRAVANDO || CHAT_BUSCANDO) return;
    CHAT_BUSCANDO = true;
    chamar("chat_fluxo", { telefone: CHAT_ABERTA }, 25).then(function (d) {
      CHAT_BUSCANDO = false;
      if (d.ok && TELA_ATUAL === "chat") atualizarChatVivo(d);
    });
  }, 6000);

  $("chExportar").addEventListener("click", function () {
    var botao = $("chExportar");
    botao.disabled = true;
    chamar("chat_treino_exportar", {}, 60).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var blob = new Blob([d.csv], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = d.nome || "treino-ia.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      recado("chat_exportado", "(" + Number(d.n || 0) + " pares)");
    });
  });

  $("chNaoSalvar").addEventListener("click", function () {
    var botao = $("chNaoSalvar");
    var corpo = $("chNao").value.trim();
    if (corpo === CHAT.nao) { recado("chat_nao_salvo"); return; }
    botao.disabled = true;
    CHAT_GRAVANDO++;
    chamar("chat_ligar", { nao: corpo }, 30).then(function (d) {
      CHAT_GRAVANDO--;
      botao.disabled = false;
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      CHAT.nao = corpo;
      desenharRespostaNao();
      recado(corpo ? "chat_nao_salvo" : "chat_nao_desligado");
    });
  });

  // ------------------------------------------------------------------ BLOQUEADOS

  CARREGA.bloqueados = function () { carregarBloqueados(); };
  var blBusca = "";

  function carregarBloqueados() {
    chamar("bloqueados_ver", { q: blBusca }, 60).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      desenharBloqueados(d.itens || [], Number(d.total || 0));
    });
  }

  $("formBloquear").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var telefone = $("blTelefone").value.trim();
    if (!telefone) { recado("telefone_invalido"); return; }
    if (!window.confirm("Bloquear este telefone para respostas do chatbot e mensagens pela GreenAPI?")) return;
    var botao = $("blBloquear");
    botao.disabled = true;
    botao.textContent = "bloqueando…";
    chamar("bloqueados_bloquear", {
      telefone: telefone,
      nome: $("blNome").value.trim(),
      motivo: $("blMotivo").value.trim(),
    }, 45).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Bloquear chatbot e mensagens";
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      $("blTelefone").value = "";
      $("blNome").value = "";
      blBusca = "";
      $("blBusca").value = "";
      recado("bloqueado_manual", d.telefone);
      desenharBloqueados(d.itens || [], Number(d.total || 0));
    });
  });

  function desenharBloqueados(itens, total) {
    $("blTotal").textContent = total;
    var vazio = $("blVazio");
    vazio.hidden = itens.length > 0;
    vazio.textContent = blBusca
      ? "Nenhum bloqueado bate com \u201c" + blBusca + "\u201d \u2014 o campo procura telefone, nome, usuário e motivo."
      : "Ninguém bloqueado. Assim que alguém responder \u201cnão\u201d para o robô da aba Chat, o número aparece aqui.";
    var corpo = limpar($("blLinhas"));
    itens.forEach(function (b) { corpo.appendChild(linhaBloqueado(b)); });
  }

  function linhaBloqueado(b) {
    var linha = document.createElement("tr");
    var quem = [texto(b.nome), texto(b.usuario)].filter(Boolean).join(" · ");
    linha.appendChild(criar("td", "", b.telefone));
    linha.appendChild(criar("td", "", quem || "—"));
    linha.appendChild(criar("td", "muted", texto(b.motivo) || "—"));
    linha.appendChild(criar("td", "muted", texto(b.criado_em) || "—"));

    var celula = criar("td", "linha");
    var botao = criar("button", "verde", "desbloquear");
    botao.type = "button";
    botao.title = "devolver " + b.telefone + " para as filas";
    botao.addEventListener("click", function () {
      botao.disabled = true;
      botao.textContent = "tirando…";
      chamar("bloqueados_desbloquear", { telefone: b.telefone }, 45).then(function (d) {
        botao.disabled = false;
        botao.textContent = "desbloquear";
        if (!d.ok) { recado(d.erro, d.detalhe); return; }
        recado("desbloqueado", b.telefone);
        carregarBloqueados();
      });
    });
    celula.appendChild(botao);
    linha.appendChild(celula);
    return linha;
  }

  $("blBuscar").addEventListener("click", function () { blBusca = $("blBusca").value.trim(); carregarBloqueados(); });
  $("blBusca").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    blBusca = $("blBusca").value.trim();
    carregarBloqueados();
  });
  $("blLimpar").addEventListener("click", function () {
    blBusca = "";
    $("blBusca").value = "";
    carregarBloqueados();
  });

  // ------------------------------------------------------------------ SENHA

  CARREGA.senha = function () { $("snErro").hidden = true; };

  $("formSenha").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var botao = evento.target.querySelector("button.prim");
    botao.disabled = true;
    botao.textContent = "trocando…";
    chamar("senha_trocar", { atual: $("snAtual").value, nova: $("snNova").value }, 60).then(function (d) {
      botao.disabled = false;
      botao.textContent = "Trocar e sair";
      if (!d.ok) {
        var caixa = $("snErro");
        caixa.textContent = mensagemDetalhada(d);
        caixa.hidden = false;
        return;
      }
      guardarToken("");
      mostrarLogin(MSG_OK.senha);
    });
  });

  // ------------------------------------------------------------------ andamento ao abrir

  function verificarAndamento(tipo) {
    chamar("lote_status", { tipo: tipo }, 30).then(function (d) {
      if (!d.ok || !d.estado) return;
      var estado = d.estado;
      if (!estado.rodando) return;
      var faixa = $(maquina(tipo).faixa);
      if (faixa) faixa.hidden = false;
      mostrarEstado(tipo, estado);
      lote.tipo = tipo;
      if (!lote.rodando) rodarLote(tipo);
    });
  }

  // ------------------------------------------------------------ barbearias

  var bbPaginaAtual = 1;
  var bbDetalheAtual = null;
  var bbAbaDetalhe = "conta";

  function bbAviso(id, mensagem, erro) {
    var el = $(id);
    if (!el) return;
    el.textContent = mensagem || "";
    el.className = erro ? "muted verm" : "muted";
  }

  CARREGA.chatbarbearia = function () {
    chamar("barb_ver", {}, 45).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      $("bcPill").textContent = d.ativo ? "Ligado" : "Desligado";
      $("bcPill").className = "pill" + (d.ativo ? " on" : "");
      $("bcContas").textContent = texto(d.contas || 0) + " (" + texto(d.ativos || 0) + " ativas; " + texto(d.vencidos || 0) + " vencidas)";
      $("bcAgendados").textContent = texto(d.agendados || 0);
      $("bcMensagens").textContent = texto(d.mensagens || 0);
      $("bcInteressados").textContent = texto(d.interessados || 0);
      $("bcWebhook").textContent = d.webhook ? "Configurado (token oculto)" : "Não configurado";
      $("bcAtivo").checked = Boolean(d.ativo);
      $("bcControle").checked = Boolean(d.responder_controle);
      $("bcTrial").value = texto(d.trial_dias || 1);
      $("bcLembreteHora").value = texto(d.lembrete_hora === undefined ? 8 : d.lembrete_hora);
      $("bcRetencao").value = texto(d.dias_retencao || 90);
      $("bcRenovarAdmin").value = "";
      $("bcRenovarAdminEstado").textContent = d.renovar_admin_configurado
        ? "Comando ativo apenas para o número autorizado (final " + texto(d.renovar_admin_final) + ")."
        : "Comando de renovação desativado; configure o número autorizado para ativar.";
      $("bcMenu").value = texto(d.menu);
      $("bcBoasVindas").value = texto(d.boas_vindas);
      $("bcAbordagem").value = texto(d.abordagem);
      $("bcLembrete").value = texto(d.lembrete);
      $("bcAvisoCliente").value = texto(d.aviso_cliente);
      $("bcInteresse").value = texto(d.msg_interesse);
      $("bcVencido").value = texto(d.msg_vencido);
      $("bcBoasVindasSite").value = texto(d.boas_vindas_site);
      $("bcAvisoNovoSite").value = texto(d.aviso_novo_site);
      $("bcAjudaFuncionario").value = texto(d.ajuda_funcionario);
    });
  };

  $("bcBomDia").addEventListener("click", function () {
    if (!window.confirm("Enviar o bom-dia de agora para todas as barbearias ativas?")) return;
    var botao = $("bcBomDia");
    botao.disabled = true;
    bbAviso("bcBomDiaEstado", "Enviando bom-dia…", false);
    chamar("barb_bom_dia", { forcar: true }, 180).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { bbAviso("bcBomDiaEstado", mensagemDetalhada(d), true); return; }
      bbAviso("bcBomDiaEstado",
        "Bom-dia enviado para " + texto(d.enviados || 0) + " barbearia(s).",
        false);
    });
  });

  function carregarContasBarbearia(pagina, busca) {
    bbPaginaAtual = Math.max(1, Number(pagina || 1));
    var termo = busca === undefined ? $("bbBusca").value.trim() : busca;
    chamar("barb_contas", { pagina: bbPaginaAtual, q: termo }, 60).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var caixa = limpar($("bbLista"));
      var linhas = d.linhas || [];
      var info = d.info || {};
      $("bbResumo").textContent = texto(info.encontrados || 0) + " estabelecimento(s); " +
        texto(info.ativos || 0) + " ativo(s), " + texto(info.vencidos || 0) + " vencido(s).";
      $("bbPagina").textContent = "Página " + texto(info.pagina || bbPaginaAtual) + " de " + texto(info.paginas || 1);
      $("bbAnterior").disabled = bbPaginaAtual <= 1;
      $("bbProxima").disabled = bbPaginaAtual >= Number(info.paginas || 1);
      if (!linhas.length) {
        caixa.appendChild(criar("p", "muted", "Nenhum estabelecimento encontrado."));
        return;
      }
      linhas.forEach(function (conta) {
        var item = criar("div", "item");
        item.appendChild(criar("b", "", conta.nome || "Sem nome"));
        item.appendChild(pilula(Boolean(conta.ativo), "Ativo", "Desativado"));
        item.appendChild(criar("span", "muted",
          texto(conta.telefone) + " · teste até " + (conta.expira || "sem data") +
          " · " + texto(conta.agendados || 0) + " agendamento(s) · " +
          texto(conta.servicos || 0) + " serviço(s) · " + texto(conta.produtos || 0) + " produto(s)"));
        if (conta.nota) item.appendChild(criar("span", "muted", conta.nota));
        var acoes = criar("div", "linha");
        var detalhe = criar("button", "", "Abrir detalhes");
        detalhe.type = "button";
        detalhe.addEventListener("click", function () { abrirDetalheBarbearia(conta.telefone); });
        acoes.appendChild(detalhe);
        var alternar = criar("button", "segundo", conta.ativo ? "Desativar" : "Ativar");
        alternar.type = "button";
        alternar.addEventListener("click", function () {
          chamar("barb_conta_ligar", { telefone: conta.telefone, ativo: !conta.ativo }, 45).then(function (r) {
            if (!r.ok) { recado(r.erro, r.detalhe); return; }
            carregarContasBarbearia(bbPaginaAtual);
          });
        });
        acoes.appendChild(alternar);
        var fechar = criar("button", "segundo", "Definir prazo");
        fechar.type = "button";
        fechar.addEventListener("click", function () {
          var dias = window.prompt("Definir o prazo a partir de hoje, em dias:", "30");
          if (dias === null) return;
          if (!/^\d+$/.test(dias) || Number(dias) < 1 || Number(dias) > 3650) {
            recado("numero");
            return;
          }
          chamar("barb_conta_fechar", { telefone: conta.telefone, dias: Number(dias) }, 45).then(function (r) {
            if (!r.ok) { recado(r.erro, r.detalhe); return; }
            carregarContasBarbearia(bbPaginaAtual);
          });
        });
        acoes.appendChild(fechar);
        var apagar = criar("button", "segundo", "Apagar dados");
        apagar.type = "button";
        apagar.addEventListener("click", function () {
          var confirmar = window.prompt("Esta ação apaga os dados deste estabelecimento. Digite APAGAR para confirmar:");
          if (String(confirmar || "").trim().toLowerCase() !== "apagar") return;
          chamar("barb_conta_apagar", { telefone: conta.telefone, confirmar: "apagar" }, 60).then(function (r) {
            if (!r.ok) { recado(r.erro, r.detalhe); return; }
            $("bbDetalhe").hidden = true;
            carregarContasBarbearia(bbPaginaAtual);
          });
        });
        acoes.appendChild(apagar);
        item.appendChild(acoes);
        caixa.appendChild(item);
      });
    });
  }

  function carregarInteressadosBarbearia() {
    chamar("barb_interessados", {}, 45).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var caixa = limpar($("bbInteressados"));
      var interessados = d.interessados || [];
      if (!interessados.length) {
        caixa.appendChild(criar("p", "muted", "Nenhum pedido ou interessado registrado."));
        return;
      }
      interessados.forEach(function (pessoa) {
        var item = criar("div", "item");
        item.appendChild(criar("b", "", pessoa.telefone || "Sem telefone"));
        item.appendChild(pilula(Boolean(pessoa.virou), pessoa.virou ? "Cadastrado" : "Pendente", "Pendente"));
        item.appendChild(criar("span", "muted", pessoa.criado_em || ""));
        item.appendChild(criar("span", "", pessoa.texto || "Sem mensagem registrada"));
        if (pessoa.conta) item.appendChild(criar("span", "muted", "Conta vinculada: " + pessoa.conta));
        caixa.appendChild(item);
      });
    });
  }

  function carregarPaginaClientesBarbearia() {
    $("bbDetalhe").hidden = true;
    carregarContasBarbearia(bbPaginaAtual);
    carregarInteressadosBarbearia();
  }

  function bbValor(valor) {
    if (valor === null || valor === undefined) return "";
    if (typeof valor === "object") return JSON.stringify(valor);
    return String(valor);
  }

  function bbRenderTabela(dados) {
    var caixa = document.createElement("div");
    if (!dados || (Array.isArray(dados) && !dados.length)) {
      caixa.appendChild(criar("p", "muted", "Nenhum registro."));
      return caixa;
    }
    var linhas = Array.isArray(dados) ? dados : [dados];
    var colunas = Object.keys(linhas[0] || {});
    if (!colunas.length) {
      caixa.appendChild(criar("p", "muted", "Nenhum detalhe disponível."));
      return caixa;
    }
    var tabela = document.createElement("table");
    var thead = document.createElement("thead");
    var cabecalho = document.createElement("tr");
    colunas.forEach(function (coluna) { cabecalho.appendChild(criar("th", "", coluna)); });
    thead.appendChild(cabecalho);
    tabela.appendChild(thead);
    var corpo = document.createElement("tbody");
    linhas.slice(0, 100).forEach(function (linha) {
      var tr = document.createElement("tr");
      colunas.forEach(function (coluna) { tr.appendChild(criar("td", "", bbValor(linha[coluna]))); });
      corpo.appendChild(tr);
    });
    tabela.appendChild(corpo);
    caixa.appendChild(tabela);
    if (linhas.length > 100) caixa.appendChild(criar("p", "muted", "Mostrando os primeiros 100 registros."));
    return caixa;
  }

  function bbRenderAgendamentosClientes() {
    var caixa = criar("section", "card");
    caixa.appendChild(criar("h3", "", "Agendamentos dos clientes"));
    var agendamentos = Array.isArray(bbDetalheAtual.agendamentos_clientes)
      ? bbDetalheAtual.agendamentos_clientes
      : [];
    if (!agendamentos.length) {
      caixa.appendChild(criar("p", "muted",
        "Sem agendamentos. Peça para seu cliente agendar pelo link da página."));
    } else {
      var colunas = [
        ["dia", "Data"], ["hora", "Hora"], ["nome", "Cliente"], ["telefone", "Telefone"],
        ["servico", "Serviço"], ["status", "Situação"], ["pagamento", "Pagamento"],
        ["compareceu", "Compareceu"],
      ];
      var tabela = document.createElement("table");
      tabela.setAttribute("aria-label", "Agendamentos dos clientes");
      var thead = document.createElement("thead");
      var cabecalho = document.createElement("tr");
      colunas.forEach(function (coluna) { cabecalho.appendChild(criar("th", "", coluna[1])); });
      thead.appendChild(cabecalho);
      tabela.appendChild(thead);
      var corpo = document.createElement("tbody");
      agendamentos.forEach(function (agendamento) {
        var linha = document.createElement("tr");
        colunas.forEach(function (coluna) {
          linha.appendChild(criar("td", "", bbValor(agendamento[coluna[0]])));
        });
        corpo.appendChild(linha);
      });
      tabela.appendChild(corpo);
      caixa.appendChild(tabela);
    }

    var pagina = "";
    try {
      var url = new URL(String(bbDetalheAtual.pagina_url || ""));
      if (url.protocol === "https:") pagina = url.href;
    } catch (e) { pagina = ""; }
    if (pagina) {
      var link = criar("a", "", pagina);
      link.href = pagina;
      link.target = "_blank";
      link.rel = "noopener";
      caixa.appendChild(link);
      var copiar = criar("button", "segundo", "Copiar link da página");
      copiar.type = "button";
      var estado = criar("span", "muted", "");
      estado.setAttribute("role", "status");
      estado.setAttribute("aria-live", "polite");
      copiar.addEventListener("click", function () {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          estado.textContent = "Não foi possível copiar automaticamente; copie o link acima.";
          return;
        }
        navigator.clipboard.writeText(pagina).then(function () {
          estado.textContent = "Link copiado.";
        }).catch(function () {
          estado.textContent = "Não foi possível copiar automaticamente; copie o link acima.";
        });
      });
      caixa.appendChild(copiar);
      caixa.appendChild(estado);
    } else {
      caixa.appendChild(criar("p", "muted", "O link público desta página ainda não está disponível."));
    }
    return caixa;
  }

  var BB_ABAS_DETALHE = [
    { id: "conta", rotulo: "Cadastro", dado: "conta" },
    { id: "servicos", rotulo: "Serviços", dado: "servicos" },
    { id: "produtos", rotulo: "Produtos", dado: "produtos" },
    { id: "pacotes", rotulo: "Pacotes", dado: "pacotes" },
    { id: "lancamentos", rotulo: "Lançamentos", dado: "lancamentos" },
    { id: "agendamentos", rotulo: "Agenda", dado: "agendamentos" },
    { id: "clientes", rotulo: "Clientes", dado: "clientes" },
    { id: "mensagens", rotulo: "Conversas", dado: "mensagens" },
    { id: "funcionarios", rotulo: "Funcionários", dado: "funcionarios" },
    { id: "horarios", rotulo: "Horários", dado: "horarios" },
    { id: "pagamentos", rotulo: "Pagamentos", dado: "pagamentos" },
    { id: "fotos", rotulo: "Fotos", dado: "fotos" },
  ];

  function renderDetalheBarbearia() {
    if (!bbDetalheAtual) return;
    var abas = limpar($("bbAbasDetalhe"));
    BB_ABAS_DETALHE.forEach(function (aba) {
      var botao = criar("button", aba.id === bbAbaDetalhe ? "prim" : "segundo", aba.rotulo);
      botao.type = "button";
      botao.addEventListener("click", function () {
        bbAbaDetalhe = aba.id;
        renderDetalheBarbearia();
      });
      abas.appendChild(botao);
    });
    var abaAtiva = BB_ABAS_DETALHE.find(function (aba) { return aba.id === bbAbaDetalhe; }) || BB_ABAS_DETALHE[0];
    var conteudo = limpar($("bbConteudoDetalhe"));
    if (abaAtiva.id === "agendamentos") {
      conteudo.appendChild(bbRenderAgendamentosClientes());
    } else {
      conteudo.appendChild(bbRenderTabela(bbDetalheAtual[abaAtiva.dado]));
      conteudo.appendChild(bbRenderAgendamentosClientes());
    }
    $("bbDetalheTitulo").textContent = "Detalhes — " + (bbDetalheAtual.conta.nome || bbDetalheAtual.conta.telefone);
    $("bbDetalheSubtitulo").textContent = (bbDetalheAtual.conta.telefone || "") +
      (bbDetalheAtual.conta.slug ? " · página: " + bbDetalheAtual.conta.slug : "");
    var acoes = limpar($("bbAcoes"));
    var telefone = bbDetalheAtual.conta.telefone;
    var ativo = Boolean(bbDetalheAtual.conta.ativo);
    var alternar = criar("button", "segundo", ativo ? "Desativar estabelecimento" : "Ativar estabelecimento");
    alternar.type = "button";
    alternar.addEventListener("click", function () {
      chamar("barb_conta_ligar", { telefone: telefone, ativo: !ativo }, 45).then(function (r) {
        if (!r.ok) { recado(r.erro, r.detalhe); return; }
        abrirDetalheBarbearia(telefone);
        carregarContasBarbearia(bbPaginaAtual);
      });
    });
    acoes.appendChild(alternar);
    var painel = criar("button", "segundo", "Gerar painel privado");
    painel.type = "button";
    painel.addEventListener("click", function () {
      if (!window.confirm("Criar ou trocar o painel privado deste estabelecimento?")) return;
      chamar("barb_painel_gerar", { telefone: telefone }, 90).then(function (r) {
        if (!r.ok) { recado(r.erro, r.detalhe); return; }
        var link = criar("a", "", r.url);
        link.href = r.url;
        link.target = "_blank";
        link.rel = "noopener";
        var linha = criar("p", "ok", "Painel privado criado: ");
        linha.appendChild(link);
        $("bbConteudoDetalhe").prepend(linha);
        recado("gravado");
      });
    });
    acoes.appendChild(painel);
    var boasVindas = criar("button", "segundo", "Enviar boas-vindas");
    boasVindas.type = "button";
    boasVindas.addEventListener("click", function () {
      if (!window.confirm("Enviar agora a mensagem de boas-vindas por WhatsApp?")) return;
      chamar("barb_boas_vindas", { telefone: telefone }, 60).then(function (r) {
        if (!r.ok) { recado(r.erro, r.detalhe); return; }
        recado("mensagem_enviada", r.simulado ? "Envio simulado; nenhum WhatsApp saiu." : "");
      });
    });
    acoes.appendChild(boasVindas);
    var mensagem = criar("button", "segundo", "Enviar mensagem");
    mensagem.type = "button";
    mensagem.addEventListener("click", function () {
      var textoMensagem = window.prompt("Mensagem para este estabelecimento:");
      if (!textoMensagem) return;
      if (!window.confirm("Enviar esta mensagem agora para " + telefone + "?")) return;
      chamar("barb_mensagem", { telefone: telefone, texto: textoMensagem }, 60).then(function (r) {
        if (!r.ok) { recado(r.erro, r.detalhe); return; }
        recado("mensagem_enviada", r.simulado ? "Envio simulado; nenhum WhatsApp saiu." : "");
      });
    });
    acoes.appendChild(mensagem);
    var fechar = criar("button", "segundo", "Definir prazo");
    fechar.type = "button";
    fechar.addEventListener("click", function () {
      var dias = window.prompt("Definir o prazo a partir de hoje, em dias:", "30");
      if (dias === null) return;
      if (!/^\d+$/.test(dias) || Number(dias) < 1 || Number(dias) > 3650) { recado("numero"); return; }
      chamar("barb_conta_fechar", { telefone: telefone, dias: Number(dias) }, 45).then(function (r) {
        if (!r.ok) { recado(r.erro, r.detalhe); return; }
        abrirDetalheBarbearia(telefone);
        carregarContasBarbearia(bbPaginaAtual);
      });
    });
    acoes.appendChild(fechar);
  }

  function abrirDetalheBarbearia(telefone) {
    $("bbDetalhe").hidden = false;
    $("bbDetalheTitulo").textContent = "Carregando estabelecimento…";
    $("bbDetalheSubtitulo").textContent = telefone;
    chamar("barb_detalhe", { telefone: telefone }, 60).then(function (d) {
      if (!d.ok) {
        $("bbDetalhe").hidden = true;
        recado(d.erro, d.detalhe);
        return;
      }
      bbDetalheAtual = d;
      bbAbaDetalhe = "conta";
      renderDetalheBarbearia();
    });
  }

  CARREGA.clientesbarbearia = carregarPaginaClientesBarbearia;

  $("formBarbPaginaImportar").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var botao = $("bbiImportar");
    botao.disabled = true;
    bbAviso("bbiEstado", "Lendo a página pública e atualizando os dados…", false);
    chamar("barb_pagina_importar", {
      telefone: $("bbiTelefone").value,
      url: $("bbiUrl").value,
    }, 90).then(function (d) {
      botao.disabled = false;
      if (!d.ok) {
        bbAviso("bbiEstado", mensagemDetalhada(d), true);
        return;
      }
      var texto = "Página clonada: " + texto(d.nome) +
        " · " + texto(d.servicos || 0) + " serviço(s)" +
        " · " + texto(d.horarios || 0) + " horário(s)" +
        " · " + texto(d.pagamentos || 0) + " forma(s) de pagamento.";
      if (d.url) texto += " Endereço: " + d.url;
      bbAviso("bbiEstado", texto, false);
      carregarContasBarbearia(bbPaginaAtual);
    });
  });

  $("formBarbChat").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var botao = evento.target.querySelector('button[type="submit"]');
    botao.disabled = true;
    bbAviso("bcEstado", "Salvando…", false);
    var dados = {
      ativo: $("bcAtivo").checked,
      responder_controle: $("bcControle").checked,
      trial_dias: $("bcTrial").value,
      lembrete_hora: $("bcLembreteHora").value,
      dias_retencao: $("bcRetencao").value,
      menu: $("bcMenu").value,
      boas_vindas: $("bcBoasVindas").value,
      abordagem: $("bcAbordagem").value,
      lembrete: $("bcLembrete").value,
      aviso_cliente: $("bcAvisoCliente").value,
      msg_interesse: $("bcInteresse").value,
      msg_vencido: $("bcVencido").value,
      boas_vindas_site: $("bcBoasVindasSite").value,
      aviso_novo_site: $("bcAvisoNovoSite").value,
      ajuda_funcionario: $("bcAjudaFuncionario").value,
    };
    var telefoneAdmin = $("bcRenovarAdmin").value.trim();
    if (telefoneAdmin) dados.renovar_admin_telefone = telefoneAdmin;
    chamar("barb_salvar", dados, 60).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { bbAviso("bcEstado", mensagemDetalhada(d), true); return; }
      bbAviso("bcEstado", "Configurações salvas.", false);
      CARREGA.chatbarbearia();
    });
  });

  $("bcRenovarAdminLimpar").addEventListener("click", function () {
    if (!window.confirm("Desativar o comando de renovação pelo WhatsApp?")) return;
    var botao = $("bcRenovarAdminLimpar");
    botao.disabled = true;
    chamar("barb_salvar", { renovar_admin_telefone: "" }, 45).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { bbAviso("bcEstado", mensagemDetalhada(d), true); return; }
      bbAviso("bcEstado", "Comando de renovação desativado.", false);
      CARREGA.chatbarbearia();
    });
  });

  $("formBarbAdicionar").addEventListener("submit", function (evento) {
    evento.preventDefault();
    var botao = $("bbAdicionar");
    botao.disabled = true;
    bbAviso("bbAdicionarEstado", "Cadastrando…", false);
    chamar("barb_conta_adicionar", {
      telefone: $("bbTelefone").value,
      nome: $("bbNome").value,
      nota: $("bbNota").value,
      dias: $("bbDias").value,
      avisar: $("bbAvisar").checked,
    }, 60).then(function (d) {
      botao.disabled = false;
      if (!d.ok) { bbAviso("bbAdicionarEstado", mensagemDetalhada(d), true); return; }
      var aviso = d.boas_vindas ? (d.boas_vindas.ok
        ? (d.boas_vindas.simulado ? " Boas-vindas simuladas; nenhum WhatsApp saiu." : " Boas-vindas enviadas.")
        : " O cadastro foi feito, mas o envio de boas-vindas falhou: " + texto(d.boas_vindas.erro))
        : " Nenhuma mensagem foi enviada.";
      bbAviso("bbAdicionarEstado", (d.novo ? "Estabelecimento cadastrado." : "Cadastro existente atualizado.") + aviso, false);
      $("bbTelefone").value = "";
      $("bbNome").value = "";
      $("bbNota").value = "";
      carregarContasBarbearia(1);
      carregarInteressadosBarbearia();
    });
  });

  $("bbBuscar").addEventListener("click", function () { carregarContasBarbearia(1, $("bbBusca").value.trim()); });
  $("bbAtualizar").addEventListener("click", function () {
    carregarContasBarbearia(bbPaginaAtual);
    carregarInteressadosBarbearia();
  });
  $("bbBusca").addEventListener("keydown", function (evento) {
    if (evento.key === "Enter") {
      evento.preventDefault();
      carregarContasBarbearia(1, $("bbBusca").value.trim());
    }
  });
  $("bbAnterior").addEventListener("click", function () {
    if (bbPaginaAtual > 1) carregarContasBarbearia(bbPaginaAtual - 1);
  });
  $("bbProxima").addEventListener("click", function () { carregarContasBarbearia(bbPaginaAtual + 1); });

  // ------------------------------------------------------------------ boot

  function relogio() {
    var el = $("relogio");
    if (el) el.textContent = new Date().toISOString().substring(0, 16).replace("T", " ") + " UTC";
  }

  setInterval(relogio, 30000);
  relogio();

  if (!FUNCAO) {
    mostrarLogin("Diga o endereço da função em painel/config.js.");
    return;
  }

  if (!token()) { mostrarLogin(""); return; }

  chamar("ping", {}, 20).then(function (d) {
    if (!d.ok) { mostrarLogin(""); return; }
    mostrarPainel();
    verificarAndamento("recuperar");
    verificarAndamento("apagar");
    verificarAndamento("mensagem");
  });
})();
