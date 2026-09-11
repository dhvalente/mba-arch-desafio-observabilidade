'use strict';

const http = require('node:http');

const porta = Number(process.env.PORT || 9099);

function extrairAlertas(corpo) {
  try {
    const conteudo = JSON.parse(corpo);

    if (Array.isArray(conteudo.alerts)) {
      return conteudo.alerts.map((alerta) => ({
        nome: (alerta.labels && alerta.labels.alertname) || 'sem-nome',
        status: alerta.status || conteudo.status || 'desconhecido',
      }));
    }

    return [
      {
        nome: (conteudo.labels && conteudo.labels.alertname) || 'sem-nome',
        status: conteudo.status || 'desconhecido',
      },
    ];
  } catch (erro) {
    return [{ nome: 'payload-nao-json', status: 'desconhecido' }];
  }
}

const servidor = http.createServer((requisicao, resposta) => {
  if (requisicao.method !== 'POST') {
    resposta.writeHead(405, { 'content-type': 'text/plain' });
    resposta.end('use POST');
    return;
  }

  const partes = [];

  requisicao.on('data', (parte) => partes.push(parte));

  requisicao.on('end', () => {
    const corpo = Buffer.concat(partes).toString('utf8');
    const recebidoEm = new Date().toISOString();

    extrairAlertas(corpo).forEach((alerta) => {
      console.log(
        recebidoEm + ' alerta=' + alerta.nome + ' status=' + alerta.status
      );
    });

    resposta.writeHead(200, { 'content-type': 'application/json' });
    resposta.end(JSON.stringify({ recebido: true }));
  });
});

servidor.listen(porta, () => {
  console.log('receptor de alertas ouvindo na porta ' + porta);
});

function encerrar() {
  servidor.close(() => process.exit(0));
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
