type OcorrenciaLegada = {
  em: string;
  origem: string;
  detalhe: string;
};

const LIMITE_DE_OCORRENCIAS = 500;

const ocorrencias: OcorrenciaLegada[] = [];

export function registrarFalhaLegado(erro: unknown, origem = 'pagamento'): void {
  const detalhe = erro instanceof Error ? erro.message : String(erro);

  ocorrencias.push({
    em: new Date().toISOString(),
    origem,
    detalhe,
  });

  if (ocorrencias.length > LIMITE_DE_OCORRENCIAS) {
    ocorrencias.shift();
  }
}

export function ocorrenciasLegadas(): OcorrenciaLegada[] {
  return ocorrencias.slice();
}
