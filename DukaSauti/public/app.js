const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  shop: null,
  qvac: null,
  proposal: null,
  today: localDate(),
  cart: [],
  products: [],
  customers: [],
  suppliers: [],
  activeShiftPosition: null
};

const money = (minor) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' }).format((Number(minor || 0)) / 100);

const amountToMinor = (value) => {
  const s = String(value ?? '').trim().replaceAll(',', '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) throw new Error('Enter a valid amount with up to two decimal places.');
  const isNeg = s.startsWith('-');
  const clean = isNeg ? s.slice(1) : s;
  const [whole, frac = ''] = clean.split('.');
  const n = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Amount is outside the supported range.');
  return isNeg ? -n : n;
};

function localDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function prettyDate(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' }).format(new Date(`${d}T12:00:00+03:00`));
}

function showNotice(message, type = 'success') {
  const n = $('#notice');
  n.textContent = message;
  n.className = `notice ${type}`;
  n.classList.remove('hidden');
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => n.classList.add('hidden'), 6000);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function titleType(type) {
  return String(type || 'activity').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Navigation router
function go(page) {
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));

  const titles = {
    today: 'Good morning.',
    checkout: 'Point of Sale (POS)',
    entry: 'Smart Shop Assistant',
    ledger: 'Transactions & General Records',
    inventory: 'Stock Control & Products',
    customers: 'Customer Accounts & Credit',
    suppliers: 'Suppliers & Bills Payable',
    mpesa: 'M-Pesa Statement Reconciler',
    reports: 'Financial Performance & COGS',
    journals: 'General Ledger & Balanced Journals',
    reconcile: 'Close Current Shift',
    settings: 'Shop Configuration & Backups'
  };
  $('#pageTitle').textContent = titles[page] || 'DukaSauti';

  if (page === 'today') refreshDashboard();
  if (page === 'checkout') renderPosCatalog();
  if (page === 'ledger') loadLedger();
  if (page === 'inventory') loadInventory().catch(e => showNotice(e.message, 'error'));
  if (page === 'customers') loadCustomers().catch(e => showNotice(e.message, 'error'));
  if (page === 'suppliers') loadSuppliers().catch(e => showNotice(e.message, 'error'));
  if (page === 'mpesa') loadMpesaRecords().catch(e => showNotice(e.message, 'error'));
  if (page === 'reports') loadReports().catch(e => showNotice(e.message, 'error'));
  if (page === 'journals') loadJournals().catch(e => showNotice(e.message, 'error'));
  if (page === 'reconcile') loadShiftReconciliation().catch(e => showNotice(e.message, 'error'));
  if (page === 'settings') renderQvacStatus();
}

$$('[data-page]').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));
$$('[data-goto]').forEach(b => b.addEventListener('click', () => go(b.dataset.goto)));
$('#quickCheckoutBtn').addEventListener('click', () => go('checkout'));

// ==========================================
// INITIALIZATION
// ==========================================
async function init() {
  state.today = localDate();
  $('#todayDate').textContent = prettyDate(state.today);
  $('#dateLabel').textContent = new Intl.DateTimeFormat('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Nairobi' }).format(new Date());
  $('#manualDate').value = state.today;
  $('#reportFrom').value = state.today;
  $('#reportTo').value = state.today;
  $('#journalForm [name=date]').value = state.today;

  try {
    const [shop, health] = await Promise.all([api('/api/shop'), api('/api/health')]);
    state.shop = shop;
    state.qvac = health.qvac;
    $('#shopNameSide').textContent = shop.name;
    $('#shopName').value = shop.name;
    $('#openingCash').value = (shop.opening_cash_minor / 100).toFixed(2);
    renderQvacStatus();
    await Promise.all([refreshDashboard(), loadInventory(), loadCustomers()]);
  } catch (e) {
    showNotice(`Could not initialize local data: ${e.message}`, 'error');
  }
}

function renderQvacStatus() {
  const ready = state.qvac?.ready;
  const text = ready ? 'Model loaded and ready for offline inference' : (state.qvac?.error || 'Local QVAC model not loaded. Manual and POS operations ready.');
  $('#aiStatusSide').textContent = ready ? 'QVAC AI active' : 'Manual / POS mode';
  $('#qvacSettingsStatus').innerHTML = `<strong>${ready ? '✓ QVAC Local AI Ready' : 'QVAC Standby'}</strong><br>${escapeHtml(text)}<br><small>Local-first, zero cloud latency</small>`;
  $('#interpretBtn').disabled = false;
  $('#qvacWarning').textContent = ready
    ? 'Local QVAC model is loaded and running offline.'
    : 'Local model is in standby. Natural language interpretation uses local deterministic parser.';
  $('#qvacWarning').classList.remove('hidden');
}

// ==========================================
// DASHBOARD LOGIC
// ==========================================
async function refreshDashboard() {
  const [summary, txs, shiftPos] = await Promise.all([
    api(`/api/summary?date=${state.today}`),
    api(`/api/transactions?status=confirmed`),
    api(`/api/shifts/position?date=${state.today}`)
  ]);

  state.activeShiftPosition = shiftPos;
  $('#salesMetric').textContent = money(summary.salesMinor);
  $('#salesSub').textContent = `${summary.transactionCount} confirmed transaction(s)`;
  $('#cashInMetric').textContent = money(summary.cashInMinor);
  $('#mpesaMetric').textContent = money(summary.mobileMoneyReceivedMinor || 0);
  $('#expensesMetric').textContent = money(summary.expensesMinor);

  const todayTx = txs.filter(t => t.business_date === state.today).slice(0, 7);
  $('#recentList').innerHTML = todayTx.length ? todayTx.map(t => {
    const isIncome = ['sale', 'customer_payment', 'cash_deposit'].includes(t.type);
    return `
      <div class="activity-row">
        <div class="activity-icon ${isIncome ? 'sale' : 'expense'}">${isIncome ? '↗' : '↘'}</div>
        <div class="activity-copy">
          <b>${escapeHtml(t.description || titleType(t.type))}</b>
          <small>${escapeHtml(titleType(t.type))} · ${escapeHtml(t.payment_method)}</small>
        </div>
        <span class="activity-amount ${isIncome ? 'pos-num' : 'neg-num'}">
          ${isIncome ? '+' : '-'}${money(t.amount_minor)}
        </span>
      </div>
    `;
  }).join('') : '<div class="empty-state">No transactions recorded today. Use Quick Entry or POS.</div>';

  $('#openingCashTeaser').textContent = money(shiftPos.opening_float_minor);
  $('#expectedCashTeaser').textContent = money(shiftPos.expected_in_counter_minor);
  $('#lastCountTeaser').textContent = `Sales: ${money(shiftPos.total_sales_minor)}`;
}

// ==========================================
// POS MULTI-ITEM CHECKOUT (TOKO TETANGGA)
// ==========================================
function renderPosCatalog() {
  const search = $('#posSearchInput').value.trim().toLowerCase();
  const cat = $('#posCategoryFilter').value;

  const filtered = state.products.filter(p => {
    if (cat !== 'all' && p.category !== cat) return false;
    if (search && !p.name.toLowerCase().includes(search) && !(p.sku || '').toLowerCase().includes(search)) return false;
    return true;
  });

  // Populate categories filter
  const cats = ['all', ...new Set(state.products.map(p => p.category).filter(Boolean))];
  $('#posCategoryFilter').innerHTML = cats.map(c => `<option value="${escapeHtml(c)}" ${c === cat ? 'selected' : ''}>${c === 'all' ? 'All Categories' : escapeHtml(c)}</option>`).join('');

  if (!filtered.length) {
    $('#posProductGrid').innerHTML = '<div class="empty-state">No products match your search.</div>';
    return;
  }

  $('#posProductGrid').innerHTML = filtered.map(p => `
    <article class="pos-item-card ${p.stock_qty <= p.reorder_level ? 'low-stock-card' : ''}" data-pos-product="${escapeHtml(p.id)}">
      <div class="pos-card-head">
        <b>${escapeHtml(p.name)}</b>
        <span class="pos-card-unit">${escapeHtml(p.unit)}</span>
      </div>
      <div class="pos-card-price">${money(p.selling_price_minor)}</div>
      <div class="pos-card-stock">
        ${p.stock_qty <= p.reorder_level ? '⚠️ Low Stock: ' : 'On hand: '}
        <b>${p.stock_qty}</b>
      </div>
    </article>
  `).join('');

  $$('.pos-item-card').forEach(card => {
    card.addEventListener('click', () => {
      const pid = card.dataset.posProduct;
      addToCart(pid);
    });
  });
}

