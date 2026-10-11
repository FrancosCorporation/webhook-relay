import { lookup as lookupDns } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

function hostnameDaUrl(url) {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function hostsPermitidos() {
  return (process.env.RELAY_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

export function validarDestino(destino, {
  permitirHttp = process.env.RELAY_ALLOW_HTTP === '1',
  allowedHosts = hostsPermitidos()
} = {}) {
  if (typeof destino !== 'string' || destino.length > 2_048) throw new Error('destino inválido');

  let url;
  try { url = new URL(destino); } catch { throw new Error('destino inválido'); }
  if (url.protocol !== 'https:' && !(permitirHttp && url.protocol === 'http:')) {
    throw new Error('destino deve usar HTTPS');
  }
  if (url.username || url.password) throw new Error('destino não pode conter credenciais');

  const host = hostnameDaUrl(url);
  if (!host || host === 'localhost' || host.endsWith('.localhost') ||
      ['.local', '.internal', '.lan', '.home', '.home.arpa'].some((suffix) => host.endsWith(suffix))) {
    throw new Error('destino interno bloqueado (SSRF)');
  }
  if (['metadata', 'metadata.google.internal', 'metadata.azure.internal', 'instance-data', 'instance-data.ec2.internal'].includes(host)) {
    throw new Error('destino de metadata bloqueado (SSRF)');
  }

  const allowlist = allowedHosts.map((item) => String(item).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  if (allowlist.length && !allowlist.includes(host)) throw new Error('destino fora de RELAY_ALLOWED_HOSTS');
  const family = isIP(host);
  if (family && !enderecoPublico(host)) throw new Error('destino de rede privada ou reservada bloqueado (SSRF)');

  url.hash = '';
  return url;
}

export function enderecoPublico(address) {
  const family = isIP(address);
  return family === 4 ? ipv4Publico(address) : family === 6 ? ipv6Publico(address) : false;
}

function ipv4Publico(address) {
  const octetos = address.split('.').map(Number);
  if (octetos.length !== 4 || octetos.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octetos;

  // Faixas não globais, reservadas, de documentação, benchmark ou multicast.
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && c === 0) || (b === 2 && c === 0) || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Palavras(address) {
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const fim = value.slice(value.lastIndexOf(':') + 1);
    const octetos = fim.split('.').map(Number);
    if (octetos.length !== 4 || octetos.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const duasPalavras = [((octetos[0] << 8) | octetos[1]).toString(16), ((octetos[2] << 8) | octetos[3]).toString(16)];
    value = `${value.slice(0, value.lastIndexOf(':'))}:${duasPalavras.join(':')}`;
  }

  const comprimido = value.includes('::');
  const [antes, depois] = value.split('::');
  const esquerda = antes ? antes.split(':') : [];
  const direita = depois ? depois.split(':') : [];
  const faltam = 8 - esquerda.length - direita.length;
  if (faltam < 0 || (comprimido ? faltam < 1 : faltam !== 0)) return null;
  const palavras = [...esquerda, ...Array(faltam).fill('0'), ...direita].map((item) => Number.parseInt(item || '0', 16));
  return palavras.length === 8 && palavras.every((item) => Number.isInteger(item) && item >= 0 && item <= 0xffff) ? palavras : null;
}

function ipv6Publico(address) {
  const palavras = ipv6Palavras(address);
  if (!palavras) return false;

  // IPv4-mapped IPv6 herda a política do endereço IPv4 representado.
  if (palavras.slice(0, 5).every((word) => word === 0) && palavras[5] === 0xffff) {
    const mapped = `${palavras[6] >> 8}.${palavras[6] & 255}.${palavras[7] >> 8}.${palavras[7] & 255}`;
    return ipv4Publico(mapped);
  }

  // Só aceita unicast global 2000::/3; isso exclui loopback, ULA, link-local,
  // multicast, endereços não especificados e formatos de transição conhecidos.
  if (palavras[0] < 0x2000 || palavras[0] >= 0x4000) return false;
  if (palavras[0] === 0x2001 && (palavras[1] <= 0x01ff || palavras[1] === 0x0db8)) return false;
  if (palavras[0] === 0x2002 || palavras[0] === 0x3fff) return false;
  return true;
}

export async function resolverDestinoPublico(destino, { lookup = lookupDns, signal } = {}) {
  const url = destino instanceof URL ? destino : validarDestino(destino);
  const hostname = hostnameDaUrl(url);
  const family = isIP(hostname);
  const resolucao = family
    ? Promise.resolve([{ address: hostname, family }])
    : lookup(hostname, { all: true, verbatim: true });
  let abortHandler;
  const cancelamento = signal && new Promise((_, reject) => {
    abortHandler = () => reject(new Error('Resolução cancelada por timeout.'));
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
  });

  let respostas;
  try { respostas = await (cancelamento ? Promise.race([resolucao, cancelamento]) : resolucao); }
  finally { if (abortHandler) signal.removeEventListener('abort', abortHandler); }

  if (!respostas.length || respostas.some(({ address }) => !enderecoPublico(address))) {
    throw new Error('O destino resolve para uma rede privada ou reservada (SSRF).');
  }
  return respostas;
}

export async function enviarWebhook(destino, { headers, body, signal } = {}) {
  const url = validarDestino(destino);
  const enderecos = await resolverDestinoPublico(url, { signal });
  if (signal?.aborted) throw new Error('Entrega cancelada por timeout.');

  const alvo = enderecos[0];
  const hostname = hostnameDaUrl(url);
  const enviar = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const options = {
    protocol: url.protocol,
    hostname,
    port: url.port || undefined,
    method: 'POST',
    path: `${url.pathname}${url.search}`,
    headers,
    signal,
    lookup: (_host, lookupOptions, callback) => {
      if (typeof lookupOptions === 'function') {
        callback = lookupOptions;
        lookupOptions = {};
      }
      if (lookupOptions?.all) callback(null, enderecos);
      else callback(null, alvo.address, alvo.family);
    }
  };
  if (url.protocol === 'https:' && !isIP(hostname)) options.servername = hostname;

  return new Promise((resolve, reject) => {
    const request = enviar(options, (response) => {
      const status = response.statusCode || 0;
      response.resume();
      response.once('end', () => resolve({ ok: status >= 200 && status < 300, status }));
    });
    request.once('error', reject);
    request.end(body);
  });
}
