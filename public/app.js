const formAcesso = document.querySelector('#form-acesso');
const campoToken = document.querySelector('#token');
const mensagem = document.querySelector('#mensagem');
const conexao = document.querySelector('#conexao');
const painel = document.querySelector('#painel');
const botaoSair = document.querySelector('#sair');
const metricas = document.querySelector('#metricas');
const corpoEventos = document.querySelector('#eventos-corpo');
const vazio = document.querySelector('#vazio');
const botaoAtualizar = document.querySelector('#atualizar');

let token = sessionStorage.getItem('relay-token') || '';
let atualizando = false;
let intervalo;

function estadoConexao(texto, estado = '') {
  conexao.textContent = texto;
  conexao.dataset.estado = estado;
}

async function api(caminho, opcoes = {}) {
  const resposta = await fetch(caminho, {
    ...opcoes,
    headers: { ...opcoes.headers, Authorization: `Bearer ${token}` }
  });
  if (resposta.status === 401) {
    desconectar('Credencial inválida ou expirada.');
    throw new Error('Credencial inválida ou expirada.');
  }
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.erro?.mensagem || `Falha HTTP ${resposta.status}`);
  return dados;
}

function desconectar(aviso = '') {
  token = '';
  sessionStorage.removeItem('relay-token');
  campoToken.value = '';
  painel.hidden = true;
  botaoSair.hidden = true;
  estadoConexao('Aguardando credencial');
  mensagem.textContent = aviso;
  if (intervalo) clearInterval(intervalo);
}

function criarMetrica(valor, rotulo) {
  const cartao = document.createElement('article');
  cartao.className = 'm';
  const numero = document.createElement('strong');
  numero.textContent = String(valor);
  const legenda = document.createElement('span');
  legenda.textContent = rotulo;
  cartao.append(numero, legenda);
  return cartao;
}

function criarCelula(texto, classe = '') {
  const celula = document.createElement('td');
  celula.textContent = texto;
  if (classe) celula.className = classe;
  return celula;
}

function desenharEventos(eventos) {
  corpoEventos.replaceChildren();
  vazio.hidden = eventos.length > 0;

  for (const evento of eventos) {
    const linha = document.createElement('tr');
    linha.append(criarCelula(`${evento.id.slice(0, 12)}…`));
    linha.append(criarCelula(evento.destino, 'destino'));

    const status = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${evento.status}`;
    badge.textContent = evento.status;
    status.append(badge);
    linha.append(status, criarCelula(String(evento.tentativas)), criarCelula(evento.criado_em));

    const acao = document.createElement('td');
    if (evento.status === 'dlq') {
      const replay = document.createElement('button');
      replay.type = 'button';
      replay.textContent = 'Reenviar';
      replay.addEventListener('click', () => reenviar(evento.id, replay));
      acao.append(replay);
    } else {
      acao.textContent = '—';
    }
    linha.append(acao);
    corpoEventos.append(linha);
  }
}

async function atualizar() {
  if (!token || atualizando) return;
  atualizando = true;
  botaoAtualizar.disabled = true;
  try {
    const [dadosMetricas, eventos] = await Promise.all([
      api('/api/metricas'),
      api('/api/eventos')
    ]);
    metricas.replaceChildren(
      criarMetrica(dadosMetricas.total, 'eventos'),
      criarMetrica(dadosMetricas.entregues, 'entregues'),
      criarMetrica(dadosMetricas.pendentes, 'pendentes'),
      criarMetrica(dadosMetricas.processando || 0, 'em processamento'),
      criarMetrica(`${dadosMetricas.taxaEntrega.toFixed(1)}%`, 'taxa de entrega')
    );
    desenharEventos(eventos);
    painel.hidden = false;
    botaoSair.hidden = false;
    estadoConexao('Conectado', 'ok');
    mensagem.textContent = '';
  } catch (erro) {
    if (token) {
      estadoConexao('Falha ao atualizar', 'erro');
      mensagem.textContent = erro.message;
    }
  } finally {
    atualizando = false;
    botaoAtualizar.disabled = false;
  }
}

async function reenviar(id, botao) {
  botao.disabled = true;
  mensagem.textContent = '';
  try {
    await api(`/api/replay/${encodeURIComponent(id)}`, { method: 'POST' });
    await atualizar();
  } catch (erro) {
    mensagem.textContent = erro.message;
  } finally {
    botao.disabled = false;
  }
}

async function conectar(valor) {
  token = valor;
  sessionStorage.setItem('relay-token', token);
  mensagem.textContent = '';
  estadoConexao('Validando credencial');
  await atualizar();
  if (token && !intervalo) intervalo = setInterval(atualizar, 5_000);
}

formAcesso.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const valor = campoToken.value.trim();
  if (new TextEncoder().encode(valor).length < 32) {
    mensagem.textContent = 'O token precisa ter pelo menos 32 bytes.';
    return;
  }
  await conectar(valor);
});

botaoSair.addEventListener('click', () => desconectar());
botaoAtualizar.addEventListener('click', atualizar);

if (token) {
  campoToken.value = token;
  conectar(token);
}
