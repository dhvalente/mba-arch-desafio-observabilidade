import { trace } from '@opentelemetry/api';
import { registrarExcecao } from '../telemetria/rastreamento';
import { cobrancasProcessadas } from './metricas-negocio';
import { processarPagamento } from './pagamento';
import { registrarFalhaLegado } from './registro-legado';

export type StatusDoPedido = 'confirmado' | 'recusado';

export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
    const resultadoDaCobranca = resultado.aprovado ? 'aprovada' : 'recusada';
    cobrancasProcessadas.inc({ resultado: resultadoDaCobranca });
    trace.getActiveSpan()?.setAttributes({
      'pagamento.resultado': resultadoDaCobranca,
      'pagamento.autorizacao': resultado.autorizacao,
    });
  } catch (erro) {
    registrarFalhaLegado(erro);
    cobrancasProcessadas.inc({ resultado: 'falha' });
    trace.getActiveSpan()?.setAttribute('pagamento.resultado', 'falha');
    registrarExcecao(erro, 'falha ao processar pagamento', {
      cliente_id: clienteId,
      valor_total: valorTotal,
    });
  }

  return recusado ? 'recusado' : 'confirmado';
}
