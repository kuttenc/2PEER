// Manda um arquivo .sql para o endpoint de SQL do projeto novo e imprime a resposta.
// Uso: node tools/_novo_sql.js tools/arquivo.sql
// Os marcadores __HOST__ / __PORT__ / __USER__ / __PASS__ são trocados pelo DATABASE_URL do
// .env (a ponte fdw da cópia) — assim nenhuma senha de banco precisa entrar num arquivo.
const fs = require("fs");

const env = fs.readFileSync(".env", "utf8");
const token = env.match(/SUPABASE_TOKEN_NOVO=([^\r\n]*)/)[1].trim();
const ref = env.match(/SUPABASE_PROJECT_NOVO=([^\r\n]*)/)[1].trim();
let query = fs.readFileSync(process.argv[2], "utf8");

const urlBanco = (env.match(/DATABASE_URL=([^\r\n]*)/) || [])[1] || "";
if (urlBanco && /__(HOST|PORT|USER|PASS)__/.test(query)) {
  const u = new URL(urlBanco.replace(/^postgres:/, "postgresql:"));
  const valores = {
    __HOST__: u.hostname,
    __PORT__: u.port || "5432",
    __USER__: decodeURIComponent(u.username),
    __PASS__: decodeURIComponent(u.password),
  };
  query = query.replace(/__(HOST|PORT|USER|PASS)__/g, (_, k) => valores[`__${k}__`]);
}

fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query }),
})
  .then((r) => r.text())
  .then((t) => console.log(t.slice(0, 4000)))
  .catch((e) => console.log("erro:", e.message));

