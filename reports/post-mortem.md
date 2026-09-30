# Post-mortem: pedidos confirmados sem cobrança

| | |
| --- | --- |
| Status | Causa raiz identificada; correção definitiva planejada, não executada (ver Itens de ação) |
| Severidade | Alta: perda financeira direta, invisível ao cliente e ao monitoramento existente |
| Período reproduzido | 2026-09-30 22:53:08 → 22:56:40 UTC (3 min 32 s de `cenario-a`, precedidos de 3 min 24 s de tráfego `normal`) |

## Resumo

Quando o processador de pagamento falha em vez de aprovar ou recusar, o worker registra a falha num buffer em memória que ninguém lê e grava o pedido como **confirmado**, sem que nenhuma cobrança tenha acontecido. Para o cliente e para o monitoramento HTTP tudo é sucesso (202 na criação, pedido confirmado na consulta), e por isso o problema só apareceu no fechamento do mês. Na reprodução, 41% das cobranças falharam e todos esses pedidos foram entregues como confirmados: 158 pedidos, R$ 146.429,22.

## Impacto

No período reproduzido (3 min 32 s de `cenario-a`):

| Número | Valor | Origem | Precisão |
| --- | --- | --- | --- |
| Cobranças com falha | **158** | Contador `cobrancas_processadas_total{resultado="falha"}`: valor bruto no fim do período (158) menos no início (0), lido no Prometheus | Exato: o worker não reiniciou no período e o contador estava em 0 antes do `cenario-a` |
| Cobranças com falha (estimativa) | 159,2 | `increase(cobrancas_processadas_total{resultado="falha"}[242s])` às 22:57:10 | Estimativa: o `increase()` extrapola as bordas da janela, daí a diferença de ~1 pedido para a contagem exata |
| Pedidos confirmados sem cobrança | **158** | Log do worker: 158 linhas `error` "falha ao processar pagamento", 158 `pedido_id` distintos, e para cada um a linha "ficou confirmado" com o mesmo `trace_id` | Exato |
| Confirmação cruzada no banco | 158 pedidos, todos `confirmado` | `SELECT status, count(*), sum(valor_total) FROM pedidos WHERE id IN (<158 ids do log>) GROUP BY status` | Exato |
| **Valor envolvido** | **R$ 146.429,22** | Soma de `valor_total` das 158 linhas de erro do log, conferida no banco pela mesma consulta acima (mesma soma) | Exato |
| Proporção | 158 de 384 cobranças (41%); R$ 146.429,22 de R$ 346.473,00 confirmados no período (42%) | Contadores (384 = 200 aprovadas + 26 recusadas + 158 falhas) e banco (`id > 445`, 350 confirmados) | A diferença entre 384 cobranças nos contadores e 376 pedidos no banco vem de ~8 pedidos do tráfego normal processados entre a última coleta antes do `cenario-a` (até 15 s antes) e o início dele |

**O que a métrica responde e o que não responde:** as métricas dizem **quantos** pedidos foram afetados (158, e a diferença `pedidos_confirmados_total − cobrancas_processadas_total{resultado="aprovada"}` mostra o mesmo número), mas não **quanto dinheiro**. Valor em reais não pode ser label (cardinalidade) e um contador de valor não existe hoje. O valor só sai do log (campo `valor_total`, ligado ao `pedido_id`) e do banco.

Nenhum erro chegou ao cliente: das 1.170 requisições HTTP estimadas no período, 100% foram 2xx (782 × 200 e 388 × 202, com zero 5xx). Os 39 clientes afetados receberam o produto como confirmado.

## Detecção

**Como foi descoberto hoje:** pelo financeiro, no fechamento do mês, cruzando pedidos confirmados com o dinheiro que entrou. Ninguém em engenharia percebeu: o Grafana só mostrava tráfego HTTP, que estava 100% 2xx; o log dizia apenas "pedido N ficou confirmado"; a falha ia para `registrarFalhaLegado()`, um array em memória que nenhum processo lê. O tempo até detectar foi de até um mês, e a hipótese que circulou ("problema do banco") era palpite.

**Quanto tempo o alerta leva, medido na reprodução:**

