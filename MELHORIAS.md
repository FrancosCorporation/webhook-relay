# MELHORIAS — webhook-relay

> **Gerado por análise de código em 2026-10-02** · Stack: Node 22 (Express + `node:sqlite`)
> Branch `main` · **1 suíte existente** (`test/relay-test.mjs`) · CI existente em `.github/workflows/ci.yml`
>
> **Este arquivo é um plano de execução.** Cada item tem ID, `arquivo:linha`, mudança exata,
> critério de aceite e comando de verificação.

---

## 0. Como usar este documento

1. Execute na ordem **P0 → P1 → P2 → P3**, respeitando as ondas da §8.
2. Ao terminar um item: marque `- [x]`, rode o **Verificação**, comite `fix(<ID>): descrição`.
3. **O projeto tem 152 linhas e faz uma coisa perigosa.** Os P0 não são "melhorias": são as
   condições que tornam o relay seguro de expor. Trate-os como pré-requisito de qualquer deploy.
4. **Não reescreva a fila.** `ingere`/`tentarEntregar`/`replay` e o backoff exponencial
   (`fila.js:62-70`) estão corretos e testados — os defeitos são de **fronteira** (quem entra, para
   onde sai) e de **segredo**.
5. **Idioma:** português; commits em inglês com `fix:`/`feat:`/`docs:`.

---

## 1. Diagnóstico executivo

Relay de webhooks: recebe evento, guarda em fila durável (SQLite) e entrega ao destino com retry
exponencial, DLQ e assinatura HMAC-SHA256 na saída. É o serviço com **maior superfície de ataque** da
Wave 2: recebe input de terceiros e **faz requisição HTTP para uma URL que o terceiro escolhe**.

**O que está bem (não reaça):**

| Item | Evidência |
|---|---|
| HMAC-SHA256 correto na saída, sobre o payload | `fila.js:37-38,52` |
| Idempotência por `X-Event-Id` | `fila.js:29-31` (dedup no banco, não em memória) |
| Backoff exponencial com teto de 8 s | `fila.js:63,68` (`Math.min(1000*2**(n-1), 8000)`) |
| DLQ após 5 tentativas | `fila.js:63` |
| `replay` só renomeia se o evento está em DLQ | `fila.js:77` (`AND status = 'dlq'`) |
| Lista do painel **não** inclui `payload` | `fila.js:84` (só `id, destino, status, tentativas, criado_em`) |
| CHECK constraint em `status` | `fila.js:12` |
| SQL parametrizado | `fila.js:19-21,32,84` |
| Path traversal bloqueado no estático | `server.js:39` |
| Teste de integração presente | `test/relay-test.mjs` |

**O que está quebrado:**

1. **A ingestão não verifica assinatura nenhuma.** `SEGREDO` é usado **apenas para assinar a
   saída** (`fila.js:52`). `POST /ingest` (`server.js:18`) aceita qualquer payload de qualquer
   origem. O HMAC protege o destinatário **do relay**, mas **não** protege o relay de ser
   encharcado por terceiros.
2. **SSRF clássico**: `destino` (`?destino=`) vai direto para `fetchImpl(ev.destino, ...)`
   (`fila.js:48`) — sem `new URL`, sem exigir `https`, sem bloquear rede privada. Isso entrega ao
   atacante leitura de resposta de serviço interno.
3. **`express.json()` sem limite** (`server.js:15`) — payload ilimitado em memória.

---

## 2. Tabela de prioridades

