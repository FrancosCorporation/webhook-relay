// Webhook Relay M1 — ingestão → fila durável (sqlite) → entrega com retry + DLQ + HMAC.
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';

export function criarFila(caminhoDb = 'webhook-relay.db') {
  const db = new DatabaseSync(caminhoDb);
  db.exec(`
  CREATE TABLE IF NOT EXISTS eventos (
    id TEXT PRIMARY KEY,
    destino TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pendente','entregue','falhou','dlq')),
    tentativas INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em TEXT
  );
  `);

  const inserir = db.prepare('INSERT INTO eventos (id, destino, payload, status) VALUES (?, ?, ?, ?)');
  const marcar = db.prepare('UPDATE eventos SET status = ?, tentativas = ?, atualizado_em = datetime(\'now\') WHERE id = ?');
  const proximos = db.prepare('SELECT * FROM eventos WHERE status = ? ORDER BY criado_em LIMIT ?');

  return {
    db,

    // ingere um evento (idempotente por id externo opcional)
    ingere({ destino, payload, idExterno }) {
      if (!destino || !payload) throw Object.assign(new Error('destino e payload obrigatórios'), { codigo: 'dados' });
      const id = idExterno || randomUUID();
      const existe = db.prepare('SELECT id FROM eventos WHERE id = ?').get(id);
      if (existe) return { id, duplicado: true };
      inserir.run(id, destino, typeof payload === 'string' ? payload : JSON.stringify(payload), 'pendente');
      return { id, duplicado: false };
    },

    // assina o payload (HMAC-SHA256) para o destinatário validar
    assinar(payload, segredo) {
      return createHmac('sha256', segredo).update(payload).digest('hex');
    },

    // tenta entregar os pendentes; volta os que falharam para retry (backoff por tentativas)
    async tentarEntregar({ segredo = '', limite = 10, fetchImpl = fetch } = {}) {
      const pendentes = proximos.all('pendente', limite);
      const resultados = [];
      for (const ev of pendentes) {
        const tentativas = ev.tentativas + 1;
        try {
          const r = await fetchImpl(ev.destino, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Relay-Signature': this.assinar(ev.payload, segredo),
              'X-Relay-Event-Id': ev.id,
              'X-Relay-Tentativa': String(tentativas)
            },
            body: ev.payload
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          marcar.run('entregue', tentativas, ev.id);
          resultados.push({ id: ev.id, ok: true, tentativas });
        } catch (e) {
          // backoff: re-enfileira até 5 tentativas; depois DLQ
          const proximoStatus = tentativas >= 5 ? 'dlq' : 'pendente';
          marcar.run(proximoStatus, tentativas, ev.id);
          resultados.push({ id: ev.id, ok: false, tentativas, erro: e.message, dlq: proximoStatus === 'dlq' });
          if (proximoStatus === 'pendente') {
            // espera o backoff antes da próxima tentativa (2^t segundos)
            await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (tentativas - 1), 8000)));
          }
        }
      }
      return resultados;
    },

    // replay de evento em DLQ (volta para pendente)
    replay(id) {
      const ev = db.prepare('SELECT id FROM eventos WHERE id = ? AND status = ?').get(id, 'dlq');
      if (!ev) return false;
      marcar.run('pendente', 0, id);
      return true;
    },

    listar(limite = 50) {
      return db.prepare('SELECT id, destino, status, tentativas, criado_em FROM eventos ORDER BY criado_em DESC LIMIT ?').all(limite);
    },

    metricas() {
      const total = db.prepare('SELECT COUNT(*) AS n FROM eventos').get().n;
      const entregues = db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE status = 'entregue'").get().n;
      const dlq = db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE status = 'dlq'").get().n;
      const pendentes = db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE status = 'pendente'").get().n;
      return { total, entregues, pendentes, dlq, taxaEntrega: total ? (entregues / total) * 100 : 0 };
    }
  };
}
