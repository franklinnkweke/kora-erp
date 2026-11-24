import type { DB } from './db.js';
import { hashPassword } from './auth.js';
import { createOrder, transition } from './services/orders.js';
import { issueInvoice, recordPayment } from './services/invoices.js';

/** Creates the first admin if there are no users yet. */
export function ensureAdmin(db: DB, email: string, password: string) {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (n > 0) return false;
  db.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, 'Admin', 'admin', ?)").run(email, hashPassword(password));
  return true;
}

/** Demo data for a small electronics distributor in Lagos. Prices in kobo. */
export function seedDemo(db: DB, password = 'Demo#12345') {
  if ((db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n > 0) return;
  const user = (email: string, name: string, role: string) =>
    Number(db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(email, name, role, hashPassword(password)).lastInsertRowid);
  const adminId = (db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id
    ?? user('admin@kora.test', 'Ada Admin', 'admin');
  user('sales@kora.test', 'Seyi Sales', 'sales');
  user('warehouse@kora.test', 'Wale Warehouse', 'warehouse');
  user('accounts@kora.test', 'Amaka Accounts', 'accounts');

  const N = (naira: number) => naira * 100;
  const products: [string, string, string, number, number, number][] = [
    ['TV-43', '43" Smart TV', 'pcs', 285000, 232000, 4],
    ['TV-55', '55" 4K Smart TV', 'pcs', 520000, 438000, 2],
    ['SB-01', 'Soundbar 2.1', 'pcs', 95000, 71000, 5],
    ['GEN-35', '3.5 kVA Generator', 'pcs', 410000, 356000, 2],
    ['INV-15', '1.5 kVA Inverter', 'pcs', 330000, 274000, 3],
    ['BAT-200', '200Ah Solar Battery', 'pcs', 265000, 219000, 6],
    ['WM-HDMI', 'TV Wall Mount', 'pcs', 18000, 11000, 10],
    ['CBL-HDMI', 'HDMI Cable 2m', 'pcs', 4500, 2200, 25],
  ];
  const pid: Record<string, number> = {};
  for (const [sku, name, unit, price, cost, reorder] of products) {
    pid[sku] = Number(db.prepare('INSERT INTO products (sku, name, unit, price, cost, reorder_level) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sku, name, unit, N(price), N(cost), reorder).lastInsertRowid);
  }
  const partner = (kind: string, name: string, email: string, phone: string, address: string, limit = 0) =>
    Number(db.prepare('INSERT INTO partners (kind, name, email, phone, address, credit_limit) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, name, email, phone, address, N(limit)).lastInsertRowid);
  const sup1 = partner('supplier', 'Ikeja Electronics Wholesale', 'orders@ikejaelec.test', '0803 000 1111', 'Computer Village, Ikeja');
  const sup2 = partner('supplier', 'SunPower Distributors', 'sales@sunpower.test', '0805 000 2222', 'Trade Fair Complex, Ojo');
  const c1 = partner('customer', 'Lekki Homes Ltd', 'accounts@lekkihomes.test', '0812 000 3333', 'Admiralty Way, Lekki', 5_000_000);
  const c2 = partner('customer', 'Bright Hotel Ikoyi', 'finance@brighthotel.test', '0813 000 4444', 'Bourdillon Rd, Ikoyi', 3_000_000);
  const c3 = partner('customer', 'Mama Nkechi Stores', 'mamankechi@mail.test', '0814 000 5555', 'Oshodi Market');
  partner('customer', 'Yaba Tech Hub', 'ops@yabahub.test', '0815 000 6666', 'Herbert Macaulay Way, Yaba', 1_500_000);

  // Stock arrives from two purchase orders.
  const po1 = createOrder(db, adminId, 'purchase', { partner_id: sup1, lines: [
    { product_id: pid['TV-43'], qty: 12 }, { product_id: pid['TV-55'], qty: 5 }, { product_id: pid['SB-01'], qty: 10 },
    { product_id: pid['WM-HDMI'], qty: 30 }, { product_id: pid['CBL-HDMI'], qty: 60 } ] });
  transition(db, adminId, 'purchase', Number(po1.id), 'ordered');
  transition(db, adminId, 'purchase', Number(po1.id), 'received');
  const po2 = createOrder(db, adminId, 'purchase', { partner_id: sup2, lines: [
    { product_id: pid['GEN-35'], qty: 4 }, { product_id: pid['INV-15'], qty: 6 }, { product_id: pid['BAT-200'], qty: 8 } ] });
  transition(db, adminId, 'purchase', Number(po2.id), 'ordered');
  transition(db, adminId, 'purchase', Number(po2.id), 'received');
  const po3 = createOrder(db, adminId, 'purchase', { partner_id: sup2, lines: [{ product_id: pid['BAT-200'], qty: 10 }] });
  transition(db, adminId, 'purchase', Number(po3.id), 'ordered');

  // Sales at different stages.
  const sale = (cust: number, lines: { product_id: number; qty: number }[], upTo: 'draft' | 'confirmed' | 'delivered' | 'invoiced') => {
    const o = createOrder(db, adminId, 'sale', { partner_id: cust, lines });
    const steps = ['confirmed', 'delivered', 'invoiced'];
    for (const s of steps.slice(0, steps.indexOf(upTo) + 1)) {
      transition(db, adminId, 'sale', Number(o.id), s, s === 'invoiced' ? (ord) => issueInvoice(db, adminId, ord) : undefined);
    }
    return o;
  };
  sale(c1, [{ product_id: pid['TV-55'], qty: 2 }, { product_id: pid['WM-HDMI'], qty: 2 }, { product_id: pid['SB-01'], qty: 2 }], 'invoiced');
  sale(c2, [{ product_id: pid['TV-43'], qty: 6 }, { product_id: pid['WM-HDMI'], qty: 6 }, { product_id: pid['CBL-HDMI'], qty: 6 }], 'invoiced');
  sale(c3, [{ product_id: pid['GEN-35'], qty: 1 }, { product_id: pid['CBL-HDMI'], qty: 4 }], 'invoiced');
  sale(c1, [{ product_id: pid['INV-15'], qty: 2 }, { product_id: pid['BAT-200'], qty: 4 }], 'delivered');
  sale(c2, [{ product_id: pid['SB-01'], qty: 3 }], 'confirmed');
  sale(c3, [{ product_id: pid['TV-43'], qty: 1 }], 'draft');

  // Payments: one paid in full, one part-paid, one unpaid. Backdate one invoice so aging has an overdue line.
  const invs = db.prepare('SELECT id, total FROM invoices ORDER BY id').all() as { id: number; total: number }[];
  recordPayment(db, adminId, invs[0].id, { amount: invs[0].total, method: 'bank_transfer', reference: 'TRF-88213' });
  recordPayment(db, adminId, invs[1].id, { amount: Math.round(invs[1].total / 2), method: 'pos', reference: 'POS-4471' });
  db.prepare("UPDATE invoices SET issued_at = date('now','-50 days'), due_at = date('now','-20 days') WHERE id = ?").run(invs[2].id);
}
