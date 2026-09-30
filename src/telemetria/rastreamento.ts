import { SpanStatusCode, trace } from '@opentelemetry/api';
import { log } from './log';

export const tracer = trace.getTracer('loja-pedidos');

type Campos = Record<string, string | number | boolean | undefined>;

// Conta uma excecao capturada: registra no span ativo, marca o span como erro e
// escreve uma linha de log de nivel error com o motivo. Nao decide o fluxo: quem
// chama continua responsavel por relancar ou seguir, exatamente como antes.
export function registrarExcecao(erro: unknown, contexto: string, campos: Campos = {}): void {
  const motivo = erro instanceof Error ? erro.message : String(erro);
  const span = trace.getActiveSpan();

  if (span) {
    span.recordException(erro instanceof Error ? erro : new Error(motivo));
    span.setStatus({ code: SpanStatusCode.ERROR, message: contexto + ': ' + motivo });
  }

  log.error(contexto + ': ' + motivo, { ...campos, motivo });
}
