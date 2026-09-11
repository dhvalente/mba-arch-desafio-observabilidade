Projeto: MBA Arquitetura Full Cycle - Observabilidade e DevOps/SRE
Fase do projeto: Do sintoma ao post-mortem

# Do sintoma ao post-mortem

Uma instrumentação inacabada, uma queixa do financeiro, e um documento no fim que explica o que aconteceu

## Descrição

Você vai receber uma aplicação em TypeScript com dois processos e uma instrumentação pela metade. Alguém do time começou a instrumentar meses atrás e parou justamente antes das partes que dão sentido ao resto.

Seu trabalho tem três movimentos. **Terminar** o que foi começado: ligar o log ao trace, fazer o contexto atravessar a fila, consertar um erro de cardinalidade que já está plantado nas métricas, criar as métricas de negócio que faltam e montar o dashboard. **Definir** o que é qualidade de serviço aqui, transformando isso num SLO e derivando dele o alerta. E **usar** tudo isso para investigar a queixa que chegou do financeiro e fechar o incidente com um post-mortem.

Este desafio cobre dois módulos do MBA: Observabilidade e DevOps e SRE.

## Cenário

Você entrou no time de plataforma de uma loja online. O sistema roda em produção, o Jaeger mostra spans, o log sai em JSON, o Prometheus está coletando. Parece que tem tudo.

Aí o financeiro fechou o mês e faltou dinheiro. Alguém abriu o Grafana, não achou nada, e a resposta que circula pelo Slack é que deve ser problema do banco. Você foi contratado para acabar com o palpite.

## Sobre o foco do desafio

O foco é observabilidade e resposta a incidente, não desenvolvimento de produto e não performance. A aplicação vem pronta e funcional, e o seu trabalho é completar a instrumentação dela e configurar o que falta na stack.

Você não deve corrigir o defeito da aplicação. Ele é o objeto de estudo: é o que a sua instrumentação precisa revelar. Corrigir faz o cenário de carga parar de reproduzir a queixa, e o alerta que deveria disparar não dispara mais.

## Sobre pesquisar fora do que foi ensinado

O curso ensinou observabilidade em Java, com Actuator, Micrometer e o bridge do OpenTelemetry. Este desafio é em TypeScript, e isso é deliberado: observabilidade é especificação, não framework. Span continua sendo span, propagação continua sendo W3C Trace Context, e cardinalidade alta continua derrubando Prometheus em qualquer stack. O que muda é o nome do pacote e a sintaxe, e descobrir esses equivalentes na documentação é parte do trabalho, tanto que o README tem uma tabela de equivalências como entregável. Você não precisa saber TypeScript de antemão: a aplicação vem funcionando e você completa código que já existe.

Do lado de SRE, o post-mortem que você vai escrever no fim segue o template do módulo de DevOps e SRE, disponível em https://github.com/devfullcycle/MBA-fundamentos-devops-sre. Vale abrir antes de começar, porque saber quais perguntas o documento faz muda o que você presta atenção durante a investigação.

## Repositório base

https://github.com/devfullcycle/mba-arch-desafio-observabilidade

Faça o fork e trabalhe nele. A entrega final fica na branch `main` do seu fork.

Pré-requisitos: Docker, Docker Compose v2 e `curl`. Nada além disso precisa estar instalado na sua máquina.

```
cp .env.example .env
docker compose up -d
curl -s localhost:8080/health
```

Isso sobe a `api`, o `worker`, o Postgres, o Redis e a stack de observabilidade inteira, já parcialmente configurada.

A pasta `src/` é montada como volume nos dois processos, então o container roda o código que está no seu disco e você não precisa reconstruir a imagem para testar uma mudança de código. Em compensação, o processo não recarrega sozinho: depois de editar qualquer arquivo em `src/`, rode `docker compose restart api worker`. Vale o mesmo para `git checkout`, `git stash` e `git pull`, que mudam o código do disco sem mexer no que já está rodando. A exceção é o `package.json`: as dependências ficam dentro da imagem, então acrescentar uma biblioteca exige `docker compose up -d --build`.

