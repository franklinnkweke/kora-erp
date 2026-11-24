import type { DB } from '../db.js';
import { nextNumber, tx } from '../db.js';
import { conflict, notFound } from '../http.js';
import { audit } from './audit.js';

/** VAT in basis points: 750 = 7.5% (Nigeria). Set VAT_BPS to change it. */
export const vatBps = () => Number(process.env.VAT_BPS ?? 750);
export const PAYMENT_DAYS = 30;

/** Builds the invoice for a delivered sales order. Called inside the order transition transaction. */
export function issueInvoice(db: DB, userId: number, order: { id: number; partner_id: number; total: number; number: string }) {
  const subtotal = Number(order.total);
  const tax = Math.round((subtotal * vatBps()) / 10000);
  const number = nextNumber(db, 'INV');
  const r = db.prepare(`INSERT INTO invoices (number, order_id, partner_id, subtotal, tax, total, status, due_at)
                        VALUES (?, ?, ?, ?, ?, ?, 'unpaid', date('now', ?))`)
    .run(number, Number(order.id), Number(order.partner_id), subtotal, tax, subtotal + tax, `+${PAYMENT_DAYS} days`);
  audit(db, userId, 'create', 'invoice', Number(r.lastInsertRowid), `${number} for ${order.number}`);
}

const INVOICE_SELECT = `SELECT i.*, i.total - i.paid AS balance, p.name AS customer_name, o.number AS order_number,
    CASE WHEN i.status != 'paid' AND i.due_at < date('now') THEN 1 ELSE 0 END AS overdue
  FROM invoices i JOIN partners p ON p.id = i.partner_id JOIN orders o ON o.id = i.order_id`;

export function listInvoices(db: DB, opts: { status?: string; customerId?: number } = {}) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.status === 'open') where.push("i.status != 'paid'");
  else if (opts.status) { where.push('i.status = ?'); args.push(opts.status); }
  if (opts.customerId) { where.push('i.partner_id = ?'); args.push(opts.customerId); }
  return db.prepare(`${INVOICE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC LIMIT 500`).all(...args);
}

export function getInvoice(db: DB, id: number) {
  const inv = db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(id) as { id: number; number: string; order_id: number; partner_id: number;
    subtotal: number; tax: number; total: number; paid: number; balance: number; status: string; issued_at: string; due_at: string;
    customer_name: string; order_number: string; overdue: number } | undefined;
  if (!inv) throw notFound('Invoice');
  const lines = db.prepare(`SELECT l.qty, l.unit_price, l.line_total, pr.sku, pr.name AS product_name FROM order_lines l
                            JOIN products pr ON pr.id = l.product_id WHERE l.order_id = ?`).all(inv.order_id);
  const payments = db.prepare(`SELECT pm.*, u.name AS user_name FROM payments pm LEFT JOIN users u ON u.id = pm.user_id
                               WHERE pm.invoice_id = ? ORDER BY pm.id`).all(id);
  return { ...inv, lines, payments };
}

export function recordPayment(db: DB, userId: number, id: number, p: { amount: number; method: string; reference?: string }) {
  return tx(db, () => {
    const inv = getInvoice(db, id);
    const balance = Number(inv.total) - Number(inv.paid);
    if (balance <= 0) throw conflict('This invoice is already fully paid');
    if (p.amount > balance) throw conflict(`Payment is more than the balance of ${balance}`, { balance });
    db.prepare('INSERT INTO payments (invoice_id, amount, method, reference, user_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, p.amount, p.method, p.reference ?? null, userId);
    const paid = Number(inv.paid) + p.amount;
    db.prepare('UPDATE invoices SET paid = ?, status = ? WHERE id = ?').run(paid, paid >= Number(inv.total) ? 'paid' : 'part_paid', id);
    audit(db, userId, 'payment', 'invoice', id, `${p.amount} by ${p.method}`);
    return getInvoice(db, id);
  });
}

/** What a customer still owes: open invoices plus delivered orders not yet invoiced. */
export function customerBalance(db: DB, customerId: number): number {
  const open = db.prepare('SELECT COALESCE(SUM(total - paid), 0) AS v FROM invoices WHERE partner_id = ?').get(customerId) as { v: number };
  const pending = db.prepare("SELECT COALESCE(SUM(total), 0) AS v FROM orders WHERE partner_id = ? AND kind = 'sale' AND status IN ('confirmed','delivered')").get(customerId) as { v: number };
  return open.v + pending.v;
}

/** Receivables aging: how much is owed, grouped by how late it is. */
export function agingReport(db: DB) {
  return db.prepare(`
    SELECT p.id AS customer_id, p.name AS customer_name,
      SUM(CASE WHEN i.due_at >= date('now') THEN i.total - i.paid ELSE 0 END) AS current,
      SUM(CASE WHEN i.due_at < date('now') AND i.due_at >= date('now','-30 days') THEN i.total - i.paid ELSE 0 END) AS days_1_30,
      SUM(CASE WHEN i.due_at < date('now','-30 days') AND i.due_at >= date('now','-60 days') THEN i.total - i.paid ELSE 0 END) AS days_31_60,
      SUM(CASE WHEN i.due_at < date('now','-60 days') THEN i.total - i.paid ELSE 0 END) AS over_60,
      SUM(i.total - i.paid) AS total
    FROM invoices i JOIN partners p ON p.id = i.partner_id
    WHERE i.status != 'paid' GROUP BY p.id ORDER BY total DESC`).all();
}
