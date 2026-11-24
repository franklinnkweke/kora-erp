import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureAdmin, seedDemo } from './seed.js';

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 16) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Set JWT_SECRET (at least 16 characters) before starting in production.');
    process.exit(1);
  }
}

const db = openDb();
const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@kora.test';
const adminPassword = process.env.ADMIN_PASSWORD ?? 'Demo#12345';
if (ensureAdmin(db, adminEmail, adminPassword)) console.log(`Created first admin: ${adminEmail}`);
if (process.env.SEED_DEMO !== 'false') seedDemo(db);

const port = Number(process.env.PORT ?? 3000);
const app = createApp(db, { jwtSecret: secret ?? 'dev-only-secret-change-me' });
const server = app.listen(port, () => console.log(`Kora ERP running on http://localhost:${port}  (API docs: /docs)`));

const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