function addToCart(productId) {
  const prod = state.products.find(p => p.id === productId);
  if (!prod) return;
  const existing = state.cart.find(it => it.product.id === productId);

  if (existing) {
    if (existing.quantity + 1 > prod.stock_qty) {
      showNotice(`Cannot add more than ${prod.stock_qty} available in stock.`, 'error');
      return;
    }
    existing.quantity += 1;
  } else {
    if (prod.stock_qty < 1) {
      showNotice(`"${prod.name}" is currently out of stock.`, 'error');
      return;
    }
    state.cart.push({ product: prod, quantity: 1, unit_price_minor: prod.selling_price_minor });
  }
  renderCart();
}

function updateCartQty(productId, newQty) {
  const idx = state.cart.findIndex(it => it.product.id === productId);
  if (idx === -1) return;
  const item = state.cart[idx];
  const q = Number(newQty);

  if (q <= 0) {
    state.cart.splice(idx, 1);
  } else if (q > item.product.stock_qty) {
    showNotice(`Only ${item.product.stock_qty} available in stock.`, 'error');
    item.quantity = item.product.stock_qty;
  } else {
    item.quantity = q;
  }
  renderCart();
}

function renderCart() {
  const list = $('#cartItemsList');
  const countBadge = $('#cartCountBadge');
  const itemsQtyEl = $('#cartItemsQty');
  const subtotalEl = $('#cartSubtotal');
  const totalEl = $('#cartTotal');

  const totalQty = state.cart.reduce((sum, it) => sum + it.quantity, 0);
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);

  countBadge.textContent = `${state.cart.length} item(s)`;
  itemsQtyEl.textContent = String(totalQty);
  subtotalEl.textContent = money(totalMinor);
  totalEl.textContent = money(totalMinor);

  if (!state.cart.length) {
    list.innerHTML = `
      <div class="empty-cart-message">
        <span style="font-size:32px;">🛒</span>
        <p>Cart is empty.<br>Click any product on the left to add.</p>
      </div>
    `;
    $('#posCash').value = '0';
    $('#posMpesa').value = '0';
    $('#posBank').value = '0';
    $('#posCredit').value = '0';
    updateTenderBalance(0);
    return;
  }

  list.innerHTML = state.cart.map(it => `
    <div class="cart-line-row">
      <div class="cart-line-info">
        <b>${escapeHtml(it.product.name)}</b>
        <small>${money(it.unit_price_minor)} / ${escapeHtml(it.product.unit)}</small>
      </div>
      <div class="cart-qty-ctrl">
        <button type="button" class="qty-btn" data-qty-dec="${escapeHtml(it.product.id)}">−</button>
        <input type="number" class="qty-num-input" value="${it.quantity}" min="0.001" step="1" data-qty-input="${escapeHtml(it.product.id)}">
        <button type="button" class="qty-btn" data-qty-inc="${escapeHtml(it.product.id)}">+</button>
      </div>
      <div class="cart-line-total">
        ${money(Math.round(it.quantity * it.unit_price_minor))}
      </div>
      <button type="button" class="remove-cart-item-btn" data-qty-remove="${escapeHtml(it.product.id)}">×</button>
    </div>
  `).join('');

  $$('[data-qty-dec]').forEach(b => b.addEventListener('click', () => {
    const item = state.cart.find(it => it.product.id === b.dataset.qtyDec);
    if (item) updateCartQty(item.product.id, item.quantity - 1);
  }));
  $$('[data-qty-inc]').forEach(b => b.addEventListener('click', () => {
    const item = state.cart.find(it => it.product.id === b.dataset.qtyInc);
    if (item) updateCartQty(item.product.id, item.quantity + 1);
  }));
  $$('[data-qty-remove]').forEach(b => b.addEventListener('click', () => {
    updateCartQty(b.dataset.qtyRemove, 0);
  }));
  $$('[data-qty-input]').forEach(inp => inp.addEventListener('change', (e) => {
    updateCartQty(inp.dataset.qtyInput, e.target.value);
  }));

  // Default tender to Cash if tenders are untouched
  const currentCash = amountToMinor($('#posCash').value || 0);
  const currentMpesa = amountToMinor($('#posMpesa').value || 0);
  const currentBank = amountToMinor($('#posBank').value || 0);
  const currentCredit = amountToMinor($('#posCredit').value || 0);

  if (currentCash === 0 && currentMpesa === 0 && currentBank === 0 && currentCredit === 0) {
    $('#posCash').value = (totalMinor / 100).toFixed(2);
  }
  updateTenderBalance(totalMinor);
}

function updateTenderBalance(totalMinor) {
  const cash = amountToMinor($('#posCash').value || 0);
  const mpesa = amountToMinor($('#posMpesa').value || 0);
  const bank = amountToMinor($('#posBank').value || 0);
  const credit = amountToMinor($('#posCredit').value || 0);
  const allocated = cash + mpesa + bank + credit;
  const remaining = totalMinor - allocated;

  const remEl = $('#tenderRemainingAmount');
  const btn = $('#completeCheckoutBtn');

  remEl.textContent = money(remaining);
  remEl.className = remaining === 0 ? 'tender-balanced' : 'tender-mismatched';

  // Toggle customer credit picker if credit > 0
  $('#posCustomerSelectWrap').classList.toggle('hidden', credit <= 0);

  const canSubmit = state.cart.length > 0 && remaining === 0 && (credit <= 0 || $('#posCustomer').value);
  btn.disabled = !canSubmit;
}

$('#posCash').addEventListener('input', () => {
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);
  updateTenderBalance(totalMinor);
});
$('#posMpesa').addEventListener('input', () => {
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);
  updateTenderBalance(totalMinor);
});
$('#posBank').addEventListener('input', () => {
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);
  updateTenderBalance(totalMinor);
});
$('#posCredit').addEventListener('input', () => {
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);
  updateTenderBalance(totalMinor);
});

$('#posCustomer').addEventListener('change', () => {
  const cid = $('#posCustomer').value;
  const cust = state.customers.find(c => c.id === cid);
  if (cust) {
    $('#customerCreditNotice').textContent = `Current balance: ${money(cust.balance_minor)} (Limit: ${money(cust.credit_limit_minor)})`;
  } else {
    $('#customerCreditNotice').textContent = '';
  }
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);
  updateTenderBalance(totalMinor);
});

// Quick tender shortcuts
$('#exactCashBtn').addEventListener('click', () => {
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);
  $('#posCash').value = (totalMinor / 100).toFixed(2);
  $('#posMpesa').value = '0';
  $('#posBank').value = '0';
  $('#posCredit').value = '0';
  updateTenderBalance(totalMinor);
});

$('#exactMpesaBtn').addEventListener('click', () => {
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);
  $('#posCash').value = '0';
  $('#posMpesa').value = (totalMinor / 100).toFixed(2);
  $('#posBank').value = '0';
  $('#posCredit').value = '0';
  updateTenderBalance(totalMinor);
});

$('#halfSplitBtn').addEventListener('click', () => {
  const totalMinor = state.cart.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_minor), 0);
  const half = Math.floor(totalMinor / 2);
  $('#posCash').value = (half / 100).toFixed(2);
  $('#posMpesa').value = ((totalMinor - half) / 100).toFixed(2);
  $('#posBank').value = '0';
  $('#posCredit').value = '0';
  updateTenderBalance(totalMinor);
});

