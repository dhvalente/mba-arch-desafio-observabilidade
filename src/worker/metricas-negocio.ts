import client from 'prom-client';
import { registro } from '../telemetria/metricas';

export const RESULTADOS_DE_COBRANCA = ['aprovada', 'recusada', 'falha'] as const;

export type ResultadoDeCobranca = (typeof RESULTADOS_DE_COBRANCA)[number];

export const pedidosConfirmados = new client.Counter({
  name: 'pedidos_confirmados_total',
  help: 'Pedidos que o worker gravou com status confirmado',
  registers: [registro],
});

export const cobrancasProcessadas = new client.Counter({
  name: 'cobrancas_processadas_total',
  help: 'Tentativas de cobranca no processador de pagamento, por resultado',
  labelNames: ['resultado'],
  registers: [registro],
});

// Todas as series nascem em zero na subida, inclusive cada valor de resultado.
// Serie que so aparece no primeiro evento some do grafico e quebra o alerta.
pedidosConfirmados.inc(0);
for (const resultado of RESULTADOS_DE_COBRANCA) {
  cobrancasProcessadas.inc({ resultado }, 0);
}
