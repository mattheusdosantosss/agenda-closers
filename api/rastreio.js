// Vercel Serverless Function  ·  POST /api/rastreio
// ---------------------------------------------------------------------------
// Portão de acesso da página privada /rastreio. Valida a senha contra a env
// RASTREIO_SECRET (definida só na Vercel, nunca no código do cliente).
// Recebe { key } no corpo; responde { ok:true } ou 401.
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "use POST" });
    return;
  }
  const secret = process.env.RASTREIO_SECRET || "";
  if (!secret) {
    res.status(501).json({ error: "RASTREIO_SECRET não configurado na Vercel." });
    return;
  }

  let key = "";
  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    key = String(body.key ?? "");
  } catch {
    key = "";
  }

  if (key !== secret) {
    res.status(401).json({ error: "senha incorreta" });
    return;
  }
  res.status(200).json({ ok: true });
}
