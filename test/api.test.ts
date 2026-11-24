import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb, type DB } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureAdmin, seedDemo } from '../src/seed.js';
import { hashPassword } from '../src/auth.js';

let server: Server;
let base = '';
let db: DB;
const tok: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, who?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tok[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db, 'admin@test.ng', 'AdminPass#1');
  for (const r of ['sales', 'warehouse', 'accounts']) {
    db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(`${r}@test.ng`, r, r, hashPassword('UserPass#1'));
  }
  const app = createApp(db, { jwtSecret: 'test-secret-1234567890' });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  for (const r of ['admin', 'sales', 'warehouse', 'accounts']) {
    const res = await call('POST', '/auth/login', { email: `${r}@test.ng`, password: r === 'admin' ? 'AdminPass#1' : 'UserPass#1' });
    assert.equal(res.status, 200);
    tok[r] = res.body.token;
  }
});
after(() => { server.close(); db.close(); });

const ids: Record<string, number> = {};

test('health check and sign-in rules', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 'admin@test.ng', password: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/products')).status, 401, 'no token');
  assert.equal((await call('GET', '/me', undefined, 'sales')).body.role, 'sales');
});

test('repeated wrong passwords lock the account for a while', async () => {
  for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { email: 'sales@test.ng', password: 'nope' });
  assert.equal((await call('POST', '/auth/login', { email: 'sales@test.ng', password: 'UserPass#1' })).status, 429);
});

test('products: create, validate, duplicates and roles', async () => {
  const p = { sku: 'TV-43', name: '43in TV', price: 28_500_000, cost: 23_200_000, reorder_level: 2 };
  assert.equal((await call('POST', '/products', p, 'sales')).status, 403, 'sales cannot create products');
  const bad = await call('POST', '/products', { ...p, price: -5 }, 'warehouse');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.details[0].field, 'price');
  const ok = await call('POST', '/products', p, 'warehouse');
  assert.equal(ok.status, 201);
  assert.equal(ok.body.on_hand, 0);
  ids.tv = ok.body.id;
  assert.equal((await call('POST', '/products', { ...p, sku: 'tv-43' }, 'warehouse')).status, 409, 'SKU is unique, any case');
  ids.cable = (await call('POST', '/products', { sku: 'CBL', name: 'HDMI cable', price: 450_000, cost: 220_000 }, 'admin')).body.id;
});

test('stock adjustments cannot take stock below zero', async () => {
  const r = await call('POST', `/products/${ids.cable}/adjust`, { qty: -1, note: 'damaged' }, 'warehouse');
  assert.equal(r.status, 409);
  const up = await call('POST', `/products/${ids.cable}/adjust`, { qty: 20, note: 'opening stock' }, 'warehouse');
  assert.equal(up.body.on_hand, 20);
  const moves = await call('GET', `/products/${ids.cable}/moves`, undefined, 'warehouse');
  assert.equal(moves.body[0].reason, 'adjustment');
});

test('partners: customers and suppliers', async () => {
  ids.sup = (await call('POST', '/suppliers', { name: 'Ikeja Wholesale' }, 'warehouse')).body.id;
  assert.equal((await call('POST', '/customers', { name: 'X' }, 'warehouse')).status, 403);
  ids.cust = (await call('POST', '/customers', { name: 'Lekki Homes', email: 'a@lekki.ng', credit_limit: 100_000_000 }, 'sales')).body.id;
  ids.small = (await call('POST', '/customers', { name: 'Small Shop', credit_limit: 30_000_000 }, 'sales')).body.id;
  const list = await call('GET', '/customers', undefined, 'sales');
  assert.equal(list.body.length, 2);
  assert.equal(list.body[0].balance, 0);
});

test('purchase order flow adds stock only when received', async () => {
  const wrong = await call('POST', '/purchase-orders', { partner_id: ids.cust, lines: [{ product_id: ids.tv, qty: 5 }] }, 'warehouse');
  assert.equal(wrong.status, 400, 'a customer is not a supplier');
  const po = await call('POST', '/purchase-orders', { partner_id: ids.sup, lines: [{ product_id: ids.tv, qty: 5 }] }, 'warehouse');
  assert.equal(po.status, 201);
  assert.match(po.body.number, /^PO-\d{5}$/);
  assert.equal(po.body.total, 5 * 23_200_000, 'defaults to cost price');
  assert.equal((await call('POST', `/purchase-orders/${po.body.id}/receive`, {}, 'warehouse')).status, 409, 'must be placed first');
  assert.equal((await call('POST', `/purchase-orders/${po.body.id}/place`, {}, 'warehouse')).status, 403, 'accounts places orders');
  await call('POST', `/purchase-orders/${po.body.id}/place`, {}, 'accounts');
  assert.equal((await call('GET', `/products/${ids.tv}`, undefined, 'sales')).body.on_hand, 0);
  const rec = await call('POST', `/purchase-orders/${po.body.id}/receive`, {}, 'warehouse');
  assert.equal(rec.body.status, 'received');
  assert.equal((await call('GET', `/products/${ids.tv}`, undefined, 'sales')).body.on_hand, 5);
});