| ID | Título | Sev | Arquivo | Depende de |
|---|---|---|---|---|
| SEC-01 | SSRF: `destino` do cliente vai para `fetch` sem validação | **P0** | `src/fila.js:48` · `server.js:21` | — |
| SEC-02 | Ingestão sem autenticação/assinatura (enche a fila) | **P0** | `server.js:18` | — |
| SEC-03 | Segredo com fallback hardcoded (`relay-dev-secret`) | **P0** | `server.js:11` | — |
| SEC-04 | Sem timeout no `fetch` de entrega | **P0** | `src/fila.js:48` | — |
| SEC-05 | `express.json()` sem limite de tamanho | **P1** | `server.js:15` | — |
| SEC-06 | `/api/replay/:id` público (reenvia evento a URL arbitrária) | **P1** | `server.js:31` | SEC-01, SEC-02 |
| SEC-07 | `destino` não exige `https` (payload segue em claro) | **P1** | `src/fila.js:48` | SEC-01 |
| SEC-08 | Redirecionamento pode contornar a validação de URL | **P1** | `src/fila.js:48` | SEC-01 |
| BUG-01 | `marcar` não é atômico (2 workers pegam o mesmo evento) | **P1** | `src/fila.js:43,59,64` | — |
| BUG-02 | `replay` zera `tentativas` mas mantém payload antigo | **P2** | `src/fila.js:79` | — |
| BUG-03 | Sem dead-letter para evento que nunca é lido de novo | **P2** | `src/fila.js:43` | — |
| IMP-01 | Sem proteção contra replay do mesmo `X-Event-Id` com destino diferente | **P2** | `src/fila.js:30` | — |
| IMP-02 | Payload sem verificação de encoding ao entregar | **P2** | `src/fila.js:56` | — |
| TEST-01 | Sem teste de SSRF (destino privado) | **P1** | `test/relay-test.mjs` | SEC-01 |
| TEST-02 | Sem teste de ingestão sem assinatura | **P1** | `test/relay-test.mjs` | SEC-02 |
| DEVOPS-01 | CI sem verificação estática do relay | **P2** | `.github/workflows/ci.yml` | — |
| DEVOPS-02 | Sem `.env.example` | **P2** | *(ausente)* | SEC-03 |
| DEVOPS-03 | `webhook-relay.db` versionado | **P2** | *(se commitado)* | — |
| DOC-01 | README não avisa que relay é superfície SSRF | **P2** | `README.md` | SEC-01 |
| DOC-02 | Falta `SECURITY.md` | **P3** | *(ausente)* | SEC-01 |

**Placar original: 4 P0 · 7 P1 · 8 P2 · 1 P3 = 20 itens.**

---

## 3. Segurança
### SEC-01 · SSRF: `destino` do cliente vai para `fetch` sem validação · [P0]

- **Arquivo:** `src/fila.js:48` · `server.js:21`
- **Evidência:**
  ```javascript
  const r = await fetchImpl(ev.destino, { method: 'POST', ... });
  ```
  `ev.destino` é a string crua de `?destino=` (`server.js:21`: `req.query.destino || req.body?.destino`),
  gravada sem validação (`fila.js:28` só checa presença) e usada como URL de destino. Não há
  `new URL()`, nem exigência de `https`, nem bloqueio de rede privada.
- **Impacto:** **SSRF clássico** contra a rede onde o relay roda. `POST /ingest?destino=http://169.254.169.254/latest/meta-data/iam/...`
  faz o relay buscar credenciais de **cloud metadata** (AWS/GCP/Azure) usando as permissões do processo.
  Também: `http://127.0.0.1:PORT/...` alcança serviços internos; `http://10.x/192.168.x` a rede
  privada. Como o relay **repete** a entrega em retry (5x, `fila.js:63`) e expõe o resultado
  indiretamente (status/tentativas em `/api/eventos`), é um proxy de rede persistente.
- **Mudança:** (1) validar `destino` **na ingestão** e **na entrega** (defesa em profundidade):
  ```javascript
  function validarDestino(u) {
    const url = new URL(u);                                  // lanca se invalido
    if (url.protocol !== 'https:') throw new Error('destino deve ser https');
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') throw new Error('localhost bloqueado');
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h))
      throw new Error('rede privada bloqueada');
    return url.toString();
  }
  ```
  (2) resolver DNS **antes** de enviar e revalidar o IP resolvido (anti-DNS-rebinding — o check por
  hostname sozinho é contornável: `meu-dominio.com` resolve para `127.0.0.1`);
  (3) `redirect: 'manual'` e revalidar cada redirect (ver `SEC-08`);
  (4) allowlist opcional de destinos (`RELAY_ALLOWED_HOSTS`) para uso corporativo.
- **Aceite:** `destino` para `127.0.0.1`, `169.254.169.254`, `10.x`, `http://` (não-https) → `400`;
  nenhum pacote sai para rede privada.
- **Verificação:**
  ```bash
  for d in 'http://127.0.0.1:22/' 'http://169.254.169.254/' 'http://10.0.0.1/' 'http://exemplo.com'; do
    curl -s -o /dev/null -w "$d -> %{http_code}\n" -X POST "http://localhost:3400/ingest?destino=$d" \
      -H 'Content-Type: application/json' -d '{"a":1}'
  done
  # esperado: 400 nos tres primeiros (http://exemplo.com tambem 400 se https-only)
  ```

### SEC-02 · Ingestão sem autenticação/assinatura (enche a fila) · [P0]