$('#clearCartBtn').addEventListener('click', () => {
  if (!state.cart.length) return;
  if (confirm('Clear all items from the current cart?')) {
    state.cart = [];
    renderCart();
  }
});

// Complete POS Checkout
$('#completeCheckoutBtn').addEventListener('click', async () => {
  if (!state.cart.length) return;
  const btn = $('#completeCheckoutBtn');
  btn.disabled = true;
  btn.textContent = 'Processing Sale…';

  try {
    const lines = state.cart.map(it => ({
      product_id: it.product.id,
      quantity: it.quantity,
      unit_price_minor: it.unit_price_minor
    }));

    const payload = {
      lines,
      cash_received_minor: amountToMinor($('#posCash').value || 0),
      mobile_money_received_minor: amountToMinor($('#posMpesa').value || 0),
      bank_received_minor: amountToMinor($('#posBank').value || 0),
      credit_amount_minor: amountToMinor($('#posCredit').value || 0),
      customer_id: $('#posCustomer').value || null,
      business_date: state.today
    };

    const res = await api('/api/sales', { method: 'POST', body: JSON.stringify(payload) });
    showNotice(`Sale confirmed: ${money(res.transaction.amount_minor)}. Stock & balances updated!`);

    // Reset cart
    state.cart = [];
    renderCart();

    // Refresh products and dashboard
    await Promise.all([loadInventory(), refreshDashboard(), loadCustomers()]);

    // Open receipt modal
    openReceiptModal(res.transaction.id);
  } catch (err) {
    showNotice(`Checkout failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Complete Sale & Print Receipt ➔';
  }
});

// Barcode scanner listener
let barcodeBuffer = '';
let lastKeyTime = Date.now();
window.addEventListener('keydown', (e) => {
  const target = e.target;
  // If user is focused on a text input, don't hijack unless it's the pos search input
  if (['TEXTAREA', 'SELECT'].includes(target.tagName) || (target.tagName === 'INPUT' && target.id !== 'posSearchInput')) {
    return;
  }

  const now = Date.now();
  if (now - lastKeyTime > 150) barcodeBuffer = '';
  lastKeyTime = now;

  if (e.key === 'Enter') {
    if (barcodeBuffer.length >= 3) {
      const match = state.products.find(p => p.sku === barcodeBuffer);
      if (match) {
        addToCart(match.id);
        showNotice(`Scanned: ${match.name}`);
        go('checkout');
        barcodeBuffer = '';
        e.preventDefault();
      }
    }
  } else if (e.key.length === 1) {
    barcodeBuffer += e.key;
  }
});

$('#posSearchInput').addEventListener('input', renderPosCatalog);
$('#posCategoryFilter').addEventListener('change', renderPosCatalog);

// ==========================================
// RECEIPT PRINTING MODAL
// ==========================================
const receiptDialog = $('#receiptDialog');
async function openReceiptModal(transactionId) {
  try {
    const data = await api(`/api/transactions/${transactionId}/receipt`);
    $('#receiptPre').textContent = data.text;
    receiptDialog.showModal();
  } catch (e) {
    showNotice(`Could not generate receipt: ${e.message}`, 'error');
  }
}
$('#closeReceiptBtn').addEventListener('click', () => receiptDialog.close());
$('#dismissReceiptBtn').addEventListener('click', () => receiptDialog.close());
$('#printReceiptBtn').addEventListener('click', () => {
  window.print();
});

// ==========================================
// STOKA CASH RECONCILIATION & SHIFT CLOSE
// ==========================================
async function loadShiftReconciliation() {
  const pos = await api(`/api/shifts/position?date=${state.today}`);
  state.activeShiftPosition = pos;

  $('#stokaTotalSales').innerHTML = `${money(pos.total_sales_minor)} <small id="stokaSalesCount">(${pos.sales_count} transactions)</small>`;
  $('#stokaMpesaReceived').textContent = money(pos.mpesa_received_minor);
  $('#stokaCashSales').textContent = money(pos.cash_sales_minor);
  $('#stokaOpeningFloat').textContent = money(pos.opening_float_minor);
  $('#stokaExpectedCounter').textContent = money(pos.expected_in_counter_minor);

  $('#compExpected').textContent = money(pos.expected_in_counter_minor);
  $('#compCounted').textContent = money(0);

  // Load history
  const history = await api('/api/reconcile');
  $('#reconcileHistory').innerHTML = history.length ? history.map(c => `
    <div class="activity-row">
      <div class="activity-icon ${c.difference_minor === 0 ? 'sale' : 'expense'}">${c.difference_minor === 0 ? '✓' : '!'}</div>
      <div class="activity-copy">
        <b>${escapeHtml(c.business_date)} · Counted: ${money(c.counted_cash_minor)}</b>
        <small>Expected: ${money(c.expected_cash_minor)} · ${escapeHtml(c.notes || 'Shift closed')}</small>
      </div>
      <span class="activity-amount ${c.difference_minor === 0 ? 'pos-num' : 'neg-num'}">
        ${c.difference_minor === 0 ? 'Balanced' : money(c.difference_minor)}
      </span>
    </div>
  `).join('') : '<div class="empty-state">No previous shift records.</div>';
}

$('#countedCash').addEventListener('input', () => {
  const countedMinor = amountToMinor($('#countedCash').value || 0);
  const expectedMinor = state.activeShiftPosition?.expected_in_counter_minor || 0;
  const diff = countedMinor - expectedMinor;

  $('#compCounted').textContent = money(countedMinor);

  const balBadge = $('#stokaBalancedBadge');
  const discBadge = $('#stokaDiscrepancyBadge');
  const diffAmount = $('#stokaDiffAmount');

  if (diff === 0 && countedMinor > 0) {
    balBadge.classList.remove('hidden');
    discBadge.classList.add('hidden');
  } else if ($('#countedCash').value.trim() !== '') {
    balBadge.classList.add('hidden');
    discBadge.classList.remove('hidden');
    diffAmount.textContent = money(diff);
  } else {
    balBadge.classList.add('hidden');
    discBadge.classList.add('hidden');
  }
});

$('#reconcileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const counted = amountToMinor($('#countedCash').value);
    const payload = {
      date: state.today,
      counted_cash_minor: counted,
      notes: $('#reconcileNotes').value
    };
    const res = await api('/api/shifts/close', { method: 'POST', body: JSON.stringify(payload) });
    if (res.is_balanced) {
      showNotice('Shift closed successfully! Counter cash is balanced.');
    } else {
      showNotice(`Shift closed with discrepancy of ${money(res.difference_minor)}. Record logged.`, 'error');
    }
    $('#countedCash').value = '';
    $('#reconcileNotes').value = '';
    await Promise.all([loadShiftReconciliation(), refreshDashboard()]);
  } catch (err) {
    showNotice(`Could not close shift: ${err.message}`, 'error');
  }
});

// ==========================================
// CASHCAPTAIN QUICK ENTRY MODAL (HOTKEY N)
// ==========================================
const quickEntryDialog = $('#quickEntryDialog');
function openQuickEntry() {
  $('#quickNoteInput').value = '';
  $('#quickParsedPreview').classList.add('hidden');
  quickEntryDialog.showModal();
}
$('#quickEntry').addEventListener('click', openQuickEntry);
$('#closeQuickEntryBtn').addEventListener('click', () => quickEntryDialog.close());
$('#cancelQuickEntryBtn').addEventListener('click', () => quickEntryDialog.close());

window.addEventListener('keydown', (e) => {
  if (e.key === 'n' || e.key === 'N') {
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      e.preventDefault();
      openQuickEntry();
    }
  }
});

$('#quickNoteInput').addEventListener('input', () => {
  const val = $('#quickNoteInput').value.trim();
  const card = $('#quickParsedPreview');
  if (!val) {
    card.classList.add('hidden');
    return;
  }

  // Quick live heuristic parser
  const match = val.match(/([+-]?\d+(?:\.\d{1,2})?)/);
  if (!match) return;
  const rawNum = match[1];
  const isExplicitExpense = rawNum.startsWith('-') || /\b(paid|spent|transport|tokens|rent|lunch)\b/i.test(val);
  const absAmount = Math.abs(parseFloat(rawNum));

  card.classList.remove('hidden');
  $('#quickPreviewType').textContent = isExplicitExpense ? 'Operating Expense' : 'Recorded Sale';
  $('#quickPreviewType').className = `quick-preview-badge ${isExplicitExpense ? 'expense-badge' : 'sale-badge'}`;
  $('#quickPreviewAmount').textContent = money(Math.round(absAmount * 100));
  $('#quickPreviewDetails').textContent = `${val} · Local ledger draft`;
});

$('#quickEntryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#quickNoteInput').value.trim();
  if (!note) return;

  try {
    const match = note.match(/([+-]?\d+(?:\.\d{1,2})?)/);
    if (!match) throw new Error('Specify an amount in your note.');
    const rawNum = match[1];
    const isExpense = rawNum.startsWith('-') || /\b(paid|spent|transport|tokens|rent|expense)\b/i.test(note);
    const amountMinor = Math.round(Math.abs(parseFloat(rawNum)) * 100);

    const isMpesa = /\b(mpesa|m-pesa)\b/i.test(note);
    const tender = isMpesa ? 'mobile_money' : 'cash';

    const payload = {
      type: isExpense ? 'expense' : 'sale',
      description: note,
      amount_minor: amountMinor,
      currency: 'KES',
      payment_method: tender,
      cash_received_minor: !isExpense && tender === 'cash' ? amountMinor : 0,
      mobile_money_received_minor: !isExpense && tender === 'mobile_money' ? amountMinor : 0,
      bank_received_minor: 0,
      cash_paid_minor: isExpense && tender === 'cash' ? amountMinor : 0,
      credit_amount_minor: 0,
      business_date: state.today,
      source: 'quick-entry'
    };

    await api('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
    quickEntryDialog.close();
    showNotice(`Recorded: ${isExpense ? 'Expense' : 'Sale'} ${money(amountMinor)}`);
    await refreshDashboard();
  } catch (err) {
    showNotice(`Quick entry failed: ${err.message}`, 'error');
  }
});

// ==========================================
// TRANSACTIONS LEDGER (FINOPIA STYLE)
// ==========================================
async function loadLedger() {
  const params = new URLSearchParams({
    status: $('#statusFilter').value,
    q: $('#searchInput').value.trim()
  });
  if ($('#filterDate').value) params.set('date', $('#filterDate').value);

  const rows = await api(`/api/transactions?${params}`);
  const tbody = $('#ledgerBody');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No transactions found matching criteria.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(t => {
    const isIncome = ['sale', 'customer_payment', 'cash_deposit'].includes(t.type);
    return `
      <tr>
        <td><b>${escapeHtml(t.business_date)}</b></td>
        <td>
          <div style="font-weight:600; color:#183d32;">${escapeHtml(t.description || titleType(t.type))}</div>
          ${t.notes ? `<small class="text-muted">${escapeHtml(t.notes)}</small>` : ''}
        </td>
        <td><span class="category-pill">${escapeHtml(t.category || t.type)}</span></td>
        <td><span class="method-tag ${escapeHtml(t.payment_method)}">${escapeHtml(titleType(t.payment_method))}</span></td>
        <td class="right">
          <strong class="${isIncome ? 'pos-num' : 'neg-num'}">
            ${isIncome ? '+' : '-'}${money(t.amount_minor)}
          </strong>
        </td>
        <td><span class="status-tag ${escapeHtml(t.status)}">${escapeHtml(titleType(t.status))}</span></td>
        <td>
          <div class="table-actions">
            ${t.type === 'sale' ? `<button class="row-action" data-receipt="${escapeHtml(t.id)}">Receipt</button>` : ''}
            ${t.status === 'confirmed' ? `<button class="row-action danger" data-reverse="${escapeHtml(t.id)}">Reverse</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  $$('[data-reverse]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Reverse this transaction? Stock will be restored and accounting reversal logged.')) return;
    try {
      await api(`/api/transactions/${b.dataset.reverse}/reverse`, { method: 'POST', body: '{}' });
      showNotice('Transaction reversed successfully.');
      await Promise.all([loadLedger(), refreshDashboard(), loadInventory()]);
    } catch (e) {
      showNotice(e.message, 'error');
    }
  }));

  $$('[data-receipt]').forEach(b => b.addEventListener('click', () => {
    openReceiptModal(b.dataset.receipt);
  }));
}

$('#filterBtn').addEventListener('click', loadLedger);
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') loadLedger(); });

// ==========================================
// INVENTORY & PRODUCTS
// ==========================================
async function loadInventory() {
  const [products, movements] = await Promise.all([
    api('/api/products'),
    api('/api/stock/movements')
  ]);
  state.products = products;

  // Compute inventory valuation
  const totalValuation = products.reduce((sum, p) => sum + (p.stock_qty * p.cost_price_minor), 0);
  $('#inventoryValuationBadge').textContent = `Total Inventory Asset: ${money(totalValuation)}`;

  $('#productsBody').innerHTML = products.length ? products.map(p => {
    const isLow = p.stock_qty <= p.reorder_level;
    const margin = p.selling_price_minor > 0
      ? Math.round(((p.selling_price_minor - p.cost_price_minor) / p.selling_price_minor) * 100)
      : 0;

    return `
      <tr>
        <td><b>${escapeHtml(p.name)}</b></td>
        <td><code>${escapeHtml(p.sku || '—')}</code></td>
        <td>${escapeHtml(p.category || 'General')}</td>
        <td><b>${p.stock_qty}</b> ${escapeHtml(p.unit)}</td>
        <td>${p.reorder_level} ${escapeHtml(p.unit)}</td>
        <td>${money(p.cost_price_minor)}</td>
        <td><b>${money(p.selling_price_minor)}</b></td>
        <td><span class="margin-pill">${margin}%</span></td>
        <td>
          <span class="status-tag ${isLow ? 'reversed' : 'confirmed'}">
            ${isLow ? '⚠️ Low Stock' : '✓ Normal'}
          </span>
        </td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="9" class="empty-cell">No products added yet.</td></tr>';

  $('#stockProduct').innerHTML = products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.stock_qty} ${escapeHtml(p.unit)} on hand)</option>`).join('');
  const productOptions = products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.stock_qty} ${escapeHtml(p.unit)})</option>`).join('');
  if ($('#unpackSourceProduct')) $('#unpackSourceProduct').innerHTML = productOptions;
  if ($('#unpackTargetProduct')) $('#unpackTargetProduct').innerHTML = productOptions;
  renderPosCatalog();
}

$('#productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  try {
    await api('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        sku: fd.get('sku'),
        category: fd.get('category'),
        unit: fd.get('unit'),
        selling_price_minor: amountToMinor(fd.get('selling')),
        cost_price_minor: amountToMinor(fd.get('cost')),
        stock_qty: Number(fd.get('qty') || 0),
        reorder_level: Number(fd.get('reorder') || 0)
      })
    });
    e.currentTarget.reset();
    showNotice('Product created and opening stock logged.');
    await loadInventory();
  } catch (err) {
    showNotice(`Product not created: ${err.message}`, 'error');
  }
});

