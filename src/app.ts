import express, { Router } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { DB } from './db.js';
import { tx } from './db.js';
import { can, checkPassword, hashPassword, requireAuth, signToken, type AuthUser } from './auth.js';
import { HttpError, conflict, errorHandler, h, idParam, notFound, parse } from './http.js';
import { adjustStock, createProduct, getProduct, listProducts, stockMoves, updateProduct } from './services/inventory.js';
import { createOrder, getOrder, listOrders, transition, updateDraft, type OrderKind } from './services/orders.js';
import { agingReport, customerBalance, getInvoice, issueInvoice, listInvoices, recordPayment } from './services/invoices.js';
import { dashboard, stockReport } from './services/reports.js';
import { audit, listAudit } from './services/audit.js';

const here = dirname(fileURLToPath(import.meta.url));

// ---- validation schemas (money is in minor units: 150000 = ₦1,500.00) ----
const money = z.number().int().min(0);
const ProductIn = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(12).optional(),
  price: money, cost: money,
  reorder_level: z.number().int().min(0).optional(),
});
const ProductPatch = ProductIn.partial().extend({ active: z.boolean().optional() });
const PartnerIn = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(240).optional(),
  credit_limit: money.optional(),
});
const LineIn = z.object({ product_id: z.number().int().positive(), qty: z.number().int().positive(), unit_price: money.optional() });
const OrderIn = z.object({ partner_id: z.number().int().positive(), lines: z.array(LineIn).min(1).max(100), notes: z.string().max(500).optional() });
const OrderPatch = OrderIn.partial();
const PaymentIn = z.object({
  amount: z.number().int().positive(),
  method: z.enum(['cash', 'bank_transfer', 'card', 'pos']),
  reference: z.string().trim().max(80).optional(),
});
const UserIn = z.object({
  email: z.string().trim().email(), name: z.string().trim().min(1).max(80),
  role: z.enum(['admin', 'sales', 'warehouse', 'accounts']), password: z.string().min(8).max(200),
});