## Contexto

### A aplicação

Um único projeto TypeScript, dois processos com o mesmo código-fonte e entrypoints diferentes, um Postgres e um Redis.

`api` na porta 8080, com quatro rotas de negócio:

- `GET /produtos` lista produtos e `GET /produtos/:id` devolve um produto, ou 404
- `POST /pedidos` recebe `{cliente_id, itens: [{produto_id, quantidade}]}`, grava o pedido como `pendente`, publica na fila `pedidos` do Redis e devolve 202 com `{pedido_id, status}`
- `GET /pedidos/:id` devolve o pedido, ou 404

Além delas, `GET /health` e `GET /metrics`.

`worker` na porta 8081, que expõe apenas `/health` e `/metrics`. Consome a fila `pedidos`, chama o processador de pagamento simulado e atualiza o pedido para `confirmado` ou `recusado`. O processador é uma função local, sem chamada externa, e o resultado depende do cliente: ele pode aprovar, recusar ou falhar.

O Postgres sobe com produtos e com alguns pedidos antigos já carregados. Use `GET /produtos` para obter identificadores válidos.

### O que já está instrumentado

Este é o ponto de partida. Confira cada item com os próprios olhos antes de começar, porque o desafio inteiro parte daqui.

- **Tracing automático funcionando.** O SDK do OpenTelemetry já sobe nos dois processos, com auto instrumentação de HTTP e de banco, exportando por OTLP para o Jaeger com amostragem em 100%. Uma requisição já vira trace com spans de rota e de consulta
- **Log em JSON.** Os dois processos já escrevem uma linha JSON por evento no stdout, com os campos `timestamp`, `level`, `service` e `msg`. Não existe nenhum campo que ligue a linha a um trace
- **Rota `/metrics` com `prom-client`.** Já existem as métricas padrão do processo e um histograma de latência HTTP chamado `http_request_duration_seconds`. Não existe nenhuma métrica de negócio
- **Prometheus coletando.** Os dois processos já aparecem como `UP` em `http://localhost:9090/targets`, e o `prometheus.yml` já declara de onde ler as regras de alerta. A pasta de regras é que está vazia
- **Grafana com datasources e um dashboard começado.** Prometheus e Jaeger já provisionados por arquivo, e existe um dashboard provisionado com um painel só, para você não precisar descobrir o formato do JSON do zero
- **Alertmanager ligado ao receptor.** A rota e o receiver já apontam para o `receptor-alertas`, com o agrupamento já ajustado para o disparo ser rápido. Não existe nenhuma regra de alerta

### O que não está

Nada liga o log ao trace, e não existe nenhum span de negócio. O contexto não atravessa a fila, então o que a `api` faz e o que o `worker` faz aparecem hoje como dois traces separados, sem relação entre si. Não existe métrica de negócio, nem SLO declarado, nem regra de alerta, e o dashboard tem um painel só.

Além disso, tem um problema plantado na instrumentação de métricas que já existe, que o requisito 3 trata.

## A queixa

**"Fechamos o mês e faltou dinheiro."** O financeiro cruzou os pedidos que aparecem como confirmados para o cliente com o que efetivamente entrou, e encontrou pedidos confirmados que nunca foram cobrados. Reproduz com `cenario-a`.

Pista: do lado de fora está tudo 2xx, o cliente recebe sucesso e o pedido aparece confirmado. Monitoramento de caixa preta não enxerga isso, e é por isso que o Grafana não mostrou nada. A resposta está no que o código sabe e hoje não conta a ninguém.

## Ferramentas do ambiente

### O gerador de carga

```
docker compose run --rm carga normal
docker compose run --rm carga cenario-a
```

