import type { DB } from '../db.js';
import { listProducts } from './inventory.js';

const one = (db: DB, sql: string, ...a: (string | number)[]) => Number((db.prepare(sql).get(...a) as { v: number }).v ?? 0);

export function dashboard(db: DB) {
  const products = listProducts(db);
  const month = new Date().toISOString().slice(0, 7);
  return {
    sales_this_month: one(db, "SELECT COALESCE(SUM(total),0) v FROM invoices WHERE strftime('%Y-%m', issued_at) = ?", month),
    cash_in_this_month: one(db, "SELECT COALESCE(SUM(amount),0) v FROM payments WHERE strftime('%Y-%m', paid_at) = ?", month),
    receivables: one(db, "SELECT COALESCE(SUM(total-paid),0) v FROM invoices WHERE status != 'paid'"),
    overdue: one(db, "SELECT COALESCE(SUM(total-paid),0) v FROM invoices WHERE status != 'paid' AND due_at < date('now')"),
    stock_value: products.reduce((s, p) => s + Number(p.cost) * Math.max(p.on_hand, 0), 0),
    open_sales_orders: one(db, "SELECT COUNT(*) v FROM orders WHERE kind='sale' AND status IN ('draft','confirmed','delivered')"),
    open_purchase_orders: one(db, "SELECT COUNT(*) v FROM orders WHERE kind='purchase' AND status IN ('draft','ordered')"),
    low_stock: products.filter((p) => p.low_stock).map((p) => ({ id: p.id, sku: p.sku, name: p.name, available: p.available, reorder_level: p.reorder_level })),
    top_products: db.prepare(`SELECT pr.id, pr.name, SUM(l.qty) AS qty, SUM(l.line_total) AS revenue
        FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN products pr ON pr.id = l.product_id
        WHERE o.kind = 'sale' AND o.status IN ('delivered','invoiced')
        GROUP BY pr.id ORDER BY revenue DESC LIMIT 5`).all(),
    sales_by_month: db.prepare(`SELECT strftime('%Y-%m', issued_at) AS month, SUM(total) AS total FROM invoices
        WHERE issued_at >= date('now','start of month','-5 months') GROUP BY month ORDER BY month`).all(),
  };
}

export function stockReport(db: DB) {
  return listProducts(db).map((p) => ({
    id: p.id, sku: p.sku, name: p.name, on_hand: p.on_hand, committed: p.committed, available: p.available,
    cost: p.cost, value: Number(p.cost) * Math.max(p.on_hand, 0), low_stock: p.low_stock,
  }));
}
