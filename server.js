// Webhook Relay — servidor: ingestão autenticada + painel + worker de entrega.
import express from 'express';
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarFila } from './src/fila.js';
import { validarDestino } from './src/destino.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_ROOT = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 3400);
const HOST = process.env.HOST || '127.0.0.1';
const SEGREDO = process.env.RELAY_SECRET || (process.env.NODE_ENV === 'test' ? 'test-only-relay-secret-for-unit-tests' : '');
if (Buffer.byteLength(SEGREDO, 'utf8') < 32) {
  throw new Error('RELAY_SECRET ausente ou curto — defina um segredo com pelo menos 32 bytes.');
}

const fila = criarFila(process.env.RELAY_DB || 'webhook-relay.db');
const app = express();
const limites = new Map();
const JANELA_RATE_LIMIT_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 120;

app.disable('x-powered-by');
app.set('trust proxy', process.env.RELAY_TRUST_PROXY === '1' ? 1 : false);
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store'
  });
  next();
});

function respostaIgual(a, b) {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function autenticar(req, res, next) {
  const cabecalho = req.get('authorization') || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : '';
  if (!respostaIgual(token, SEGREDO)) {
    return res.status(401).json({ erro: { codigo: 'auth', mensagem: 'Credencial inválida ou ausente.' } });
  }
  next();
}

function limitarRequisicoes(req, res, next) {
  const agora = Date.now();
  const chave = req.ip || req.socket.remoteAddress || 'desconhecido';
  let estado = limites.get(chave);
  if (!estado || agora - estado.inicio >= JANELA_RATE_LIMIT_MS) {
    estado = { inicio: agora, quantidade: 0 };
    limites.set(chave, estado);
  }
  estado.quantidade += 1;
  if (estado.quantidade > MAX_REQUESTS_PER_WINDOW) {
    res.set('Retry-After', String(Math.ceil((estado.inicio + JANELA_RATE_LIMIT_MS - agora) / 1000)));
    return res.status(429).json({ erro: { codigo: 'limite', mensagem: 'Muitas requisições; tente novamente em instantes.' } });
  }
  if (limites.size > 10_000) {
    for (const [ip, item] of limites) {
      if (agora - item.inicio >= JANELA_RATE_LIMIT_MS) limites.delete(ip);
    }
    while (limites.size > 10_000) limites.delete(limites.keys().next().value);
  }
  next();
}

export function destinoPermitido(destino) {
  try { validarDestino(destino); return true; } catch { return false; }
}

// O token é validado antes do parser para não aceitar JSON grande de clientes anônimos.
app.post('/ingest', limitarRequisicoes, autenticar, express.json({ limit: '1mb', strict: true }), (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ erro: { codigo: 'dados', mensagem: 'O corpo deve ser um objeto JSON.' } });
    }
    const { destino, ...campos } = req.body;
    try { validarDestino(destino); }
    catch (erro) { return res.status(400).json({ erro: { codigo: 'destino', mensagem: erro.message } }); }

    const payload = Object.hasOwn(campos, 'payload')
      ? campos.payload
      : campos;
    const r = fila.ingere({ destino, payload, idExterno: req.get('x-event-id') });
    res.status(r.duplicado ? 200 : 201).json(r);
  } catch (erro) {
    const status = erro.codigo === 'conflito' ? 409 : erro.codigo === 'limite' ? 413 : 400;
    res.status(status).json({ erro: { codigo: erro.codigo || 'dados', mensagem: erro.message } });
  }
});

// Todas as operações administrativas exigem o mesmo token Bearer.
app.use('/api', limitarRequisicoes, autenticar);
app.get('/api/eventos', (req, res) => {
  const solicitado = Number.parseInt(req.query.limite, 10);
  const limite = Number.isFinite(solicitado) ? solicitado : 50;
  res.json(fila.listar(limite));
});
app.get('/api/metricas', (_req, res) => res.json(fila.metricas()));
app.post('/api/replay/:id', (req, res) => {
  const replay = fila.replay(req.params.id, req.ip || '');
  if (!replay) return res.status(409).json({ erro: { codigo: 'replay', mensagem: 'Evento indisponível ou limite de replays atingido.' } });
  res.json({ replay: true });
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/ingest') return next();
  try {
    const caminho = decodeURIComponent(req.path);
    const relativo = caminho === '/' ? 'index.html' : normalize(caminho).replace(/^[/\\]+/, '');
    const arquivo = resolve(PUBLIC_ROOT, relativo);
    if (arquivo !== PUBLIC_ROOT && !arquivo.startsWith(`${PUBLIC_ROOT}${sep}`)) return res.sendStatus(404);
    const conteudo = await readFile(arquivo);
    return res.type(MIME[extname(arquivo).toLowerCase()] || 'application/octet-stream').send(conteudo);
  } catch (erro) {
    if (erro.code === 'ENOENT' || erro instanceof URIError) return res.sendStatus(404);
    return next(erro);
  }
});

app.use((erro, _req, res, next) => {
  if (res.headersSent) return next(erro);
  if (erro.type === 'entity.too.large') {
    return res.status(413).json({ erro: { codigo: 'limite', mensagem: 'O corpo excede o limite de 1 MB.' } });
  }
  if (erro.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: { codigo: 'json', mensagem: 'JSON inválido.' } });
  }
  return res.status(500).json({ erro: { codigo: 'interno', mensagem: 'Falha interna no relay.' } });
});

const server = http.createServer(app);
export { server, fila, SEGREDO };

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => {
    console.log(`Webhook Relay em http://${HOST}:${PORT} (ingest: POST /ingest)`);
  });

  let workerAtivo = false;
  const worker = setInterval(async () => {
    if (workerAtivo) return;
    workerAtivo = true;
    try { await fila.tentarEntregar({ segredo: SEGREDO }); }
    catch (erro) { console.error(`Falha no worker: ${erro.message}`); }
    finally { workerAtivo = false; }
  }, 3_000);
  worker.unref();
}
