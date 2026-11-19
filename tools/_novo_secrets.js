// Seta os secrets do painel no projeto novo. Nunca imprime valor: só nomes e comprimentos.
// Uso: node tools/_novo_secrets.js
const fs = require("fs");

const env = fs.readFileSync(".env", "utf8");
const pega = (chave) => {
  const m = env.match(new RegExp(chave + "=([^\\r\\n]*)"));
  return m ? m[1].trim() : "";
};

const token = pega("SUPABASE_TOKEN_NOVO");
const ref = pega("SUPABASE_PROJECT_NOVO");
const senhaBanco = pega("PEIXEIRO_2PEER_DB_SENHA");

const alvosOriginais = [
  { name: "DATABASE_URL", value: `postgres://peixeiro_2peer.${ref}:${senhaBanco}@aws-0-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require` },
  { name: "MC_USERNAME", value: pega("MC_USERNAME") },
  { name: "MC_PASSWORD", value: pega("MC_PASSWORD") },
  { name: "URTADOR_BASE_URL", value: pega("URTADOR_BASE_URL") },
  { name: "URTADOR_TOKEN", value: pega("URTADOR_TOKEN") },
  { name: "PAINEL_ORIGENS", value: "https://kuttenc.github.io" },
  { name: "PAINEL_ASSETS_URL", value: "https://kuttenc.github.io/2PEER/assets" },
];
const alvos = alvosOriginais.filter((s) => s.value.length > 0);
const pulados = alvosOriginais.filter((s) => s.value.length === 0).map((s) => s.name);

fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(alvos),
})
  .then((r) => r.text().then((t) => ({ status: r.status, t })))
  .then(({ status, t }) => {
    console.log("http", status, "|", t.slice(0, 300));
    console.log("setados:", alvos.map((s) => `${s.name} (${s.value.length} chars)`).join(", "));
    if (pulados.length) console.log("pulados por estarem vazios no .env:", pulados.join(", "));
  })
  .catch((e) => console.log("erro:", e.message));
