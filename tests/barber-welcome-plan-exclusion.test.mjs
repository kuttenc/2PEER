import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const arquivo = (caminho) => readFile(new URL(caminho, import.meta.url), "utf8");

test("renovações ativas alimentam uma lista separada de proteção de boas-vindas", async () => {
  const migration = await arquivo("../tools/20261123_barber_welcome_plan_exclusions.sql");
  const bloqueios = await arquivo("../supabase/functions/peixeiro/boas-vindas-bloqueios.ts");
  assert.match(migration, /create table if not exists public\.barber_boas_vindas_bloqueios/);
  assert.match(migration, /r\.resultado = 'renovado'[\s\S]*c\.ativo[\s\S]*c\.expira_em > now\(\)/);
  assert.match(migration, /after insert or update on public\.barber_renovacoes/);
  assert.match(migration, /on conflict \(telefone\) do update[\s\S]*ativo = true/);
  assert.match(migration, /null::timestamptz/);
  assert.match(bloqueios, /where telefone = \$1 and ativo/);
  assert.match(bloqueios, /set ativo = false[\s\S]*desativado_em = now\(\)/);
});

test("todas as rotas de boas-vindas e prospecção consultam a proteção", async () => {
  const barbearia = await arquivo("../supabase/functions/peixeiro/barbearia.ts");
  const acoes = await arquivo("../supabase/functions/peixeiro/acoes.ts");
  const index = await arquivo("../supabase/functions/peixeiro/index.ts");
  const painelJs = await arquivo("../painel/app.js");
  const painelHtml = await arquivo("../painel/index.html");
  assert.match(barbearia, /boasVindasPlanoAtivo\(conta\.telefone\)/);
  assert.match(barbearia, /not exists \([\s\S]*barber_boas_vindas_bloqueios/);
  assert.match(barbearia, /enviarParaBarbeiro\(telefone, textos\.boas_vindas, true\)/);
  assert.match(acoes, /boasVindasPlanoAtivo\(telefone\)/);
  assert.match(acoes, /enviarParaBarbeiro\(telefone, modelo, booleano\(dados\.boas_vindas\)\)/);
  assert.match(index, /barb_boas_vindas_bloqueios_ver: acoes\.barbBoasVindasBloqueiosVer/);
  assert.match(painelHtml, /id="formBoasVindasPlano"/);
  assert.match(painelJs, /Enviar boas-vindas\/prospecção/);
  assert.match(painelJs, /boas_vindas: boasVindas/);
});
