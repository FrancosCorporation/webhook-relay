# Resumo — webhook-relay

## Sessão 2026-10-14 (planejamento padronizado + modernização da CI)

- **Resumo executivo:** relay de webhooks já endurecido (SSRF/HMAC/DLQ; DEVOPS-01 feito em 2026-10-11). Nesta sessão: CI fixada (Ubuntu 24.04, Actions v7 SHA, Node 22/24, `npm ci`, gate audit); `package-lock.json` versionado (estava ignorado); docs padronizadas.
- **Validações:** `npm audit --audit-level=high` = 0; `git diff --check` limpo; suíte só na CI (regra).
- **Resultado:** [x] CI verde; [x] docs; [x] sem dados locais a preservar.
- **Continuidade:** HEAD sincronizado; checkout removível. Backlog no `plan.md`.

### Adendo técnico (traço do push)
- O gate de testes revelou que **C6 (anti-SSRF) nunca passou na CI** desde a introdução em 2026-10-11 (runs `38116916777`, `38161247214` falhos). Correções aplicadas: (a) teste configurava-se sem `RELAY_ALLOW_HTTP=1` e esperava erro "SSRF" para URLs `http://` bloqueadas antes na camada de protocolo → env setado no teste + fixture `ftp` assertada contra a mensagem de protocolo; (b) **BUG-06 real:** `tentarEntregar` tratava destino bloqueado como falha transitória, retentando 5× com backoff antes da DLQ — agora erro `codigo:'destino_invalido'` vai **direto para a DLQ**. CI `38520944844` verde em Node 22/24 com a suíte inteira.
