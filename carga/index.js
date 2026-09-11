'use strict';

const CENARIOS = ['normal', 'cenario-a'];

const cenario = process.argv[2] || 'normal';
const enderecoDaApi = process.env.API_URL || 'http://localhost:8080';

if (!CENARIOS.includes(cenario)) {
  console.log('cenario invalido: ' + cenario);
  console.log('use um destes: ' + CENARIOS.join(', '));
  process.exit(1);
}

const INTERVALO_DE_REQUISICAO = 200;
const INTERVALO_DO_RESUMO = 5000;
const TOTAL_DE_CLIENTES = 400;
const TOTAL_DE_PRODUTOS = 200;
const PROPORCAO_DO_GRUPO_B = 0.4;
const SEMENTE = 987654321;

const clientesDoGrupoA = [];
const clientesDoGrupoB = [];

for (let numero = 1; numero <= TOTAL_DE_CLIENTES; numero++) {
  const identificador = 'cli-' + String(numero).padStart(4, '0');
  if (numero % 10 === 7) {
    clientesDoGrupoB.push(identificador);
  } else {
    clientesDoGrupoA.push(identificador);
  }
}

function criarGerador(semente) {
  let estado = semente >>> 0;

  return () => {
    estado = (estado + 0x6d2b79f5) >>> 0;
    let valor = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    valor = (valor + Math.imul(valor ^ (valor >>> 7), 61 | valor)) ^ valor;
    return ((valor ^ (valor >>> 14)) >>> 0) / 4294967296;
  };
}

const gerar = criarGerador(SEMENTE);

function inteiroEntre(minimo, maximo) {
  return minimo + Math.floor(gerar() * (maximo - minimo + 1));
}

function escolher(lista) {
  return lista[inteiroEntre(0, lista.length - 1)];
}

const resumo = {
  enviadas: 0,
  respostas2xx: 0,
  respostas4xx: 0,
  respostas5xx: 0,
  erros: 0,
  porRota: {},
};

const pedidosCriados = [];

function registrar(rota, statusOuErro, duracao) {
  resumo.enviadas += 1;

  if (!resumo.porRota[rota]) {
    resumo.porRota[rota] = { chamadas: 0, tempoTotal: 0 };
  }
  resumo.porRota[rota].chamadas += 1;
  resumo.porRota[rota].tempoTotal += duracao;

  if (statusOuErro === 'erro') {
    resumo.erros += 1;
  } else if (statusOuErro >= 500) {
    resumo.respostas5xx += 1;
  } else if (statusOuErro >= 400) {
    resumo.respostas4xx += 1;
  } else {
    resumo.respostas2xx += 1;
  }
}

async function chamar(rota, caminho, opcoes) {
  const inicio = Date.now();

  try {
    const resposta = await fetch(enderecoDaApi + caminho, opcoes);
    const corpo = await resposta.json().catch(() => null);
    registrar(rota, resposta.status, Date.now() - inicio);
    return { status: resposta.status, corpo };
  } catch (erro) {
    registrar(rota, 'erro', Date.now() - inicio);
    return { status: 0, corpo: null };
  }
}

function montarPedido() {
  const usarGrupoB = cenario === 'cenario-a' && gerar() < PROPORCAO_DO_GRUPO_B;

  const clienteId = usarGrupoB
    ? escolher(clientesDoGrupoB)
    : escolher(clientesDoGrupoA);

  const quantidadeDeItens = inteiroEntre(1, 3);
  const itens = [];

  for (let indice = 0; indice < quantidadeDeItens; indice++) {
    itens.push({
      produto_id: inteiroEntre(1, TOTAL_DE_PRODUTOS),
      quantidade: inteiroEntre(1, 3),
    });
  }

  return { cliente_id: clienteId, itens };
}

async function criarPedido() {
  const resultado = await chamar('POST /pedidos', '/pedidos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(montarPedido()),
  });

  if (resultado.corpo && resultado.corpo.pedido_id) {
    pedidosCriados.push(resultado.corpo.pedido_id);
    if (pedidosCriados.length > 200) {
      pedidosCriados.shift();
    }
  }
}

async function passo() {
  const sorteio = gerar();

  if (sorteio < 0.4) {
    await criarPedido();
    return;
  }

  if (sorteio < 0.7) {
    await chamar('GET /produtos', '/produtos');
    return;
  }

  if (sorteio < 0.9) {
    await chamar('GET /produtos/:id', '/produtos/' + inteiroEntre(1, TOTAL_DE_PRODUTOS));
    return;
  }

  if (pedidosCriados.length === 0) {
    await chamar('GET /produtos', '/produtos');
    return;
  }

  await chamar('GET /pedidos/:id', '/pedidos/' + escolher(pedidosCriados));
}

function imprimirResumo() {
  const linhas = Object.keys(resumo.porRota)
    .sort()
    .map((rota) => {
      const dados = resumo.porRota[rota];
      const media = Math.round(dados.tempoTotal / dados.chamadas);
      return '  ' + rota + ': ' + dados.chamadas + ' chamadas, media ' + media + 'ms';
    });

  console.log('[' + cenario + '] enviadas=' + resumo.enviadas +
    ' 2xx=' + resumo.respostas2xx +
    ' 4xx=' + resumo.respostas4xx +
    ' 5xx=' + resumo.respostas5xx +
    ' erros=' + resumo.erros);
  linhas.forEach((linha) => console.log(linha));
}

console.log('gerando carga no cenario ' + cenario + ' contra ' + enderecoDaApi);
console.log('pressione Ctrl+C para parar');

const temporizadorDeRequisicoes = setInterval(() => {
  passo();
}, INTERVALO_DE_REQUISICAO);

const temporizadorDoResumo = setInterval(imprimirResumo, INTERVALO_DO_RESUMO);

function encerrar() {
  clearInterval(temporizadorDeRequisicoes);
  clearInterval(temporizadorDoResumo);

  console.log('');
  console.log('resumo final');
  imprimirResumo();

  process.exit(0);
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
