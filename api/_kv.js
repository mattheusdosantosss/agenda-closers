// Helper de armazenamento (Upstash REST / Vercel KV) — sem dependências.
// Arquivos com "_" no início não viram rota na Vercel; é só um módulo.
//
// Credenciais (defina UMA das duplas na Vercel):
//   KV_REST_API_URL + KV_REST_API_TOKEN            (Vercel KV — injeta sozinho)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Upstash direto)

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN_ = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const kvReady = () => !!(URL_ && TOKEN_);

// Data de HOJE no fuso de Brasília (YYYY-MM-DD).
export const dataBRT = () => new Date(Date.now() - 180 * 60000).toISOString().slice(0, 10);

async function cmd(args) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`kv ${r.status}`);
  const d = await r.json();
  return d.result;
}

export async function kvGetJSON(key) {
  const v = await cmd(["GET", key]);
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
}

export async function kvSetJSON(key, val, ttlSec) {
  const args = ["SET", key, JSON.stringify(val)];
  if (ttlSec) args.push("EX", String(ttlSec));
  return cmd(args);
}
