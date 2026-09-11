import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';

function escrever(level: Nivel, msg: string): void {
  const linha = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
  };

  process.stdout.write(JSON.stringify(linha) + '\n');
}

export const log = {
  info(msg: string): void {
    escrever('info', msg);
  },
  warn(msg: string): void {
    escrever('warn', msg);
  },
  error(msg: string): void {
    escrever('error', msg);
  },
};