$('#stockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  try {
    await api('/api/stock/movements', {
      method: 'POST',
      body: JSON.stringify({
        product_id: fd.get('product_id'),
        movement_type: fd.get('movement_type'),
        quantity: Number(fd.get('quantity')),
        unit_cost_minor: amountToMinor(fd.get('cost') || 0),
        notes: fd.get('notes')
      })
    });
    e.currentTarget.reset();
    showNotice('Stock movement recorded.');
    await loadInventory();
  } catch (err) {
    showNotice(`Stock update failed: ${err.message}`, 'error');
  }
});

// ==========================================
// CUSTOMERS & CREDIT (DENI)
// ==========================================
async function loadCustomers() {
  const rows = await api('/api/customers');
  state.customers = rows;

  const totalDebt = rows.reduce((sum, c) => sum + (c.balance_minor || 0), 0);
  $('#totalCustomerDebtBadge').textContent = `Total Outstanding Debt: ${money(totalDebt)}`;

  $('#customersBody').innerHTML = rows.length ? rows.map(c => `
    <tr>
      <td><b>${escapeHtml(c.name)}</b></td>
      <td>${escapeHtml(c.phone || '—')}</td>
      <td>${money(c.credit_limit_minor)}</td>
      <td><b class="${c.balance_minor > 0 ? 'neg-num' : ''}">${money(c.balance_minor)}</b></td>
      <td><span class="status-tag ${c.balance_minor > 0 ? 'reversed' : 'confirmed'}">${c.balance_minor > 0 ? 'Owes Money' : 'Settled'}</span></td>
      <td><button class="row-action" data-customer-stmt="${escapeHtml(c.id)}">Statement</button></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty-cell">No customer records yet.</td></tr>';

  $$('[data-customer-stmt]').forEach(btn => btn.addEventListener('click', async () => {
    openStatementModal(`/api/customers/${btn.dataset.customerStmt}/statement`, 'Customer Account Statement');
  }));

  $('#creditCustomer').innerHTML = rows.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${money(c.balance_minor)} balance)</option>`).join('');
  $('#posCustomer').innerHTML = '<option value="">-- Choose Customer --</option>' + rows.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
}

