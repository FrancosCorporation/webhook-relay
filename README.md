# Webhook Relay

Relay de webhooks com fila SQLite durável, assinatura HMAC-SHA256 na saída, retry exponencial,
dead-letter queue (DLQ), replay administrativo e painel protegido.

## Requisitos

- Node.js 22.5 ou superior (usa `node:sqlite`)
- Um segredo `RELAY_SECRET` com pelo menos 32 bytes

## Inicialização com Docker Compose

```bash
cp .env.example .env
```

Preencha `RELAY_SECRET` em `.env` com um valor aleatório:

```bash
openssl rand -hex 32
```

Depois execute:

```bash
docker compose up --build
```

O painel fica em `http://127.0.0.1:3400`. A porta é publicada apenas no loopback. Para acesso remoto,
use um proxy reverso com TLS e mantenha o token fora de URLs, logs e código do navegador. O banco fica
no volume Docker `dados`.

Para executar sem Docker, instale as dependências com `npm install`, exporte `RELAY_SECRET` e rode
`npm start`. Copiar `.env.example` para `.env` não carrega as variáveis automaticamente no Node;
exporte-as no shell ou use Docker Compose.

## Enviar um evento

O token autentica a entrada. O evento usa um objeto JSON com `destino` e `payload`; o identificador
opcional `X-Event-Id` torna a ingestão idempotente.

```bash
curl -X POST http://127.0.0.1:3400/ingest \
  -H "Authorization: Bearer $RELAY_SECRET" \
  -H 'Content-Type: application/json' \
  -H 'X-Event-Id: pedido-123' \
  -d '{"destino":"https://hooks.exemplo.com/pedidos","payload":{"pedido":123}}'
```

O relay serializa o payload como JSON, limita seu tamanho a 1 MB e assina os bytes enviados no header
`X-Relay-Signature`. Reutilizar `X-Event-Id` com destino ou payload diferente retorna `409`.

## Segurança e operação

Este serviço recebe uma URL controlada pelo cliente e faz uma requisição de saída; portanto, é uma
superfície SSRF por natureza. A ingestão e a entrega validam o destino. Por padrão, apenas HTTPS é
aceito; o relay bloqueia loopback, redes privadas, endereços reservados, hosts locais e respostas DNS
que incluam qualquer endereço não público. A conexão usa o IP validado, evitando nova resolução entre
a checagem e o envio. Redirects não são seguidos.

- `RELAY_SECRET` é obrigatório, tem no mínimo 32 bytes e protege ingestão, painel e replay.
- `/api/eventos`, `/api/metricas` e `/api/replay/:id` exigem `Authorization: Bearer ...`.
- O painel guarda o token apenas em `sessionStorage` da aba atual e não o envia na URL.
- Payloads acima de 1 MB são recusados; HTTP é recusado por padrão. `RELAY_ALLOW_HTTP=1` permite HTTP
  para hosts públicos, mas não libera endereços privados.
- `RELAY_ALLOWED_HOSTS` aceita uma lista opcional de hosts exatos separados por vírgula.
- Replays são registrados com IP e limitados a três por evento.
- Configure `RELAY_TRUST_PROXY=1` somente atrás de um proxy confiável que substitua corretamente
  `X-Forwarded-For`; o relay confiará em um salto de proxy.
- Proteja o segredo e o volume SQLite como dados sensíveis. Não exponha a porta diretamente à
  internet; use TLS no proxy e controle a rede que pode acessar o relay.

## Desenvolvimento

```bash
npm install
npm run check
```

O workflow existente também executa a suíte do projeto nos pushes e pull requests.

## Licença

MIT — Rodolfo Franco ([FrancosCorporation](https://github.com/FrancosCorporation)).
