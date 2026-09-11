import { migrar } from '../src/db/migracao';
import { esperarBanco, fecharPool, pool } from '../src/db/pool';
import { log } from '../src/telemetria/log';

const TOTAL_PRODUTOS = 200;
const TOTAL_PEDIDOS = 24;
const TOTAL_CLIENTES = 400;
const DIAS_DE_HISTORICO = 7;
const SEMENTE = 20240101;

const TIPOS = [
  'Cadeira',
  'Mesa',
  'Luminaria',
  'Estante',
  'Poltrona',
  'Tapete',
  'Espelho',
  'Banqueta',
  'Aparador',
  'Sofa',
];

const LINHAS = [
  'Alto Alegre',
  'Bela Vista',
  'Campo Novo',
  'Dom Pedro',
  'Estancia',
  'Farroupilha',
  'Guarani',
  'Horizonte',
  'Ipiranga',
  'Jacaranda',
  'Kalunga',
  'Laranjeiras',
  'Morumbi',
  'Nazare',
  'Olinda',
  'Paineiras',
  'Quitandinha',
  'Recanto',
  'Serrano',
  'Tijuca',
];

function criarGerador(semente: number): () => number {
  let estado = semente >>> 0;

  return () => {
    estado = (estado + 0x6d2b79f5) >>> 0;
    let valor = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    valor = (valor + Math.imul(valor ^ (valor >>> 7), 61 | valor)) ^ valor;
    return ((valor ^ (valor >>> 14)) >>> 0) / 4294967296;
  };
}

function inteiroEntre(gerar: () => number, minimo: number, maximo: number): number {
  return minimo + Math.floor(gerar() * (maximo - minimo + 1));
}

function nomeDoProduto(indice: number): string {
  const tipo = TIPOS[indice % TIPOS.length];
  const linha = LINHAS[Math.floor(indice / TIPOS.length) % LINHAS.length];
  return tipo + ' ' + linha;
}

function identificadorDeCliente(numero: number): string {
  return 'cli-' + String(numero).padStart(4, '0');
}

// O defeito estudado no desafio confirma pedidos de clientes cujo identificador
// termina em 7. Nenhum pedido historico pode nascer com essa assinatura, senao ele
// vira um sosia do incidente no banco: o aluno consulta por ela, encontra pedido
// que nunca passou pelo worker e conclui que o problema existe ha uma semana.
function desviarDoFinalSete(numero: number): number {
  return numero % 10 === 7 ? (numero % TOTAL_CLIENTES) + 1 : numero;
}

async function jaFoiCarregado(): Promise<boolean> {
  const produtos = await pool.query('SELECT count(*)::int AS total FROM produtos');
  const pedidos = await pool.query('SELECT count(*)::int AS total FROM pedidos');

  return produtos.rows[0].total >= TOTAL_PRODUTOS && pedidos.rows[0].total > 0;
}

async function carregarProdutos(gerar: () => number): Promise<number[]> {
  const ids: number[] = [];
  const nomes: string[] = [];
  const precos: number[] = [];

  for (let indice = 0; indice < TOTAL_PRODUTOS; indice++) {
    ids.push(indice + 1);
    nomes.push(nomeDoProduto(indice));
    precos.push(inteiroEntre(gerar, 990, 49990) / 100);
  }

  await pool.query(
    `INSERT INTO produtos (id, nome, preco)
     SELECT * FROM unnest($1::int[], $2::text[], $3::numeric[])`,
    [ids, nomes, precos]
  );

  await pool.query("SELECT setval('produtos_id_seq', $1)", [TOTAL_PRODUTOS]);

  return precos;
}

async function carregarPedidos(gerar: () => number, precos: number[]): Promise<number> {
  const agora = Date.now();
  const janela = DIAS_DE_HISTORICO * 24 * 60 * 60 * 1000;

  const pedidosIds: number[] = [];
  const pedidosClientes: string[] = [];
  const pedidosStatus: string[] = [];
  const pedidosValores: number[] = [];
  const pedidosDatas: Date[] = [];

  const itensPedidoIds: number[] = [];
  const itensProdutoIds: number[] = [];
  const itensQuantidades: number[] = [];
  const itensPrecos: number[] = [];

  for (let pedidoId = 1; pedidoId <= TOTAL_PEDIDOS; pedidoId++) {
    const sorteioDeStatus = gerar();
    const status =
      sorteioDeStatus < 0.85 ? 'confirmado' : sorteioDeStatus < 0.97 ? 'recusado' : 'pendente';

    const quantidadeDeItens = inteiroEntre(gerar, 1, 4);
    let valorTotal = 0;

    for (let item = 0; item < quantidadeDeItens; item++) {
      const produtoId = inteiroEntre(gerar, 1, TOTAL_PRODUTOS);
      const quantidade = inteiroEntre(gerar, 1, 5);
      const preco = precos[produtoId - 1];

      itensPedidoIds.push(pedidoId);
      itensProdutoIds.push(produtoId);
      itensQuantidades.push(quantidade);
      itensPrecos.push(preco);

      valorTotal += preco * quantidade;
    }

    const numeroDoCliente = inteiroEntre(gerar, 1, TOTAL_CLIENTES);

    pedidosIds.push(pedidoId);
    pedidosClientes.push(
      identificadorDeCliente(
        status === 'confirmado' ? desviarDoFinalSete(numeroDoCliente) : numeroDoCliente
      )
    );
    pedidosStatus.push(status);
    pedidosValores.push(Math.round(valorTotal * 100) / 100);
    pedidosDatas.push(new Date(agora - Math.floor(gerar() * janela)));
  }

  await pool.query(
    `INSERT INTO pedidos (id, cliente_id, status, valor_total, criado_em)
     SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::numeric[], $5::timestamptz[])`,
    [pedidosIds, pedidosClientes, pedidosStatus, pedidosValores, pedidosDatas]
  );

  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, preco_unitario)
     SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::numeric[])`,
    [itensPedidoIds, itensProdutoIds, itensQuantidades, itensPrecos]
  );

  await pool.query("SELECT setval('pedidos_id_seq', $1)", [TOTAL_PEDIDOS]);

  return itensPedidoIds.length;
}

async function executar(): Promise<void> {
  await esperarBanco();
  await migrar();

  if (await jaFoiCarregado()) {
    log.info('seed ja aplicado, nada a fazer');
    return;
  }

  await pool.query('TRUNCATE pedido_itens, pedidos, produtos RESTART IDENTITY');

  const gerar = criarGerador(SEMENTE);
  const precos = await carregarProdutos(gerar);
  const totalDeItens = await carregarPedidos(gerar, precos);

  log.info(
    'seed aplicado com ' +
      TOTAL_PRODUTOS +
      ' produtos, ' +
      TOTAL_PEDIDOS +
      ' pedidos e ' +
      totalDeItens +
      ' itens'
  );
}

executar()
  .then(async () => {
    await fecharPool();
    process.exit(0);
  })
  .catch(async (erro) => {
    log.error('seed nao pode ser aplicado: ' + erro.message);
    await fecharPool();
    process.exit(1);
  });