$('#customerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  try {
    await api('/api/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        phone: fd.get('phone'),
        credit_limit_minor: amountToMinor(fd.get('limit') || 0),
        notes: fd.get('notes')
      })
    });
    e.currentTarget.reset();
    showNotice('Customer profile saved.');
    await loadCustomers();
  } catch (err) {
    showNotice(`Could not save customer: ${err.message}`, 'error');
  }
});

$('#creditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  try {
    await api('/api/credits', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: fd.get('customer_id'),
        entry_type: fd.get('entry_type'),
        amount_minor: amountToMinor(fd.get('amount')),
        payment_method: fd.get('payment_method'),
        notes: fd.get('notes')
      })
    });
    e.currentTarget.reset();
    showNotice('Account entry saved and customer balance updated.');
    await Promise.all([loadCustomers(), refreshDashboard()]);
  } catch (err) {
    showNotice(`Account entry failed: ${err.message}`, 'error');
  }
});

// ==========================================
// SUPPLIERS & BILLS
// ==========================================
async function loadSuppliers() {
  const [suppliers, bills] = await Promise.all([
    api('/api/suppliers'),
    api('/api/suppliers/bills')
  ]);
  state.suppliers = suppliers;

  $('#billSupplier').innerHTML = suppliers.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
  $('#billPaymentSelect').innerHTML = bills.filter(b => b.balance_minor > 0).map(b => `
    <option value="${escapeHtml(b.id)}">${escapeHtml(b.supplier_name)} · ${escapeHtml(b.reference || 'Bill')} (${money(b.balance_minor)} due)</option>
  `).join('');

  $('#billsBody').innerHTML = bills.length ? bills.map(b => `
    <tr>
      <td><b>${escapeHtml(b.supplier_name)}</b></td>
      <td><code>${escapeHtml(b.reference || '—')}</code></td>
      <td>${money(b.amount_minor)}</td>
      <td>${money(b.paid_minor)}</td>
      <td><b class="${b.balance_minor > 0 ? 'neg-num' : ''}">${money(b.balance_minor)}</b></td>
      <td>${escapeHtml(b.due_date || '—')}</td>
      <td><span class="status-tag ${b.balance_minor === 0 ? 'confirmed' : 'reversed'}">${b.balance_minor === 0 ? 'Paid' : 'Unpaid'}</span></td>
      <td><button class="row-action" data-supplier-stmt="${escapeHtml(b.supplier_id)}">Statement</button></td>
    </tr>
  `).join('') : '<tr><td colspan="8" class="empty-cell">No supplier bills recorded.</td></tr>';

  $$('[data-supplier-stmt]').forEach(btn => btn.addEventListener('click', async () => {
    openStatementModal(`/api/suppliers/${btn.dataset.supplierStmt}/statement`, 'Supplier Account Statement');
  }));
}

$('#supplierForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  try {
    await api('/api/suppliers', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        phone: fd.get('phone'),
        email: fd.get('email'),
        notes: fd.get('notes')
      })
    });
    e.currentTarget.reset();
    showNotice('Supplier directory updated.');
    await loadSuppliers();
  } catch (err) {
    showNotice(err.message, 'error');
  }
});

$('#billForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  try {
    await api('/api/suppliers/bills', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: fd.get('supplier_id'),
        reference: fd.get('reference'),
        due_date: fd.get('due_date') || null,
        amount_minor: amountToMinor(fd.get('amount')),
        notes: fd.get('notes')
      })
    });
    e.currentTarget.reset();
    showNotice('Supplier bill saved and Accounts Payable updated.');
    await loadSuppliers();
  } catch (err) {
    showNotice(`Bill creation failed: ${err.message}`, 'error');
  }
});

$('#billPaymentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  try {
    const billId = fd.get('bill_id');
    await api(`/api/suppliers/bills/${encodeURIComponent(billId)}/payment`, {
      method: 'POST',
      body: JSON.stringify({
        amount_minor: amountToMinor(fd.get('amount')),
        payment_method: fd.get('payment_method')
      })
    });
    e.currentTarget.reset();
    showNotice('Supplier payment recorded and bill balance reduced.');
    await Promise.all([loadSuppliers(), refreshDashboard()]);
  } catch (err) {
    showNotice(`Payment failed: ${err.message}`, 'error');
  }
});

