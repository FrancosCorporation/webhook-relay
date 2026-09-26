// Testes do Webhook Relay — fila, retry, DLQ, HMAC, idempotência (servidor real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { criarFila, } from '../src/fila.js';

const require = createRequire(import.meta.url);

// ---- testes da fila (unidade, com sqlite em tmp) ----
const dbArquivo = join(mkdtempSync(join(tmpdir(), 'relay-')), 'teste.db');
const fila = criarFila(dbArquivo);

test('ingestão + idempotência por id externo', () => {
  const r1 = fila.ingere({ destino: 'http://x/y', payload: { a: 1 }, idExterno: 'evt-1' });
  assert.equal(r1.duplicado, false);
  const r2 = fila.ingere({ destino: 'http://x/y', payload: { a: 1 }, idExterno: 'evt-1' });
  assert.equal(r2.duplicado, true);
  assert.throws(() => fila.ingere({ payload: {} }));
});

test('entrega ok marca entregue (servidor alvo real)', async () => {
  const recebidos = [];
  const alvo = createServer((req, res) => { recebidos.push(req.headers); res.writeHead(200); res.end(); });
  await new Promise((r) => alvo.listen(0, r));
  const porta = alvo.address().port;
  fila.ingere({ destino: `http://localhost:${porta}/hook`, payload: { x: 1 }, idExterno: 'evt-ok' });
  const r = await fila.tentarEntregar({ segredo: 'seg' });
  // a fila é compartilhada entre testes: filtra pelo MEU evento
  const meu = r.find((x) => x.id === 'evt-ok');
  assert.equal(meu.ok, true);
  assert.equal(recebidos.length, 1);
  assert.ok(recebidos[0]['x-relay-signature']); // HMAC presente
  assert.equal(recebidos[0]['x-relay-event-id'], 'evt-ok');
  alvo.close();
});

test('HMAC: assinatura determinística e verificável', () => {
  const s1 = fila.assinar('{"a":1}', 'segredo');
  const s2 = fila.assinar('{"a":1}', 'segredo');
  const s3 = fila.assinar('{"a":2}', 'segredo');
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
});

test('falha -> retry -> DLQ após 5 tentativas (alvo caindo)', async () => {
  const alvo = createServer((req, res) => { res.writeHead(500); res.end(); });
  await new Promise((r) => alvo.listen(0, r));
  const porta = alvo.address().port;
  fila.ingere({ destino: `http://localhost:${porta}/hook`, payload: { x: 2 }, idExterno: 'evt-fail' });
  // primeira tentativa: falha, volta pra pendente
  const r1 = await fila.tentarEntregar({ segredo: 's' });
  const meu1 = r1.find((x) => x.id === 'evt-fail');
  assert.equal(meu1.ok, false);
  assert.equal(meu1.dlq, false);
  // força 4 tentativas restantes de uma vez (sem esperar backoff real: bypass manual)
  const ev = fila.db.prepare("SELECT id FROM eventos WHERE id = 'evt-fail'").get();
  for (let i = 0; i < 3; i++) fila.db.prepare("UPDATE eventos SET tentativas = ? WHERE id = ?").run(i + 2, ev.id);
  const r2 = await fila.tentarEntregar({ segredo: 's' });
  const meu2 = r2.find((x) => x.id === 'evt-fail');
  assert.equal(meu2.tentativas, 5);
  assert.equal(meu2.dlq, true);
  const metricas = fila.metricas();
  assert.equal(metricas.dlq, 1);
  alvo.close();
});

test('replay de DLQ volta para pendente', () => {
  fila.ingere({ destino: 'http://x/z', payload: { y: 3 }, idExterno: 'evt-dlq' });
  const ev = fila.db.prepare("SELECT id FROM eventos WHERE id = 'evt-dlq'").get();
  fila.db.prepare("UPDATE eventos SET status = 'dlq' WHERE id = ?").run(ev.id);
  assert.equal(fila.replay(ev.id), true);
  const st = fila.db.prepare("SELECT status FROM eventos WHERE id = ?").get(ev.id);
  assert.equal(st.status, 'pendente');
});

test('metricas: taxa de entrega calculada', () => {
  const m = fila.metricas();
  assert.ok(m.total >= 3);
  assert.ok(m.taxaEntrega > 0 && m.taxaEntrega <= 100);
});
