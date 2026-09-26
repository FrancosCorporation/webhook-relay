# Webhook Relay — Queue + Retry + DLQ for Local Automations

![Status](https://img.shields.io/badge/status-em%20constru%C3%A7%C3%A3o-orange)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

A webhook relay for local automation stacks: ingestion endpoint → durable queue (SQLite) →
delivery with exponential retry + dead-letter queue, HMAC-signed payloads, admin panel
with replay and delivery metrics.

> 🇧🇷 Relay de webhooks para automações locais: ingestão → fila durável (SQLite) →
> entrega com retry exponencial + DLQ, payloads assinados por HMAC, painel com replay
> e métricas de entrega.

## Features (roadmap)

- [ ] **M1a** — Ingest → queue → delivery with retry + DLQ
- [ ] **M1b** — Admin panel (events, delivery status, replay) + HMAC signing
- [ ] **M2** — Fan-out multi-destination, per-subscriber rate limits, p99 metrics

## Built with

- The WebSocket relay core proven in
  [chat_criptografado](https://github.com/FrancosCorporation/chat_criptografado) (7/7 tests)
- References: [simonw/webhook-relay](https://github.com/simonw/webhook-relay),
  [cloudflare/cf-webhook-relay](https://github.com/cloudflare/cf-webhook-relay)

## License

MIT — Rodolfo Franco ([FrancosCorporation](https://github.com/FrancosCorporation))
