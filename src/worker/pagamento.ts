export type ResultadoPagamento = {
  aprovado: boolean;
  autorizacao: string;
};

function aguardar(milissegundos: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, milissegundos));
}

function latenciaSimulada(clienteId: string): number {
  let soma = 0;
  for (const caractere of clienteId) {
    soma += caractere.charCodeAt(0);
  }
  return 30 + (soma % 21);
}

export async function processarPagamento(
  clienteId: string,
  valorTotal: number
): Promise<ResultadoPagamento> {
  await aguardar(latenciaSimulada(clienteId));

  const ultimoDigito = Number(clienteId.slice(-1));

  if (ultimoDigito === 3) {
    return { aprovado: false, autorizacao: '' };
  }

  if (ultimoDigito === 7) {
    throw new Error('gateway respondeu de forma inesperada');
  }

  return {
    aprovado: true,
    autorizacao: 'aut-' + clienteId + '-' + Math.round(valorTotal * 100),
  };
}
