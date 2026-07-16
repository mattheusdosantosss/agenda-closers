// Vercel Serverless Function  ·  GET /api/historico
// ---------------------------------------------------------------------------
// Devolve tudo que foi "visto hoje" (gravado por /api/reunioes-hoje). A página
// /rastreio compara isso com o estado atual para achar as reuniões excluídas.
// ---------------------------------------------------------------------------

import { kvReady, kvGetJSON, dataBRT } from "./_kv.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!kvReady()) {
    res.status(200).json({ kv: false, dia: dataBRT(), visto: {}, alteracoes: [] });
    return;
  }
  try {
    const dia = dataBRT();
    const [visto, alteracoes, sigs] = await Promise.all([
      kvGetJSON(`visto:${dia}`),
      kvGetJSON("alteracoes"),
      kvGetJSON("sigs"), // assinatura atual (janela ampla) p/ saber onde a reunião está agora
    ]);
    res.status(200).json({ kv: true, dia, visto: visto || {}, alteracoes: alteracoes || [], sigs: sigs || {} });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? "erro ao ler histórico", visto: {}, alteracoes: [] });
  }
}