// ==========================================
// M-PESA STATEMENT MATCHER
// ==========================================
async function loadMpesaRecords() {
  const rows = await api('/api/mpesa');
  $('#mpesaTableBody').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td><code>${escapeHtml(r.mpesa_code)}</code></td>
      <td><span class="type-pill ${r.direction === 'in' ? 'sale' : 'expense'}">${r.direction === 'in' ? 'Received (In)' : 'Sent (Out)'}</span></td>
      <td><b>${escapeHtml(r.sender_or_recipient || '—')}</b></td>
      <td>${escapeHtml(r.phone || '—')}</td>
      <td>${escapeHtml(r.transaction_time || '—')}</td>
      <td class="right"><b>${money(r.amount_minor)}</b></td>
      <td><span class="status-tag ${r.status === 'matched' ? 'confirmed' : 'draft'}">${escapeHtml(titleType(r.status))}</span></td>
    </tr>
  `).join('') : '<tr><td colspan="7" class="empty-cell">No M-Pesa records imported yet.</td></tr>';
}

$('#refreshMpesaBtn').addEventListener('click', loadMpesaRecords);

$('#mpesaParseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const textVal = $('#mpesaSmsInput').value.trim();
  if (!textVal) return;

  try {
    const parsed = await api('/api/mpesa/parse', { method: 'POST', body: JSON.stringify({ text: textVal }) });
    const box = $('#mpesaParseResult');
    box.classList.remove('hidden');
    box.innerHTML = `
      <div style="font-weight:700; color:#183d32; margin-bottom:6px;">✓ M-Pesa Message Parsed:</div>
      <div>Code: <code>${escapeHtml(parsed.mpesa_code)}</code></div>
      <div>Amount: <b>${money(parsed.amount_minor)}</b> (${parsed.direction === 'in' ? 'Inflow' : 'Outflow'})</div>
      <div>Party: ${escapeHtml(parsed.sender_or_recipient || 'N/A')} ${escapeHtml(parsed.phone)}</div>
      <button class="button button-green" id="importParsedMpesaBtn" style="margin-top:10px;">Import to Reconciliation Log</button>
    `;

    $('#importParsedMpesaBtn').onclick = async () => {
      await api('/api/mpesa/import', { method: 'POST', body: JSON.stringify({ records: [parsed] }) });
      showNotice('M-Pesa record added to ledger reconciler.');
      $('#mpesaSmsInput').value = '';
      box.classList.add('hidden');
      await loadMpesaRecords();
    };
  } catch (err) {
    showNotice(`Parsing error: ${err.message}`, 'error');
  }
});

// ==========================================
// PERFORMANCE, COGS & REPORTS
// ==========================================
async function loadReports() {
  const from = $('#reportFrom').value || state.today;
  const to = $('#reportTo').value || state.today;

  const [rep, daily] = await Promise.all([
    api(`/api/reports/overview?from=${from}&to=${to}`),
    api('/api/reports/daily')
  ]);

  const cards = [
    { label: 'Recorded Gross Sales', val: rep.sales_minor, cls: 'pos-num', sub: 'Total sales invoices' },
    { label: 'Cost of Goods Sold (COGS)', val: rep.cogs_minor, cls: '', sub: 'Inventory purchase cost' },
    { label: 'Gross Profit', val: rep.gross_profit_minor, cls: 'pos-num highlight-card', sub: 'Net Sales − COGS' },
    { label: 'Operating Expenses', val: rep.expenses_minor, cls: 'neg-num', sub: 'Rent, transport, utilities' },
    { label: 'Operating Surplus / Profit', val: rep.operating_surplus_minor, cls: rep.operating_surplus_minor >= 0 ? 'pos-num' : 'neg-num', sub: 'Gross Profit − Expenses' },
    { label: 'Credit Sales (Deni)', val: rep.credit_sales_minor, cls: '', sub: 'Uncollected sales' }
  ];

  $('#reportCards').innerHTML = cards.map(c => `
    <article class="metric-card ${c.cls.includes('highlight') ? 'metric-highlight' : ''}">
      <div class="metric-label">${c.label}</div>
      <strong class="${c.cls}">${money(c.val)}</strong>
      <small>${c.sub}</small>
    </article>
  `).join('');

  $('#dailyReportBody').innerHTML = daily.length ? daily.map(d => {
    const grossMargin = d.sales_minor > 0
      ? Math.round(((d.sales_minor - (d.cogs_minor || 0)) / d.sales_minor) * 100)
      : 0;

    return `
      <tr>
        <td><b>${escapeHtml(d.business_date)}</b></td>
        <td>${d.count}</td>
        <td><b>${money(d.sales_minor)}</b></td>
        <td>${money(d.cogs_minor || 0)}</td>
        <td><span class="margin-pill">${grossMargin}%</span></td>
        <td class="neg-num">${money(d.expenses_minor)}</td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="6" class="empty-cell">No daily activity recorded.</td></tr>';

  // Load KRA eTIMS VAT Breakdown
  try {
    const tax = await api(`/api/tax/summary?from=${from}&to=${to}`);
    if ($('#taxableSalesMetric')) $('#taxableSalesMetric').textContent = money(tax.taxable_sales_minor);
    if ($('#vatPayableMetric')) $('#vatPayableMetric').textContent = money(tax.vat_payable_minor);
  } catch {}
}

if ($('#loadTaxSummaryBtn')) $('#loadTaxSummaryBtn').addEventListener('click', loadReports);
$('#runReport').addEventListener('click', loadReports);

// ==========================================
// DOUBLE-ENTRY JOURNALS & GENERAL LEDGER
// ==========================================
async function loadJournals() {
  const rows = await api('/api/journals');
  $('#journalsBody').innerHTML = rows.length ? rows.map(j => `
    <tr>
      <td>${escapeHtml(j.business_date)}</td>
      <td><b>${escapeHtml(j.description)}</b></td>
      <td><code>${escapeHtml(j.reference || '—')}</code></td>
      <td><span class="category-pill">${escapeHtml(j.source_type || 'manual')}</span></td>
      <td>${money(j.debit_minor)}</td>
      <td>${money(j.credit_minor)}</td>
      <td><span class="status-tag ${j.status === 'posted' ? 'confirmed' : 'reversed'}">${escapeHtml(titleType(j.status))}</span></td>
    </tr>
  `).join('') : '<tr><td colspan="7" class="empty-cell">No journals posted yet.</td></tr>';
}

$('#journalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  try {
    const lines = [
      { account_code: fd.get('debit_code'), account_name: fd.get('debit_name'), debit_minor: amountToMinor(fd.get('debit')), credit_minor: 0 },
      { account_code: fd.get('credit_code'), account_name: fd.get('credit_name'), debit_minor: 0, credit_minor: amountToMinor(fd.get('credit')) }
    ];
    await api('/api/journals', {
      method: 'POST',
      body: JSON.stringify({
        description: fd.get('description'),
        reference: fd.get('reference'),
        business_date: fd.get('date') || state.today,
        lines
      })
    });
    e.currentTarget.reset();
    showNotice('Balanced journal entry posted to general ledger.');
    await loadJournals();
  } catch (err) {
    showNotice(`Journal error: ${err.message}`, 'error');
  }
});

// ==========================================
// SETTINGS & ENCRYPTED BACKUP/RESTORE
// ==========================================
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const payload = {
      name: $('#shopName').value.trim(),
      opening_cash_minor: amountToMinor($('#openingCash').value)
    };
    state.shop = await api('/api/shop', { method: 'PUT', body: JSON.stringify(payload) });
    $('#shopNameSide').textContent = state.shop.name;
    showNotice('Shop settings updated.');
    await refreshDashboard();
  } catch (err) {
    showNotice(`Could not save settings: ${err.message}`, 'error');
  }
});

$('#loadModelBtn').addEventListener('click', async () => {
  const btn = $('#loadModelBtn');
  btn.disabled = true;
  btn.textContent = 'Loading QVAC Model…';
  try {
    state.qvac = await api('/api/ai/load', { method: 'POST', body: '{}' });
    showNotice('Local QVAC AI model is loaded and ready offline!');
    renderQvacStatus();
  } catch (e) {
    state.qvac = { ready: false, error: e.message };
    renderQvacStatus();
    showNotice(`QVAC model note: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load Local QVAC Model';
  }
});

// Encrypted Backup
$('#encExportBtn').addEventListener('click', async () => {
  const pass = $('#encExportPass').value;
  if (!pass || pass.length < 6) return showNotice('Enter a passphrase with at least 6 characters.', 'error');

  try {
    const res = await fetch('/api/backup/export-encrypted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: pass })
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dukasauti-backup-encrypted-${state.today}.json`;
    a.click();
    showNotice('Encrypted backup downloaded successfully.');
  } catch (e) {
    showNotice(`Backup failed: ${e.message}`, 'error');
  }
});

// Restore backup file selection
let restoreDataObj = null;
$('#restoreFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      restoreDataObj = JSON.parse(evt.target.result);
      if (restoreDataObj.cipher === 'aes-256-gcm') {
        $('#restorePassWrap').classList.remove('hidden');
        showNotice('Encrypted backup detected. Enter passphrase to decrypt.');
      } else {
        $('#restorePassWrap').classList.add('hidden');
        showNotice('Valid DukaSauti JSON backup selected.');
      }
      $('#restoreExecuteBtn').disabled = false;
    } catch {
      showNotice('File is not a valid JSON document.', 'error');
      $('#restoreExecuteBtn').disabled = true;
    }
  };
  reader.readAsText(file);
});

