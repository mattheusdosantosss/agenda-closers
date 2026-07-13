// Vercel Serverless Function  ·  GET /api/reunioes-hoje
// ---------------------------------------------------------------------------
// Devolve as reuniões (meetings) de HOJE dos closers, agrupadas por owner e
// separadas em B2B / B2C, no formato que o index.html espera:
//
//   [{ nome, iniciais, cor, segmento, reunioes:[{titulo,contato,empresa,
//      inicio,fim,outcome}] }]
//
// Regras (definidas com o time):
//   • Segmento vem de listas fixas de owners (HUBSPOT_CLOSERS_B2B / _B2C).
//   • "Reunião do dia" = qualquer meeting cujo owner é um closer e que começa
//     HOJE no fuso de Brasília (UTC-3), independente de negócio associado.
//
// A Private App do HubSpot fica AQUI no servidor (HUBSPOT_TOKEN), nunca no
// navegador da TV. Scopes: crm.objects.meetings.read, crm.objects.owners.read,
// crm.objects.contacts.read.
// ---------------------------------------------------------------------------

const BASE = "https://api.hubapi.com";

// Cores de marca PSA em rodízio para os avatares dos closers.
const CORES = ["#ff6a1a", "#2f80ed", "#ffa24d", "#1fa971"];

// Closers por segmento (ownerId do HubSpot). Podem ser sobrescritos por
// HUBSPOT_CLOSERS_B2B / HUBSPOT_CLOSERS_B2C sem mexer no código.
// B2B resolvido em 2026-07-13 a partir da lista enviada pelo time.
const DEFAULT_B2B = [
  "80454586", // Rafael Azevedo Teixeira
  "80651489", // Catarina Varoni Borges
  "92704130", // Talita Santos Cruz
  "80169395", // Lucas Rosa de Oliveira
  "80454588", // João Gabriel Marins Pereira
  "87159365", // João Lucas Backmann
  "86859895", // Mateus Menezes Mariano
];
// B2C resolvido em 2026-07-13 a partir da lista enviada pelo time.
const DEFAULT_B2C = [
  "79760676", // Amanda de Oliveira
  "79760746", // Mayda Quadros
  "88628309", // João Paulo da Silveira Araújo
  "89632494", // Willker Santos Belous
  "88628313", // Gabrielly Milani da Silva
];

// Brasília é UTC-3 (o Brasil não tem mais horário de verão desde 2019).
const BRT_OFFSET_MIN = -180;

