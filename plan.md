# Plan — webhook-relay

## 1. Visão geral

- **Nome:** webhook-relay — relay de webhooks com fila durável
- **Descrição:** relay Node 22+ (ESM): fila durável SQLite, retry exponencial, DLQ, verificação HMAC e painel — com proteção SSRF por validação de DNS/IP e pinning (confirmado na revisão 2026-10-11).
- **Estado atual:** SEC/BUG/IMP/DEVOPS/DOC implementados; DEVOPS-01 (`npm run check` incluído no workflow) publicado em `24b4ec0`; CI modernizada nesta sessão.

## 2. Arquitetura e tecnologias

- Node ≥ 22.5, depende só de express 5; fila em SQLite local; destinos configuráveis com HMAC e limites.
- CI: sintaxe + suíte + licenças; **modernizada nesta sessão** (Ubuntu 24.04, Actions v7, Node 22/24, `npm ci`, gate audit, lockfile versionado).

## 3. Funcionalidades existentes

- [x] Fila durável + retry exponencial + DLQ — implementado.
- [x] HMAC, limites, timeout, reserva atômica, replay auditado — implementado.
- [x] Anti-SSRF (validação DNS/IP + pinning) — implementado.
- [x] CI — **modernizada nesta sessão**.

## 4. Objetivos futuros

- **OBJ-01 (P2, concluído nesta sessão):** CI previsível com gates.
- **OBJ-02 (P3, recomendação):** métricas do painel (profundidade da fila/DLQ) expostas em JSON.
- **OBJ-03 (P3, recomendação):** assinatura do corpo bruto documentada com exemplo de verificação em cliente.

## 5–7. Melhorias / Roadmap / Backlog

Fases 1–3 concluídas; backlog: OBJ-02, OBJ-03 (P3).

## 8. Riscos e pendências

- TEST-01/02 (validações comportamentais HTTP) seguem pendentes fora da esteira; nenhum risco novo identificado.

## 9. Ideias adicionais

- Export OpenTelemetry opcional usando `observa-stack` (projeto irmão).

---
*(Gerado em 2026-10-14 pelo agente orquestrador)*
