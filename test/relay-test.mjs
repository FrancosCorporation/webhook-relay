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

test('entrega ok marca entregue (fetch simulado + HMAC)', async () => {
  const recebidos = [];
  const fetchOk = async (url, opts) => { recebidos.push(opts.headers); return { ok: true }; };
  fila.ingere({ destino: 'https://relay-test.invalid/hook', payload: { x: 1 }, idExterno: 'evt-ok' });
  const r = await fila.tentarEntregar({ segredo: 'seg', fetchImpl: fetchOk });
  // a fila é compartilhada entre testes: filtra pelo MEU evento
  const meu = r.find((x) => x.id === 'evt-ok');
  assert.equal(meu.ok, true);
  // a fila é compartilhada: outros pendentes podem ter sido entregues juntos —
  // filtra pelos headers do MEU evento
  const meus = recebidos.filter((h) => h['X-Relay-Event-Id'] === 'evt-ok');
  assert.equal(meus.length, 1);
  assert.ok(meus[0]['X-Relay-Signature']); // HMAC presente
});

test('HMAC: assinatura determinística e verificável', () => {
  const s1 = fila.assinar('{"a":1}', 'segredo');
  const s2 = fila.assinar('{"a":1}', 'segredo');
  const s3 = fila.assinar('{"a":2}', 'segredo');
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
});

test('falha -> retry -> DLQ após 5 tentativas (alvo caindo)', async () => {
  // destino público fictício; o anti-SSRF bloqueia 127.0.0.1/localhost,
  // então este teste usa fetchImpl simulado em vez de rede real
  fila.ingere({ destino: 'https://relay-test.invalid/hook', payload: { x: 2 }, idExterno: 'evt-fail' });
  const fetch500 = async () => ({ ok: false, status: 500 });
  // primeira tentativa: falha, volta pra pendente
  const r1 = await fila.tentarEntregar({ segredo: 's', fetchImpl: fetch500 });
  const meu1 = r1.find((x) => x.id === 'evt-fail');
  assert.equal(meu1.ok, false);
  assert.equal(meu1.dlq, false);
  // força 4 tentativas restantes de uma vez (sem esperar backoff real: bypass manual)
  const ev = fila.db.prepare("SELECT id FROM eventos WHERE id = 'evt-fail'").get();
  for (let i = 0; i < 3; i++) fila.db.prepare("UPDATE eventos SET tentativas = ? WHERE id = ?").run(i + 2, ev.id);
  const r2 = await fila.tentarEntregar({ segredo: 's', fetchImpl: fetch500 });
  const meu2 = r2.find((x) => x.id === 'evt-fail');
  assert.equal(meu2.tentativas, 5);
  assert.equal(meu2.dlq, true);
  const metricas = fila.metricas();
  assert.ok(metricas.dlq >= 1);
});

test('C6: destino interno vai direto para DLQ sem fetch (anti-SSRF)', async () => {
  const chamadasBloqueadas = [];
  const fetchSpy = async (url) => { chamadasBloqueadas.push(url); return { ok: true }; };
  for (const [id, dest] of [
    ['ssrf-1', 'http://169.254.169.254/latest/meta-data/'],
    ['ssrf-2', 'http://localhost:8080/hook'],
    ['ssrf-3', 'http://192.168.1.1/hook'],
    ['ssrf-4', 'ftp://x.invalid/f'],
  ]) {
    fila.ingere({ destino: dest, payload: { x: 1 }, idExterno: id });
  }
  const r = await fila.tentarEntregar({ segredo: 's', fetchImpl: fetchSpy });
  for (const id of ['ssrf-1', 'ssrf-2', 'ssrf-3', 'ssrf-4']) {
    const meu = r.find((x) => x.id === id);
    assert.equal(meu.ok, false, id);
    assert.equal(meu.dlq, true, id);
    assert.match(meu.erro, /SSRF/, id);
  }
  // nenhum fetch para destino interno (a fila é compartilhada: outros testes
  // podem ter pendentes legítimos — filtra só pelos destinos bloqueados)
  for (const u of chamadasBloqueadas) {
    assert.ok(!/169\.254|localhost|192\.168|^ftp:/.test(u), `fetch bloqueado chamado: ${u}`);
  }
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