function headers(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Aceita IDs separados por ",", ";" ou espaço/quebra de linha.
function parseIds(raw) {
  return String(raw || "")
    .split(/[;,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Início e fim (ms epoch) do dia de HOJE no fuso de Brasília.
function janelaHojeBRT() {
  const agora = Date.now();
  // "parede" de Brasília = UTC + offset
  const brt = new Date(agora + BRT_OFFSET_MIN * 60000);
  const y = brt.getUTCFullYear();
  const m = brt.getUTCMonth();
  const d = brt.getUTCDate();
  // 00:00 BRT em UTC = 00:00 - (-3h) = 03:00 UTC  ->  subtrai o offset
  const inicio = Date.UTC(y, m, d, 0, 0, 0, 0) - BRT_OFFSET_MIN * 60000;
  const fim = inicio + 24 * 60 * 60 * 1000 - 1;
  return { inicio, fim };
}

function iniciaisDe(nome) {
  const partes = String(nome || "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return "?";
  const a = partes[0][0] || "";
  const b = partes.length > 1 ? partes[partes.length - 1][0] : "";
  return (a + b).toUpperCase();
}

// Datas do HubSpot chegam ora como epoch ms ("1720900800000"), ora como ISO
// ("2026-07-13T18:00:00Z"). Aceita os dois; devolve Date válido ou null.
function parseHsDate(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Mapa ownerId -> nome, lendo em lote os owners que interessam.
async function nomesDosOwners(token, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const res = await fetch(`${BASE}/crm/v3/owners/batch/read`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ inputs: ids.map((id) => ({ id: String(id) })) }),
    cache: "no-store",
  });
  if (res.ok) {
    const data = await res.json();
    for (const o of data.results ?? []) {
      const nome =
        `${(o.firstName ?? "").trim()} ${(o.lastName ?? "").trim()}`.trim() ||
        (o.email ?? "").trim();
      if (o.id != null) map.set(String(o.id), nome || "—");
    }
    return map;
  }
  // fallback: lê individualmente se o batch não estiver disponível
  await Promise.all(
    ids.map(async (id) => {
      const r = await fetch(`${BASE}/crm/v3/owners/${id}`, {
        headers: headers(token),
        cache: "no-store",
      });
      if (r.ok) {
        const o = await r.json();
        const nome =
          `${(o.firstName ?? "").trim()} ${(o.lastName ?? "").trim()}`.trim() ||
          (o.email ?? "").trim();
        map.set(String(id), nome || "—");
      }
    })
  );
  return map;
}

// Todas as meetings dos closers que começam hoje (BRT), paginado.
async function buscarMeetings(token, ownerIds, janela) {
  const out = [];
  let after;
  for (let i = 0; i < 50; i++) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "hubspot_owner_id", operator: "IN", values: ownerIds },
            {
              propertyName: "hs_meeting_start_time",
              operator: "BETWEEN",
              value: String(janela.inicio),
              highValue: String(janela.fim),
            },
          ],
        },
      ],
      properties: [
        "hs_meeting_title",
        "hs_meeting_start_time",
        "hs_meeting_end_time",
        "hs_meeting_outcome",
        "hubspot_owner_id",
      ],
      sorts: [{ propertyName: "hs_meeting_start_time", direction: "ASCENDING" }],
      limit: 100,
    };
    if (after) body.after = after;
    const res = await fetch(`${BASE}/crm/v3/objects/meetings/search`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      const detalhe = await res.text().catch(() => "");
      throw new Error(`meetings search ${res.status}: ${detalhe.slice(0, 400)}`);
    }
    const data = await res.json();
    out.push(...(data.results ?? []));
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

// contato + empresa da reunião: 1 contato associado por meeting (o principal).
async function contatosDasMeetings(token, meetingIds) {
  const info = new Map(); // meetingId -> {contato, empresa}
  if (!meetingIds.length) return info;

  // meeting -> contactId (batch de associações)
  const assoc = await fetch(
    `${BASE}/crm/v4/associations/meetings/contacts/batch/read`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ inputs: meetingIds.map((id) => ({ id: String(id) })) }),
      cache: "no-store",
    }
  );
  if (!assoc.ok) return info;
  const assocData = await assoc.json();
  const meetingToContact = new Map();
  const contactIds = new Set();
  for (const row of assocData.results ?? []) {
    const from = String(row.from?.id ?? "");
    const to = row.to?.[0]?.toObjectId ?? row.to?.[0]?.id;
    if (from && to != null) {
      meetingToContact.set(from, String(to));
      contactIds.add(String(to));
    }
  }
  if (!contactIds.size) return info;

  // dados dos contatos (batch)
  const cRes = await fetch(`${BASE}/crm/v3/objects/contacts/batch/read`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      inputs: [...contactIds].map((id) => ({ id })),
      properties: ["firstname", "lastname", "company"],
    }),
    cache: "no-store",
  });
  const contatos = new Map();
  if (cRes.ok) {
    const cData = await cRes.json();
    for (const c of cData.results ?? []) {
      const p = c.properties ?? {};
      const nome =
        `${(p.firstname ?? "").trim()} ${(p.lastname ?? "").trim()}`.trim() || "Contato";
      contatos.set(String(c.id), { contato: nome, empresa: (p.company ?? "").trim() || "—" });
    }
  }

  for (const [mId, cId] of meetingToContact) {
    info.set(mId, contatos.get(cId) || { contato: "—", empresa: "—" });
  }
  return info;
}

