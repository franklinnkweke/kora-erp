import type { DB } from '../db.js';
import { tx } from '../db.js';
import { conflict, notFound } from '../http.js';
import { audit } from './audit.js';

export interface ProductInput {
  sku: string; name: string; unit?: string; price: number; cost: number; reorder_level?: number; active?: boolean;
}

const PRODUCT_SELECT = `
  SELECT p.*, COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.product_id = p.id), 0) AS on_hand,
         COALESCE((SELECT SUM(l.qty) FROM order_lines l JOIN orders o ON o.id = l.order_id
                   WHERE l.product_id = p.id AND o.kind = 'sale' AND o.status = 'confirmed'), 0) AS committed
  FROM products p`;

type ProductRow = { id: number; sku: string; name: string; unit: string; price: number; cost: number; active: number;
  reorder_level: number; created_at: string; on_hand: number; committed: number };

const shape = (r: ProductRow) => ({
  ...r,
  active: Boolean(r.active),
  available: r.on_hand - r.committed,
  low_stock: r.on_hand - r.committed <= r.reorder_level,
});

export function listProducts(db: DB, opts: { q?: string; lowStock?: boolean; includeInactive?: boolean } = {}) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (!opts.includeInactive) where.push('p.active = 1');
  if (opts.q) { where.push('(p.name LIKE ? OR p.sku LIKE ?)'); args.push(`%${opts.q}%`, `%${opts.q}%`); }
  const rows = db.prepare(`${PRODUCT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name`).all(...args) as ProductRow[];
  const out = rows.map(shape);
  return opts.lowStock ? out.filter((p) => p.low_stock) : out;
}

export function getProduct(db: DB, id: number) {
  const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id) as ProductRow | undefined;
  if (!row) throw notFound('Product');
  return shape(row);
}

export function createProduct(db: DB, userId: number, p: ProductInput) {
  return tx(db, () => {
    const r = db.prepare('INSERT INTO products (sku, name, unit, price, cost, reorder_level) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.sku.trim(), p.name.trim(), p.unit ?? 'pcs', p.price, p.cost, p.reorder_level ?? 0);
    const id = Number(r.lastInsertRowid);
    audit(db, userId, 'create', 'product', id, p.sku);
    return getProduct(db, id);
  });
}

export function updateProduct(db: DB, userId: number, id: number, p: Partial<ProductInput>) {
  return tx(db, () => {
    const cur = getProduct(db, id);
    const next = { ...cur, ...p };
    db.prepare('UPDATE products SET sku = ?, name = ?, unit = ?, price = ?, cost = ?, reorder_level = ?, active = ? WHERE id = ?')
      .run(String(next.sku), String(next.name), String(next.unit), Number(next.price), Number(next.cost),
        Number(next.reorder_level), next.active ? 1 : 0, id);
    audit(db, userId, 'update', 'product', id, JSON.stringify(p));
    return getProduct(db, id);
  });
}

/** Manual stock correction (count, damage, opening stock). Stock can never go below zero. */
export function adjustStock(db: DB, userId: number, id: number, qty: number, note: string) {
  return tx(db, () => {
    const p = getProduct(db, id);
    if (p.on_hand + qty < 0) throw conflict(`Only ${p.on_hand} in stock; cannot remove ${-qty}`);
    db.prepare("INSERT INTO stock_moves (product_id, qty, reason, note, user_id) VALUES (?, ?, 'adjustment', ?, ?)").run(id, qty, note, userId);
    audit(db, userId, 'adjust_stock', 'product', id, `${qty > 0 ? '+' : ''}${qty} ${note}`);
    return getProduct(db, id);
  });
}

export function stockMoves(db: DB, productId: number) {
  getProduct(db, productId);
  return db.prepare(`SELECT m.*, u.name AS user_name FROM stock_moves m LEFT JOIN users u ON u.id = m.user_id
                     WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 200`).all(productId);
}
