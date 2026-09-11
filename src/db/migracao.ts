import { pool } from './pool';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS produtos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  preco NUMERIC(10, 2) NOT NULL
);

CREATE TABLE IF NOT EXISTS pedidos (
  id SERIAL PRIMARY KEY,
  cliente_id TEXT NOT NULL,
  status TEXT NOT NULL,
  valor_total NUMERIC(10, 2) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedido_itens (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos (id),
  produto_id INTEGER NOT NULL REFERENCES produtos (id),
  quantidade INTEGER NOT NULL,
  preco_unitario NUMERIC(10, 2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido_id ON pedido_itens (pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_criado_em ON pedidos (criado_em);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos (status);
`;

export async function migrar(): Promise<void> {
  await pool.query(ESQUEMA);
}