| Marco | Horário (UTC) | Desde o início do `cenario-a` |
| --- | --- | --- |
| `cenario-a` iniciado (após 3 min 24 s de `normal`) | 22:53:08 | 0 s |
| Primeira falha de cobrança no log | 22:53:09.250 | +1 s |
| `FalhaEmCobrancas` em `pending` no Prometheus | 22:55:27 | +139 s |
| `FalhaEmCobrancas` no log do `receptor-alertas` (`status=firing`) | 22:56:25.923 | **+198 s (3 min 18 s)** |

Dos 3 min 18 s, cerca de 2 minutos são a proporção na janela `rate(...[5m])` diluindo os 5 minutos de tráfego saudável anteriores até cruzar 14,4%. O restante é a coleta e a avaliação (15 s cada), o `for: 1m` e o `group_wait` de 10 s do Alertmanager. Com o sistema já em falha, sem tráfego limpo na janela, o piso é o `for` mais ~40 s.

**O que a diferença significa:** de até ~30 dias para ~3 minutos. Na reprodução, cada minuto de falha custou em média ~45 pedidos e ~R$ 41 mil. Detectar no fechamento do mês significa descobrir depois que o dinheiro já não pode ser recuperado sem ir atrás de cada cliente. Detectar em 3 minutos limita o prejuízo a algumas centenas de pedidos, que ainda estão antes do envio e podem ser recobrados. A diferença não veio de monitorar melhor o HTTP, e sim de o código passar a contar o que ele já sabia: que a cobrança falhou.

## Causa raiz

**Arquivo:** `src/worker/conciliacao.ts`
**Função:** `decidirStatusDoPedido`

Código original (antes da instrumentação; a instrumentação acrescentou métricas, span e log no `catch`, sem mudar o fluxo):

```ts
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
```

O status é decidido por uma única flag booleana, `recusado`, que começa `false` e só vira `true` quando o processador responde com recusa. Quando `processarPagamento` **lança** exceção (o gateway "respondeu de forma inesperada"), o `catch` engole o erro, registra em `registrarFalhaLegado` (array em memória de 500 posições, sem leitor) e a flag continua `false`: o pedido cai no `'confirmado'`. A função trata "não sei se cobrei" como "cobrei". Faltava um terceiro estado, e a falha era silenciosa por construção.

O gatilho na reprodução foi o processador lançar exceção para um grupo de clientes: a telemetria mostra que as 158 falhas vieram de 39 clientes distintos, todos com identificador terminado em 7, sempre com o motivo "gateway respondeu de forma inesperada". O gatilho, porém, é secundário: qualquer exceção do processador, por qualquer motivo, produz o mesmo pedido confirmado sem cobrança.

## Evidências

