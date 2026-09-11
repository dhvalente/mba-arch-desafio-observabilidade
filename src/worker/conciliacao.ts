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
  } catch (erro) {
    registrarFalhaLegado(erro);
  }

  return recusado ? 'recusado' : 'confirmado';
}
