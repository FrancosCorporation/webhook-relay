// Webhook Relay M1 — ingestão → fila durável (sqlite) → entrega com retry + DLQ + HMAC.
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';
import { enviarWebhook, validarDestino } from './destino.js';

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_REPLAYS = 3;
const LEASE_PROCESSANDO_MS = 60_000;

function normalizarPayload(payload) {
  let valor = payload;
  if (typeof valor === 'string') {
    try { valor = JSON.parse(valor); }
    catch { throw Object.assign(new Error('payload deve conter JSON válido'), { codigo: 'dados' }); }
  }
  let serializado;
  try { serializado = JSON.stringify(valor); }
  catch { throw Object.assign(new Error('payload não pode ser serializado como JSON'), { codigo: 'dados' }); }
  if (serializado === undefined) throw Object.assign(new Error('payload deve ser um valor JSON'), { codigo: 'dados' });
  if (Buffer.byteLength(serializado, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw Object.assign(new Error('payload excede o limite de 1 MB'), { codigo: 'limite' });
  }
  return serializado;
}

function resumoDestino(destino) {
  try {
    const url = new URL(destino);
    return `${url.origin}${url.pathname}`;
  } catch { return '[destino inválido]'; }
}

function garantirSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eventos (
      id TEXT PRIMARY KEY,
      destino TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pendente','processando','entregue','falhou','dlq')),
      tentativas INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT
    );
  `);

  const definicao = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'eventos'").get()?.sql || '';
  if (!definicao.includes("'processando'")) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const definicaoAtual = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'eventos'").get()?.sql || '';
      if (!definicaoAtual.includes("'processando'")) {
        db.exec(`
          CREATE TABLE eventos_migracao (
            id TEXT PRIMARY KEY,
            destino TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pendente','processando','entregue','falhou','dlq')),
            tentativas INTEGER NOT NULL DEFAULT 0,
            criado_em TEXT NOT NULL DEFAULT (datetime('now')),
            atualizado_em TEXT
          );
          INSERT INTO eventos_migracao (id, destino, payload, status, tentativas, criado_em, atualizado_em)
            SELECT id, destino, payload, status, tentativas, criado_em, atualizado_em FROM eventos;
          DROP TABLE eventos;
          ALTER TABLE eventos_migracao RENAME TO eventos;
        `);
      }
      db.exec('COMMIT');
    } catch (erro) {
      db.exec('ROLLBACK');
      throw erro;
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento_id TEXT NOT NULL,
      ator TEXT NOT NULL DEFAULT '',
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS replay_auditoria_evento_idx ON replay_auditoria (evento_id);
  `);
}