Cada cenário roda até você interromper com Ctrl+C. Para deixar rodando em segundo plano, a flag vem antes do nome do serviço, como em `docker compose run --rm -d carga normal`, e para parar o que ficou rodando assim use `docker stop $(docker ps -q --filter name=carga-run)`. O `normal` é o tráfego saudável, com aprovações e recusas legítimas, e a queixa não se manifesta nele: é contra ele que você calibra o alerta. O `cenario-a` reproduz a queixa, e leva menos de um minuto para isso acontecer.

### O receptor de alertas

`http://localhost:9099`, um serviço mínimo que recebe webhook do Alertmanager e registra no stdout tudo que chega. É a sua prova de que o alerta disparou.

## Requisitos

### 1. Correlacionar log com trace

Por quê. Log e trace hoje são duas ilhas: você tem o trace de uma operação e não acha as linhas de log dela, e tem a linha de um erro e não acha o trace onde ele aconteceu. Essa ponte é a espinha da observabilidade.

Tarefa. Acrescente a toda linha de log dos dois processos os campos `trace_id` e `span_id`, com esses nomes exatos, preenchidos a partir do span ativo no momento em que a linha é escrita. Linhas relacionadas a um pedido carregam também `pedido_id`.

Os dois campos existem em toda linha, sempre. Quando não houver span ativo, como na subida do processo, eles vão vazios. Campo que aparece e some conforme o contexto quebra qualquer filtro automático em cima do log.

O identificador tem que ser o mesmo que aparece no Jaeger. Identificador próprio, gerado pela aplicação e desconectado do trace, não atende.

### 2. Tracing manual e travessia da fila

Por quê. A auto instrumentação entrega os limites técnicos, que são rota e consulta, e não entrega os limites de negócio. E ela não atravessa fila, então hoje não existe forma de olhar um pedido confirmado e ver o que aconteceu na cobrança dele.

Tarefa. Duas coisas.

- Crie dois spans manuais, com estes nomes exatos: `pedido.criar` no `POST /pedidos` e `pedido.processar` no consumo da mensagem pelo worker. Ambos com atributos úteis para diagnóstico, incluindo o identificador do pedido
- Faça o contexto de trace atravessar a fila, injetando na publicação e extraindo no consumo, de modo que um `POST /pedidos` e o processamento dele formem um único trace com um único `trace_id`

Além disso, toda exceção capturada pelo código passa a ser registrada no span, com o status do span indo para erro, e a produzir uma linha de log de nível `error` com o motivo. O fluxo da aplicação continua exatamente o mesmo: você só passa a contar o que acontece.

Um detalhe do Express que atrapalha exatamente aqui: a versão 4 não captura exceção de handler `async`, então hoje um erro dentro do `POST /pedidos` não chega ao middleware de erro e derruba o processo da `api`. Se você envolver o handler em `try/catch` para registrar a exceção no span, **relance o erro** no fim do `catch`. Capturar a exceção e responder 500 onde antes o processo caía é mudar comportamento, e o que se pede aqui é instrumentar sem mudar.

### 3. Métricas

Por quê. O histograma que já existe comete o erro de cardinalidade mais clássico que existe, e o custo dele não aparece em teste: aparece em produção, semanas depois, quando o Prometheus começa a consumir memória sem explicação. E métrica de infraestrutura sozinha não conta a história do negócio: o sistema pode estar com 100% de disponibilidade e sangrando dinheiro.

Tarefa. Três coisas.

- Encontre o erro de cardinalidade na instrumentação de métricas existente, corrija, e explique no README em uma frase por que aquilo derrubaria um Prometheus em produção
- Crie três métricas de negócio, com estes nomes e tipos exatos: `pedidos_criados_total` e `pedidos_confirmados_total`, contadores, e `cobrancas_processadas_total`, contador com o label `resultado`, que assume os valores `aprovada`, `recusada` e `falha`
- Inicialize os três contadores em zero na subida, incluindo cada valor do label `resultado`. Série que só nasce no primeiro evento some do gráfico enquanto está tudo bem e quebra o alerta que dependia dela

