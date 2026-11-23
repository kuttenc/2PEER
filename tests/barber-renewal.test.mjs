import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseComandoRenovacao } from "../supabase/functions/_shared/barber-renewal.mjs";

const raiz = new URL("../", import.meta.url);
const [barbearia, migration] = await Promise.all([
  readFile(new URL("supabase/functions/peixeiro/barbearia.ts", raiz), "utf8"),
  readFile(new URL("tools/20261122_barber_renewal_command.sql", raiz), "utf8"),
]);

test("reconhece somente o comando renovar com telefone", () => {
  assert.deepEqual(parseComandoRenovacao("renovar 55 (11) 99999-8888"), { telefone: "5511999998888" });
  assert.deepEqual(parseComandoRenovacao("RENOVAR"), { telefone: "" });
  assert.equal(parseComandoRenovacao("renovar plano"), null);
  assert.equal(parseComandoRenovacao("quero renovar 5511999998888"), null);
});

test("renovação exige remetente autorizado e identificador estável do webhook", () => {
  assert.match(barbearia, /m\.telefone !== telefoneAdmin/);
  assert.match(barbearia, /if \(!m\.chave\)\s*\{\s*return await responder\(/);
  assert.match(migration, /message_id text primary key/);
  assert.match(migration, /on conflict \(message_id\) do nothing/);
});

test("renova um mês de calendário e salva a expiração resultante", () => {
  assert.match(migration, /interval '1 month'/);
  assert.match(migration, /expira_anterior/);
  assert.match(migration, /expira_nova/);
});