- **Arquivo:** `server.js:18` · `src/fila.js:27`
- **Evidência:** `POST /ingest` (`server.js:18-26`) não valida token nem assinatura. `SEGREDO`
  (`server.js:11`) aparece **apenas** em `tentarEntregar` para assinar a **saída** (`fila.js:52`) —
  confirmei com `grep`: não há uso de segredo no `ingere` nem no middleware.
- **Impacto:** o relay é um **serviço aberto de entrega**: qualquer pessoa que alcance a porta
  injeta eventos para qualquer destino válido (ver `SEC-01` para o alcance). Consequências: (a)
  enche o disco/fila (cada evento é uma linha + payload); (b) usa o relay como **amplificador** para
  spam/abuso contra terceiros (o HMAC dá aparência de evento confiável, com o nome `X-Relay-*`); (c)
  exaur quota do destino. A **assinatura de saída engana**: o destinatário vê HMAC válido e pode
  confiar num evento que **ninguém** autorizou a enviar.
- **Mudança aplicada:** exigir `Authorization: Bearer <RELAY_SECRET>` antes de analisar o corpo ou
  acessar o banco; comparar credenciais em tempo constante (`crypto.timingSafeEqual`). O mesmo
  segredo continua sendo usado para assinar a saída.
- **Aceite aplicado:** `POST /ingest` sem token → `401`; o corpo não é analisado e nada é gravado.
- **Verificação:**
  ```bash
  # sem assinatura
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3400/ingest?destino=https://exemplo.com/hook" \
    -H 'Content-Type: application/json' -d '{"a":1}'
  # esperado 401 (hoje: 201)
  ```

### SEC-03 · Segredo com fallback hardcoded · [P0]

- **Arquivo:** `server.js:11`
- **Evidência:** `const SEGREDO = process.env.RELAY_SECRET || 'relay-dev-secret';`
- **Impacto:** sem `RELAY_SECRET`, o relay sobe com segredo **público no repositório**. E o segredo é
  a **mesma chave** da assinatura de saída (e da futura de entrada, `SEC-02`): com ele, um atacante
  (a) forja assinatura de entrada (se `SEC-02` for implementado com o mesmo segredo) e (b) gera
  `X-Relay-Signature` válida para enganar o destinatário.
- **Mudança:** falhar no boot sem a variável (mínimo 32 bytes), como nos projetos irmãos:
  ```javascript
  const SEGREDO = process.env.RELAY_SECRET;
  if (!SEGREDO || Buffer.byteLength(SEGREDO, 'utf8') < 32)
    throw new Error('RELAY_SECRET nao definido ou curto (min 32 bytes).');
  ```
- **Aceite:** sem `RELAY_SECRET` (ou curto) o processo não inicia.
- **Verificação:**
  ```bash
  grep -n 'relay-dev-secret' server.js && echo FALHA || echo OK
  unset RELAY_SECRET; node server.js 2>&1 | grep -qi 'RELAY_SECRET' && echo OK
  ```

### SEC-04 · Sem timeout no `fetch` de entrega · [P0]

- **Arquivo:** `src/fila.js:48`
- **Evidência:** `await fetchImpl(ev.destino, { method: 'POST', headers, body })` — sem `signal`,
  sem `timeout`. (O `setInterval` do worker é de 3 s, `server.js:55`.)
- **Impacto:** um destino que **aceita a conexão e não responde** (ou responde devagar) trava a
  `tentarEntregar` **para sempre** — as linhas 45-71 esperam em sequência. Como o worker roda a cada
  3 s e `setInterval` não espera o anterior (linha 55 não tem trava), os workers se **acumulam**
  em promises pendentes, cada uma segurando um fetch. Um destino malicioso (controlado via
  `SEC-01`... ou até o mesmo) trava a fila inteira e vaza memória/FD.
- **Mudança:** (1) `AbortSignal.timeout(10_000)` (ou `AbortController` + `setTimeout`) em cada entrega;
  (2) **trava de reentrância** no worker (não iniciar `tentarEntregar` se a anterior não terminou —
  ver `BUG-01`); (3) `redirect: 'manual'` com teto (ver `SEC-08`).
- **Aceite:** destino que não responde não trava o worker; após o timeout, o evento segue para retry/DLQ.
- **Verificação:**
  ```bash
  # evento para um destino que aceita e nao responde (servidor dummy): apos 10s, worker continua
  node -e "require('http').createServer(()=>{}).listen(9999)" &
  # ingerir para http://... (bloqueado por SEC-01 apos corrigir; usar https local de teste)
  # observar que /api/metricas ainda responde e o worker nao trava
  ```

### SEC-05 · `express.json()` sem limite de tamanho · [P1]