A proibição de cardinalidade vale para métrica. Em span e em log o identificador é bem-vindo e necessário, porque lá ele custa barato e é o que permite achar o caso individual.

### 4. Dashboard

Por quê. Dashboard construído na mão dentro do Grafana morre com o container: não é versionado, não é revisado, ninguém sabe quem mudou o quê. E dashboard eficaz não é o que mostra tudo, é o que cabe numa tela e responde as perguntas que alguém vai fazer às três da manhã.

Tarefa. Complete o dashboard `Pedidos`, que já vem provisionado em `grafana/provisioning/dashboards/pedidos.json` e hoje tem um painel só. No fim ele tem no máximo quatro painéis e responde estas três perguntas:

- o sistema está com erro?
- o sistema está lento?
- o dinheiro está entrando?

Quais painéis usar para responder é decisão sua, e o teto de quatro é parte do exercício. Todo painel com título que diz o que ele mostra, e o README diz qual das três perguntas cada painel responde.

O painel que já vem no arquivo é exemplo de formato, não peça obrigatória: mantenha, retitule ou apague, como preferir. O que conta no fim é que todo painel que sobrar responda uma das três perguntas e que o seu README diga qual.

### 5. SLO e alerta

Por quê. Limiar escolhido no olho é chute com aparência de rigor, e é assim que nasce o alerta que ninguém respeita. SLO inverte a ordem: primeiro você declara quanta falha o serviço pode ter sem que ninguém precise ser acordado, e o limiar do alerta vira consequência aritmética disso, não opinião.

Tarefa. Declare o objetivo de serviço e derive o alerta dele.

- Defina o **SLI**: a medida de saúde do processamento de cobrança, em uma frase, acompanhada da expressão PromQL que a calcula a partir das suas métricas
- Defina o **SLO**: o alvo numérico para esse SLI, com a janela de tempo a que ele se refere, e o error budget que esse alvo implica
- Escreva no Prometheus uma regra chamada exatamente `FalhaEmCobrancas`, cujo limiar **saia do SLO**, com a conta explicada no README. Regra com número redondo escolhido no olho não atende, ainda que dispare na hora certa
- `for` entre 30s e 1m, inclusive nos extremos. É um limite do desafio, para o disparo ser observável durante a correção
- O Alertmanager agrupa alertas e espera um intervalo antes de disparar o webhook. O starter já vem com esse intervalo curto, então some ao seu `for` mais alguns segundos e saiba que isso existe antes de achar que a sua regra está quebrada
- A janela do seu `rate()` também entra no tempo de detecção, e esse é o detalhe que mais confunde. O alerta compara uma proporção, então, se o `cenario-a` sobe logo depois do `normal`, a janela ainda está cheia de sucesso e a proporção precisa primeiro diluir o que estava limpo para só então cruzar o limiar. Quanto mais tráfego saudável cabe na sua janela, e quanto mais alto o seu limiar, mais isso demora. Reiniciar `api` e `worker` não adianta: o Prometheus compensa o reset do contador e o histórico continua contando dentro da janela. Isso não é defeito da sua regra, e o critério de aceite já dá margem para isso. Só não meça o tempo de disparo no primeiro minuto e conclua que nada funciona
- Comportamento exigido: a regra não dispara no cenário `normal` e dispara no `cenario-a`

Não existe SLO certo neste desafio. Existe SLO justificado: o que vale é a coerência entre o número que você escolheu, o que ele significa para o negócio e o limiar que sai dele.

### 6. Post-mortem

Por quê. Instrumentação existe para responder pergunta, e num time de verdade a resposta vira um documento que outras pessoas leem: o que aconteceu, quanto custou, como foi descoberto e o que muda para não repetir. Sem isso, o incidente é resolvido e esquecido, e volta em três meses com outra roupa.

Tarefa. Investigue a queixa usando a sua instrumentação e escreva `reports/post-mortem.md`, numa versão enxuta do template do módulo de DevOps e SRE, com exatamente estas oito seções, com estes títulos:

