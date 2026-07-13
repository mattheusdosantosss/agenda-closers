# Agenda Closers · Painel ao vivo

Painel de TV (dashboard) que mostra, em tempo real, a agenda/reuniões dos times
de **closers B2B e B2C** da PSA. Pensado para ficar aberto numa TV da sala
comercial: relógio ao vivo, KPIs do dia e um card por closer com toda a agenda.

## Como funciona

- **Frontend estático** (`index.html`): renderiza o painel, recalcula o status
  das reuniões a cada segundo (Realizada / Agora / Futura / No-show) e busca
  dados novos a cada 30s. Alterna entre **B2B** e **B2C** pelas abas ou pela URL
  (`?seg=b2b` / `?seg=b2c`) — cada TV pode abrir fixa num segmento.
- **Backend** (`api/reunioes-hoje.js`): função serverless da Vercel que consulta
  o HubSpot com a Private App (o token fica **só no servidor**) e devolve as
  reuniões de hoje já agrupadas por closer. Enquanto a integração não estiver
  configurada, o front cai automaticamente em **dados de exemplo**.

## Identidade visual (PSA)

- Paleta: **laranja `#ff6a1a`** (acontecendo agora), **azul `#5aa9ff`** (futuras),
  branco sobre fundo grafite. Verde = realizada, vermelho = no-show.
- Fonte de marca: **Bruta Pro Compressed ExtraBold** (`fonts/`) nos números e
  títulos; **Archivo** no corpo.

## Rodar localmente

```bash
npm i -g vercel   # uma vez
vercel dev        # serve index.html + /api em http://localhost:3000
```

Sem token configurado, o painel abre com dados de exemplo. Basta abrir
`index.html` no navegador para ver o layout (sem o backend).

## Variáveis de ambiente

Veja [.env.example](.env.example). Na Vercel, defina `HUBSPOT_TOKEN` em
Project Settings > Environment Variables. O mapeamento dos closers (owners do
HubSpot por segmento) é o próximo passo.

## Deploy

Deploy automático pela Vercel a cada push na `main`.
