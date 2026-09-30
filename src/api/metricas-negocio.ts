import client from 'prom-client';
import { registro } from '../telemetria/metricas';

// Sem label: o identificador do pedido vai para o span e para o log, nunca para a metrica.
export const pedidosCriados = new client.Counter({
  name: 'pedidos_criados_total',
  help: 'Pedidos aceitos pela api e publicados na fila para processamento',
  registers: [registro],
});

// Serie nasce em zero na subida, antes do primeiro pedido.
pedidosCriados.inc(0);