- `## Resumo`: o que aconteceu, em duas ou três frases, para quem só vai ler isto
- `## Impacto`: no período que você reproduziu, quantos pedidos foram afetados e qual o valor envolvido, dizendo de onde saiu cada número. Repare que a sua métrica responde uma dessas perguntas e não responde a outra
- `## Detecção`: como o problema foi descoberto hoje, quanto tempo o seu alerta leva para detectar o mesmo problema, medido na sua reprodução, e o que essa diferença significa
- `## Causa raiz`: o arquivo e a função onde o defeito mora, com o trecho de código colado
- `## Evidências`: um `trace_id` real observado no Jaeger, a query PromQL usada e o comando de busca no log usado, cada um com o resultado que você obteve
- `## Lições aprendidas`: as três perguntas do template, que são o que correu bem, o que correu mal e onde tivemos sorte
- `## Itens de ação`: tabela com no mínimo três ações, cada uma com o tipo, sendo evitar ou mitigar, e a prioridade. A correção definitiva do defeito é uma delas, descrita e não executada
- `## Timeline`: a sequência do que aconteceu e do que você fez, reconstruída a partir da evidência

Um aviso sobre a contagem de pedidos afetados: o `increase()` do Prometheus extrapola a janela e devolve estimativa, não contagem exata, então é normal que ele divirja em alguns pedidos do que você contar no log ou no banco. Isso não é erro seu. Diga de onde veio cada número e, se as fontes divergirem, diga isso também: post-mortem que declara a origem e a precisão de cada número vale mais do que um que apresenta estimativa como se fosse contagem.

Escreva sem procurar culpado. Post-mortem que aponta pessoa não gera aprendizado, gera silêncio no próximo incidente.

### 7. README

Por quê. A entrega é lida por alguém que nunca viu o seu repositório e que vai executar exatamente o que estiver escrito. Se o roteiro não funcionar do zero, a entrega não existe.

Tarefa. Substitua o `README.md` do projeto base por um com estas quatro seções, com estes títulos:

- `## Como rodar`: do clone à stack no ar
- `## Equivalências com o curso`: tabela com quatro linhas, uma para métricas, uma para tracing, uma para logs estruturados e uma para propagação de contexto, dizendo o que o curso usou em Java e o que você usou em TypeScript
- `## Decisões técnicas`: a explicação do erro de cardinalidade, o que cada métrica de negócio responde, e qual das três perguntas cada painel do dashboard responde
- `## SLO e alerta`: o SLI com a expressão que o calcula, o SLO com a janela, o error budget que ele implica, e a conta que leva do SLO ao limiar da regra

## Restrições (não negociáveis)

- Você completa a instrumentação. Não altera comportamento funcional e não muda o contrato das rotas existentes
- Escrever dentro de um bloco que hoje não registra nada é instrumentação, não correção, e é esperado que você faça isso
- Não altere a pasta `carga/` nem a pasta `receptor-alertas/`
- Nenhum componente da stack pode ser substituído por serviço de terceiros, porque a entrega roda inteira na máquina do avaliador
- Dashboard entra por arquivo versionado. Você pode montar o painel pela interface do Grafana para experimentar, mas o que conta é o JSON versionado, e o ambiente subindo do zero tem que trazer tudo pronto sem nenhum clique
- Nenhuma credencial nova em arquivo versionado. O que precisar de valor vem do `.env`

## Fora de escopo

- Corrigir o defeito da aplicação
- Agregação centralizada de log. O log fica em JSON no stdout e a correlação se prova por linha de comando
- OpenTelemetry Collector e Pushgateway. A exportação é direta e a coleta é por pull
- Exporters de infraestrutura. O foco é a instrumentação da aplicação
- Instrumentar o `receptor-alertas` ou o gerador de carga
- Integração com Slack, e-mail ou qualquer canal externo. O `receptor-alertas` é o destino
- Pipeline de CI, publicação de imagem e infraestrutura como código. Nada de GitHub Actions aqui

