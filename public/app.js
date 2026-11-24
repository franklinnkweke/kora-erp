'use strict';
(() => {
  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const naira = (kobo) => '₦' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toKobo = (v) => Math.round(Number(String(v).replace(/[^0-9.]/g, '')) * 100);
  const date = (s) => (s ? new Date(s.replace(' ', 'T') + (s.length > 10 ? 'Z' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const pill = (s) => `<span class="pill ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
  let session = null;
  try { session = JSON.parse(localStorage.getItem('kora.session') || 'null'); } catch { /* storage blocked */ }

  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast'), 3200);
  }

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method, headers: { 'content-type': 'application/json', ...(session ? { authorization: 'Bearer ' + session.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 401 && path !== '/auth/login') { logout(); throw new Error('Please sign in again'); }
    if (!res.ok) {
      let msg = data?.error || 'Request failed';
      if (Array.isArray(data?.details)) msg += ': ' + data.details.map((d) => d.field ? `${d.field} ${d.message}` : d.product ? `${d.product} (want ${d.wanted}, have ${d.available})` : '').filter(Boolean).join('; ');
      throw new Error(msg);
    }
    return data;
  }

  // Who can do what (the server enforces the same rules).
  const can = (...roles) => session && (session.user.role === 'admin' || roles.includes(session.user.role));

  // ---------- sign in ----------
  function showLogin() { $('#shell').hidden = true; $('#login').hidden = false; $('#email').focus(); }
  function logout() { session = null; try { localStorage.removeItem('kora.session'); } catch {} showLogin(); }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      session = await api('POST', '/auth/login', { email: $('#email').value, password: $('#password').value });
      try { localStorage.setItem('kora.session', JSON.stringify(session)); } catch {}
      start();
    } catch (err) { $('#loginErr').textContent = err.message; }
  });
  document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => {
    $('#email').value = b.dataset.demo + '@kora.test'; $('#password').value = 'Demo#12345';
  }));
  $('#logout').addEventListener('click', logout);

  // ---------- navigation ----------
  const PAGES = [
    ['dashboard', 'Dashboard'], ['products', 'Products & stock'], ['sales', 'Sales orders'], ['purchases', 'Purchase orders'],
    ['invoices', 'Invoices'], ['customers', 'Customers'], ['suppliers', 'Suppliers'], ['receivables', 'Who owes us'],
    ['audit', 'Activity log', 'admin'], ['users', 'Users', 'admin'],
  ];
  function start() {
    $('#login').hidden = true; $('#shell').hidden = false;
    $('#whoName').textContent = session.user.name; $('#whoRole').textContent = session.user.role;
    $('#nav').innerHTML = PAGES.filter((p) => !p[2] || session.user.role === 'admin')
      .map(([k, l]) => `<a href="#${k}" data-k="${k}">${l}<span class="count" data-c="${k}" hidden></span></a>`).join('');
    route();
  }
  window.addEventListener('hashchange', route);

  async function route() {
    if (!session) return showLogin();
    const [page, id] = (location.hash.slice(1) || 'dashboard').split('-');
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === page));
    const main = $('#main');
    try {
      const fn = { dashboard, products, sales: (i) => orders('sale', i), purchases: (i) => orders('purchase', i), invoices, customers: () => partners('customers'), suppliers: () => partners('suppliers'), receivables, audit, users }[page];
      main.innerHTML = fn ? await fn(id) : '<p>Page not found.</p>';
      bind(main);
    } catch (err) { main.innerHTML = `<div class="card err">${esc(err.message)}</div>`; }
    main.focus({ preventScroll: true });
  }
  const refresh = () => route();

  // Elements with data-go navigate; data-act run actions.
  const ACTIONS = {};
  function bind(root) {
    root.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => (location.hash = el.dataset.go)));
    root.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', async () => {
      el.disabled = true;
      try { await ACTIONS[el.dataset.act](el.dataset); } catch (err) { toast(err.message, true); } finally { el.disabled = false; }
    }));
    root.querySelectorAll('[data-filter]').forEach((el) => el.addEventListener('input', () => {
      const q = el.value.toLowerCase();
      root.querySelectorAll('tbody tr').forEach((tr) => (tr.hidden = !tr.textContent.toLowerCase().includes(q)));
    }));
  }

  const table = (cols, rows, rowAttr = () => '') => rows.length
    ? `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th class="${c[2] || ''}">${c[0]}</th>`).join('')}</tr></thead>
       <tbody>${rows.map((r) => `<tr ${rowAttr(r)}>${cols.map((c) => `<td class="${c[2] || ''}">${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<div class="tablewrap"><div class="empty">Nothing here yet.</div></div>';

  // ---------- form dialog ----------
  function form(title, fieldsHtml, onSubmit, submitLabel = 'Save') {
    const dlg = $('#dlg'), f = $('#dlgForm');
    f.innerHTML = `<h2>${esc(title)}</h2>${fieldsHtml}<p class="err" id="dlgErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" id="dlgCancel">Cancel</button><button class="btn primary" value="ok">${esc(submitLabel)}</button></div>`;
    $('#dlgCancel').onclick = () => dlg.close();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await onSubmit(new FormData(f), f); dlg.close(); refresh(); }
      catch (err) { $('#dlgErr').textContent = err.message; }
    };
    dlg.showModal();
    f.querySelector('input,select')?.focus();
    return f;
  }

  // ---------- dashboard ----------
  async function dashboard() {
    const d = await api('GET', '/dashboard');
    const max = Math.max(1, ...d.sales_by_month.map((m) => m.total));
    const lowCount = $('[data-c="products"]');
    if (lowCount) { lowCount.hidden = !d.low_stock.length; lowCount.textContent = d.low_stock.length; }
    return `<div class="head"><h1 class="grow">Good to see you, ${esc(session.user.name.split(' ')[0])}</h1>
      ${can('sales') ? '<button class="btn primary" data-go="sales-new">New sales order</button>' : ''}</div>
      <div class="kpis">
        <div class="kpi"><span>Sales this month</span><b>${naira(d.sales_this_month)}</b></div>
        <div class="kpi"><span>Cash received this month</span><b>${naira(d.cash_in_this_month)}</b></div>
        <div class="kpi"><span>Customers owe us</span><b>${naira(d.receivables)}</b></div>
        <div class="kpi ${d.overdue ? 'alert' : ''}"><span>Overdue</span><b>${naira(d.overdue)}</b></div>
        <div class="kpi"><span>Stock value (at cost)</span><b>${naira(d.stock_value)}</b></div>
        <div class="kpi"><span>Open sales / purchase orders</span><b>${d.open_sales_orders} / ${d.open_purchase_orders}</b></div>
      </div>
      <div class="grid2">
        <div class="card"><h2>Invoiced sales by month</h2><div class="bars">${d.sales_by_month.length ? d.sales_by_month.map((m) =>
          `<div class="bar"><span>${esc(m.month)}</span><i style="width:${(m.total / max) * 100}%"></i><span class="v">${naira(m.total)}</span></div>`).join('') : '<p class="muted">No invoices yet.</p>'}</div></div>
        <div class="card"><h2>Running low</h2>${d.low_stock.length ? d.low_stock.map((p) =>
          `<p style="display:flex;justify-content:space-between;margin:6px 0"><span>${esc(p.name)}</span><span>${pill('low')} ${p.available} left (reorder at ${p.reorder_level})</span></p>`).join('') : '<p class="muted">All stock above reorder level.</p>'}</div>
        <div class="card"><h2>Best sellers</h2>${table([['Product', (r) => esc(r.name)], ['Qty', (r) => r.qty, 'num'], ['Revenue', (r) => naira(r.revenue), 'num']], d.top_products)}</div>
      </div>`;
  }

  // ---------- products ----------
  async function products() {
    const list = await api('GET', '/products?all=true');
    ACTIONS.newProduct = () => productForm();
    ACTIONS.editProduct = ({ id }) => productForm(list.find((p) => p.id == id));
    ACTIONS.adjust = ({ id }) => {
      const p = list.find((x) => x.id == id);
      form(`Adjust stock: ${p.name}`, `<p class="muted">On hand now: <b>${p.on_hand}</b>. Use a minus number to remove stock.</p>
        <div class="row"><label>Change (+/-)<input name="qty" type="number" step="1" required></label><label>Reason<input name="note" required placeholder="e.g. stock count, damaged"></label></div>`,
        async (fd) => { await api('POST', `/products/${id}/adjust`, { qty: Number(fd.get('qty')), note: fd.get('note') }); toast('Stock updated'); });
    };
    ACTIONS.moves = async ({ id }) => {
      const m = await api('GET', `/products/${id}/moves`);
      form('Stock history', table([['When', (r) => date(r.created_at)], ['Change', (r) => (r.qty > 0 ? '+' : '') + r.qty, 'num'], ['Why', (r) => esc(r.reason)], ['Ref', (r) => esc(r.ref || r.note)], ['By', (r) => esc(r.user_name)]], m), async () => {}, 'Close');
    };
    const w = can('warehouse');
    return `<div class="head"><h1 class="grow">Products & stock</h1>${w ? '<button class="btn primary" data-act="newProduct">Add product</button>' : ''}</div>
      <div class="toolbar"><input data-filter placeholder="Search products" aria-label="Search products"></div>
      ${table([
        ['SKU', (r) => esc(r.sku)], ['Name', (r) => esc(r.name) + (r.active ? '' : ' ' + pill('inactive'))],
        ['Price', (r) => naira(r.price), 'num'], ['Cost', (r) => naira(r.cost), 'num'],
        ['On hand', (r) => r.on_hand, 'num'], ['Reserved', (r) => r.committed, 'num'],
        ['Available', (r) => `${r.available}${r.low_stock ? ' ' + pill('low') : ''}`, 'num'],
        ['', (r) => `<button class="link" data-act="moves" data-id="${r.id}">History</button>${w ? ` · <button class="link" data-act="adjust" data-id="${r.id}">Adjust</button> · <button class="link" data-act="editProduct" data-id="${r.id}">Edit</button>` : ''}`],
      ], list)}`;
  }
  function productForm(p) {
    form(p ? `Edit ${p.name}` : 'New product', `
      <div class="row"><label>SKU<input name="sku" required value="${esc(p?.sku)}"></label><label>Unit<input name="unit" value="${esc(p?.unit || 'pcs')}"></label></div>
      <label>Name<input name="name" required value="${esc(p?.name)}"></label>
      <div class="row"><label>Selling price (₦)<input name="price" inputmode="decimal" required value="${p ? p.price / 100 : ''}"></label>
      <label>Cost price (₦)<input name="cost" inputmode="decimal" required value="${p ? p.cost / 100 : ''}"></label>
      <label>Reorder at<input name="reorder_level" type="number" min="0" value="${p?.reorder_level ?? 0}"></label></div>
      ${p ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" style="width:auto" ${p.active ? 'checked' : ''}> Still selling this</label>` : ''}`,
      async (fd) => {
        const body = { sku: fd.get('sku'), name: fd.get('name'), unit: fd.get('unit'), price: toKobo(fd.get('price')), cost: toKobo(fd.get('cost')), reorder_level: Number(fd.get('reorder_level')) };
        if (p) await api('PATCH', `/products/${p.id}`, { ...body, active: fd.get('active') === 'on' }); else await api('POST', '/products', body);
        toast('Product saved');
      });
  }

  // ---------- customers / suppliers ----------
  async function partners(path) {
    const list = await api('GET', '/' + path);
    const cust = path === 'customers';
    const editable = cust ? can('sales', 'accounts') : can('warehouse', 'accounts');
    const edit = (p) => form(p ? `Edit ${p.name}` : cust ? 'New customer' : 'New supplier', `
      <label>Name<input name="name" required value="${esc(p?.name)}"></label>
      <div class="row"><label>Email<input name="email" type="email" value="${esc(p?.email)}"></label><label>Phone<input name="phone" value="${esc(p?.phone)}"></label></div>
      <label>Address<input name="address" value="${esc(p?.address)}"></label>
      ${cust ? `<label>Credit limit (₦, 0 = none)<input name="credit_limit" inputmode="decimal" value="${p ? p.credit_limit / 100 : 0}"></label>` : ''}`,
      async (fd) => {
        const b = { name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), address: fd.get('address') };
        if (cust) b.credit_limit = toKobo(fd.get('credit_limit') || 0);
        await api(p ? 'PATCH' : 'POST', `/${path}${p ? '/' + p.id : ''}`, b); toast('Saved');
      });
    ACTIONS.newPartner = () => edit();
    ACTIONS.editPartner = ({ id }) => edit(list.find((x) => x.id == id));
    return `<div class="head"><h1 class="grow">${cust ? 'Customers' : 'Suppliers'}</h1>${editable ? `<button class="btn primary" data-act="newPartner">Add ${cust ? 'customer' : 'supplier'}</button>` : ''}</div>
      <div class="toolbar"><input data-filter placeholder="Search" aria-label="Search"></div>
      ${table([
        ['Name', (r) => esc(r.name)], ['Phone', (r) => esc(r.phone)], ['Email', (r) => esc(r.email)],
        ...(cust ? [['Credit limit', (r) => (r.credit_limit ? naira(r.credit_limit) : 'None'), 'num'], ['Owes', (r) => naira(r.balance), 'num']] : [['Address', (r) => esc(r.address)]]),
        ['', (r) => (editable ? `<button class="link" data-act="editPartner" data-id="${r.id}">Edit</button>` : '')],
      ], list)}`;
  }

  // ---------- orders ----------
  const STEP = {
    sale: { confirmed: ['confirm', 'Confirm order', ['sales']], delivered: ['deliver', 'Mark delivered', ['warehouse']], invoiced: ['invoice', 'Create invoice', ['accounts']], cancelled: ['cancel', 'Cancel', ['sales']] },
    purchase: { ordered: ['place', 'Place with supplier', ['accounts']], received: ['receive', 'Receive stock', ['warehouse']], cancelled: ['cancel', 'Cancel', ['warehouse', 'accounts']] },
  };
  async function orders(kind, id) {
    const path = kind === 'sale' ? 'sales-orders' : 'purchase-orders';
    const page = kind === 'sale' ? 'sales' : 'purchases';
    const editors = kind === 'sale' ? ['sales'] : ['warehouse', 'accounts'];
    if (id === 'new') { setTimeout(() => orderForm(kind, path, page), 0); location.replace('#' + page); return ''; }
    if (id) return orderDetail(kind, path, page, Number(id), editors);
    const list = await api('GET', '/' + path);
    ACTIONS.newOrder = () => orderForm(kind, path, page);
    return `<div class="head"><h1 class="grow">${kind === 'sale' ? 'Sales orders' : 'Purchase orders'}</h1>${can(...editors) ? '<button class="btn primary" data-act="newOrder">New order</button>' : ''}</div>
      <div class="toolbar"><input data-filter placeholder="Search by number, name or status" aria-label="Search orders"></div>
      ${table([['Number', (r) => `<b>${esc(r.number)}</b>`], [kind === 'sale' ? 'Customer' : 'Supplier', (r) => esc(r.partner_name)], ['Date', (r) => date(r.created_at)],
        ['Lines', (r) => r.line_count, 'num'], ['Total', (r) => naira(r.total), 'num'], ['Status', (r) => pill(r.status)]],
        list, (r) => `class="click" data-go="${page}-${r.id}"`)}`;
  }
  async function orderDetail(kind, path, page, id, editors) {
    const o = await api('GET', `/${path}/${id}`);
    ACTIONS.step = async ({ to }) => {
      const [action, label] = STEP[kind][to];
      await api('POST', `/${path}/${id}/${action}`); toast(`${label}: done`); refresh();
    };
    ACTIONS.editOrder = () => orderForm(kind, path, page, o);
    const steps = o.next_steps.filter((s) => can(...STEP[kind][s][2]))
      .map((s) => `<button class="btn ${s === 'cancelled' ? 'danger' : 'primary'}" data-act="step" data-to="${s}">${STEP[kind][s][1]}</button>`).join('');
    const waiting = o.next_steps.filter((s) => s !== 'cancelled' && !can(...STEP[kind][s][2])).map((s) => `${STEP[kind][s][1]} (${STEP[kind][s][2].join(' or ')} team)`);
    return `<div class="head"><button class="btn" data-go="${page}">← Back</button><h1 class="grow">${esc(o.number)} ${pill(o.status)}</h1>
        <div class="steps">${o.status === 'draft' && can(...editors) ? '<button class="btn" data-act="editOrder">Edit</button>' : ''}${steps}
        ${o.invoice_id ? `<button class="btn" data-go="invoices-${o.invoice_id}">View invoice</button>` : ''}</div></div>
      ${waiting.length ? `<p class="muted">Next step: ${esc(waiting.join(', '))}.</p>` : ''}
      <div class="card"><div class="meta"><div><span>${kind === 'sale' ? 'Customer' : 'Supplier'}</span>${esc(o.partner_name)}</div><div><span>Created</span>${date(o.created_at)} by ${esc(o.created_by_name)}</div>
        <div><span>Notes</span>${esc(o.notes || '—')}</div></div>
      ${table([['SKU', (r) => esc(r.sku)], ['Product', (r) => esc(r.product_name)], ['Qty', (r) => `${r.qty} ${esc(r.unit)}`, 'num'], ['Unit price', (r) => naira(r.unit_price), 'num'], ['Line total', (r) => naira(r.line_total), 'num']], o.lines)}
      <div class="totals"><div class="big"><span>Total${kind === 'sale' ? ' (before VAT)' : ''}</span><span>${naira(o.total)}</span></div></div></div>`;
  }
  async function orderForm(kind, path, page, o) {
    const [partners, prods] = await Promise.all([api('GET', kind === 'sale' ? '/customers' : '/suppliers'), api('GET', '/products')]);
    const opt = (list, sel, label) => list.map((x) => `<option value="${x.id}" ${x.id == sel ? 'selected' : ''}>${esc(label(x))}</option>`).join('');
    const lineRow = (l = {}) => `<div class="line"><label>Product<select name="product_id" required><option value="">Choose…</option>${opt(prods, l.product_id, (p) => `${p.name} (${p.sku}) · ${p.available} available`)}</select></label>
      <label>Qty<input name="qty" type="number" min="1" step="1" required value="${l.qty || 1}"></label><button type="button" class="btn" data-rm aria-label="Remove line">✕</button></div>`;
    const f = form(o ? `Edit ${o.number}` : kind === 'sale' ? 'New sales order' : 'New purchase order', `
      <label>${kind === 'sale' ? 'Customer' : 'Supplier'}<select name="partner_id" required><option value="">Choose…</option>${opt(partners, o?.partner_id, (p) => p.name)}</select></label>
      <div id="lines" style="display:grid;gap:8px">${(o?.lines.length ? o.lines : [{}]).map(lineRow).join('')}</div>
      <button type="button" class="link" id="addLine" style="justify-self:start">+ Add another product</button>
      <label>Notes<input name="notes" value="${esc(o?.notes)}"></label>
      <p class="muted small">Prices default to the product's ${kind === 'sale' ? 'selling' : 'cost'} price.</p>`,
      async (fd, form) => {
        const lines = [...form.querySelectorAll('.line')].map((r) => ({ product_id: Number(r.querySelector('select').value), qty: Number(r.querySelector('input').value) }));
        const body = { partner_id: Number(fd.get('partner_id')), lines, notes: fd.get('notes') || undefined };
        const saved = o ? await api('PATCH', `/${path}/${o.id}`, body) : await api('POST', '/' + path, body);
        toast(`${saved.number} saved`);
        if (!o) setTimeout(() => (location.hash = `${page}-${saved.id}`), 0);
      }, o ? 'Save changes' : 'Create order');
    const wire = () => f.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { if (f.querySelectorAll('.line').length > 1) b.closest('.line').remove(); }));
    $('#addLine', f).onclick = () => { $('#lines', f).insertAdjacentHTML('beforeend', lineRow()); wire(); };
    wire();
  }

  // ---------- invoices ----------
  async function invoices(id) {
    if (id) return invoiceDetail(Number(id));
    const list = await api('GET', '/invoices');
    return `<div class="head"><h1 class="grow">Invoices</h1></div>
      <div class="toolbar"><input data-filter placeholder="Search invoices" aria-label="Search invoices"></div>
      ${table([['Number', (r) => `<b>${esc(r.number)}</b>`], ['Customer', (r) => esc(r.customer_name)], ['Issued', (r) => date(r.issued_at)],
        ['Due', (r) => date(r.due_at) + (r.overdue ? ' ' + pill('overdue') : '')], ['Total', (r) => naira(r.total), 'num'], ['Balance', (r) => naira(r.balance), 'num'], ['Status', (r) => pill(r.status)]],
        list, (r) => `class="click" data-go="invoices-${r.id}"`)}`;
  }
  async function invoiceDetail(id) {
    const i = await api('GET', `/invoices/${id}`);
    ACTIONS.pay = () => form(`Record payment for ${i.number}`, `<p class="muted">Balance: <b>${naira(i.balance)}</b></p>
      <div class="row"><label>Amount (₦)<input name="amount" inputmode="decimal" required value="${i.balance / 100}"></label>
      <label>Method<select name="method"><option value="bank_transfer">Bank transfer</option><option value="pos">POS</option><option value="cash">Cash</option><option value="card">Card</option></select></label></div>
      <label>Reference<input name="reference" placeholder="e.g. transfer reference"></label>`,
      async (fd) => { await api('POST', `/invoices/${id}/payments`, { amount: toKobo(fd.get('amount')), method: fd.get('method'), reference: fd.get('reference') || undefined }); toast('Payment recorded'); }, 'Record payment');
    return `<div class="head"><button class="btn" data-go="invoices">← Back</button><h1 class="grow">${esc(i.number)} ${pill(i.status)}${i.overdue ? ' ' + pill('overdue') : ''}</h1>
        ${i.balance > 0 && can('accounts') ? '<button class="btn primary" data-act="pay">Record payment</button>' : ''}</div>
      <div class="card"><div class="meta"><div><span>Customer</span>${esc(i.customer_name)}</div><div><span>Order</span>${esc(i.order_number)}</div>
        <div><span>Issued</span>${date(i.issued_at)}</div><div><span>Due</span>${date(i.due_at)}</div></div>
      ${table([['Product', (r) => esc(r.product_name)], ['Qty', (r) => r.qty, 'num'], ['Unit price', (r) => naira(r.unit_price), 'num'], ['Amount', (r) => naira(r.line_total), 'num']], i.lines)}
      <div class="totals"><div><span>Subtotal</span><span>${naira(i.subtotal)}</span></div><div><span>VAT</span><span>${naira(i.tax)}</span></div>
        <div class="big"><span>Total</span><span>${naira(i.total)}</span></div><div><span>Paid</span><span>${naira(i.paid)}</span></div><div class="big"><span>Balance</span><span>${naira(i.balance)}</span></div></div></div>
      <h2 style="margin-top:20px">Payments</h2>
      ${table([['Date', (r) => date(r.paid_at)], ['Method', (r) => esc(r.method.replace('_', ' '))], ['Reference', (r) => esc(r.reference)], ['By', (r) => esc(r.user_name)], ['Amount', (r) => naira(r.amount), 'num']], i.payments)}`;
  }

  // ---------- reports / admin ----------
  async function receivables() {
    if (!can('accounts', 'sales')) return '<div class="card">Only the sales and accounts teams can see this.</div>';
    const rows = await api('GET', '/reports/receivables');
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    return `<div class="head"><h1 class="grow">Who owes us</h1></div><p class="muted">Unpaid invoices grouped by how late they are.</p>
      ${table([['Customer', (r) => esc(r.customer_name)], ['Not yet due', (r) => naira(r.current), 'num'], ['1–30 days late', (r) => naira(r.days_1_30), 'num'],
        ['31–60 days late', (r) => naira(r.days_31_60), 'num'], ['Over 60 days', (r) => naira(r.over_60), 'num'], ['Total', (r) => `<b>${naira(r.total)}</b>`, 'num']],
        rows.length ? [...rows, { customer_name: 'Total', current: sum('current'), days_1_30: sum('days_1_30'), days_31_60: sum('days_31_60'), over_60: sum('over_60'), total: sum('total') }] : [])}`;
  }
  async function audit() {
    const rows = await api('GET', '/audit?limit=200');
    return `<div class="head"><h1 class="grow">Activity log</h1></div><div class="toolbar"><input data-filter placeholder="Search activity" aria-label="Search activity"></div>
      ${table([['When', (r) => esc(r.at)], ['Who', (r) => esc(r.user_name)], ['Action', (r) => esc(r.action)], ['Record', (r) => esc(r.entity.replace('_', ' '))], ['Detail', (r) => esc(r.detail)]], rows)}`;
  }
  async function users() {
    const rows = await api('GET', '/users');
    ACTIONS.newUser = () => form('Add a user', `<div class="row"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label></div>
      <div class="row"><label>Role<select name="role"><option>sales</option><option>warehouse</option><option>accounts</option><option>admin</option></select></label>
      <label>Temporary password<input name="password" type="password" minlength="8" required></label></div>`,
      async (fd) => { await api('POST', '/users', Object.fromEntries(fd)); toast('User added'); });
    ACTIONS.toggleUser = async ({ id, active }) => { await api('PATCH', `/users/${id}`, { active: active !== '1' }); refresh(); };
    return `<div class="head"><h1 class="grow">Users</h1><button class="btn primary" data-act="newUser">Add user</button></div>
      ${table([['Name', (r) => esc(r.name)], ['Email', (r) => esc(r.email)], ['Role', (r) => pill(r.role)], ['Status', (r) => (r.active ? 'Active' : pill('disabled'))],
        ['', (r) => (r.id === session.user.id ? '' : `<button class="link" data-act="toggleUser" data-id="${r.id}" data-active="${r.active}">${r.active ? 'Disable' : 'Enable'}</button>`)]], rows)}`;
  }

  session ? start() : showLogin();
})();