$('#restoreExecuteBtn').addEventListener('click', async () => {
  if (!restoreDataObj) return;
  if (!confirm('Are you sure you want to restore? This will replace all current database records with the backup file.')) return;

  const btn = $('#restoreExecuteBtn');
  btn.disabled = true;
  btn.textContent = 'Restoring…';

  try {
    const payload = { ...restoreDataObj, passphrase: $('#restorePassInput').value };
    await api('/api/backup/restore', { method: 'POST', body: JSON.stringify(payload) });
    showNotice('Database restored successfully from backup!');
    setTimeout(() => window.location.reload(), 1500);
  } catch (err) {
    showNotice(`Restore failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Restore Database';
  }
});

// Manual transaction modal
const manualDialog = $('#manualDialog');
function openManual() {
  $('#manualDate').value = state.today;
  $('#manualForm').reset();
  $('#manualDate').value = state.today;
  $('#manualCategoryWrap').classList.remove('hidden');
  manualDialog.showModal();
}
$('#manualBtn').addEventListener('click', openManual);

$('#manualType').addEventListener('change', () => {
  const t = $('#manualType').value;
  $('#manualSaleAllocation').classList.toggle('hidden', t !== 'sale');
  $('#manualCategoryWrap').classList.toggle('hidden', t !== 'expense');
});

$('#manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const type = $('#manualType').value;
    const amount = amountToMinor($('#manualAmount').value);
    const method = $('#manualPayment').value;
    const category = type === 'expense' ? $('#manualCategory').value : '';

    const cash = type === 'sale' ? amountToMinor($('#manualCashReceived').value || (method === 'cash' ? $('#manualAmount').value : '0')) : 0;
    const mobile = type === 'sale' ? amountToMinor($('#manualMobile').value || (method === 'mobile_money' ? $('#manualAmount').value : '0')) : 0;
    const bank = type === 'sale' ? amountToMinor($('#manualBank').value || (method === 'bank' ? $('#manualAmount').value : '0')) : 0;
    const credit = type === 'sale' ? amountToMinor($('#manualCredit').value || (method === 'credit' ? $('#manualAmount').value : '0')) : 0;
    const cashPaid = ['expense', 'stock_purchase', 'supplier_payment', 'refund', 'cash_withdrawal'].includes(type) ? (method === 'cash' ? amount : 0) : 0;

    const payload = {
      type,
      category,
      description: $('#manualDescription').value,
      amount_minor: amount,
      currency: 'KES',
      payment_method: method,
      cash_received_minor: cash,
      mobile_money_received_minor: mobile,
      bank_received_minor: bank,
      cash_paid_minor: cashPaid,
      credit_amount_minor: credit,
      business_date: $('#manualDate').value,
      notes: $('#manualNotes').value,
      source: 'manual'
    };

    await api('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
    manualDialog.close();
    showNotice('Confirmed record saved to ledger.');
    await refreshDashboard();
  } catch (err) {
    showNotice(`Record not saved: ${err.message}`, 'error');
  }
});

// Sauti assistant interpretation
$('#interpretBtn').addEventListener('click', async () => {
  const note = $('#noteInput').value.trim();
  if (!note) return showNotice('Write a business note first.', 'error');
  const btn = $('#interpretBtn');
  btn.disabled = true;
  btn.textContent = 'Interpreting Note…';

  try {
    const res = await api('/api/ai/extract', { method: 'POST', body: JSON.stringify({ note }) });
    renderProposal(res);
  } catch (e) {
    showNotice(`Local interpretation error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Interpret with QVAC →';
  }
});

function renderProposal(result) {
  const area = $('#proposalArea');
  area.classList.remove('hidden');

  if (!result.events?.length) {
    area.innerHTML = `
      <article class="proposal-card">
        <h3>More Information Needed</h3>
        <p class="muted">${(result.questions || ['Could not extract financial event.']).map(escapeHtml).join('<br>')}</p>
        <button class="button button-outline" id="proposalManual">Enter Manually</button>
      </article>
    `;
    $('#proposalManual').onclick = openManual;
    return;
  }

  area.innerHTML = `
    <div class="section-intro" style="margin-top:20px;">
      <p class="eyebrow">VERIFY BEFORE SAVING</p>
      <h2>Proposed Transaction Drafts</h2>
      <p>Review the interpreted values below. Confirm to post to your official ledger.</p>
    </div>
  ` + result.events.map((e, idx) => `
    <article class="proposal-card" data-proposal-idx="${idx}">
      <div class="proposal-head">
        <div>
          <h3>Draft Event #${idx + 1}</h3>
          <p>Source: ${escapeHtml(result.parser || 'Local QVAC Model')}</p>
        </div>
        <span class="status-pill">DRAFT</span>
      </div>
      <div class="proposal-fields">
        <div>
          <label>Type</label>
          <select data-field="type">
            ${['sale', 'expense', 'stock_purchase', 'customer_payment', 'supplier_payment', 'cash_withdrawal', 'cash_deposit', 'refund', 'opening_balance', 'adjustment'].map(t => `<option value="${t}" ${e.type === t ? 'selected' : ''}>${titleType(t)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Amount (KSh)</label>
          <input data-field="amount" inputmode="decimal" value="${(e.amount_minor / 100).toFixed(2)}">
        </div>
        <div>
          <label>Description</label>
          <input data-field="description" value="${escapeHtml(e.description || '')}">
        </div>
        <div>
          <label>Tender Method</label>
          <select data-field="payment_method">
            ${['cash', 'mobile_money', 'bank', 'credit', 'mixed', 'other', 'none'].map(t => `<option value="${t}" ${e.payment_method === t ? 'selected' : ''}>${titleType(t)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Cash Received (KSh)</label>
          <input data-field="cash_received" inputmode="decimal" value="${((e.cash_received_minor || 0) / 100).toFixed(2)}">
        </div>
        <div>
          <label>M-Pesa Received (KSh)</label>
          <input data-field="mobile_money_received" inputmode="decimal" value="${((e.mobile_money_received_minor || 0) / 100).toFixed(2)}">
        </div>
        <div>
          <label>Cash Paid Out (KSh)</label>
          <input data-field="cash_paid" inputmode="decimal" value="${((e.cash_paid_minor || 0) / 100).toFixed(2)}">
        </div>
        <div>
          <label>Credit Amount (KSh)</label>
          <input data-field="credit_amount" inputmode="decimal" value="${((e.credit_amount_minor || 0) / 100).toFixed(2)}">
        </div>
      </div>
      <div class="proposal-actions">
        <button class="button button-outline" data-reject>Reject</button>
        <button class="button button-green" data-confirm>Confirm & Save to Ledger</button>
      </div>
    </article>
  `).join('');

  $$('.proposal-card').forEach(card => {
    const idx = Number(card.dataset.proposalIdx);
    card.querySelector('[data-reject]')?.addEventListener('click', () => {
      card.remove();
      if (!area.querySelector('.proposal-card')) area.classList.add('hidden');
    });
    card.querySelector('[data-confirm]')?.addEventListener('click', async () => {
      try {
        const val = f => card.querySelector(`[data-field="${f}"]`)?.value;
        const payload = {
          type: val('type'),
          amount_minor: amountToMinor(val('amount')),
          description: val('description'),
          currency: 'KES',
          payment_method: val('payment_method'),
          cash_received_minor: amountToMinor(val('cash_received') || '0'),
          mobile_money_received_minor: amountToMinor(val('mobile_money_received') || '0'),
          bank_received_minor: 0,
          cash_paid_minor: amountToMinor(val('cash_paid') || '0'),
          credit_amount_minor: amountToMinor(val('credit_amount') || '0'),
          business_date: state.today,
          source_text: result.source_text,
          source: result.parser || 'qvac-local'
        };
        await api('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
        card.remove();
        if (!area.querySelector('.proposal-card')) area.classList.add('hidden');
        showNotice('Confirmed record saved to local ledger.');
        await refreshDashboard();
      } catch (err) {
        showNotice(`Failed to confirm: ${err.message}`, 'error');
      }
    });
  });
}

// ==========================================
// OFFICIAL STATEMENTS MODAL
// ==========================================
const statementDialog = $('#statementDialog');
async function openStatementModal(url, title) {
  try {
    const data = await api(url);
    if ($('#statementTitle')) $('#statementTitle').textContent = title || 'Statement of Account';
    $('#statementPre').textContent = data.text;
    statementDialog.showModal();
  } catch (err) {
    showNotice(`Could not load statement: ${err.message}`, 'error');
  }
}
if ($('#closeStatementBtn')) $('#closeStatementBtn').onclick = () => statementDialog.close();
if ($('#dismissStatementBtn')) $('#dismissStatementBtn').onclick = () => statementDialog.close();
if ($('#printStatementBtn')) $('#printStatementBtn').onclick = () => window.print();

// ==========================================
// STAFF PERMISSIONS & PIN LOCK
// ==========================================
state.role = 'owner'; // 'owner' | 'attendant'
const pinDialog = $('#pinDialog');

function updateStaffUi() {
  const btn = $('#staffModeBtn');
  if (btn) {
    btn.textContent = state.role === 'owner' ? '👑 Owner Mode' : '👤 Attendant Mode';
    btn.className = `button ${state.role === 'owner' ? 'button-outline' : 'button-dark'}`;
  }
}

if ($('#staffModeBtn')) {
  $('#staffModeBtn').addEventListener('click', () => {
    if (state.role === 'owner') {
      state.role = 'attendant';
      showNotice('Switched to Attendant Mode. Settings and general ledger locked.');
      updateStaffUi();
    } else {
      $('#pinCodeInput').value = '';
      pinDialog.showModal();
    }
  });
}
if ($('#closePinDialogBtn')) $('#closePinDialogBtn').onclick = () => pinDialog.close();
if ($('#cancelPinBtn')) $('#cancelPinBtn').onclick = () => pinDialog.close();

if ($('#pinUnlockForm')) {
  $('#pinUnlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const pin = $('#pinCodeInput').value.trim();
      const res = await api('/api/auth/verify-pin', { method: 'POST', body: JSON.stringify({ pin }) });
      state.role = res.user.role;
      pinDialog.close();
      showNotice(`Unlocked as ${res.user.name} (${res.user.role})!`);
      updateStaffUi();
    } catch (err) {
      showNotice(`PIN Verification failed: ${err.message}`, 'error');
    }
  });
}

if ($('#changePinBtn')) {
  $('#changePinBtn').addEventListener('click', async () => {
    const oldPin = $('#oldPinInput').value.trim();
    const newPin = $('#newPinInput').value.trim();
    if (!oldPin || !newPin) return showNotice('Enter current and new PIN.', 'error');
    try {
      await api('/api/auth/change-pin', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'usr-owner-1', old_pin: oldPin, new_pin: newPin })
      });
      $('#oldPinInput').value = '';
      $('#newPinInput').value = '';
      showNotice('Owner PIN updated successfully.');
    } catch (err) {
      showNotice(`Failed to update PIN: ${err.message}`, 'error');
    }
  });
}