## Critérios de Aceite

Todos os critérios são eliminatórios: qualquer item não atendido reprova a entrega. Cada um traz o comando ou a tela que dá o check, a partir de um clone limpo do seu fork, com a stack no ar e com o cenário de carga que o próprio critério indicar.

Logs

☐ Toda linha de log dos dois processos é JSON e traz `timestamp`, `level`, `service`, `msg`, `trace_id` e `span_id`, mesmo quando os dois últimos estão vazios. Confira com `docker compose logs api | tail -20` e `docker compose logs worker | tail -20`
☐ Linhas relacionadas a um pedido trazem `pedido_id`
☐ Rodando `cenario-a`, aparecem linhas de nível `error` com o motivo da falha

Tracing

☐ Um `POST /pedidos` aparece no Jaeger como um trace único que contém spans da `api` e do `worker`
☐ Esse mesmo trace contém os spans `pedido.criar` e `pedido.processar`
☐ Rodando `cenario-a`, existe no Jaeger ao menos um trace com span marcado como erro
☐ O `trace_id` de um trace do Jaeger, buscado com `docker compose logs api worker`, devolve linhas dos dois processos

Métricas

☐ Nenhuma série de `http_request_duration_seconds` usa caminho concreto no lugar do template. `/produtos/:id` está correto, `/produtos/42` reprova
☐ Nenhuma série usa identificador de pedido ou de cliente como label
☐ As saídas de `/metrics` dos dois processos, somadas, contêm `pedidos_criados_total`, `pedidos_confirmados_total` e `cobrancas_processadas_total`, esta última com o label `resultado` nos valores `aprovada`, `recusada` e `falha`
☐ Os três contadores existem já na subida, antes de qualquer tráfego

Dashboard

☐ Existe exatamente um dashboard provisionado por arquivo JSON versionado, e ele abre no Grafana logo após a subida, sem nenhum clique de configuração
☐ Tem no máximo quatro painéis, nenhum com título vazio ou igual a `Panel Title`
☐ O README diz, para cada painel, qual das três perguntas do requisito 4 ele responde

SLO e alerta

☐ O README declara o SLI com a expressão PromQL que o calcula, o SLO com alvo e janela, o error budget que ele implica, e a conta que leva do SLO ao limiar da regra
☐ `http://localhost:9090/rules` exibe `FalhaEmCobrancas`, carregada sem erro e com `for` entre 30s e 1m
☐ Com o cenário `normal` rodando por 3 minutos após `docker compose restart receptor-alertas`, nenhum alerta aparece em `docker compose logs receptor-alertas`
☐ Rodando `cenario-a`, `FalhaEmCobrancas` aparece no log do `receptor-alertas` em até 5 minutos. A margem é bem maior que o `for` de propósito: quando o `cenario-a` sobe logo depois do `normal`, a proporção ainda precisa diluir o tráfego saudável que está na janela do `rate()` antes de cruzar o limiar, e quanto mais alto o seu limiar, mais isso demora

Post-mortem

☐ Existe `reports/post-mortem.md` com as oito seções exigidas, com os títulos exatos
☐ `## Impacto` quantifica pedidos afetados e valor envolvido, dizendo a origem de cada número
☐ `## Detecção` diz como o problema foi descoberto, quanto tempo o alerta leva para detectá-lo e o que a diferença significa
☐ `## Causa raiz` cita o arquivo e a função onde o defeito mora, e ambos coincidem com o gabarito de correção
☐ `## Evidências` traz um `trace_id`, uma query PromQL e um comando de busca no log, cada um com o resultado obtido
☐ `## Itens de ação` é uma tabela com no mínimo três ações, cada uma com tipo e prioridade

README

☐ O `README.md` tem as quatro seções exigidas, com os títulos exatos, e a tabela de equivalências está preenchida com o que foi usado de fato no código

Integridade

