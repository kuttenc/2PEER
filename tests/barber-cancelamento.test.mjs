import assert from "node:assert/strict";
import test from "node:test";
import {
  hashCodigoCancelamento,
  instanteDoAgendamento,
  novoCodigoCancelamento,
} from "../supabase/functions/peixeiro/cancelamento.mjs";

test("gera códigos de seis dígitos, inclusive com zeros à esquerda", () => {
  for (let i = 0; i < 100; i++) {
    assert.match(novoCodigoCancelamento(), /^\d{6}$/);
  }
});

test("o código é protegido por HMAC com salt e segredo do servidor", async () => {
  const primeiro = await hashCodigoCancelamento("042681", "salt-a", "segredo-servidor");
  assert.equal(primeiro.length, 64);
  assert.notEqual(primeiro, await hashCodigoCancelamento("042681", "salt-b", "segredo-servidor"));
  assert.notEqual(primeiro, await hashCodigoCancelamento("042681", "salt-a", "outro-segredo"));
  await assert.rejects(() => hashCodigoCancelamento("42681", "salt-a", "segredo-servidor"));
});

test("converte data e hora de Brasília para UTC e rejeita horários inválidos/passados", () => {
  assert.equal(
    instanteDoAgendamento("2026-11-22", "09:30", Date.parse("2026-11-21T00:00:00Z")),
    "2026-11-22T12:30:00.000Z",
  );
  assert.equal(instanteDoAgendamento("2026-02-30", "09:30"), null);
  assert.equal(instanteDoAgendamento("2026-11-22", "24:00"), null);
  assert.equal(
    instanteDoAgendamento("2026-11-20", "09:30", Date.parse("2026-11-21T00:00:00Z")),
    null,
  );
});