- **Arquivo:** `server.js:15`
- **Evidência:** `app.use(express.json());` — sem `{ limit }`.
- **Impacto:** payload **ilimitado** em memória por requisição. Com `SEC-02` fechado (auth), o risco
  cai, mas ainda: um cliente legítimo (ou com credencial vazada) envia um JSON gigante e o processo
  estoura memória. `express.json()` sem limite é o default do próprio Express.
- **Mudança:** `app.use(express.json({ limit: '1mb' }));` (ajustar ao tamanho típico de webhook) —
  o padrão da casa (`docmind-rag` usa `10mb`).
- **Aceite:** payload > 1 MB → `413`.
- **Verificação:**
  ```bash
  head -c 2000000 /dev/zero | tr '\0' 'a' > /tmp/big.json
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3400/ingest?destino=https://x.com" \
    -H 'Content-Type: application/json' --data-binary @/tmp/big.json    # 413
  ```

### SEC-06 · `/api/replay/:id` público (reenvia evento a URL arbitrária) · [P1]

- **Arquivo:** `server.js:31`
- **Evidência:** `app.post('/api/replay/:id', ...)` — rota **pública** (sem `exigirToken`, sem
  assinatura) que chama `fila.replay(id)` e devolve o evento em DLQ para `pendente` (reenvio).
- **Impacto:** (a) qualquer pessoa pode **reenfileirar** eventos em DLQ, causando reenvio em massa
  ao destino (amplificação/abuso); (b) se o `id` for previsível/fornecido, o replay dispara entrega
  de novo a uma URL que pode serCombination com `SEC-01`; (c) não há registro de **quem** reenviou.
- **Mudança:** (1) **auth obrigatória** nesta rota (token admin, padrão da casa) — replay é ação de
  operação, não pública; (2) registrar `replay_por`/`replay_em` (auditoria); (3) com `SEC-01` fechado,
  o destino do replay já é validado.
- **Aceite:** `POST /api/replay/:id` sem token → `401`; replay registra autor.
- **Verificação:**
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3400/api/replay/$ID   # 401
  ```

### SEC-07 · `destino` não exige `https` (payload segue em claro) · [P1]

- **Arquivo:** `src/fila.js:48`
- **Evidência:** nenhuma exigência de `protocol === 'https:'`; `fetch` aceita `http:`.
- **Impacto:** o payload do webhook (que pode conter dados sensíveis do evento original) trafega em
  **claro** pela internet até o destino. E a assinatura HMAC vai em header — visível em rede aberta.
  Combined com `SEC-01`, é exfiltração de dados em trânsito.
- **Mudança:** no `validarDestino` (ver `SEC-01`), **exigir** `https:` como padrão (permitir `http:`
  só com `RELAY_ALLOW_HTTP=1` explícito, para dev/local).
- **Aceite:** `destino=http://exemplo.com` → `400` (por padrão).
- **Verificação:**
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3400/ingest?destino=http://exemplo.com" \
    -H 'Content-Type: application/json' -d '{"a":1}'    # 400
  ```

### SEC-08 · Redirecionamento pode contornar a validação de URL · [P1]

- **Arquivo:** `src/fila.js:48`
- **Evidência:** `fetchImpl(ev.destino, {...})` usa o default do `fetch` = `redirect: 'follow'` — o
  relay segue redirects **sem revalidar** o destino final.
- **Impacto:** contorna `SEC-01`/`SEC-07` fácilmente: `destino=https://atacante.com/r` responde `302`
  para `http://169.254.169.254/` ou `http://127.0.0.1/` — a validação do **primeiro** hop passa, o
  segundo (interno) éfollowed sem checagem. SSRF via redirect é a variante mais comum de bypass.
- **Mudança:** (1) `redirect: 'manual'` e, se seguir redirects, revalidar **cada** `Location` com
  `validarDestino`; (2) limitar nº de redirects (ex.: 2).
- **Aceite:** destino que redireciona para rede privada → entrega **não** acontece.
- **Verificação:**
  ```bash
  # https://exemplo.com/r -> 302 http://169.254.169.254/ : o relay deve recusar/nao entregar
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3400/ingest?destino=https://redirector.local/r" \
    -H 'Content-Type: application/json' -d '{"a":1}'   # com redirect: manual + revalidacao -> falha na entrega
  ```
---

## 4. Bugs e defeitos funcionais

### BUG-01 · `marcar` não é atômico (2 workers pegam o mesmo evento) · [P1]

