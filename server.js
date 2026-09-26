// Webhook Relay — servidor: ingestão + painel + worker de entrega.
import express from 'express';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarFila } from './src/fila.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3400;
const SEGREDO = process.env.RELAY_SECRET || 'relay-dev-secret';
const fila = criarFila(process.env.RELAY_DB || 'webhook-relay.db');

const app = express();
app.use(express.json());

// ingestão (idempotente por X-Event-Id opcional)
app.post('/ingest', (req, res) => {
  try {
    const idExterno = req.headers['x-event-id'];
    const r = fila.ingere({ destino: req.query.destino || req.body?.destino, payload: req.body, idExterno });
    res.status(r.duplicado ? 200 : 201).json(r);
  } catch (e) {
    res.status(400).json({ erro: { codigo: e.codigo || 'dados', mensagem: e.message } });
  }
});

// API do painel
app.get('/api/eventos', (req, res) => res.json(fila.listar(Number(req.query.limite) || 50)));
app.get('/api/metricas', (req, res) => res.json(fila.metricas()));
app.post('/api/replay/:id', (req, res) => res.json({ replay: fila.replay(req.params.id) }));

// estático (painel)
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/ingest') return next();
  try {
    let arquivo = normalize(join(ROOT, 'public', req.path));
    if (!arquivo.startsWith(ROOT)) throw new Error('fora');
    res.writeHead(200, { 'Content-Type': MIME[extname(arquivo)] || 'text/html; charset=utf-8' });
    res.end(await readFile(arquivo));
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(join(ROOT, 'public/index.html')));
  }
});

const server = http.createServer(app);
export { server, fila, SEGREDO };

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`Webhook Relay em http://localhost:${PORT} (ingest: POST /ingest?destino=<url>)`);
    // worker: entrega a cada 3s
    setInterval(() => fila.tentarEntregar({ segredo: SEGREDO }).catch(() => {}), 3000);
  });
}
