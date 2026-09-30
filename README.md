# Loja de pedidos: do sintoma ao post-mortem

Instrumentação completa (log ↔ trace, spans de negócio, propagação pela fila, métricas de negócio, dashboard, SLO e alerta) de uma api de pedidos em TypeScript, e a investigação da queixa do financeiro, registrada em [`reports/post-mortem.md`](reports/post-mortem.md).

## Como rodar

Pré-requisitos: Docker, Docker Compose v2 e curl.

```bash
git clone https://github.com/dhvalente/mba-arch-desafio-observabilidade.git
cd mba-arch-desafio-observabilidade
cp .env.example .env
docker compose up -d
curl -s localhost:8080/health          # {"status":"ok"}
```

A primeira subida constrói a imagem e roda o seed do Postgres, então leva um ou dois minutos até a api responder.

Se a porta 3000 (Grafana) ou a 5432 (Postgres) já estiverem ocupadas na sua máquina, troque `GRAFANA_PORT` ou `POSTGRES_HOST_PORT` no `.env` antes de subir. Os demais serviços se falam pela rede interna do compose, então só o endereço que você abre no navegador muda.

| O quê | Onde |
| --- | --- |
| api | http://localhost:8080 (`/produtos`, `/pedidos`, `/health`, `/metrics`) |
| worker | http://localhost:8081 (`/health`, `/metrics`) |
| Jaeger | http://localhost:16686 |
| Prometheus | http://localhost:9090 (alvos em `/targets`, regra em `/rules`, alertas em `/alerts`) |
| Grafana | http://localhost:3000, usuário e senha do `.env` (`admin`/`admin`), dashboard **Pedidos** |
| Alertmanager | http://localhost:9093 |
| Receptor de alertas | `docker compose logs -f receptor-alertas` |

Carga e cenários:

```bash
docker compose run --rm -d carga normal       # tráfego saudável
docker compose run --rm -d carga cenario-a    # reproduz a queixa do financeiro
docker stop $(docker ps -q --filter name=carga-run)
```

Roteiro rápido de verificação:

```bash
# um pedido vira um único trace (api + worker) e o mesmo trace_id aparece no log dos dois processos
curl -s -XPOST localhost:8080/pedidos -H 'content-type: application/json' \
  -d '{"cliente_id":"cli-0001","itens":[{"produto_id":1,"quantidade":2}]}'
docker compose logs api worker --no-log-prefix | tail -5
docker compose logs api worker | grep <trace_id copiado de uma das linhas>

# métricas de negócio existem desde a subida, zeradas
curl -s localhost:8080/metrics | grep -E '^pedidos_'
curl -s localhost:8081/metrics | grep -E '^(pedidos_|cobrancas_)'

# silêncio no normal (3 min) e disparo no cenario-a
docker compose restart receptor-alertas
docker compose run --rm -d carga normal
docker compose logs receptor-alertas                 # nada além da linha de subida
docker stop $(docker ps -q --filter name=carga-run)
docker compose run --rm -d carga cenario-a
docker compose logs -f receptor-alertas              # alerta=FalhaEmCobrancas status=firing
```

Depois de editar qualquer arquivo em `src/`, rode `docker compose restart api worker`. Depois de editar `prometheus/regras/`, rode `curl -XPOST localhost:9090/-/reload` ou `docker compose restart prometheus`.

## Equivalências com o curso

| Pilar | Curso (Java / Spring) | Este projeto (TypeScript / Node) |
| --- | --- | --- |
| Métricas | Micrometer (`Counter`, `Timer`) exposto pelo Actuator em `/actuator/prometheus` | `prom-client`: `Registry`, `Counter`, `Histogram` e `collectDefaultMetrics`, expostos em `/metrics` (`src/telemetria/metricas.ts`, `src/api/metricas-negocio.ts`, `src/worker/metricas-negocio.ts`) |
| Tracing | Micrometer Tracing com o bridge do OpenTelemetry (`micrometer-tracing-bridge-otel`) e exporter OTLP; spans manuais com `Observation`/`Tracer` | `@opentelemetry/sdk-node` (`NodeSDK`) com `auto-instrumentations-node` e `exporter-trace-otlp-http`; spans manuais com `tracer.startActiveSpan()` de `@opentelemetry/api` (`src/telemetria/rastreamento.ts`) |
| Logs estruturados | SLF4J/Logback com encoder JSON; `traceId`/`spanId` preenchidos no MDC pelo Micrometer Tracing | Logger próprio que escreve uma linha JSON no stdout e lê `trace_id`/`span_id` de `trace.getActiveSpan().spanContext()`; o `pedido_id` viaja numa chave do `Context` do OpenTelemetry, que faz o papel do MDC (`src/telemetria/log.ts`) |
| Propagação de contexto | W3C Trace Context automático nos clientes HTTP instrumentados (`RestTemplate`/`WebClient`) e nos binders de mensageria | W3C Trace Context (`traceparent`) com `propagation.inject()` na publicação e `propagation.extract(ROOT_CONTEXT, ...)` no consumo, com a mensagem do Redis como carrier (campo `contexto_trace`, `src/fila/fila.ts` e `src/worker/index.ts`) |