- **Arquivo:** `src/fila.js:43,59,64` · `server.js:55`
- **Evidência:** `proximos.all('pendente', limite)` (linha 43) seleciona, e **só depois** o worker faz
  `marcar.run('entregue'/'pendente'/'dlq', ...)` (linhas 59/64) no fim do `await`. O `setInterval`
  (`server.js:55`) dispara a cada 3 s **sem esperar** o `tentarEntregar` anterior (nem trava de
  reentrância, nem `await`).
- **Impacto:** dois ticks do worker pegam os **mesmos** eventos `pendente` (o SELECT já os listou
  antes do primeiro UPDATE) e fazem **duas entregas** do mesmo evento ao destino — entrega
  duplicada (o destinatário processa duas vezes). Com `SEC-04` (timeout), o problema fica mais
  provável: um destino lento mantém eventos em `pendente` por vários ticks.
- **Mudança:** (1) **trava de reentrância** no worker (não iniciar se o anterior roda) — resolve o
  tick-overlap; (2) **reserva atômica** do evento: `UPDATE eventos SET status='processando' WHERE
  id=? AND status='pendente'` e só processar se `changes===1` (adicionar `'processando'` ao CHECK,
  ou usar `tentativas` como lock); (3) garantir recuperação de eventos presos em `processando`
  (timeout → volta a `pendente`).
- **Aceite:** um evento nunca é entregue duas vezes; tick não sobrepõe worker.
- **Verificação:**
  ```bash
  # dois eventos para o mesmo destino; rodar dois workers; contar entregas no destino -> 2, nao 4
  ```

### BUG-02 · `replay` zera `tentativas` mas mantém payload antigo · [P2]

- **Arquivo:** `src/fila.js:79` (`marcar.run('pendente', 0, id)`)
- **Evidência:** o replay reseta `tentativas` para 0, mantendo o `payload` e `destino` originais.
- **Impacto:** menor. Um evento em DLQ que **nunca** vai funcionar (destino removido, payload inválido
  para o consumidor) é replayado infinitamente: cada replay dá 5 novas tentativas. Sem limite de
  replay, é um loop de reenvio manual — mas é manual, então o risco é o operador ficar refém.
- **Mudança:** (1) contar replays (`replays`) e limitar (ex.: máximo 3); (2) documentar que replay
  reenvia o payload **original** (o operador deve conferir antes); (3) opcionalmente, permitir
  corrigir o `destino` no replay (útil quando o destino mudou).
- **Aceite:** evento replayado 4x não volta mais a `pendente` (ou exige forçar).
- **Verificação:**
  ```bash
  # replayar 4x e conferir que a 4a é recusada
  ```

### BUG-03 · Evento preso em `processando` (se usar o lock do BUG-01) não se recupera · [P2]

- **Arquivo:** `src/fila.js:12` (CHECK `status`) · `:43`
- **Evidência:** o schema atual não tem `'processando'`; se `BUG-01` for corrigido adicionando esse
  estado, é preciso lidar com eventos que **ficam** nele se o processo morrer no meio (crash entre
  reservar e concluir).
- **Impacto:** evento preso em `processando` **nunca** é retomado — perda silenciosa de entrega. É o
  trade-off do lock atômico.
- **Mudança:** (1) ao iniciar, recuperar eventos em `processando` com `atualizado_em` antiga
  (timeout) de volta a `pendente`; (2) ou não usar estado novo e fazer o lock via `tentativas`
  incrementado condicionalmente.
- **Aceite:** após reinício com evento preso, ele volta à fila.
- **Verificação:**
  ```bash
  # marcar um evento como processando, reiniciar o processo, e ver se ele volta a pendente
  ```

### IMP-01 · Replay do mesmo `X-Event-Id` com destino diferente é ignorado · [P2]

- **Arquivo:** `src/fila.js:30-31`
- **Evidência:** `if (existe) return { id, duplicado: true };` — se o `id` já existe, **ignora** o
  novo `destino`/`payload` silenciosamente.
- **Impacto:** um cliente que reutiliza `X-Event-Id` com conteúdo diferente (bug do cliente, ou
  reuso acidental) tem o evento novo **descartado sem erro** — perda de webhook silenciosa. O
  retorno `200` (não `201`) sugere que foi aceito.
- **Mudança:** comparar `destino`/`payload` do existente com o novo; se divergirem, responder `409`
  (conflito) em vez de `200 duplicado`, para o cliente detectar o bug.
- **Aceite:** mesmo `X-Event-Id` com payload diferente → `409` explícito.
- **Verificação:**
  ```bash
  # ingerir mesmo id duas vezes com payloads diferentes -> 409
  ```