test('sales order: stock check, delivery, invoice with VAT, payments', async () => {
  const tooMany = await call('POST', '/sales-orders', { partner_id: ids.cust, lines: [{ product_id: ids.tv, qty: 9 }] }, 'sales');
  const short = await call('POST', `/sales-orders/${tooMany.body.id}/confirm`, {}, 'sales');
  assert.equal(short.status, 409);
  assert.deepEqual(short.body.details[0], { product: '43in TV', wanted: 9, available: 5 });
  const fixed = await call('PATCH', `/sales-orders/${tooMany.body.id}`, { lines: [{ product_id: ids.tv, qty: 2 }, { product_id: ids.cable, qty: 4 }] }, 'sales');
  assert.equal(fixed.body.total, 2 * 28_500_000 + 4 * 450_000);
  const so = fixed.body;

  const conf = await call('POST', `/sales-orders/${so.id}/confirm`, {}, 'sales');
  assert.equal(conf.body.status, 'confirmed');
  const tv = (await call('GET', `/products/${ids.tv}`, undefined, 'sales')).body;
  assert.equal(tv.on_hand, 5); assert.equal(tv.committed, 2); assert.equal(tv.available, 3);
  assert.equal((await call('PATCH', `/sales-orders/${so.id}`, { notes: 'x' }, 'sales')).status, 409, 'only drafts can change');
  assert.equal((await call('POST', `/sales-orders/${so.id}/invoice`, {}, 'accounts')).status, 409, 'deliver before invoicing');

  await call('POST', `/sales-orders/${so.id}/deliver`, {}, 'warehouse');
  assert.equal((await call('GET', `/products/${ids.tv}`, undefined, 'sales')).body.on_hand, 3);
  const inv = await call('POST', `/sales-orders/${so.id}/invoice`, {}, 'accounts');
  assert.equal(inv.body.status, 'invoiced');
  ids.inv = inv.body.invoice_id;

  const invoice = (await call('GET', `/invoices/${ids.inv}`, undefined, 'accounts')).body;
  assert.equal(invoice.subtotal, so.total);
  assert.equal(invoice.tax, Math.round(so.total * 0.075));
  assert.equal(invoice.total, invoice.subtotal + invoice.tax);
  assert.equal(invoice.lines.length, 2);

  assert.equal((await call('POST', `/invoices/${ids.inv}/payments`, { amount: 100, method: 'cash' }, 'sales')).status, 403);
  const part = await call('POST', `/invoices/${ids.inv}/payments`, { amount: 10_000_000, method: 'bank_transfer', reference: 'TRF1' }, 'accounts');
  assert.equal(part.body.status, 'part_paid');
  const over = await call('POST', `/invoices/${ids.inv}/payments`, { amount: invoice.total, method: 'cash' }, 'accounts');
  assert.equal(over.status, 409, 'cannot pay more than the balance');
  const rest = await call('POST', `/invoices/${ids.inv}/payments`, { amount: invoice.total - 10_000_000, method: 'pos' }, 'accounts');
  assert.equal(rest.body.status, 'paid');
  assert.equal(rest.body.payments.length, 2);
});

test('credit limit blocks orders that would go over it', async () => {
  const so = await call('POST', '/sales-orders', { partner_id: ids.small, lines: [{ product_id: ids.tv, qty: 2 }] }, 'sales');
  const r = await call('POST', `/sales-orders/${so.body.id}/confirm`, {}, 'sales');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /credit limit/);
  const ok = await call('PATCH', `/sales-orders/${so.body.id}`, { lines: [{ product_id: ids.tv, qty: 1 }] }, 'sales');
  assert.equal((await call('POST', `/sales-orders/${ok.body.id}/confirm`, {}, 'sales')).status, 200);
  const cancel = await call('POST', `/sales-orders/${ok.body.id}/cancel`, {}, 'sales');
  assert.equal(cancel.body.status, 'cancelled');
  assert.equal((await call('GET', `/products/${ids.tv}`, undefined, 'sales')).body.committed, 0, 'cancel frees the stock');
});

test('dashboard, reports and audit log', async () => {
  const d = (await call('GET', '/dashboard', undefined, 'sales')).body;
  assert.equal(d.receivables, 0);
  assert.ok(d.sales_this_month > 0);
  assert.equal(d.stock_value, 3 * 23_200_000 + 16 * 220_000);
  assert.equal((await call('GET', '/reports/receivables', undefined, 'warehouse')).status, 403);
  assert.equal((await call('GET', '/audit', undefined, 'sales')).status, 403);
  const log = (await call('GET', '/audit', undefined, 'admin')).body as { action: string }[];
  assert.ok(log.some((a) => a.action === 'payment'));
  assert.ok(log.some((a) => a.action === 'delivered'));
});

test('admin manages users but cannot lock themselves out', async () => {
  const u = await call('POST', '/users', { email: 'new@test.ng', name: 'New', role: 'sales', password: 'short' }, 'admin');
  assert.equal(u.status, 400);
  const ok = await call('POST', '/users', { email: 'new@test.ng', name: 'New', role: 'sales', password: 'LongEnough#1' }, 'admin');
  assert.equal(ok.status, 201);
  const me = (await call('GET', '/me', undefined, 'admin')).body;
  assert.equal((await call('PATCH', `/users/${me.id}`, { active: false }, 'admin')).status, 409);
  await call('PATCH', `/users/${ok.body.id}`, { active: false }, 'admin');
  assert.equal((await call('POST', '/auth/login', { email: 'new@test.ng', password: 'LongEnough#1' })).status, 401, 'disabled users cannot sign in');
});

test('demo data loads cleanly and stays consistent', () => {
  const d = openDb(':memory:');
  ensureAdmin(d, 'admin@kora.test', 'Demo#12345');
  seedDemo(d);
  const neg = d.prepare('SELECT product_id, SUM(qty) q FROM stock_moves GROUP BY product_id HAVING q < 0').all();
  assert.equal(neg.length, 0);
  const bad = d.prepare('SELECT COUNT(*) n FROM invoices WHERE paid > total OR total != subtotal + tax').get() as { n: number };
  assert.equal(bad.n, 0);
  assert.equal((d.prepare('SELECT COUNT(*) n FROM invoices').get() as { n: number }).n, 3);
  d.close();
});
