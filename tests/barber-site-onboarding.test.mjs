import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  mensagemPerfilWhatsApp,
  paginaProntaParaAgendamento,
} from "../supabase/functions/_shared/barber-site-onboarding.mjs";

const paginaCompleta = {
  aceita_agendamento: true,
  nome: "Barbearia Exemplo",
  telefone: "5511999999999",
  telefone_publico: "",
  servicos: [{ nome: "Corte" }],
  horarios: [{ abre: "09:00", fecha: "18:00" }],
  pagamentos: ["Pix"],
};

test("só considera a página pronta quando pode receber agendamentos completos", () => {
  assert.equal(paginaProntaParaAgendamento(paginaCompleta), true);
  assert.equal(paginaProntaParaAgendamento({ ...paginaCompleta, aceita_agendamento: false }), false);
  assert.equal(paginaProntaParaAgendamento({ ...paginaCompleta, servicos: [] }), false);
  assert.equal(paginaProntaParaAgendamento({ ...paginaCompleta, horarios: [] }), false);
  assert.equal(paginaProntaParaAgendamento({ ...paginaCompleta, pagamentos: [] }), false);
});

test("a orientação contém o link público e o caminho do WhatsApp Business", () => {
  const mensagem = mensagemPerfilWhatsApp("https://exemplo.test/barbearia/");
  assert.match(mensagem, /Ferramentas comerciais/);
  assert.match(mensagem, /Perfil comercial/);
  assert.match(mensagem, /Toque em Site/);
  assert.equal((mensagem.match(/https:\/\/exemplo\.test\/barbearia\//g) || []).length, 2);
});

test("o envio é reivindicado uma vez e só conta como enviado após aceitação real", async () => {
  const source = (await readFile(
    new URL("../supabase/functions/peixeiro/estabelecimento.ts", import.meta.url),
    "utf8",
  )).replace(/\r\n/g, "\n");
  const inicio = source.indexOf("async function enviarOrientacaoWhatsApp");
  const fim = source.indexOf("export async function publicarPainelBarbearia", inicio);
  assert.ok(inicio >= 0);
  assert.ok(fim > inicio);
  const envio = source.slice(inicio, fim);
  assert.match(envio, /site_instrucoes_whatsapp_enviado_em is null/);
  assert.match(envio, /site_instrucoes_whatsapp_tentativa_em/);
  assert.match(envio, /envio\.ok && !envio\.simulado/);
  assert.match(envio, /enviarTexto\(conf, d\.telefone/);
});

test("a publicação concluída dispara a orientação depois do site estar publicado", async () => {
  const source = (await readFile(
    new URL("../supabase/functions/peixeiro/estabelecimento.ts", import.meta.url),
    "utf8",
  )).replace(/\r\n/g, "\n");
  const inicio = source.indexOf("export async function publicarPagina");
  const fim = source.indexOf("async function enviarOrientacaoWhatsApp", inicio);
  assert.ok(inicio >= 0);
  assert.ok(fim > inicio);
  const publicar = source.slice(inicio, fim);
  assert.ok(publicar.indexOf("await publicarIndice()") < publicar.indexOf("enviarOrientacaoWhatsApp(d)"));
});
