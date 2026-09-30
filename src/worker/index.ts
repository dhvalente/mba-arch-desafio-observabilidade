import http from 'node:http';
import { ROOT_CONTEXT, SpanKind, propagation } from '@opentelemetry/api';
import { atualizarStatusPedido } from '../db/consultas';
import { esperarBanco, fecharPool } from '../db/pool';
import { migrar } from '../db/migracao';
import {
  NOME_DA_FILA,
  consumirPedido,
  criarConexaoRedis,
  type ContextoDeTrace,
} from '../fila/fila';
import { comPedido, log } from '../telemetria/log';
import { TIPO_DE_CONTEUDO, coletar } from '../telemetria/metricas';
import { registrarExcecao, tracer } from '../telemetria/rastreamento';
import { decidirStatusDoPedido } from './conciliacao';
import { pedidosConfirmados } from './metricas-negocio';

const porta = Number(process.env.WORKER_PORT ?? process.env.PORT ?? 8081);

let rodando = true;

function iniciarServidorDeSaude(): http.Server {
  const servidor = http.createServer(async (requisicao, resposta) => {
    if (requisicao.url === '/health') {
      resposta.writeHead(200, { 'content-type': 'application/json' });
      resposta.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (requisicao.url === '/metrics') {
      resposta.writeHead(200, { 'content-type': TIPO_DE_CONTEUDO });
      resposta.end(await coletar());
      return;
    }

    resposta.writeHead(404, { 'content-type': 'application/json' });
    resposta.end(JSON.stringify({ erro: 'rota nao encontrada' }));
  });

  servidor.listen(porta, () => {
    log.info('worker ouvindo na porta ' + porta);
  });

  return servidor;
}

async function processarMensagem(mensagem: Record<string, unknown>): Promise<void> {
  const pedidoId = Number(mensagem.pedido_id);
  const clienteId = String(mensagem.cliente_id);
  const valorTotal = Number(mensagem.valor_total);

  // Continua o trace de quem publicou. A base e o contexto raiz, nao o ativo do
  // worker: assim o span nasce filho do pedido.criar, e nao de algo local.
  const contextoDoProdutor = propagation.extract(
    ROOT_CONTEXT,
    (mensagem.contexto_trace ?? {}) as ContextoDeTrace
  );

  const atributos = {
    'pedido.id': pedidoId,
    'cliente.id': clienteId,
    'pedido.valor_total': valorTotal,
    'messaging.system': 'redis',
    'messaging.destination.name': NOME_DA_FILA,
    'messaging.operation.type': 'process',
  };

  await tracer.startActiveSpan(
    'pedido.processar',
    { kind: SpanKind.CONSUMER, attributes: atributos },
    contextoDoProdutor,
    (span) =>
      comPedido(pedidoId, async () => {
        try {
          log.info('mensagem do pedido ' + pedidoId + ' recebida da fila', {
            cliente_id: clienteId,
            valor_total: valorTotal,
          });

          const status = await decidirStatusDoPedido(clienteId, valorTotal);
          await atualizarStatusPedido(pedidoId, status);
          span.setAttribute('pedido.status', status);
          if (status === 'confirmado') {
            pedidosConfirmados.inc();
          }

          log.info('pedido ' + pedidoId + ' ficou ' + status, {
            status,
            cliente_id: clienteId,
            valor_total: valorTotal,
          });
        } catch (erro) {
          registrarExcecao(erro, 'erro ao processar pedido');
          throw erro;
        } finally {
          span.end();
        }
      })
  );
}

async function iniciar(): Promise<void> {
  await esperarBanco();
  await migrar();

  const redis = criarConexaoRedis();
  const servidor = iniciarServidorDeSaude();

  const encerrar = () => {
    rodando = false;
    servidor.close(async () => {
      redis.disconnect();
      await fecharPool();
      process.exit(0);
    });
  };

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  log.info('worker consumindo a fila de pedidos');

  while (rodando) {
    try {
      const mensagem = await consumirPedido(redis);

      if (mensagem) {
        await processarMensagem(mensagem);
      }
    } catch (erro) {
      registrarExcecao(erro, 'erro ao ler a fila');
      await new Promise((resolver) => setTimeout(resolver, 1000));
    }
  }
}

iniciar().catch((erro) => {
  log.error('worker nao conseguiu iniciar: ' + erro.message);
  process.exit(1);
});
