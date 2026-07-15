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

import { kvReady, kvGetJSON, kvSetJSON, dataBRT } from "./_kv.js";

const BASE = "https://api.hubapi.com";

// Cores de marca PSA em rodízio para os avatares dos closers.
const CORES = ["#ff6a1a", "#5aa9ff", "#ffa24d", "#46d17f"];

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
const horaBRT = (d) => {
  const b = new Date(d.getTime() + BRT_OFFSET_MIN * 60000);
  return `${String(b.getUTCHours()).padStart(2, "0")}:${String(b.getUTCMinutes()).padStart(2, "0")}`;
};

// Links para abrir o registro no HubSpot (portal da PSA).
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "49656171";
const HS_UI = "https://app.hubspot.com";
const linkContato = (id) => `${HS_UI}/contacts/${PORTAL_ID}/record/0-1/${id}`;
const linkReuniao = (id) => `${HS_UI}/contacts/${PORTAL_ID}/record/0-47/${id}`;

// Normaliza p/ comparação: sem acento, minúsculo, espaços colapsados.
const semAcento = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// No B2C, conta TUDO que foi agendado, EXCETO estes tipos (e reunião sem tipo).
// Lista de exclusão (trechos, sem acento). Override: HUBSPOT_B2C_TIPOS_EXCLUIR.
const B2C_TIPOS_EXCLUIR = (
  process.env.HUBSPOT_B2C_TIPOS_EXCLUIR || "followup;relacionamento;whatsapp;b2b"
)
  .split(";")
  .map(semAcento)
  .filter(Boolean);

function tipoBloqueadoB2C(tipo) {
  const t = semAcento(tipo);
  if (!t) return true; // reunião sem tipo definido não entra
  return B2C_TIPOS_EXCLUIR.some((x) => t.includes(x));
}

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

const DIA_MS = 24 * 60 * 60 * 1000;
const RANGES = ["hoje", "amanha", "semana", "mes"];

// Janela [inicio, fim] em ms epoch para o período pedido, no fuso de Brasília.
//   hoje   -> só hoje
//   amanha -> só amanhã
//   semana -> de hoje até domingo desta semana
//   mes    -> de hoje até o último dia deste mês
function janelaPara(range) {
  const brt = new Date(Date.now() + BRT_OFFSET_MIN * 60000); // "parede" BRT
  const y = brt.getUTCFullYear();
  const m = brt.getUTCMonth();
  const d = brt.getUTCDate();
  const dow = brt.getUTCDay(); // 0=domingo .. 6=sábado
  // 00:00 BRT (de uma data) em ms UTC: meia-noite UTC menos o offset
  const inicioDia = (yy, mm, dd) => Date.UTC(yy, mm, dd, 0, 0, 0, 0) - BRT_OFFSET_MIN * 60000;

  const hoje0 = inicioDia(y, m, d);
  switch (range) {
    case "amanha":
      return { inicio: hoje0 + DIA_MS, fim: hoje0 + 2 * DIA_MS - 1 };
    case "semana": {
      const diasAteDomingo = (7 - dow) % 7; // hoje..domingo
      return { inicio: hoje0, fim: hoje0 + (diasAteDomingo + 1) * DIA_MS - 1 };
    }
    case "mes": {
      const fimMes = Date.UTC(y, m + 1, 1, 0, 0, 0, 0) - BRT_OFFSET_MIN * 60000; // 00:00 do dia 1 do próximo mês
      return { inicio: hoje0, fim: fimMes - 1 };
    }
    case "hoje":
    default:
      return { inicio: hoje0, fim: hoje0 + DIA_MS - 1 };
  }
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
        "hs_activity_type",
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

// Quebra um array em lotes de tamanho n (limite dos batch/read do HubSpot = 100).
function emLotes(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// contato + empresa da reunião: 1 contato associado por meeting (o principal).
// Lida com períodos longos (semana/mês) quebrando os batch/read em lotes de 100
// e rodando os lotes em paralelo.
async function contatosDasMeetings(token, meetingIds) {
  const info = new Map(); // meetingId -> {contato, empresa, contatoId}
  if (!meetingIds.length) return info;

  // meeting -> contactId (associações, em lotes)
  const meetingToContact = new Map();
  const contactIds = new Set();
  await Promise.all(
    emLotes(meetingIds, 100).map(async (lote) => {
      const assoc = await fetch(
        `${BASE}/crm/v4/associations/meetings/contacts/batch/read`,
        {
          method: "POST",
          headers: headers(token),
          body: JSON.stringify({ inputs: lote.map((id) => ({ id: String(id) })) }),
          cache: "no-store",
        }
      );
      if (!assoc.ok) return;
      const assocData = await assoc.json();
      for (const row of assocData.results ?? []) {
        const from = String(row.from?.id ?? "");
        const to = row.to?.[0]?.toObjectId ?? row.to?.[0]?.id;
        if (from && to != null) {
          meetingToContact.set(from, String(to));
          contactIds.add(String(to));
        }
      }
    })
  );
  if (!contactIds.size) return info;

  // dados dos contatos (batch/read, em lotes)
  const contatos = new Map();
  await Promise.all(
    emLotes([...contactIds], 100).map(async (lote) => {
      const cRes = await fetch(`${BASE}/crm/v3/objects/contacts/batch/read`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          inputs: lote.map((id) => ({ id })),
          properties: ["firstname", "lastname", "company"],
        }),
        cache: "no-store",
      });
      if (!cRes.ok) return;
      const cData = await cRes.json();
      for (const c of cData.results ?? []) {
        const p = c.properties ?? {};
        const nome =
          `${(p.firstname ?? "").trim()} ${(p.lastname ?? "").trim()}`.trim() || "Contato";
        contatos.set(String(c.id), {
          contato: nome,
          empresa: (p.company ?? "").trim() || "—",
          contatoId: String(c.id),
        });
      }
    })
  );

  for (const [mId, cId] of meetingToContact) {
    info.set(mId, contatos.get(cId) || { contato: "—", empresa: "—", contatoId: cId });
  }
  return info;
}