## Decisões técnicas

### Correlação de log com trace

Toda linha tem `timestamp`, `level`, `service`, `msg`, `trace_id` e `span_id`. Os dois últimos vêm do span ativo no momento da escrita e ficam como string vazia quando não há span, como na subida do processo. O campo nunca some da linha. Linhas de pedido carregam `pedido_id`: na api ele é passado explicitamente e, no worker, `comPedido()` o coloca no `Context` do OpenTelemetry, de modo que qualquer linha escrita durante o processamento (inclusive dentro de `conciliacao.ts`, que não conhece o pedido) o herda.

### Spans e travessia da fila

- `pedido.criar` (api, `POST /pedidos`): atributos `cliente.id`, `pedido.id`, `pedido.valor_total`, `pedido.quantidade_de_itens` e, quando a requisição é rejeitada, `pedido.rejeitado`.
- `pedido.processar` (worker, `SpanKind.CONSUMER`): atributos `pedido.id`, `cliente.id`, `pedido.valor_total`, `pedido.status`, `pagamento.resultado` (`aprovada`, `recusada` ou `falha`), `pagamento.autorizacao` e os atributos `messaging.*`.
- A publicação injeta o `traceparent` do contexto ativo, que é o de `pedido.criar`, no campo `contexto_trace` da mensagem. O worker extrai esse campo sobre `ROOT_CONTEXT`, e não sobre o contexto ativo dele, e abre `pedido.processar` como filho de `pedido.criar`. Um `POST /pedidos` vira um único trace com os spans dos dois serviços.
- Toda exceção capturada passa por `registrarExcecao()`: `span.recordException`, status `ERROR` no span e uma linha de log `error` com o campo `motivo`. O fluxo não muda: o `catch` do `POST /pedidos` e o de `pedido.processar` relançam o erro, e o de `conciliacao.ts` continua engolindo a exceção exatamente como antes. Agora ele só conta o que aconteceu.

### Erro de cardinalidade

O histograma `http_request_duration_seconds` usava `requisicao.path` como label `route`, ou seja, o caminho concreto (`/produtos/42`, `/pedidos/1234`). Agora ele usa o template da rota casada pelo Express (`requisicao.baseUrl + requisicao.route.path`, que dá `/produtos/:id`), e o valor fixo `nao_mapeada` quando nenhuma rota casa, para um scanner que varre URLs aleatórias não criar séries.

**Por que derrubaria o Prometheus:** cada id distinto de produto ou pedido cria uma nova série temporal, multiplicada pelos buckets do histograma e pelas combinações de método e status, e como os ids de pedido crescem sem limite, o número de séries (e a memória do Prometheus, que mantém cada série ativa no head block) cresce sem limite até o processo ser morto por falta de memória.

### Métricas de negócio

Todas são inicializadas em zero na subida, inclusive cada valor de `resultado`, para a série existir antes do primeiro evento e o alerta não depender de ela nascer.

| Métrica | Processo | O que responde |
| --- | --- | --- |
| `pedidos_criados_total` | api | Quantos pedidos a loja aceitou e mandou processar. É a demanda: se cair a zero com a api saudável, algo antes do pagamento parou. |
| `pedidos_confirmados_total` | worker | Quantos pedidos o cliente viu como confirmados. É o que a loja se comprometeu a entregar. |
| `cobrancas_processadas_total{resultado}` | worker | Quantas cobranças foram aprovadas (dinheiro que entrou), recusadas (negativa legítima do processador) ou falharam (a cobrança não aconteceu). É a base do SLI. |

A pergunta que a métrica levantou: em operação correta, `pedidos_confirmados_total` e `cobrancas_processadas_total{resultado="aprovada"}` andam juntos. No `cenario-a` eles se separam, e a diferença é exatamente o número de cobranças com `falha`: pedidos confirmados sem cobrança. Nenhuma métrica usa id de pedido ou de cliente como label; esses identificadores vão para span e log.

