/* O painel sem Render: tudo que o navegador faz é chamar a Edge Function com {"action": ...}
   e o token da sessão no Authorization. Nenhuma chave de banco ou senha do MC passa por aqui. */
(function () {
  "use strict";

  var FUNCAO = (window.PEIXEIRO || {}).funcao || "";
  var CHAVE_SESSAO = "peixeiro_sessao";
  var CHAVE_PULAR = "peixeiro_lote_pular";
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
    csv_vazio: "O CSV não veio, ou não tem nenhuma linha com usuário.",
    csv_cabecalho: "Use as colunas Usuário, Telefone, Expira, Status, Nota (na ordem ou no cabeçalho).",
    varrer: "A varredura não conseguiu rodar agora.",
    sem_sessao: "A sessão expirou. Entre de novo.",
    sem_sobra: "Ninguém sobrou para enviar. Desmarque alguém ou cadastre o telefone.",
    sem_sobra_apagar: "Ninguém sobrou para apagar. Desmarque alguém ou ligue o item de quem está ativo.",
    conferencia_venceu: "A conferência venceu. Abra o modal de novo para contar outra vez.",
    lote_rodando: "Já existe um lote rodando. Abra o progresso para ver.",
    prefixo_ruim: "Prefixo demais: até 24 letras, sem espaço.",
    intervalo_obrigatorio: "Preencha o de e o até com números.",
    intervalo_invertido: "O \u201caté\u201d precisa ser maior que o \u201cde\u201d.",
    intervalo_grande: "Intervalo grande demais para um lote só.",
    acao_inexistente: "Esta versão do painel não conhece essa ação.",
    interna: "A função respondeu errado. Abra de novo ou veja os logs dela.",
    sem_resposta: "A função não respondeu. Confira a conexão e tente de novo.",
    url: "Escreva o endereço inteiro, começando por https:// (ou deixe vazio para seguir o padrão).",
    sem_slug: "Este link não está na lista. Use recuperar para ele aparecer aqui.",
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
    var meio = d.length === 9 ? 5 : 4;
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

  var TELAS = ["inicio", "config", "avisos", "acessos", "recuperacao", "clientes", "deletar", "links", "senha", "apagar"];
  var CARREGA = {};

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

  var lote = { tipo: "recuperar", rodando: false, temporizador: null, terminou: false, passo: null };

  function desenharProgresso(tipo, estado) {
    var total = estado.total || 0;
    var feitos = (estado.enviados || 0) + (estado.falhas || 0);
    var prefixo = tipo === "apagar" ? "ap" : "lp";
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
      seguidas: "Três falhas seguidas: o lote parou para você conferir.",
      parou_manual: "Você parou o lote.",
    }[codigo] || "";
  }

  function rodarLote(tipo) {
    lote.tipo = tipo;
    lote.rodando = true;
    lote.terminou = false;
    lote.passo = function () {
      if (!lote.rodando) return;
      chamar("lote_item", { tipo: tipo }, 120).then(function (d) {
        if (!lote.rodando) return;
        if (!d.ok) {
          lote.rodando = false;
          pararTemporizador();
          recado(d.erro, d.detalhe);
          return;
        }
        var estado = d.estado || {};
        mostrarEstado(tipo, estado);
        if (d.terminado || !estado.rodando) {
          terminarLote(tipo, estado);
          return;
        }
        esperar(Number(d.esperar || 0) * 1000 || 120);
      });
    };
    lote.passo();
  }

  /** A função devolve quantos segundos esperar antes do próximo item (0 = sem espera,
   *  como no lote de apagar). A contagem na tela é para ele saber que o lote está vivo. */
  function esperar(ms) {
    pararTemporizador();
    var alvo = $("lpPausa");
    if (ms <= 1000 || !alvo) {
      lote.temporizador = setTimeout(function () { lote.temporizador = null; lote.passo(); }, ms);
      return;
    }
    var restante = Math.ceil(ms / 1000);
    alvo.hidden = false;
    alvo.textContent = "próxima mensagem em " + restante + "s";
    lote.temporizador = setInterval(function () {
      restante -= 1;
      if (restante > 0) { alvo.textContent = "próxima mensagem em " + restante + "s"; return; }
      pararTemporizador();
      if (lote.rodando) lote.passo();
    }, 1000);
  }

  function pararTemporizador() {
    if (lote.temporizador) { clearTimeout(lote.temporizador); clearInterval(lote.temporizador); lote.temporizador = null; }
    var alvo = $("lpPausa");
    if (alvo) { alvo.hidden = true; alvo.textContent = ""; }
  }

  function mostrarEstado(tipo, estado) {
    var desenhado = desenharProgresso(tipo, estado);
    var alvo = $(tipo === "apagar" ? "apTexto" : "lpTexto");
    if (alvo) {
      alvo.textContent = (estado.enviados || 0) + (tipo === "apagar" ? " apagados de " : " enviados de ") +
        desenhado.total + " · " + (estado.falhas || 0) + " com erro";
    }
    var faixa = $(tipo === "apagar" ? "apAndamento" : "loteAndamento");
    if (faixa) {
      faixa.hidden = !estado.rodando;
      var textoFaixa = $(tipo === "apagar" ? "apAndamentoTexto" : "loteAndamentoTexto");
      if (textoFaixa) {
        textoFaixa.textContent = (estado.enviados || 0) + " de " + desenhado.total +
          (tipo === "apagar" ? " apagados" : " enviados");
      }
    }
  }

  function terminarLote(tipo, estado) {
    pararTemporizador();
    lote.rodando = false;
    lote.terminou = true;
    mostrarEstado(tipo, estado);
    var alvo = $(tipo === "apagar" ? "apTexto" : "lpTexto");
    if (alvo) {
      alvo.textContent = "terminou: " + (estado.enviados || 0) +
        (tipo === "apagar" ? " apagados, " : " enviados, ") + (estado.falhas || 0) + " com erro";
    }
    var parar = $(tipo === "apagar" ? "apParar" : "lpParar");
    if (parar) parar.hidden = true;
    if (estado.motivo) {
      var motivo = $(tipo === "apagar" ? "apMotivo" : "lpMotivo");
      if (motivo) { motivo.textContent = motivoParada(estado.motivo); motivo.hidden = false; }
    }
    var faixa = $(tipo === "apagar" ? "apAndamento" : "loteAndamento");
    if (faixa) faixa.hidden = true;
  }

  function abrirProgresso(tipo, total) {
    var revisar = $(tipo === "apagar" ? "maRevisar" : "mlRevisar");
    var progresso = $(tipo === "apagar" ? "maProgresso" : "mlProgresso");
    var modal = $(tipo === "apagar" ? "modalApagar" : "modalLote");
    if (revisar) revisar.hidden = true;
    if (progresso) progresso.hidden = false;
    if (modal) modal.hidden = false;
    var parar = $(tipo === "apagar" ? "apParar" : "lpParar");
    if (parar) { parar.hidden = false; parar.disabled = false; }
    var motivo = $(tipo === "apagar" ? "apMotivo" : "lpMotivo");
    if (motivo) motivo.hidden = true;
    desenharProgresso(tipo, { total: total, enviados: 0, falhas: 0, erros: [] });
    rodarLote(tipo);
  }

  function pararLote(tipo) {
    var botao = $(tipo === "apagar" ? "apParar" : "lpParar");
    if (botao) { botao.disabled = true; botao.textContent = "parando…"; }
    chamar("lote_parar", { tipo: tipo }, 30).then(function () {
      pararTemporizador();
      lote.rodando = false;
      if (botao) { botao.disabled = false; botao.textContent = tipo === "apagar" ? "Parar de apagar" : "Parar de enviar"; }
    });
  }

  $("lpParar").addEventListener("click", function () { pararLote("recuperar"); });
  $("apParar").addEventListener("click", function () { pararLote("apagar"); });

  function fecharLote(tipo) {
    var modal = $(tipo === "apagar" ? "modalApagar" : "modalLote");
    if (modal) modal.hidden = true;
    if (lote.terminou) {
      lote.terminou = false;
      if (tipo === "apagar") irPara("#deletar"); else carregarAcessos(acPagina, acBusca);
    }
  }

  $("lpFechar").addEventListener("click", function () { fecharLote("recuperar"); });
  $("mlVoltar").addEventListener("click", function () { $("modalLote").hidden = true; });
  $("apFechar").addEventListener("click", function () { fecharLote("apagar"); });
  $("maVoltar").addEventListener("click", function () { $("modalApagar").hidden = true; });
  $("btnVerEnvio").addEventListener("click", function () { $("modalLote").hidden = false; });
  $("btnVerExclusao").addEventListener("click", function () { $("modalApagar").hidden = false; });

  document.addEventListener("keydown", function (evento) {
    if (evento.key !== "Escape") return;
    $("modalMescla").hidden = true;
    if (!$("modalLote").hidden) fecharLote("recuperar");
    if (!$("modalApagar").hidden) fecharLote("apagar");
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
    $("mlEnviar").disabled = true;
    $("mlAlvos").textContent = "…";
    $("mlVencidos").textContent = "…";
    $("modalLote").hidden = false;
    recado("");
    chamar("lote_contagem", { tipo: "recuperar", q: acBusca, pular: Array.from(pular) }, 180).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      $("mlAlvos").textContent = d.alvos;
      $("mlVencidos").textContent = d.vencidos;
      $("mlPulados").textContent = d.pulados;
      $("mlSemTelefone").textContent = d.sem_telefone;
      $("mlEsperando").textContent = d.esperando;
      $("mlForaMC").textContent = d.so_no_espelho;
      $("mlFoto").textContent = d.foto ? "sim, a foto da aba Recuperação" : "não — vai só o texto";
      $("mlBusca").textContent = (d.busca
        ? "Filtro \u201c" + d.busca + "\u201d ativo: só entra na conta quem bate nesse filtro."
        : "Sem filtro: a varrida pega todas as páginas do painel MC.") +
        (d.marcados > d.pulados ? " " + (d.marcados - d.pulados) + " marcado(s) não estavam entre os vencidos." : "");
      var fora = $("mlFora");
      fora.hidden = !d.so_no_espelho;
      fora.textContent = d.so_no_espelho
        ? ("Ficam de fora porque a linha não existe mais no painel MC (só no espelho): " +
          (d.fora_do_mc || []).join(", ") +
          (d.so_no_espelho > (d.fora_do_mc || []).length ? "…" : "") +
          " — para esses, use o botão recuperar da própria linha.")
        : "";
      var nomes = limpar($("mlNomes"));
      (d.primeiros || []).forEach(function (n) { nomes.appendChild(criar("span", "", n)); });
      var enviar = $("mlEnviar");
      enviar.disabled = !d.alvos;
      if (!d.alvos) avisoLote("Ninguém sobrou para enviar. Desmarque alguém ou cadastre o telefone.");
      else if (d.aviso) avisoLote("A varrida parou antes do fim: " + d.aviso);
      else avisoLote("");
    });
  });

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

  // ------------------------------------------------------------------ clientes

  CARREGA.clientes = function () { carregarClientes(); };

  function carregarClientes() {
    chamar("clientes_ver", {}, 60).then(function (d) {
      if (!d.ok) { recado(d.erro, d.detalhe); return; }
      var linhas = d.linhas || [];
      var comTelefone = d.com_telefone || 0;
      $("clResumo").textContent = linhas.length + " clientes · " + comTelefone + " com telefone" +
        (linhas.length && linhas[0].sincronizado ? " · última sincronização " + linhas[0].sincronizado : "");
      $("clAvisoLista").textContent = linhas.length
        ? "Corrija ou cadastre o número na caixinha e toque salvar — a máscara já formata (DDD) nnnnn-nnnn e o 55 entra sozinho."
        : "";
      $("clBarraLote").hidden = !linhas.length;
      var corpo = limpar($("clLinhas"));
      if (!linhas.length) {
        var vazio = criar("p", "muted", "Nada no espelho ainda. Use \"Sincronizar agora\" ou abra a tela Acessos — cada página aberta já grava aqui.");
        corpo.appendChild(vazio);
      }
      linhas.forEach(function (c) { corpo.appendChild(linhaCliente(c)); });
      aplicarMarcasPular();
      atualizarBarraLote();
    });
  }

  function linhaCliente(c) {
    var linha = document.createElement("tr");
    var tdLote = criar("td", "lote");
    if (c.vencido) {
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
    [tdLote, tdNome, tdTel, tdExpira, tdFaltam, tdStatus, tdNota, tdAccoes].forEach(function (c2) {
      linha.appendChild(c2);
    });
    return linha;
  }

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
      var faixa = $(tipo === "apagar" ? "apAndamento" : "loteAndamento");
      if (faixa) faixa.hidden = false;
      mostrarEstado(tipo, estado);
      lote.tipo = tipo;
      if (!lote.rodando) rodarLote(tipo);
    });
  }

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
  });
})();