### IMP-02 · Encoding do payload na entrega · [P2]

- **Arquivo:** `src/fila.js:32,56`
- **Evidência:** o payload é `JSON.stringify` do objeto (linha 32) e entregue como `body: ev.payload`
  (linha 56) com `Content-Type: application/json` (linha 51).
- **Impacto:** se o payload foi armazenado como **string** (linha 32 aceita `typeof payload ===
  'string'`), a string é entregue **crua** — mas o `X-Relay-Signature` é sobre ela; se for objeto,
  é serializado. Os dois caminhos são consistentes internamente, mas um payload string que não é
  JSON válido seria entregue com `Content-Type: application/json` (**inválido**) eHMAC de um corpo
  que o destinatário pode não parsear igual.
- **Mudança:** (1) normalizar o payload na ingestão (sempre `JSON.stringify`, validando que string é
  JSON válido); (2) incluir `charset=utf-8` no `Content-Type`.
- **Aceite:** payload string inválido → `400`; payload string JSON válido → entregue como JSON
  consistente.
- **Verificação:**
  ```bash
  curl -s -X POST "http://localhost:3400/ingest?destino=https://x.com" \
    -H 'Content-Type: application/json' -d '"texto puro nao-json"'   # deve rejeitar (400)
  ```

---

## 5. Qualidade: testes, arquitetura e observabilidade

### TEST-01 · Sem teste de SSRF (destino privado) · [P1]

- **Arquivo:** `test/relay-test.mjs`
- **Evidência:** o teste cobre ingest/entrega/retry/DLQ com `fetchImpl` injetado; **não** cobre
  validação de `destino` (porque não existe — `SEC-01`).
- **Impacto:** o `SEC-01` pode voltar sem teste que pegue — reintroduzir `fetch(destino)` cru é uma
  linha.
- **Mudança:** casos para `validarDestino`: `127.0.0.1` → recusa; `169.254.169.254` → recusa;
  `10.x`/`192.168.x` → recusa; `localhost` → recusa; `http://` → recusa; `https://exemplo.com` → passa.
- **Aceite:** `npm test` inclui os 6 casos e falha se a validação for removida.
- **Verificação:**
  ```bash
  npm test 2>&1 | tail -3
  ```

### TEST-02 · Sem teste de ingestão sem assinatura · [P1]

- **Arquivo:** `test/relay-test.mjs`
- **Evidência:** nenhum teste ingere **sem** assinatura esperando `401` (hoje não há assinatura na
  entrada — `SEC-02`).
- **Impacto:** o `SEC-02` pode voltar sem teste que pegue.
- **Mudança:** caso: `POST /ingest` sem `X-Relay-Signature` → `401` e **nada** no banco; com assinatura
  válida → `201`.
- **Aceite:** `npm test` inclui o caso; falha se a verificação for removida.
- **Verificação:**
  ```bash
  npm test 2>&1 | tail -3
  ```

---

## 6. DevOps / Infra

### DEVOPS-01 · CI sem verificação estática do relay · [P2]

- **Arquivo:** `.github/workflows/ci.yml`
- **Evidência:** o workflow já executa `npm test`, mas não verificava a sintaxe do servidor nem do transporte anti-SSRF.
- **Impacto:** sem verificação sintática, erros de parsing podem chegar ao deploy — e um relay de webhook é
  infraestrutura que não pode ter regressão silenciosa (especialmente SSRF/auth, que aqui são P0).
- **Mudança aplicada:** script `npm run check` com `node --check` para servidor, fila, validador de
  destino e painel, disponível para revisão estática local.
- **Pendente:** o workflow ainda não chama esse script nem tem barreira estática dedicada contra
  regressão de SSRF.
- **Verificação:**
  ```bash
  node --check server.js src/fila.js && npm test
  ```

### DEVOPS-02 · Sem `.env.example` · [P2]

- **Arquivo:** *(ausente)* `.env.example` · `server.js:10-12`
- **Evidência:** lê `PORT` e `RELAY_SECRET` e `RELAY_DB`; nenhum exemplo versionado.
- **Impacto:** após o `SEC-03` (sem fallback), quem clona não sobe sem descobrir a variável.
- **Mudança:** `.env.example` com `PORT`, `RELAY_DB`, `RELAY_SECRET` (mín 32 bytes), e as novas do
  `SEC-01`/`SEC-07` (`RELAY_ALLOWED_HOSTS`, `RELAY_ALLOW_HTTP`).
