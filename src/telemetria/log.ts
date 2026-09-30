import { context, createContextKey, isSpanContextValid, trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';

type Campos = Record<string, string | number | boolean | undefined>;

// Chave de contexto que carrega o pedido em processamento. Toda linha escrita
// dentro de comPedido() herda o pedido_id sem precisar repassar o identificador.
const CHAVE_DO_PEDIDO = createContextKey('loja.pedido_id');

export function comPedido<T>(pedidoId: number, funcao: () => T): T {
  return context.with(context.active().setValue(CHAVE_DO_PEDIDO, pedidoId), funcao);
}

function identificadoresDoTrace(): { trace_id: string; span_id: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();

  if (!spanContext || !isSpanContextValid(spanContext)) {
    return { trace_id: '', span_id: '' };
  }

  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

function escrever(level: Nivel, msg: string, campos: Campos = {}): void {
  const pedidoDoContexto = context.active().getValue(CHAVE_DO_PEDIDO) as number | undefined;

  const linha = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
    ...identificadoresDoTrace(),
    ...(pedidoDoContexto !== undefined ? { pedido_id: pedidoDoContexto } : {}),
    ...campos,
  };

  process.stdout.write(JSON.stringify(linha) + '\n');
}

export const log = {
  info(msg: string, campos?: Campos): void {
    escrever('info', msg, campos);
  },
  warn(msg: string, campos?: Campos): void {
    escrever('warn', msg, campos);
  },
  error(msg: string, campos?: Campos): void {
    escrever('error', msg, campos);
  },
};