**1. Trace no Jaeger:** `28447bc03fa7ed6563c146e89218c59c` (http://localhost:16686/trace/28447bc03fa7ed6563c146e89218c59c)

Trace único com api e worker: `POST /pedidos` → `pedido.criar` (api) → `lpush` → `pedido.processar` (worker, filho de `pedido.criar` pela propagação da fila) → `UPDATE`. O span `pedido.processar` traz:

```
pedido.id=446  cliente.id=cli-0367  pedido.valor_total=1108.31
pagamento.resultado=falha
pedido.status=confirmado            <- confirmado apesar da falha
otel.status_code=ERROR  otel.status_description="falha ao processar pagamento: gateway respondeu de forma inesperada"
evento exception: "Error: gateway respondeu de forma inesperada at processarPagamento (/app/src/worker/pagamento.ts...)"
```

Busca no Jaeger por service `worker`, operação `pedido.processar` e tags `error=true pedido.status=confirmado` (últimos 15 min, durante a reprodução): 17 traces já no primeiro minuto do cenário. Cada um é um pedido confirmado com a cobrança em erro.

**2. PromQL:**

```promql
sum(increase(pedidos_confirmados_total[242s]))
  - sum(increase(cobrancas_processadas_total{resultado="aprovada"}[242s]))
```

Resultado às 22:57:10: `159.19`, que são pedidos confirmados sem cobrança aprovada. Em operação correta esse número é 0: no tráfego normal anterior, confirmados = aprovadas = 379. A mesma leitura por resultado, `sum by (resultado) (increase(cobrancas_processadas_total[242s]))`, deu `aprovada=198.99  recusada=25.81  falha=159.19`, e os valores brutos dos contadores deram `falha` de 0 → 158 no período. O SLI de falha (`rate[5m]`) chegou a 31,2% no pico, contra o limiar de 14,4%.

**3. Busca no log:**

```bash
docker compose logs api worker | grep 28447bc03fa7ed6563c146e89218c59c
```

Resultado, com as linhas dos dois processos no mesmo trace:

```
api-1    | {"timestamp":"2026-09-30T22:53:09.200Z","level":"info","service":"api","msg":"pedido 446 criado para cli-0367","trace_id":"28447bc03fa7ed6563c146e89218c59c","span_id":"7a588ce5edee9c6f","pedido_id":446,"cliente_id":"cli-0367","valor_total":1108.31}
worker-1 | {"timestamp":"2026-09-30T22:53:09.200Z","level":"info","service":"worker","msg":"mensagem do pedido 446 recebida da fila","trace_id":"28447bc03fa7ed6563c146e89218c59c","span_id":"f5dfe3940686ee72","pedido_id":446,...}
worker-1 | {"timestamp":"2026-09-30T22:53:09.250Z","level":"error","service":"worker","msg":"falha ao processar pagamento: gateway respondeu de forma inesperada","trace_id":"28447bc03fa7ed6563c146e89218c59c","span_id":"f5dfe3940686ee72","pedido_id":446,"cliente_id":"cli-0367","valor_total":1108.31,"motivo":"gateway respondeu de forma inesperada"}
worker-1 | {"timestamp":"2026-09-30T22:53:09.252Z","level":"info","service":"worker","msg":"pedido 446 ficou confirmado","trace_id":"28447bc03fa7ed6563c146e89218c59c","span_id":"f5dfe3940686ee72","pedido_id":446,"status":"confirmado",...}
```

Uma linha `error` de falha de pagamento seguida, 2 ms depois e no mesmo span, de "ficou confirmado". Para o período inteiro:

```bash
docker compose logs worker --no-log-prefix --since 2026-09-30T22:53:00Z --until 2026-09-30T22:57:10Z \
  | grep '"msg":"falha ao processar pagamento'
```

Resultado: 158 linhas, 158 `pedido_id` distintos, soma de `valor_total` = R$ 146.429,22. Cruzando pelo `trace_id`, as 158 têm uma linha "ficou confirmado" correspondente.

## Lições aprendidas

**O que correu bem**

- Com log e trace ligados pelo `trace_id` e o contexto atravessando a fila, a primeira linha `error` levou direto ao trace completo do pedido, da criação na api ao `UPDATE` no worker, sem nenhuma busca manual por horário.
- As métricas de negócio levantaram a pergunta certa sozinhas: `pedidos_confirmados_total` descolando de `cobrancas_processadas_total{resultado="aprovada"}` é um sinal que não depende de saber a causa.
- Três fontes independentes (contador, log e banco) chegaram ao mesmo número, 158, o que dá confiança no impacto informado ao financeiro.
- O alerta, derivado do SLO e não de um número escolhido no olho, disparou em 3 min 18 s e ficou em silêncio no tráfego normal.

**O que correu mal**

- A falha de cobrança existia no código como informação (o `catch` sabia) e não saía do processo: ia para um buffer em memória sem leitor, sem log, sem métrica e sem span.
- O monitoramento era só de caixa preta. Disponibilidade e latência HTTP estavam perfeitas durante todo o incidente, e isso foi lido como "o sistema está bem".
- Na ausência de dados, a hipótese que circulou ("deve ser o banco") não tinha como ser confirmada nem descartada.
- O contexto de trace não atravessava a fila, então mesmo com Jaeger não era possível ir do pedido à sua cobrança.

**Onde tivemos sorte**

- O financeiro faz conciliação mensal. Sem ela, o prejuízo continuaria acumulando sem prazo.
- O gatilho afetou um grupo delimitado de clientes, com uma assinatura clara (mesmo motivo de erro, mesmo final de identificador), o que facilitou dimensionar o impacto. Uma falha intermitente e aleatória do gateway teria o mesmo efeito, e seria bem mais difícil de enxergar sem a instrumentação.
- O `valor_total` estava disponível na mensagem da fila e pôde ser posto no log; sem ele, o valor do prejuízo dependeria só do banco.

## Itens de ação

| Ação | Tipo | Prioridade |
| --- | --- | --- |
| Corrigir `decidirStatusDoPedido` em `src/worker/conciliacao.ts` para tratar exceção do processador como estado próprio: não confirmar o pedido, gravá-lo como `falha_pagamento` (ou devolvê-lo à fila com retentativa e limite) e só confirmar com cobrança aprovada. **Descrita, não executada neste desafio.** | Evitar | P0 |
| Levantar no banco e no log os pedidos confirmados sem cobrança do mês, a partir das linhas `falha ao processar pagamento`, e acionar recobrança ou contato com os clientes antes do envio | Mitigar | P0 |
| Manter `FalhaEmCobrancas` (burn rate 14,4× sobre SLO de 99%) roteado para plantão e acrescentar um alerta de burn rate lento (6× em 6 h) para falhas baixas e persistentes que ficam abaixo de 14,4% | Mitigar | P1 |
| Alerta de invariante de negócio: `pedidos_confirmados_total − cobrancas_processadas_total{resultado="aprovada"}` diferente de zero por mais de 5 min, porque confirmar sem cobrança nunca é aceitável, independente do SLO | Mitigar | P1 |
| Criar `cobrancas_valor_total{resultado}` (contador em reais, sem id) para a métrica responder também "quanto", sem depender de log e banco | Mitigar | P2 |
| Remover `registrarFalhaLegado` e proibir em revisão de código `catch` que não registra no span, no log e numa métrica; adicionar teste de que exceção do processador nunca resulta em `confirmado` | Evitar | P2 |

## Timeline

Horários em UTC, em 2026-09-30, reconstruídos do log dos containers, dos contadores no Prometheus e do log do `receptor-alertas`.

| Horário | Evento |
| --- | --- |
| (mês anterior) | Pedidos confirmados sem cobrança se acumulam sem nenhum sinal; o financeiro detecta a diferença no fechamento e a hipótese "problema no banco" circula sem evidência |
| 22:46:19 | Stack no ar com a instrumentação original. Levantamento do ponto de partida: log sem `trace_id`, histograma com `route="/produtos/42"`, nenhuma métrica de negócio |
| 22:46:30 | Pedido de teste 25 (cliente `cli-0017`) na instrumentação original: o log mostra só "mensagem do pedido 25 recebida" e "pedido 25 ficou confirmado", sem nenhuma pista de falha. É o mesmo ponto cego que o financeiro teve |
| 22:48:38 | api e worker reiniciados com a instrumentação completa; contadores de negócio nascem em zero |
| 22:48:39 | Pedido de validação 26: um único trace `966aa966…` com `pedido.criar` (api) e `pedido.processar` (worker), e o mesmo `trace_id` nas linhas dos dois processos |
| 22:49:42 | Tráfego `normal` iniciado com o `receptor-alertas` recém-reiniciado |
| 22:52:53 | 3 min de `normal`: 351 aprovadas, 31 recusadas, 0 falhas; nenhum alerta no receptor |
| 22:53:06 | `normal` parado; último pedido antes da reprodução: 445 |
| 22:53:08 | `cenario-a` iniciado |
| 22:53:09.250 | Primeira linha `error` "falha ao processar pagamento" (pedido 446), seguida de "pedido 446 ficou confirmado" no mesmo trace |
| ~22:54 | Jaeger: 17 traces com `pedido.processar` em erro e `pedido.status=confirmado`. Painel "pedidos confirmados x cobranças aprovadas" descola; a diferença é igual às falhas |
| 22:55:27 | `FalhaEmCobrancas` entra em `pending` (+139 s) |
| 22:56:25.923 | `FalhaEmCobrancas` chega ao `receptor-alertas` com `status=firing` (+198 s) |
| 22:56:38.713 | Última falha de cobrança do período |
| 22:56:40 | `cenario-a` parado |
| 22:57:10 | Impacto levantado: 158 falhas (contador), 158 pedidos confirmados após falha (log, por `trace_id`), 158 confirmados e R$ 146.429,22 no banco para os ids do log. Causa localizada pelo `exception.stacktrace` do span e pelo atributo `pedido.status=confirmado` junto de `pagamento.resultado=falha` em `decidirStatusDoPedido`, `src/worker/conciliacao.ts` |
