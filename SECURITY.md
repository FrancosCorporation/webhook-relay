# Segurança

## Reportar uma vulnerabilidade

Envie detalhes em privado para a equipe mantenedora pelo canal de contato do
[FrancosCorporation no GitHub](https://github.com/FrancosCorporation). Inclua passos para reproduzir,
impacto, versão e uma forma segura de contato. Não publique tokens, payloads reais ou dados de
terceiros em uma issue pública.

## Limites de segurança

O relay recebe destinos fornecidos por clientes e faz requisições de saída. A regra central é:

> Todo destino é validado na ingestão e novamente na entrega. O relay não segue redirects.

A resolução DNS rejeita destinos com qualquer resposta privada ou reservada e a conexão usa os IPs
que foram validados. Ingestão e operações do painel exigem `RELAY_SECRET`; o segredo deve ter pelo
menos 32 bytes e ser entregue por um canal seguro. O payload é limitado a 1 MB. Replay é autenticado,
auditado e limitado a três ações por evento.

Use HTTPS e mantenha o serviço atrás de um proxy reverso confiável. `RELAY_ALLOW_HTTP=1` remove apenas
a exigência de HTTPS para destinos públicos; não libera redes privadas.
