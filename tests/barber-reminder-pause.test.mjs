import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { diasConsecutivosEntregues } from "../supabase/functions/_shared/barber-reminder-pause.mjs";

const raiz = new URL("../", import.meta.url);
const [barbearia, chat, acoes, migration] = await Promise.all([
  readFile(new URL("supabase/functions/peixeiro/barbearia.ts", raiz), "utf8"),
  readFile(new URL("supabase/functions/peixeiro/chat.ts", raiz), "utf8"),
  readFile(new URL("supabase/functions/peixeiro/acoes.ts", raiz), "utf8"),
  readFile(new URL("tools/20261122_barber_reminder_delivery_pause.sql", raiz), "utf8"),
]);

test("pausa com duas datas consecutivas entregues, mesmo com mais de um envio no dia", () => {
  assert.equal(diasConsecutivosEntregues(["2026-11-21", "2026-11-22", "2026-11-22"]), true);
  assert.equal(diasConsecutivosEntregues(["2026-11-22", "2026-11-21"]), true);
});

test("não pausa por entrega única, duplicada no mesmo dia ou com intervalo", () => {
  assert.equal(diasConsecutivosEntregues(["2026-11-22"]), false);
  assert.equal(diasConsecutivosEntregues(["2026-11-22", "2026-11-22"]), false);
  assert.equal(diasConsecutivosEntregues(["2026-11-20", "2026-11-22"]), false);
});

test("resposta nova apaga o ciclo anterior e só status entregue/lido marca confirmação", () => {
  assert.match(barbearia, /delete from public\.barber_reminder_deliveries where telefone = \$1/);
  assert.match(barbearia, /status !== "DELIVERED" && status\.status !== "READ"/);
  assert.match(barbearia, /m\.criado_em > d\.enviado_em/);
  assert.match(chat, /timestamp: Number\.isFinite\(timestamp\)/);
});

test("apenas os lembretes agendados consultam a pausa e guardam o id Green API", () => {
  assert.equal((barbearia.match(/automatico && await lembreteAutomaticoPausado\(conta\.telefone\)/g) || []).length, 2);
  assert.equal((barbearia.match(/registrarRastreamentoLembrete\(envio, conta\.telefone/g) || []).length, 2);
  assert.match(barbearia, /if \(!idMessage\) return false;[\s\S]*await registrarLembreteEnviado\(idMessage, telefone, tipo, enviadoEm\);/);
  assert.match(acoes, /bomDiaTodos\(forcar, new Date\(\), !forcar\)/);
  assert.match(acoes, /lembretesDoDia\(forcar, new Date\(\), !forcar\)/);
  assert.match(migration, /create table if not exists public\.barber_reminder_deliveries/);
  assert.match(migration, /categoria in \('bom_dia', 'agenda'\)/);
});