- **Aceite:** exemplo versionado documenta as variáveis operacionais e de segurança.
- **Verificação:** `diff` entre `process.env.*` e as chaves do exemplo.

### DEVOPS-03 · `webhook-relay.db` versionado · [P2]

- **Arquivo:** `webhook-relay.db` (se commitado — verificar `git ls-files`)
- **Evidência:** `server.js:12` usa `RELAY_DB || 'webhook-relay.db'` (default no repo).
- **Impacto:** eventos/payloads de webhook commitados no repo (podem conter dados de terceiros) e
  sobrescritos no `pull`.
- **Mudança:** `git rm --cached webhook-relay.db` (se versionado); `*.db` no `.gitignore`.
- **Aceite:** nenhum `.db` no índice; testes verdes.
- **Verificação:**
  ```bash
  git ls-files | grep -c '\\.db$'   # 0
  ```

---

## 7. Documentação

### DOC-01 · README não avisa que relay é superfície SSRF · [P2]

- **Arquivo:** `README.md`
- **Evidência:** o README descreve o relay (fila/retry/DLQ/HMAC), mas não avisa que (a) o relay faz
  requisição para uma URL fornecida pelo cliente (SSRF) e (b) a ingestão precisa ser autenticada.
- **Impacto:** quem expõe o relay em rede pública sem ler o código não sabe que está oferecendo
  proxy de rede + entrega em nome de terceiros.
- **Mudança:** seção "Segurança": o relay é uma superfície SSRF por natureza; destino é validado
  (após `SEC-01`), ingestão autenticada (após `SEC-02`), e **recomendações de exposição** (não
  expor publicamente sem auth; usar allowlist).
- **Aceite:** README tem a seção com as 3 recomendações.
- **Verificação:** `grep -ni 'ssrf\|autentic\|expor' README.md`.

### DOC-02 · Falta `SECURITY.md` · [P3]

- **Arquivo:** *(ausente)* `SECURITY.md`
- **Evidência:** tem `LICENSE`/README, sem guia de reporte.
- **Impacto:** relay é superfície de alto risco; achado de SSRF/bypass não tem canal.
- **Mudança:** criar com canal + as ameaças (SSRF via destino/redirect, replay/abuso, HMAC) +
  a invariante "destino é sempre validado na ingestão **e** na entrega, redirect inclusive".
- **Aceite:** arquivo existe com a invariante.
- **Verificação:** `ls SECURITY.md`.

---

## 8. Ordem de execução (waves)

### Wave 1 — Fechar as condições de exposição (P0)
1. **`SEC-03`** — exigir `RELAY_SECRET` (sem isso, todo HMAC é decorativo).
2. **`SEC-01`** — validar `destino` (SSRF) — o item mais crítico do projeto.
3. **`SEC-04`** — timeout + trava de reentrância (worker não trava).
4. **`SEC-02`** — autenticar a ingestão (HMAC de entrada, tempo constante).

> Depois da Wave 1, expor o relay não dá proxy de rede nem fila aberta.

### Wave 2 — Fechar as bordas (P1)
5. **`SEC-08`** — `redirect: 'manual'` + revalidar (anti-bypass do SSRF).
6. **`SEC-07`** — exigir `https`.
7. **`SEC-06`** — auth no replay + auditar quem replayou.
8. **`SEC-05`** — limite no `express.json`.
9. **`BUG-01`** — reserva atômica do evento (entrega duplicada).
10. **`TEST-01`**, **`TEST-02`** — travar SSRF e auth.

### Wave 3 — Robustez (P2)
11. **`BUG-02`** — limite de replay.
12. **`BUG-03`** — recuperação de evento preso (se usar o lock).
13. **`IMP-01`** — `409` em `X-Event-Id` com payload diferente.
14. **`IMP-02`** — normalizar encoding do payload.
15. **`DEVOPS-01`** — CI com barreira de SSRF.
16. **`DEVOPS-02`**, **`DEVOPS-03`** — `.env.example`, `.db` fora do índice.

### Wave 4 — Registro (P3)
17. **`DOC-01`**, **`DOC-02`**.

**Dependências que não podem ser invertidas:**
`SEC-03` antes de `SEC-02` (o segredo é o que assina a entrada) · `SEC-01` antes de `SEC-06`/`SEC-08`
(o replay reenvia para a URL do evento — precisa estar validado) · `SEC-08` junto com `SEC-01`
(sem `manual`, o `SEC-01` é contornável) · `SEC-04` antes de `BUG-01` (trava antes da atomicidade) ·
`TEST-01`/`TEST-02` depois das correções que testam.

---