export function criarFila(caminhoDb = 'webhook-relay.db') {
  const db = new DatabaseSync(caminhoDb);
  garantirSchema(db);

  const inserir = db.prepare('INSERT INTO eventos (id, destino, payload, status) VALUES (?, ?, ?, ?)');
  const marcar = db.prepare("UPDATE eventos SET status = ?, tentativas = ?, atualizado_em = datetime('now') WHERE id = ?");
  const proximos = db.prepare("SELECT * FROM eventos WHERE status = 'pendente' ORDER BY criado_em LIMIT ?");
  const reservar = db.prepare("UPDATE eventos SET status = 'processando', tentativas = ?, atualizado_em = datetime('now') WHERE id = ? AND status = 'pendente' AND tentativas = ?");
  const recuperar = db.prepare("UPDATE eventos SET status = CASE WHEN tentativas >= 5 THEN 'dlq' ELSE 'pendente' END, atualizado_em = datetime('now') WHERE status = 'processando' AND (atualizado_em IS NULL OR atualizado_em < datetime('now', ?))");
  const contarReplays = db.prepare('SELECT COUNT(*) AS total FROM replay_auditoria WHERE evento_id = ?');

  return {
    db,

    // Ingere um evento idempotente e compara conteúdo ao receber de novo o mesmo id.
    ingere({ destino, payload, idExterno }) {
      if (typeof destino !== 'string' || !destino || payload === undefined) {
        throw Object.assign(new Error('destino e payload obrigatórios'), { codigo: 'dados' });
      }
      if (idExterno !== undefined && (typeof idExterno !== 'string' || !idExterno || idExterno.length > 200 || /[\r\n\0]/.test(idExterno))) {
        throw Object.assign(new Error('X-Event-Id inválido'), { codigo: 'dados' });
      }
      const id = idExterno || randomUUID();
      const payloadNormalizado = normalizarPayload(payload);
      const existente = db.prepare('SELECT id, destino, payload FROM eventos WHERE id = ?').get(id);
      if (existente) {
        if (existente.destino !== destino || existente.payload !== payloadNormalizado) {
          throw Object.assign(new Error('X-Event-Id já foi usado com outro destino ou payload'), { codigo: 'conflito' });
        }
        return { id, duplicado: true };
      }
      inserir.run(id, destino, payloadNormalizado, 'pendente');
      return { id, duplicado: false };
    },

    // Assina o JSON exato que será entregue ao destino.
    assinar(payload, segredo) {
      return createHmac('sha256', segredo).update(payload).digest('hex');
    },

    async tentarEntregar({ segredo = '', limite = 10, fetchImpl = enviarWebhook } = {}) {
      recuperar.run(`-${LEASE_PROCESSANDO_MS / 1000} seconds`);
      const tamanhoLote = Math.max(1, Math.min(Number(limite) || 10, 100));
      const pendentes = proximos.all(tamanhoLote);
      const resultados = [];

      for (const ev of pendentes) {
        const tentativas = ev.tentativas + 1;
        const reserva = reservar.run(tentativas, ev.id, ev.tentativas);
        if (Number(reserva.changes) !== 1) continue;

        let timer;
        try {
          try { validarDestino(ev.destino); }
          catch (erro) {
            throw Object.assign(
              new Error(`destino bloqueado (SSRF ou protocolo inseguro): ${erro.message}`),
              { codigo: 'destino_invalido' }
            );
          }

          const ctrl = new AbortController();
          timer = setTimeout(() => ctrl.abort(), 10_000);
          const resposta = await fetchImpl(ev.destino, {
            method: 'POST',
            redirect: 'manual',
            signal: ctrl.signal,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'X-Relay-Signature': this.assinar(ev.payload, segredo),
              'X-Relay-Event-Id': ev.id,
              'X-Relay-Tentativa': String(tentativas)
            },
            body: ev.payload
          });
          if (!resposta.ok) throw new Error(`HTTP ${resposta.status || 0}`);
          marcar.run('entregue', tentativas, ev.id);
          resultados.push({ id: ev.id, ok: true, tentativas });
        } catch (erro) {
          // Destino inválido (SSRF/protocolo) não pode ter sucesso em retry:
          // vai direto para a DLQ. Falhas transitórias seguem o backoff.
          const proximoStatus = erro.codigo === 'destino_invalido' || tentativas >= 5 ? 'dlq' : 'pendente';
          marcar.run(proximoStatus, tentativas, ev.id);
          resultados.push({ id: ev.id, ok: false, tentativas, erro: erro.message, dlq: proximoStatus === 'dlq' });
          if (proximoStatus === 'pendente') {
            await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** (tentativas - 1), 8_000)));
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return resultados;
    },

    replay(id, ator = '') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const evento = db.prepare('SELECT id FROM eventos WHERE id = ? AND status = ?').get(id, 'dlq');
        if (!evento || contarReplays.get(id).total >= MAX_REPLAYS) {
          db.exec('ROLLBACK');
          return false;
        }
        const atualizacao = db.prepare("UPDATE eventos SET status = 'pendente', tentativas = 0, atualizado_em = datetime('now') WHERE id = ? AND status = 'dlq'").run(id);
        if (Number(atualizacao.changes) !== 1) {
          db.exec('ROLLBACK');
          return false;
        }
        db.prepare('INSERT INTO replay_auditoria (evento_id, ator) VALUES (?, ?)').run(id, String(ator).slice(0, 200));
        db.exec('COMMIT');
        return true;
      } catch (erro) {
        db.exec('ROLLBACK');
        throw erro;
      }
    },

    listar(limite = 50) {
      const seguro = Math.max(1, Math.min(Number(limite) || 50, 200));
      return db.prepare('SELECT id, destino, status, tentativas, criado_em FROM eventos ORDER BY criado_em DESC LIMIT ?')
        .all(seguro)
        .map((evento) => ({ ...evento, destino: resumoDestino(evento.destino) }));
    },

    metricas() {
      const total = db.prepare('SELECT COUNT(*) AS n FROM eventos').get().n;
      const entregues = db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE status = 'entregue'").get().n;
      const dlq = db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE status = 'dlq'").get().n;
      const pendentes = db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE status = 'pendente'").get().n;
      const processando = db.prepare("SELECT COUNT(*) AS n FROM eventos WHERE status = 'processando'").get().n;
      return { total, entregues, pendentes, processando, dlq, taxaEntrega: total ? (entregues / total) * 100 : 0 };
    }
  };
}