// ==========================================
// VOICE RECORDING (SAUTI SPEECH-TO-TEXT)
// ==========================================
if ($('#voiceRecordBtn')) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = state.lang === 'sw' ? 'sw-KE' : 'en-KE';

    let isRecording = false;
    $('#voiceRecordBtn').addEventListener('click', () => {
      if (isRecording) {
        recognition.stop();
        return;
      }
      try {
        recognition.lang = state.lang === 'sw' ? 'sw-KE' : 'en-KE';
        recognition.start();
        isRecording = true;
        $('#voiceRecordBtn').textContent = '⏹️ Listening… (Speak)';
        $('#voiceRecordBtn').classList.add('button-dark');
        showNotice('Listening… Speak your note in English or Kiswahili.');
      } catch (e) {
        showNotice(`Microphone error: ${e.message}`, 'error');
      }
    });

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const existing = $('#noteInput').value.trim();
      $('#noteInput').value = existing ? `${existing} ${transcript}` : transcript;
      $('#charCount').textContent = `${$('#noteInput').value.length} / 5,000`;
      showNotice('Voice note captured! Click "Interpret with QVAC" to verify.');
    };

    recognition.onerror = (e) => {
      showNotice(`Speech error: ${e.error || 'Check microphone permission.'}`, 'error');
    };

    recognition.onend = () => {
      isRecording = false;
      $('#voiceRecordBtn').textContent = '🎙️ Speak Note';
      $('#voiceRecordBtn').classList.remove('button-dark');
    };
  } else {
    $('#voiceRecordBtn').title = 'Microphone speech recognition is available in Chrome / Edge / Electron';
    $('#voiceRecordBtn').addEventListener('click', () => {
      showNotice('Speech recognition is supported in browser/desktop with microphone access. Type note directly.', 'error');
    });
  }
}

// ==========================================
// STOCK BULK UNPACKING (CRATE TO PIECE)
// ==========================================
if ($('#unpackForm')) {
  $('#unpackForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      const res = await api('/api/units/unpack', {
        method: 'POST',
        body: JSON.stringify({
          from_product_id: fd.get('from_product_id'),
          to_product_id: fd.get('to_product_id'),
          quantity: Number(fd.get('quantity')),
          factor: Number(fd.get('factor'))
        })
      });
      showNotice(`Unpacked ${fd.get('quantity')} bulk unit(s) into retail shelf pieces!`);
      await loadInventory();
    } catch (err) {
      showNotice(`Unpacking error: ${err.message}`, 'error');
    }
  });
}

// ==========================================
// SAMPLE WORKSPACE SEEDER
// ==========================================
if ($('#seedDemoBtn')) {
  $('#seedDemoBtn').addEventListener('click', async () => {
    if (!confirm('Load sample Kenyan Duka workspace with products, customers and suppliers?')) return;
    try {
      const res = await api('/api/demo/seed', { method: 'POST', body: '{}' });
      showNotice(res.message);
      await Promise.all([loadInventory(), loadCustomers(), loadSuppliers(), refreshDashboard()]);
    } catch (err) {
      showNotice(`Seeding failed: ${err.message}`, 'error');
    }
  });
}

// ==========================================
// LOCALIZATION (ENGLISH / KISWAHILI)
// ==========================================
state.lang = localStorage.getItem('dukasauti_lang') || 'en';

const I18N = {
  en: {
    today: 'Good morning.',
    checkout: 'Point of Sale (POS)',
    entry: 'Smart Shop Assistant',
    ledger: 'Transactions & General Records',
    inventory: 'Stock Control & Products',
    customers: 'Customer Accounts & Credit',
    suppliers: 'Suppliers & Bills Payable',
    mpesa: 'M-Pesa Statement Reconciler',
    reports: 'Financial Performance & COGS',
    journals: 'General Ledger & Balanced Journals',
    reconcile: 'Close Current Shift',
    settings: 'Shop Configuration & Backups',
    sales: 'Recorded Sales',
    cashIn: 'Cash Received',
    expenses: 'Operating Expenses',
    toggleBtn: '🇰🇪 Kiswahili'
  },
  sw: {
    today: 'Habari ya Leo.',
    checkout: 'Dawati la Mauzo (POS)',
    entry: 'Msaidizi wa Sauti AI',
    ledger: 'Leja ya Biashara',
    inventory: 'Udhibiti wa Bidhaa na Ghala',
    customers: 'Wateja na Madeni (Deni)',
    suppliers: 'Wasambazaji na Ankara',
    mpesa: 'Upatanisho wa M-Pesa',
    reports: 'Ripoti za Mapato na Faida',
    journals: 'Leja Kuu na Majarida',
    reconcile: 'Funga Shift / Hesabu ya Fedha',
    settings: 'Mipangilio na Hifadhi ya Data',
    sales: 'Mauzo Yaliyothibitishwa',
    cashIn: 'Pesa Taslimu',
    expenses: 'Matumizi ya Duka',
    toggleBtn: '🇬🇧 English'
  }
};

function applyLanguage(lang) {
  state.lang = lang;
  localStorage.setItem('dukasauti_lang', lang);
  if ($('#langToggleBtn')) $('#langToggleBtn').textContent = I18N[lang].toggleBtn;
  const activePage = document.querySelector('.page.active')?.id?.replace('page-', '') || 'today';
  $('#pageTitle').textContent = I18N[lang][activePage] || 'DukaSauti';
}

if ($('#langToggleBtn')) {
  $('#langToggleBtn').addEventListener('click', () => {
    applyLanguage(state.lang === 'en' ? 'sw' : 'en');
  });
}

// Start application
applyLanguage(state.lang);
init();