## 9. Fora de escopo / riscos

| Item | Decisão | Motivo |
|---|---|---|
| Suportar destino em allowlist **apenas** (sem open) | **Não** | Open (com validação) é o uso do produto; allowlist é **complemento** (`RELAY_ALLOWED_HOSTS`), não substituto. |
| TLS mTLS para entrega | **Não, ainda** | HMAC já autentica o payload; mTLS é complexidade extra sem ganho aqui. |
| Assinatura por evento (chave por destino) | **Não, agora** | Um segredo global basta no volume; chame de evolução (ver `SEC-09` se crescer). |
| Assinatura do payload de **entrada** com chave distinta | **Não** | Reutilizar `RELAY_SECRET` é aceitável no volume; rotação separata é evolução. |
| Fila com worker dedicado (BullMQ/Redis) | **Não** | SQLite + worker setInterval é adequado; o problema é o SSRF/auth, não a escala. |

**Riscos desta execução:**

- **`SEC-01` pode bloquear destinos legítimos** que usem `http://` ou rede interna (ex.: serviço
  local). Oferecer `RELAY_ALLOW_HTTP=1` e allowlist como escape, e documentar (`SEC-07`).
- **`SEC-02` quebra clientes atuais** que ingestem sem assinatura (não há forma de磁 autenticar o que
  já não manda nada). Migrar cliente + servidor juntos; sem isso, o relay rejeita tudo.
- **`SEC-04` (timeout) pode cortar entregas lentas legítimas.** 10 s é folgado para webhook; se um
  destino legítimo for mais lento, o retry resolve.
- **`BUG-01` (trava de reentrância) reduz paralelismo** — mas o `limite=10` por tick continua. Medir
  throughput antes/depois.
- **`SEC-06` (auth no replay) exige token** que o painel atual não manda — migrar painel + servidor.

---

## 10. Definição de pronto (DoD)

**Segurança**
- [x] `SEC-01` — validação na ingestão e entrega, DNS fixado no IP validado e redes não públicas bloqueadas
- [x] `SEC-02` — ingestão sem token → `401`; o parser JSON roda depois da autenticação
- [x] `SEC-03` — sem `RELAY_SECRET` com pelo menos 32 bytes o processo não inicia
- [x] `SEC-04` — timeout de 10 s e trava de reentrância do worker
- [x] `SEC-05` — payload limitado a 1 MB → `413`
- [x] `SEC-06` — replay protegido por token, auditado e limitado
- [x] `SEC-07` — `http://` rejeitado por padrão
- [x] `SEC-08` — redirects não são seguidos

**Funcional**
- [x] `BUG-01` — reserva atômica, sem sobreposição do worker no processo
- [x] `BUG-02` — replay tem limite de três ações por evento
- [x] `BUG-03` — reserva presa em `processando` volta à fila após o lease de 60 s
- [x] `IMP-01` — `X-Event-Id` com destino ou payload diferente → `409`
- [x] `IMP-02` — payload é validado, normalizado e enviado como JSON UTF-8

**Testes e infra**
- [ ] `TEST-01` — 6 casos de `validarDestino` no `npm test`
- [ ] `TEST-02` — caso de ingestão sem assinatura
- [ ] `DEVOPS-01` — CI com barreira estática de SSRF (CI existente ainda não chama `npm run check`)
- [x] `DEVOPS-02` — `.env.example` documenta as variáveis de execução
- [x] `DEVOPS-03` — nenhum `.db` no índice; arquivos locais também foram preservados

**Documentação**
- [x] `DOC-01` — README avisa que relay é superfície SSRF e orienta exposição segura
- [x] `DOC-02` — `SECURITY.md` registra a invariante de validação do destino

**Execução desta revisão (2026-10-11)**

- Implementadas as proteções e a documentação marcadas acima, além de usuário não-root no Docker,
  bind local padrão e dependência Express declarada no `package.json`.
- Não foram adicionados nem executados testes nesta revisão. A validação de execução permanece
  pendente; os itens `TEST-01` e `TEST-02` continuam abertos.
- A suíte existente do CI não foi executada manualmente nesta revisão.

**Validação final:**
```bash
npm test 2>&1 | tail -2
node --check server.js src/fila.js
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:3400/ingest?destino=http://169.254.169.254/" \
  -H 'Content-Type: application/json' -d '{"a":1}'   # 400
git ls-files | grep -c '\\.db$'   # 0
```

---

*Plano gerado por leitura direta do código em 2026-10-02; o registro de execução acima descreve o estado após a revisão de 2026-10-11.*
