// MC de mentira para provar o painel sem Render: só login e a lista de linhas, com nomes
// "stub..." para dar fácil de apagar do banco de testes depois. Roda em 127.0.0.1:8099 e a
// função aponta para ele com MC_API_BASE. Nada aqui fala com o painel MC verdadeiro.
//
// Como usar (dois terminais, a partir da pasta 2peer):
//   deno run -A tools/mc_stub.ts
//   cd supabase/functions/peixeiro
//   MC_API_BASE=http://127.0.0.1:8099 deno run -A --env-file=../../../.env index.ts
// A função abre a porta 8000 e o painel local chama ela lá; o .env da cópia traz o
// DATABASE_URL e o PEIXEIRO_MODO_TESTE.
// Depois de brincar com ele, o bearer falso fica guardado em `mcapi_token_cache`: apague a
// linha (delete from public.mcapi_token_cache where id = 1) antes de mexer nas chaves reais.
const itens = [
  { id: "9001", username: "stub-ativo-30dias", password: "abc123", exp_date: iso(+30), status: 1, notes: "plano mensal", createdAt: iso(-120) },
  { id: "9002", username: "stub-vence-amanha", password: "def456", exp_date: iso(+1.2), status: 1, notes: "", createdAt: iso(-90) },
  { id: "9003", username: "stub-vencido-4dias", password: "ghi789", exp_date: iso(-4 * 24), status: 0, notes: "cobrar no pix", createdAt: iso(-60) },
  { id: "9004", username: "stub-sem-telefone", password: "jkl012", exp_date: iso(+7), status: 1, notes: "", createdAt: iso(-20) },
  { id: "9005", username: "stub-vencido-70dias", password: "mno345", exp_date: iso(-70 * 24), status: 0, notes: "antigo", createdAt: iso(-300) },
  // Números soltos depois do prefixo: é o desenho que a aba Deletar entende (prefixo + intervalo).
  { id: "9006", username: "rt7", password: "p07", exp_date: iso(-9 * 24), status: 0, notes: "vencida de teste", createdAt: iso(-40) },
  { id: "9007", username: "rt8", password: "p08", exp_date: iso(+21), status: 1, notes: "ativa de teste", createdAt: iso(-10) },
  { id: "9008", username: "rt9", password: "p09", exp_date: iso(-3 * 24), status: 0, notes: "", createdAt: iso(-50) },
];

function iso(horas: number): string {
  return new Date(Date.now() + horas * 3600_000).toISOString().slice(0, 19);
}

function jwtFalso(): string {
  const parte = (objeto: Record<string, unknown>) =>
    btoa(JSON.stringify(objeto)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${parte({ alg: "HS256", typ: "JWT" })}.${parte({ sub: "stub", exp })}.assinatura`;
}

Deno.serve({ port: 8099 }, async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/auth/login") {
    return Response.json({ token: jwtFalso(), user: { id: "stub" } });
  }
  if (url.pathname === "/lines") {
    const pagina = Number(url.searchParams.get("page") || 1);
    const porPagina = Number(url.searchParams.get("quantityPerPage") || 40);
    const busca = (url.searchParams.get("generalSearch") || "").trim();
    const filtradas = busca ? itens.filter((i) => i.username.includes(busca)) : itens;
    const fatia = filtradas.slice((pagina - 1) * porPagina, pagina * porPagina);
    return Response.json({ items: fatia, count: filtradas.length, pagesQuantity: 1, totalPage: 1 });
  }
  if (url.pathname.startsWith("/lines/") && req.method === "DELETE") {
    return Response.json({ status: true, message: "apagada (stub)" });
  }
  return Response.json({ erro: "rota não simulada", pathname: url.pathname }, { status: 404 });
});
