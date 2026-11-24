import type { DB } from '../db.js';
import { nextNumber, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../http.js';
import { audit } from './audit.js';
import { getProduct } from './inventory.js';
import { customerBalance } from './invoices.js';

export type OrderKind = 'sale' | 'purchase';
export interface LineInput { product_id: number; qty: number; unit_price?: number }

/**
 * Order life cycles.
 *  Sale:     draft -> confirmed -> delivered -> invoiced     (cancel from draft or confirmed)
 *  Purchase: draft -> ordered   -> received                  (cancel from draft or ordered)
 */
const FLOW: Record<OrderKind, Record<string, string[]>> = {
  sale: { draft: ['confirmed', 'cancelled'], confirmed: ['delivered', 'cancelled'], delivered: ['invoiced'], invoiced: [], cancelled: [] },
  purchase: { draft: ['ordered', 'cancelled'], ordered: ['received', 'cancelled'], received: [], cancelled: [] },
};

function partnerKind(kind: OrderKind) { return kind === 'sale' ? 'customer' : 'supplier'; }

export interface OrderRow { id: number; kind: string; number: string; partner_id: number; status: string; notes: string | null;
  total: number; created_by: number | null; created_at: string; updated_at: string; partner_name: string; created_by_name: string | null; invoice_id: number | null }

export function getOrder(db: DB, kind: OrderKind, id: number) {
  const o = db.prepare(`SELECT o.*, p.name AS partner_name, u.name AS created_by_name,
                          (SELECT id FROM invoices i WHERE i.order_id = o.id) AS invoice_id
                        FROM orders o JOIN partners p ON p.id = o.partner_id LEFT JOIN users u ON u.id = o.created_by
                        WHERE o.id = ? AND o.kind = ?`).get(id, kind) as OrderRow | undefined;
  if (!o) throw notFound(kind === 'sale' ? 'Sales order' : 'Purchase order');
  const lines = db.prepare(`SELECT l.*, pr.sku, pr.name AS product_name, pr.unit FROM order_lines l
                            JOIN products pr ON pr.id = l.product_id WHERE l.order_id = ? ORDER BY l.id`).all(id);
  return { ...o, lines: lines as unknown as { product_id: number; qty: number; unit_price: number; line_total: number; sku: string; product_name: string; unit: string }[], next_steps: FLOW[kind][o.status] ?? [] };
}

export function listOrders(db: DB, kind: OrderKind, opts: { status?: string; partnerId?: number } = {}) {
  const where = ['o.kind = ?'];
  const args: (string | number)[] = [kind];
  if (opts.status) { where.push('o.status = ?'); args.push(opts.status); }
  if (opts.partnerId) { where.push('o.partner_id = ?'); args.push(opts.partnerId); }
  return db.prepare(`SELECT o.id, o.number, o.status, o.total, o.created_at, o.partner_id, p.name AS partner_name,
                       (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count
                     FROM orders o JOIN partners p ON p.id = o.partner_id
                     WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT 500`).all(...args);
}

function writeLines(db: DB, kind: OrderKind, orderId: number, lines: LineInput[]) {
  if (!lines.length) throw badRequest('An order needs at least one line');
  const seen = new Set<number>();
  db.prepare('DELETE FROM order_lines WHERE order_id = ?').run(orderId);
  let total = 0;
  for (const l of lines) {
    if (seen.has(l.product_id)) throw badRequest('Each product can only appear once per order');
    seen.add(l.product_id);
    const p = getProduct(db, l.product_id);
    if (!p.active) throw conflict(`${p.name} is no longer sold`);
    const price = l.unit_price ?? (kind === 'sale' ? Number(p.price) : Number(p.cost));
    const lineTotal = price * l.qty;
    total += lineTotal;
    db.prepare('INSERT INTO order_lines (order_id, product_id, qty, unit_price, line_total) VALUES (?, ?, ?, ?, ?)')
      .run(orderId, l.product_id, l.qty, price, lineTotal);
  }
  db.prepare("UPDATE orders SET total = ?, updated_at = datetime('now') WHERE id = ?").run(total, orderId);
}

function checkPartner(db: DB, kind: OrderKind, partnerId: number) {
  const p = db.prepare('SELECT kind FROM partners WHERE id = ?').get(partnerId) as { kind: string } | undefined;
  if (!p || p.kind !== partnerKind(kind)) throw badRequest(`Pick a valid ${partnerKind(kind)}`);
}

export function createOrder(db: DB, userId: number, kind: OrderKind, input: { partner_id: number; lines: LineInput[]; notes?: string }) {
  return tx(db, () => {
    checkPartner(db, kind, input.partner_id);
    const number = nextNumber(db, kind === 'sale' ? 'SO' : 'PO');
    const r = db.prepare("INSERT INTO orders (kind, number, partner_id, status, notes, created_by) VALUES (?, ?, ?, 'draft', ?, ?)")
      .run(kind, number, input.partner_id, input.notes ?? null, userId);
    const id = Number(r.lastInsertRowid);
    writeLines(db, kind, id, input.lines);
    audit(db, userId, 'create', `${kind}_order`, id, number);
    return getOrder(db, kind, id);
  });
}

export function updateDraft(db: DB, userId: number, kind: OrderKind, id: number, input: { partner_id?: number; lines?: LineInput[]; notes?: string }) {
  return tx(db, () => {
    const o = getOrder(db, kind, id);
    if (o.status !== 'draft') throw conflict('Only draft orders can be edited');
    if (input.partner_id) { checkPartner(db, kind, input.partner_id); db.prepare('UPDATE orders SET partner_id = ? WHERE id = ?').run(input.partner_id, id); }
    if (input.notes !== undefined) db.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(input.notes, id);
    if (input.lines) writeLines(db, kind, id, input.lines);
    audit(db, userId, 'update', `${kind}_order`, id, String(o.number));
    return getOrder(db, kind, id);
  });
}

/** Moves an order to its next status and applies the side effects (stock, credit, invoice). */
export function transition(db: DB, userId: number, kind: OrderKind, id: number, to: string, extra?: (o: ReturnType<typeof getOrder>) => void) {
  return tx(db, () => {
    const o = getOrder(db, kind, id);
    const from = String(o.status);
    if (!FLOW[kind][from]?.includes(to)) throw conflict(`Cannot move a ${from} order to ${to}`);
    const lines = o.lines as { product_id: number; qty: number; product_name: string }[];

    if (kind === 'sale' && to === 'confirmed') {
      const short = lines.map((l) => ({ l, p: getProduct(db, l.product_id) }))
        .filter(({ l, p }) => p.available < l.qty)
        .map(({ l, p }) => ({ product: l.product_name, wanted: l.qty, available: p.available }));
      if (short.length) throw conflict('Not enough stock to confirm this order', short);
      const c = db.prepare('SELECT credit_limit FROM partners WHERE id = ?').get(o.partner_id as number) as { credit_limit: number };
      if (c.credit_limit > 0) {
        const owed = customerBalance(db, o.partner_id as number);
        if (owed + Number(o.total) > c.credit_limit) {
          throw conflict('This order would take the customer over their credit limit', { owed, order_total: o.total, credit_limit: c.credit_limit });
        }
      }
    }
    if (kind === 'sale' && to === 'delivered') {
      for (const l of lines) {
        const p = getProduct(db, l.product_id);
        if (p.on_hand < l.qty) throw conflict(`Only ${p.on_hand} of ${l.product_name} on hand`);
        db.prepare("INSERT INTO stock_moves (product_id, qty, reason, ref, user_id) VALUES (?, ?, 'delivery', ?, ?)").run(l.product_id, -l.qty, String(o.number), userId);
      }
    }
    if (kind === 'purchase' && to === 'received') {
      for (const l of lines) {
        db.prepare("INSERT INTO stock_moves (product_id, qty, reason, ref, user_id) VALUES (?, ?, 'receipt', ?, ?)").run(l.product_id, l.qty, String(o.number), userId);
      }
    }
    extra?.(o);
    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(to, id);
    audit(db, userId, to, `${kind}_order`, id, `${o.number}: ${from} -> ${to}`);
    return getOrder(db, kind, id);
  });
}
