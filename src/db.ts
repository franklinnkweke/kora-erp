import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

/**
 * Schema migrations. Each entry runs once, in order, and is recorded in `migrations`.
 * Money is stored as whole minor units (kobo / cents) so totals never drift.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin','sales','warehouse','accounts')),
     password_hash TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE products (
     id INTEGER PRIMARY KEY,
     sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL,
     unit TEXT NOT NULL DEFAULT 'pcs',
     price INTEGER NOT NULL CHECK (price >= 0),
     cost INTEGER NOT NULL CHECK (cost >= 0),
     reorder_level INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   -- Stock is never edited in place: every change is a row here, and on-hand = SUM(qty).
   CREATE TABLE stock_moves (
     id INTEGER PRIMARY KEY,
     product_id INTEGER NOT NULL REFERENCES products(id),
     qty INTEGER NOT NULL,
     reason TEXT NOT NULL CHECK (reason IN ('receipt','delivery','adjustment')),
     ref TEXT,
     note TEXT,
     user_id INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX stock_moves_product ON stock_moves(product_id);
   CREATE TABLE partners (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('customer','supplier')),
     name TEXT NOT NULL,
     email TEXT,
     phone TEXT,
     address TEXT,
     credit_limit INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE orders (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('sale','purchase')),
     number TEXT NOT NULL UNIQUE,
     partner_id INTEGER NOT NULL REFERENCES partners(id),
     status TEXT NOT NULL,
     notes TEXT,
     total INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE order_lines (
     id INTEGER PRIMARY KEY,
     order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
     product_id INTEGER NOT NULL REFERENCES products(id),
     qty INTEGER NOT NULL CHECK (qty > 0),
     unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
     line_total INTEGER NOT NULL
   );
   CREATE TABLE invoices (
     id INTEGER PRIMARY KEY,
     number TEXT NOT NULL UNIQUE,
     order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
     partner_id INTEGER NOT NULL REFERENCES partners(id),
     subtotal INTEGER NOT NULL,
     tax INTEGER NOT NULL,
     total INTEGER NOT NULL,
     paid INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL CHECK (status IN ('unpaid','part_paid','paid')),
     issued_at TEXT NOT NULL DEFAULT (date('now')),
     due_at TEXT NOT NULL
   );
   CREATE TABLE payments (
     id INTEGER PRIMARY KEY,
     invoice_id INTEGER NOT NULL REFERENCES invoices(id),
     amount INTEGER NOT NULL CHECK (amount > 0),
     method TEXT NOT NULL,
     reference TEXT,
     user_id INTEGER REFERENCES users(id),
     paid_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY,
     user_id INTEGER REFERENCES users(id),
     action TEXT NOT NULL,
     entity TEXT NOT NULL,
     entity_id INTEGER,
     detail TEXT,
     at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`,
];

export function openDb(file = process.env.DB_FILE ?? 'data/kora.db'): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT id FROM migrations').all() as { id: number }[]).map((r) => r.id));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    tx(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (id, at) VALUES (?, datetime('now'))").run(i + 1);
    });
  });
  return db;
}

/** Runs fn inside a transaction; rolls back on any error. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Gapless document numbers such as SO-00012, PO-00003, INV-00007. */
export function nextNumber(db: DB, prefix: string): string {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(prefix);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(prefix);
  const { value } = db.prepare('SELECT value FROM counters WHERE name = ?').get(prefix) as { value: number };
  return `${prefix}-${String(value).padStart(5, '0')}`;
}
