# Kora ERP

A small ERP (enterprise resource planning) system for a trading business: stock, sales, purchasing, invoicing and payments in one place. It is built with **Node.js, TypeScript and Express**, has a REST API and a web app, and every change is recorded in an activity log.

The demo data is a Lagos electronics distributor (TVs, generators, inverters, solar batteries), with prices in naira and 7.5% VAT.

## What it does

| Area | Features |
|---|---|
| **Products & stock** | Products with SKU, selling price, cost price and reorder level. Stock is a ledger of movements (receipts, deliveries, adjustments), so the history is never lost. Shows on hand, reserved and available, and flags low stock. Stock can never go below zero. |
| **Sales** | Orders go draft → confirmed → delivered → invoiced. Confirming checks there is enough available stock and that the customer stays within their credit limit, then reserves the stock. Delivery takes it out. |
| **Purchasing** | Orders go draft → placed → received. Receiving adds the stock. |
| **Invoicing & payments** | Invoices are created from delivered orders, with VAT and a 30-day due date. Supports part payments (cash, transfer, POS, card) and refuses overpayments. |
| **Reports** | Dashboard (monthly sales, cash in, money owed, overdue, stock value, best sellers, low stock), stock valuation and a receivables aging report (who owes what, and how late). |
| **Users & roles** | Admin, sales, warehouse and accounts. Each team can only do its own steps (for example, only warehouse can deliver and only accounts can take payments). |
| **Activity log** | Every create, update, status change and payment is logged with who did it and when. |

## How it's built

```
src/
  app.ts            Express app: routes, validation (zod), role checks
  db.ts             SQLite (node:sqlite), migrations, transactions, document numbers
  auth.ts           Password hashing (scrypt), JWT sign-in, role middleware
  http.ts           Error handling and helpers
  services/
    inventory.ts    Products and the stock ledger
    orders.ts       Sales and purchase order life cycles
    invoices.ts     Invoices, payments, credit balance, aging
    reports.ts      Dashboard and stock valuation
    audit.ts        Activity log
  seed.ts           First admin and demo data
public/             Web app (plain HTML, CSS and JavaScript) and OpenAPI docs
test/api.test.ts    API tests (node:test)
```

Design choices:
- **Money is stored in kobo** (whole numbers), so totals never pick up rounding errors.
- **Every multi-step change runs in a database transaction**, so a failed step leaves nothing half-done.
- **Stock is calculated from movements**, not edited in place, which keeps an audit trail.
- **The API is the source of truth.** The web app hides buttons a role can't use, but the server checks every request.
- Sign-in is protected against password guessing (5 tries, then a 5-minute lock).

## Run it

Needs Node.js 22.5 or newer.

```bash
npm install
npm run dev          # http://localhost:3000   API docs: http://localhost:3000/docs
```

Demo sign-ins (password `Demo#12345`): `admin@kora.test`, `sales@kora.test`, `warehouse@kora.test`, `accounts@kora.test`.

With Docker:

```bash
docker build -t kora-erp .
docker run -p 3000:3000 -v kora-data:/data \
  -e JWT_SECRET=$(openssl rand -hex 32) -e ADMIN_EMAIL=you@company.com -e ADMIN_PASSWORD=change-me \
  -e SEED_DEMO=false kora-erp
```

Settings are listed in `.env.example`.

## Tests and CI/CD

```bash
npm run typecheck
npm test
```

The API tests cover sign-in, roles, validation, the full purchase and sales flows, stock rules, credit limits, VAT, part payments and overpayment, reports and the activity log.

GitHub Actions (`.github/workflows/ci.yml`) runs the type check, tests and build on every push and pull request. On `main`, it then builds the Docker image and pushes it to GitHub Container Registry.

## API

The full API is documented at `/docs` (OpenAPI 3, `public/openapi.json`). Some examples:

```
POST /api/auth/login                  { email, password } -> { token, user }
GET  /api/products?low_stock=true
POST /api/sales-orders                { partner_id, lines: [{ product_id, qty }] }
POST /api/sales-orders/:id/confirm    checks stock and credit limit
POST /api/sales-orders/:id/deliver    takes stock out
POST /api/sales-orders/:id/invoice    creates the invoice with VAT
POST /api/invoices/:id/payments       { amount, method, reference }
GET  /api/reports/receivables
```

## Next steps

- Move from SQLite to PostgreSQL for many users at once
- Multiple warehouses and stock transfers
- Supplier bills and a simple general ledger
- PDF invoices and email reminders for overdue payments

MIT licence.
