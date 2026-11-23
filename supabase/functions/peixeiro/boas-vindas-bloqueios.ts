import { consultar, consultar1 } from "./db.ts";
import { formatarTelefone, normalizarWhatsapp, telefoneValido } from "./texto.ts";

export type BloqueioBoasVindas = {
  telefone: string;
  nome: string;
  motivo: string;
  atualizado_em: string;
};

const numeroNormalizado = (telefone: string) => normalizarWhatsapp(telefone);

export async function boasVindasPlanoAtivo(telefone: string): Promise<boolean> {
  const numero = numeroNormalizado(telefone);
  if (!telefoneValido(numero)) return false;
  return Boolean(await consultar1(
    `select 1 as bloqueado
       from public.barber_boas_vindas_bloqueios
      where telefone = $1 and ativo
      limit 1`,
    [numero],
  ));
}

export async function listarBloqueiosBoasVindas(
  termo: string,
): Promise<{ itens: BloqueioBoasVindas[]; total: number; busca: string }> {
  const bruto = String(termo || "").trim();
  const temLetra = /\p{L}/u.test(bruto);
  const alvo = temLetra ? bruto.replace(/[%_]/g, "") : bruto.replace(/\D/g, "");
  const filtro = !alvo
    ? ""
    : temLetra
    ? "and (nome ilike '%' || $1 || '%' or motivo ilike '%' || $1 || '%')"
    : "and (telefone like '%' || $1 || '%' or regexp_replace(telefone, '^55', '') like '%' || $1 || '%')";
  const argumentos = alvo ? [alvo] : [];
  const lista = await consultar(
    `select telefone, nome, motivo,
            to_char(atualizado_em, 'DD/MM/YYYY \"às\" HH24:MI') as atualizado_em
       from public.barber_boas_vindas_bloqueios
      where ativo ${filtro}
      order by atualizado_em desc
      limit 900`,
    argumentos,
  );
  const total = await consultar(
    `select count(*)::int as total
       from public.barber_boas_vindas_bloqueios
      where ativo ${filtro}`,
    argumentos,
  );
  return {
    itens: lista.rows.map((linha) => ({
      telefone: formatarTelefone(String(linha.telefone || "")),
      nome: String(linha.nome || ""),
      motivo: String(linha.motivo || ""),
      atualizado_em: String(linha.atualizado_em || ""),
    })),
    total: Number(total.rows[0]?.total || 0),
    busca: bruto,
  };
}

export async function adicionarBloqueioBoasVindas(
  telefone: string,
  nome: string,
  motivo: string,
): Promise<{ ok: boolean; erro?: string }> {
  const numero = numeroNormalizado(telefone);
  if (!telefoneValido(numero)) return { ok: false, erro: "telefone_invalido" };
  const nomeLimpo = String(nome || "").trim().slice(0, 120);
  const motivoLimpo = String(motivo || "").trim().slice(0, 160) || "plano ativo";
  await consultar(
    `insert into public.barber_boas_vindas_bloqueios
       (telefone, nome, motivo, ativo, criado_em, atualizado_em, desativado_em)
     values ($1, $2, $3, true, now(), now(), null)
     on conflict (telefone) do update
       set nome = coalesce(nullif(excluded.nome, ''), barber_boas_vindas_bloqueios.nome),
           motivo = excluded.motivo,
           ativo = true,
           atualizado_em = now(),
           desativado_em = null`,
    [numero, nomeLimpo, motivoLimpo],
  );
  return { ok: true };
}

export async function desativarBloqueioBoasVindas(telefone: string): Promise<boolean> {
  const numero = numeroNormalizado(telefone);
  if (!telefoneValido(numero)) return false;
  const resultado = await consultar(
    `update public.barber_boas_vindas_bloqueios
        set ativo = false, atualizado_em = now(), desativado_em = now()
      where telefone = $1 and ativo`,
    [numero],
  );
  return resultado.rowCount > 0;
}