// Classifica o resultado bruto do HubSpot. CANCELED é usado para EXCLUIR a
// reunião (não conta como marcada). O front só entende SCHEDULED/COMPLETED/
// NO_SHOW e decide "realizada" pelo horário quando não há no-show.
function normalizaOutcome(v) {
  const s = String(v || "").toUpperCase();
  if (s.includes("CANCEL")) return "CANCELED";
  if (s.includes("NO_SHOW") || s.includes("NO SHOW")) return "NO_SHOW";
  if (s.includes("COMPLETED")) return "COMPLETED";
  return "SCHEDULED"; // SCHEDULED, RESCHEDULED ou vazio
}

async function montarSegmento(token, ownerIds, segmento, janela, diag) {
  if (!ownerIds.length) return [];
  const [nomes, meetings] = await Promise.all([
    nomesDosOwners(token, ownerIds),
    buscarMeetings(token, ownerIds, janela),
  ]);

  const contatos = await contatosDasMeetings(
    token,
    meetings.map((m) => m.id).filter(Boolean)
  );

  const dpo = (owner) => {
    if (!diag) return null;
    if (!diag[owner]) {
      diag[owner] = {
        nome: nomes.get(owner) || `Owner ${owner}`,
        brutoDoHubSpot: 0, mantidas: 0, canceladas: 0,
        tipoForaDaLista: 0, semData: 0,
        tiposDescartados: {}, tiposMantidos: {},
      };
    }
    return diag[owner];
  };

  // agrupa por owner
  const porOwner = new Map();
  for (const m of meetings) {
    const p = m.properties ?? {};
    const owner = String(p.hubspot_owner_id ?? "");
    const d = dpo(owner);
    if (d) d.brutoDoHubSpot++;
    const tipo = (p.hs_activity_type ?? "").trim();
    const oc = normalizaOutcome(p.hs_meeting_outcome);
    const iniDbg = parseHsDate(p.hs_meeting_start_time);
    const bloqueado = segmento === "B2C" && tipoBloqueadoB2C(tipo);
    if (d) {
      (d.itens = d.itens || []).push({
        h: iniDbg ? horaBRT(iniDbg) : "??:??",
        tipo: tipo || "(sem tipo)",
        outcome: oc,
        ok: !bloqueado && !!iniDbg,
      });
    }
    // No B2C, fora só os tipos bloqueados (FollowUp/Relacionamento/Whatsapp/B2B/sem-tipo).
    if (bloqueado) {
      if (d) { d.tipoForaDaLista++; const k = tipo || "(sem tipo)"; d.tiposDescartados[k] = (d.tiposDescartados[k] || 0) + 1; }
      continue;
    }
    const ini = parseHsDate(p.hs_meeting_start_time);
    if (!ini) { if (d) d.semData++; continue; } // sem início válido
    const fim =
      parseHsDate(p.hs_meeting_end_time) || new Date(ini.getTime() + 45 * 60000);
    if (!porOwner.has(owner)) porOwner.set(owner, []);
    if (d) { d.mantidas++; if (oc === "CANCELED") d.canceladas++; const k = tipo || "(sem tipo)"; d.tiposMantidos[k] = (d.tiposMantidos[k] || 0) + 1; }
    const ct = contatos.get(String(m.id)) || { contato: "—", empresa: "—" };
    porOwner.get(owner).push({
      id: String(m.id),
      titulo: (p.hs_meeting_title ?? "").trim() || "Reunião",
      contato: ct.contato,
      empresa: segmento === "B2C" ? "—" : ct.empresa,
      tipo,
      inicio: ini.toISOString(),
      fim: fim.toISOString(),
      // conta tudo que foi agendado; cancelada e no-show são circunstanciais
      outcome:
        oc === "CANCELED" ? "CANCELED"
        : oc === "NO_SHOW" ? "NO_SHOW"
        : oc === "COMPLETED" ? "COMPLETED"
        : "SCHEDULED",
      link: ct.contatoId ? linkContato(ct.contatoId) : linkReuniao(String(m.id)),
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

  // ?range=hoje|amanha|semana|mes (padrão hoje)
  const rangeMatch = /[?&]range=([a-z]+)/.exec(req.url || "");
  const range = RANGES.includes(rangeMatch?.[1]) ? rangeMatch[1] : "hoje";

  try {
    const janela = janelaPara(range);
    const diagB2C = debug ? {} : null;
    const [closersB2B, closersB2C] = await Promise.all([
      montarSegmento(token, b2b, "B2B", janela),
      montarSegmento(token, b2c, "B2C", janela, diagB2C),
    ]);
    const payload = { range, inicio: janela.inicio, fim: janela.fim, closers: [...closersB2B, ...closersB2C] };
    if (debug) {
      payload._diagB2C = diagB2C;
      // tally por status (mesma regra do front) p/ conferir que a soma = agendadas
      const agoraMs = Date.now();
      const t = { agendadas: 0, realizadas: 0, agora: 0, futuras: 0, perdidas: 0, aRegistrar: 0, canceladas: 0 };
      for (const c of closersB2C) for (const m of c.reunioes) {
        t.agendadas++;
        const ini = new Date(m.inicio).getTime(), fim = new Date(m.fim).getTime();
        if (m.outcome === "CANCELED") t.canceladas++;
        else if (m.outcome === "COMPLETED") t.realizadas++;
        else if (m.outcome === "NO_SHOW") t.perdidas++;
        else if (agoraMs >= ini && agoraMs <= fim) t.agora++;
        else if (agoraMs < ini) t.futuras++;
        else t.aRegistrar++;
      }
      payload._resumoB2C = t;
    }

    // Histórico do dia: registra tudo que foi visto hoje (piggyback no tráfego
    // da TV, que bate aqui a cada 30s). Reuniões que somem depois = excluídas/
    // reagendadas. Best-effort: se o KV falhar, o painel segue normal.
    if (range === "hoje" && kvReady()) {
      try {
        const dia = dataBRT();
        const key = `visto:${dia}`;
        const store = (await kvGetJSON(key)) || {};
        const nowIso = new Date().toISOString();
        for (const c of payload.closers) {
          for (const m of c.reunioes) {
            if (!m.id) continue;
            const prev = store[m.id];
            store[m.id] = {
              seg: c.segmento, closer: c.nome, contato: m.contato, empresa: m.empresa,
              tipo: m.tipo, link: m.link, inicio: m.inicio, outcome: m.outcome,
              firstSeen: prev?.firstSeen || nowIso, lastSeen: nowIso,
            };
          }
        }
        await kvSetJSON(key, store, 60 * 60 * 48); // guarda 48h
      } catch (e) {
        console.error("kv visto error:", e?.message);
      }
    }

    res.status(200).json(payload);
  } catch (e) {
    console.error("reunioes-hoje error:", e);
    const payload = { error: e?.message ?? "erro ao consultar o HubSpot" };
    if (debug) payload.stack = String(e?.stack ?? e);
    res.status(debug ? 200 : 500).json(payload);
  }
}