export function createApp(db: DB, opts: { jwtSecret: string }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    next();
  });

  const api = Router();
  api.get('/health', (_req, res) => res.json({ ok: true }));

  // ---- auth ----
  const attempts = new Map<string, { n: number; until: number }>();
  api.post('/auth/login', h((req, res) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const key = email.toLowerCase();
    const a = attempts.get(key);
    if (a && a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as (AuthUser & { password_hash: string; active: number }) | undefined;
    if (!u || !u.active || !checkPassword(password, u.password_hash)) {
      const n = (a?.n ?? 0) + 1;
      attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
      throw new HttpError(401, 'Wrong email or password');
    }
    attempts.delete(key);
    const user: AuthUser = { id: u.id, email: u.email, name: u.name, role: u.role };
    res.json({ token: signToken(user, opts.jwtSecret), user });
  }));

  api.use(requireAuth(opts.jwtSecret));
  api.get('/me', (req, res) => res.json(req.user));

  // ---- users (admin) ----
  api.get('/users', can(), h((_req, res) => res.json(db.prepare('SELECT id, email, name, role, active, created_at FROM users ORDER BY id').all())));
  api.post('/users', can(), h((req, res) => {
    const u = parse(UserIn, req.body);
    const r = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(u.email, u.name, u.role, hashPassword(u.password));
    audit(db, req.user!.id, 'create', 'user', Number(r.lastInsertRowid), `${u.email} (${u.role})`);
    res.status(201).json({ id: Number(r.lastInsertRowid), email: u.email, name: u.name, role: u.role, active: 1 });
  }));
  api.patch('/users/:id', can(), h((req, res) => {
    const id = idParam(req);
    const p = parse(z.object({ role: UserIn.shape.role.optional(), active: z.boolean().optional() }), req.body);
    if (id === req.user!.id && (p.active === false || (p.role && p.role !== 'admin'))) throw conflict('You cannot lock yourself out');
    const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as { role: string; active: number } | undefined;
    if (!cur) throw notFound('User');
    db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(p.role ?? cur.role, p.active === undefined ? cur.active : p.active ? 1 : 0, id);
    audit(db, req.user!.id, 'update', 'user', id, JSON.stringify(p));
    res.json(db.prepare('SELECT id, email, name, role, active FROM users WHERE id = ?').get(id));
  }));

  // ---- products and stock ----
  api.get('/products', h((req, res) => res.json(listProducts(db, {
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    lowStock: req.query.low_stock === 'true',
    includeInactive: req.query.all === 'true',
  }))));
  api.get('/products/:id', h((req, res) => res.json(getProduct(db, idParam(req)))));
  api.get('/products/:id/moves', h((req, res) => res.json(stockMoves(db, idParam(req)))));
  api.post('/products', can('warehouse'), h((req, res) => res.status(201).json(createProduct(db, req.user!.id, parse(ProductIn, req.body)))));
  api.patch('/products/:id', can('warehouse'), h((req, res) => res.json(updateProduct(db, req.user!.id, idParam(req), parse(ProductPatch, req.body)))));
  api.post('/products/:id/adjust', can('warehouse'), h((req, res) => {
    const b = parse(z.object({ qty: z.number().int().refine((n) => n !== 0, 'Cannot be zero'), note: z.string().trim().min(3).max(200) }), req.body);
    res.json(adjustStock(db, req.user!.id, idParam(req), b.qty, b.note));
  }));

  // ---- customers and suppliers ----
  for (const [path, kind, roles] of [['customers', 'customer', ['sales', 'accounts']], ['suppliers', 'supplier', ['warehouse', 'accounts']]] as const) {
    api.get(`/${path}`, h((req, res) => {
      const q = typeof req.query.q === 'string' ? `%${req.query.q}%` : '%';
      const rows = db.prepare('SELECT * FROM partners WHERE kind = ? AND name LIKE ? ORDER BY name').all(kind, q) as { id: number }[];
      res.json(kind === 'customer' ? rows.map((r) => ({ ...r, balance: customerBalance(db, r.id) })) : rows);
    }));
    api.get(`/${path}/:id`, h((req, res) => {
      const r = db.prepare('SELECT * FROM partners WHERE id = ? AND kind = ?').get(idParam(req), kind) as { id: number } | undefined;
      if (!r) throw notFound(kind === 'customer' ? 'Customer' : 'Supplier');
      res.json(kind === 'customer' ? { ...r, balance: customerBalance(db, r.id) } : r);
    }));
    api.post(`/${path}`, can(...roles), h((req, res) => {
      const p = parse(PartnerIn, req.body);
      const r = db.prepare('INSERT INTO partners (kind, name, email, phone, address, credit_limit) VALUES (?, ?, ?, ?, ?, ?)')
        .run(kind, p.name, p.email || null, p.phone ?? null, p.address ?? null, p.credit_limit ?? 0);
      audit(db, req.user!.id, 'create', kind, Number(r.lastInsertRowid), p.name);
      res.status(201).json(db.prepare('SELECT * FROM partners WHERE id = ?').get(Number(r.lastInsertRowid)));
    }));
    api.patch(`/${path}/:id`, can(...roles), h((req, res) => {
      const id = idParam(req);
      const p = parse(PartnerIn.partial(), req.body);
      const cur = db.prepare('SELECT * FROM partners WHERE id = ? AND kind = ?').get(id, kind) as Record<string, string | number | null> | undefined;
      if (!cur) throw notFound(kind === 'customer' ? 'Customer' : 'Supplier');
      const n = { ...cur, ...p };
      db.prepare('UPDATE partners SET name = ?, email = ?, phone = ?, address = ?, credit_limit = ? WHERE id = ?')
        .run(String(n.name), n.email || null, n.phone ?? null, n.address ?? null, n.credit_limit ?? 0, id);
      audit(db, req.user!.id, 'update', kind, id, JSON.stringify(p));
      res.json(db.prepare('SELECT * FROM partners WHERE id = ?').get(id));
    }));
  }

  // ---- sales and purchase orders ----
  const orderRoutes = (path: string, kind: OrderKind, editors: Parameters<typeof can>, steps: Record<string, { to: string; roles: Parameters<typeof can> }>) => {
    api.get(`/${path}`, h((req, res) => res.json(listOrders(db, kind, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      partnerId: req.query.partner_id ? Number(req.query.partner_id) : undefined,
    }))));
    api.get(`/${path}/:id`, h((req, res) => res.json(getOrder(db, kind, idParam(req)))));
    api.post(`/${path}`, can(...editors), h((req, res) => res.status(201).json(createOrder(db, req.user!.id, kind, parse(OrderIn, req.body)))));
    api.patch(`/${path}/:id`, can(...editors), h((req, res) => res.json(updateDraft(db, req.user!.id, kind, idParam(req), parse(OrderPatch, req.body)))));
    for (const [action, s] of Object.entries(steps)) {
      api.post(`/${path}/:id/${action}`, can(...s.roles), h((req, res) => {
        const extra = s.to === 'invoiced' ? (o: Parameters<typeof issueInvoice>[2]) => issueInvoice(db, req.user!.id, o) : undefined;
        res.json(transition(db, req.user!.id, kind, idParam(req), s.to, extra));
      }));
    }
  };
  orderRoutes('sales-orders', 'sale', ['sales'], {
    confirm: { to: 'confirmed', roles: ['sales'] },
    deliver: { to: 'delivered', roles: ['warehouse'] },
    invoice: { to: 'invoiced', roles: ['accounts'] },
    cancel: { to: 'cancelled', roles: ['sales'] },
  });
  orderRoutes('purchase-orders', 'purchase', ['warehouse', 'accounts'], {
    place: { to: 'ordered', roles: ['accounts'] },
    receive: { to: 'received', roles: ['warehouse'] },
    cancel: { to: 'cancelled', roles: ['warehouse', 'accounts'] },
  });

  // ---- invoices and payments ----
  api.get('/invoices', h((req, res) => res.json(listInvoices(db, {
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    customerId: req.query.customer_id ? Number(req.query.customer_id) : undefined,
  }))));
  api.get('/invoices/:id', h((req, res) => res.json(getInvoice(db, idParam(req)))));
  api.post('/invoices/:id/payments', can('accounts'), h((req, res) => res.status(201).json(recordPayment(db, req.user!.id, idParam(req), parse(PaymentIn, req.body)))));

  // ---- reports ----
  api.get('/dashboard', h((_req, res) => res.json(dashboard(db))));
  api.get('/reports/stock', h((_req, res) => res.json(stockReport(db))));
  api.get('/reports/receivables', can('accounts', 'sales'), h((_req, res) => res.json(agingReport(db))));
  api.get('/audit', can(), h((req, res) => res.json(listAudit(db, Number(req.query.limit ?? 100)))));

  api.use((_req, _res, next) => next(notFound('Endpoint')));
  app.use('/api', api);

  // ---- web app and API docs ----
  const pub = join(here, '..', 'public');
  app.use(express.static(pub, { index: 'index.html', maxAge: '1h' }));
  app.get('/docs', (_req, res) => res.sendFile(join(pub, 'docs.html')));
  app.use(errorHandler);
  return app;
}

export { tx };