### Dashboard

`grafana/provisioning/dashboards/pedidos.json`, provisionado por arquivo, com quatro painéis:

| Painel | Pergunta que responde |
| --- | --- |
| Erro: % de cobranças com falha (SLI) e % de respostas HTTP 5xx | **O sistema está com erro?** Junta o erro que o cliente vê (5xx da api) com o que ele não vê (falha de cobrança no worker), com o limiar do alerta desenhado. |
| Lentidão: latência p95 das rotas da api | **O sistema está lento?** |
| Dinheiro: cobranças por resultado (por minuto) | **O dinheiro está entrando?** Aprovadas contra recusadas e falhas. |
| Dinheiro: pedidos confirmados x cobranças aprovadas (por minuto) | **O dinheiro está entrando?** A linha "confirmados sem cobrança" deveria ser zero; acima de zero é pedido entregue sem dinheiro. |

## SLO e alerta

**SLI:** proporção das cobranças processadas pelo worker que chegaram a uma resposta do processador de pagamento, aprovada ou recusada, em vez de falhar. Recusa é resposta legítima (cartão sem saldo, por exemplo) e conta como sucesso do serviço. Falha é a loja não ter conseguido cobrar.

```promql
sum(rate(cobrancas_processadas_total{resultado=~"aprovada|recusada"}[30d]))
/
sum(rate(cobrancas_processadas_total[30d]))
```

**SLO:** 99% das cobranças sem falha, em janela móvel de 30 dias.

**Error budget:** 1% das cobranças do período podem falhar. Com o ritmo do cenário normal (cerca de 2 pedidos por segundo, o que dá ~5,2 milhões de cobranças em 30 dias), isso equivale a ~52 mil cobranças com falha no mês, ou 7,2 horas de falha total.

Por que 99% e não mais: o processador é um terceiro sobre o qual a loja não tem controle, e cada falha é recuperável com uma nova tentativa de cobrança antes do envio. Um alvo mais apertado nos acordaria por instabilidades do gateway que não chegam a custar dinheiro. Um alvo mais frouxo deixaria passar dias de pedidos sem cobrança.

**Do SLO ao limiar:** a regra é um alerta de burn rate. Burn rate é a velocidade de consumo do budget relativa ao ritmo que o esgota exatamente no fim da janela (burn rate 1 = 1% de falha sustentado por 30 dias). O limiar escolhido é o de página do SRE Workbook, consumir 2% do budget mensal em 1 hora:

```
burn rate    = 0,02 × (30 dias × 24 h) / 1 h = 0,02 × 720 = 14,4
taxa de falha que corresponde = burn rate × (1 − SLO) = 14,4 × (1 − 0,99) = 0,144  →  14,4%
```

Nesse ritmo o budget inteiro acaba em 720 h / 14,4 = 50 horas. É um problema que precisa de alguém agora, não na segunda-feira.

A regra (`prometheus/regras/cobrancas.yml`) escreve o limiar como a própria conta, para ele não virar número mágico:

```yaml
- alert: FalhaEmCobrancas
  expr: |
    (
      sum(rate(cobrancas_processadas_total{resultado="falha"}[5m]))
      /
      sum(rate(cobrancas_processadas_total[5m]))
    ) > (14.4 * (1 - 0.99))
  for: 1m
```

- **Janela de 5m:** é a janela curta que o SRE Workbook pareia com o burn rate de 14,4. Ela é curta o bastante para detectar em minutos e longa o bastante (20 coletas de 15s) para uma falha isolada não cruzar o limiar sozinha.
- **`for: 1m`:** exige que a taxa se sustente por quatro avaliações seguidas antes de acordar alguém.
- **Tempo de detecção medido:** com o `cenario-a` subindo logo depois de 3 minutos de `normal`, a regra entrou em `pending` em 139s e o `receptor-alertas` recebeu `alerta=FalhaEmCobrancas status=firing` em **3 min 18 s** (detalhes em `## Detecção` de `reports/post-mortem.md`). O tempo soma a proporção na janela de 5m diluindo o tráfego saudável até cruzar 14,4% (com ~40% de falha, é preciso que ~36% da janela seja `cenario-a`, ou seja ~1 min 50 s), a coleta e a avaliação (15s cada), o `for` de 1m e o `group_wait` de 10s do Alertmanager.
- **Comportamento:** no cenário normal não existe cobrança com `falha` (a taxa é 0%), então a regra fica em silêncio. No `cenario-a` cerca de 40% das cobranças falham, quase três vezes o limiar, e ela dispara.
