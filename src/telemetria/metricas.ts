import client from 'prom-client';

export const registro = new client.Registry();

client.collectDefaultMetrics({ register: registro });

export const TIPO_DE_CONTEUDO = registro.contentType;

export function coletar(): Promise<string> {
  return registro.metrics();
}
