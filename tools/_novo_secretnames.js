// Compara os NOMES de secret entre a cópia e o projeto novo (valores não saem: a API devolve hash).
const fs = require("fs");
const env = fs.readFileSync(".env", "utf8");
const pega = (k) => { const m = env.match(new RegExp(k + "=([^\r\n]*)")); return m ? m[1].trim() : ""; };
const COPIA = "bzgtptbwcvwpgnhbctjn";
async function nomes(ref, token) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 200) return { erro: `${r.status} ${await r.text()}` };
  return (await r.json()).map((s) => s.name).sort();
}
(async () => {
  const novo = await nomes(pega("SUPABASE_PROJECT_NOVO"), pega("SUPABASE_TOKEN_NOVO"));
  const copia = await nomes(COPIA, pega("SUPABASE_PROJECT_2peer"));
  if (novo.erro || copia.erro) { console.log("novo:", JSON.stringify(novo).slice(0, 200)); console.log("copia:", JSON.stringify(copia).slice(0, 200)); process.exit(1); }
  const faltando = copia.filter((n) => !novo.includes(n));
  const sobrando = novo.filter((n) => !copia.includes(n));
  console.log("cópia tem", copia.length, "| novo tem", novo.length);
  console.log("faltando no novo (está na cópia):", faltando.join(", ") || "nenhum");
  console.log("só no novo:", sobrando.join(", ") || "nenhum");
})();