☐ `git diff` contra o repositório base não mostra alteração em `carga/` nem em `receptor-alertas/`
☐ `git diff -w` contra o repositório base em `src/` mostra apenas linhas de instrumentação, sem alteração no fluxo da aplicação. A opção `-w` existe porque envolver um bloco em um span reindenta o código sem mudar nada

## Estrutura obrigatória do entregável

```
.
├── README.md                     (substituído por você)
├── compose.yaml
├── .env.example
├── src/
│   ├── api/                      você completa a instrumentação
│   ├── worker/                   você completa a instrumentação
│   ├── telemetria/               bootstrap do OTel, logger e métricas
│   └── ...
├── carga/                        (não alterar)
├── receptor-alertas/             (não alterar)
├── prometheus/
│   ├── prometheus.yml            já configurado, inclusive de onde ler as regras
│   └── regras/                   (você preenche)
├── alertmanager/
│   └── alertmanager.yml          já configurado
├── grafana/
│   └── provisioning/
│       ├── datasources/          já configurado
│       └── dashboards/
│           └── pedidos.json      um painel pronto, você completa
└── reports/
    └── post-mortem.md            esqueleto pronto, você preenche
```

## Entrega

- Link do fork público no GitHub, com tudo consolidado na branch `main`
- README com as quatro seções obrigatórias, verificado do zero
- O post-mortem em `reports/`
- A base é obrigatória. Entregas que reescrevem a aplicação, trocam a stack ou corrigem o defeito não serão aceitas

## Ordem de execução sugerida

**1.** Suba o ambiente e explore o que já existe antes de escrever qualquer linha. Faça um pedido, abra o trace no Jaeger, leia uma linha de log, olhe a saída de `/metrics` e os alvos no Prometheus. Metade do desafio é entender onde a instrumentação atual para.

**2.** Comece pela correlação de log com trace. É a peça mais barata e a que mais muda o seu dia dali em diante: sem ela, você vai depurar o resto no escuro. Só considere pronto quando conseguir pegar um `trace_id` no Jaeger e achar as linhas dos dois processos por aquele identificador.

**3.** Ataque as métricas: conserte a cardinalidade primeiro, porque ela suja tudo que vem depois, e só então crie as de negócio. Feito isso, suba os dois cenários e passe alguns minutos só olhando os números subirem. Métrica de negócio serve para levantar pergunta, e é bem provável que você saia daqui com uma.

**4.** Faça os spans manuais e depois a travessia da fila. Este é o ponto mais difícil do desafio. O contexto de trace não é mágica do framework, é dado que precisa viajar junto com a mensagem, e o OpenTelemetry tem uma API própria de propagação para isso. Se ao consumir a mensagem você começar um trace novo em vez de continuar o que existia, o sintoma é claro: dois traces curtos no Jaeger em vez de um completo. E preste atenção em qual contexto você usa como base ao extrair, porque usar o contexto ativo do worker em vez de um contexto raiz é o erro que faz o span nascer no lugar errado.

**5.** Monte o dashboard por arquivo. Derrube tudo com `docker compose down -v`, suba de novo e confirme que os painéis voltaram sozinhos.

**6.** Declare o SLI e o SLO antes de escrever a regra. A ordem importa: quem escreve a regra primeiro acaba inventando um SLO que justifica o número que já tinha escolhido. Depois prove os dois comportamentos, silêncio no `normal` e disparo no `cenario-a`.

**7.** Investigue e escreva o post-mortem. Abra o esqueleto do documento antes de começar a investigar, porque as perguntas dele dizem que evidência você precisa guardar pelo caminho. Reconstruir evidência depois é mais caro do que salvar na hora, e resista ao impulso de procurar a resposta lendo o código: se ela vier do código e não da telemetria, você não provou nada, só confirmou um palpite, que é o que a empresa já fazia antes de você chegar.

**8.** Percorra os critérios de aceite item a item, do zero, seguindo só o seu README, antes do push final.