// SCHEDULED / COMPLETED / NO_SHOW  (RESCHEDULED/CANCELED viram SCHEDULED por padrão;
// o front decide "realizada" pelo horário quando não há no-show).
function normalizaOutcome(v) {
  const s = String(v || "").toUpperCase();
  if (s.includes("NO_SHOW") || s.includes("NO SHOW")) return "NO_SHOW";
  if (s.includes("COMPLETED")) return "COMPLETED";
  return "SCHEDULED";
}

async function montarSegmento(token, ownerIds, segmento, janela) {
  if (!ownerIds.length) return [];
  const [nomes, meetings] = await Promise.all([
    nomesDosOwners(token, ownerIds),
    buscarMeetings(token, ownerIds, janela),
  ]);

  const contatos = await contatosDasMeetings(
    token,
    meetings.map((m) => m.id).filter(Boolean)
  );

  // agrupa por owner
  const porOwner = new Map();
  for (const m of meetings) {
    const p = m.properties ?? {};
    const owner = String(p.hubspot_owner_id ?? "");
    if (!porOwner.has(owner)) porOwner.set(owner, []);
    const ini = parseHsDate(p.hs_meeting_start_time);
    if (!ini) continue; // sem início válido não dá pra posicionar na agenda
    const fim =
      parseHsDate(p.hs_meeting_end_time) || new Date(ini.getTime() + 45 * 60000);
    const ct = contatos.get(String(m.id)) || { contato: "—", empresa: "—" };
    porOwner.get(owner).push({
      titulo: (p.hs_meeting_title ?? "").trim() || "Reunião",
      contato: ct.contato,
      empresa: segmento === "B2C" ? "—" : ct.empresa,
      inicio: ini.toISOString(),
      fim: fim.toISOString(),
      outcome: normalizaOutcome(p.hs_meeting_outcome),
    });
  }

  // um card por closer (mesmo sem reunião hoje, para o time aparecer na TV)
  return ownerIds.map((id, i) => {
    const nome = nomes.get(String(id)) || `Owner ${id}`;
    return {
      nome,
      iniciais: iniciaisDe(nome),
      cor: CORES[i % CORES.length],
      segmento,
      reunioes: porOwner.get(String(id)) || [],
    };
  });
}

export default async function handler(req, res) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    res.status(501).json({ error: "HUBSPOT_TOKEN ausente — integração não configurada." });
    return;
  }

  const b2b = process.env.HUBSPOT_CLOSERS_B2B
    ? parseIds(process.env.HUBSPOT_CLOSERS_B2B)
    : DEFAULT_B2B;
  const b2c = process.env.HUBSPOT_CLOSERS_B2C
    ? parseIds(process.env.HUBSPOT_CLOSERS_B2C)
    : DEFAULT_B2C;
  if (!b2b.length && !b2c.length) {
    res.status(501).json({
      error: "Defina HUBSPOT_CLOSERS_B2B e/ou HUBSPOT_CLOSERS_B2C (IDs dos owners).",
    });
    return;
  }

  // ?debug=1 devolve o erro completo em HTTP 200 (facilita diagnóstico externo).
  const debug = /[?&]debug=1\b/.test(req.url || "");

  try {
    const janela = janelaHojeBRT();
    const [closersB2B, closersB2C] = await Promise.all([
      montarSegmento(token, b2b, "B2B", janela),
      montarSegmento(token, b2c, "B2C", janela),
    ]);
    res.status(200).json([...closersB2B, ...closersB2C]);
  } catch (e) {
    console.error("reunioes-hoje error:", e);
    const payload = { error: e?.message ?? "erro ao consultar o HubSpot" };
    if (debug) payload.stack = String(e?.stack ?? e);
    res.status(debug ? 200 : 500).json(payload);
  }
}
