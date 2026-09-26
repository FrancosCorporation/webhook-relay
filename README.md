# Webhook Relay — Queue + Retry + DLQ for Local Automations

![Status](https://img.shields.io/badge/M1-funcionando%20(6%2F6%20testes)-brightgreen)
![CI](https://img.shields.io/badge/CI-test%20%2B%20license%20check-blue)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

A webhook relay for local automation stacks: ingestion endpoint → durable queue (SQLite) →
delivery with exponential retry + dead-letter queue, HMAC-signed payloads, admin panel
with replay and delivery metrics.

> 🇧🇷 Relay de webhooks para automações locais: ingestão → fila durável (SQLite) →
> entrega com retry exponencial + DLQ, payloads assinados por HMAC, painel com replay
> e métricas de entrega.

## Features

- [x] **M1a** — Ingest → durable queue (SQLite) → delivery with exponential retry + DLQ (6/6 tests)
- [x] **M1b** — Admin panel (events, delivery status, replay) + HMAC-SHA256 signing + metrics (taxa de entrega)
- [ ] **M2** — Fan-out multi-destination, per-subscriber rate limits, p99 metrics

## Quick start

```bash
docker compose up   # painel em http://localhost:3400
```

```bash
# ingere um evento (idempotente por X-Event-Id)
curl -X POST "http://localhost:3400/ingest?destino=http://localhost:3500/hook" \
  -H "Content-Type: application/json" -H "X-Event-Id: evt-1" -d '{"pediu":"pizza"}'
```

## Built with

- The WebSocket relay core proven in
  [chat_criptografado](https://github.com/FrancosCorporation/chat_criptografado) (7/7 tests)
- References: [simonw/webhook-relay](https://github.com/simonw/webhook-relay),
  [cloudflare/cf-webhook-relay](https://github.com/cloudflare/cf-webhook-relay)

## License

MIT — Rodolfo Franco ([FrancosCorporation](https://github.com/FrancosCorporation))
