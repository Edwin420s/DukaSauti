import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, audit } from '../src/db.js';
import { handleBusinessApi } from '../src/business.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dukasauti-biz-test-'));
  const db = openDatabase(path.join(dir, 'test.sqlite'));
  return {
    db,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function call(db, method, url, payload = {}) {
  let status, body;
  const res = {
    writeHead(s) { status = s; },
    end(v) {
      try { body = JSON.parse(v); }
      catch { body = v; }
    }
  };
  const req = { method };
  const handled = await handleBusinessApi(req, res, new URL(url, 'http://local'), db, async () => payload, audit);
  return { handled, status, body };
}

test('multi-item POS sale decrements stock, calculates COGS, and posts auto journal', async () => {
  const f = fixture();
  try {
    const p1 = await call(f.db, 'POST', '/api/products', { name: 'Soap 200g', selling_price_minor: 10000, cost_price_minor: 7000, stock_qty: 10 });
    const p2 = await call(f.db, 'POST', '/api/products', { name: 'Bread 400g', selling_price_minor: 6500, cost_price_minor: 5000, stock_qty: 5 });
    const c = await call(f.db, 'POST', '/api/customers', { name: 'Otieno', credit_limit_minor: 50000 });

    const sale = await call(f.db, 'POST', '/api/sales', {
      lines: [
        { product_id: p1.body.id, quantity: 2 }, // 2 * 10000 = 20000, cogs: 14000
        { product_id: p2.body.id, quantity: 1 }  // 1 * 6500 = 6500, cogs: 5000
      ],
      cash_received_minor: 15000,
      mobile_money_received_minor: 5000,
      bank_received_minor: 0,
      credit_amount_minor: 6500,
      customer_id: c.body.id,
      business_date: '2026-10-30'
    });

    assert.equal(sale.status, 201);
    assert.equal(sale.body.transaction.amount_minor, 26500);
    assert.equal(sale.body.transaction.cogs_minor, 19000); // 14000 + 5000

    // Check stock decremented
    assert.equal(f.db.prepare('SELECT stock_qty FROM products WHERE id=?').get(p1.body.id).stock_qty, 8);
    assert.equal(f.db.prepare('SELECT stock_qty FROM products WHERE id=?').get(p2.body.id).stock_qty, 4);

    // Check customer credit charge
    assert.equal(f.db.prepare("SELECT amount_minor FROM customer_credits WHERE customer_id=? AND entry_type='charge'").get(c.body.id).amount_minor, 6500);

    // Check automatic journal posting
    const journal = f.db.prepare('SELECT * FROM journal_entries WHERE reference=?').get(sale.body.transaction.id);
    assert.ok(journal);
    assert.equal(journal.status, 'posted');

    const jLines = f.db.prepare('SELECT * FROM journal_lines WHERE entry_id=?').all(journal.id);
    const sumDebit = jLines.reduce((s, l) => s + l.debit_minor, 0);
    const sumCredit = jLines.reduce((s, l) => s + l.credit_minor, 0);
    assert.equal(sumDebit, sumCredit);
  } finally {
    f.close();
  }
});

test('supplier bills can restock products and bill payments reduce payable', async () => {
  const f = fixture();
  try {
    const s = await call(f.db, 'POST', '/api/suppliers', { name: 'Unga Millers' });
    const p = await call(f.db, 'POST', '/api/products', { name: 'Flour 2kg', selling_price_minor: 20000, cost_price_minor: 15000, stock_qty: 5 });

    // Bill with stock restock
    const bill = await call(f.db, 'POST', '/api/suppliers/bills', {
      supplier_id: s.body.id,
      reference: 'INV-441',
      amount_minor: 150000,
      items: [{ product_id: p.body.id, quantity: 10, unit_cost_minor: 15000 }]
    });
    assert.equal(bill.status, 201);

    // Stock should increase from 5 to 15
    assert.equal(f.db.prepare('SELECT stock_qty FROM products WHERE id=?').get(p.body.id).stock_qty, 15);

    // Partial bill payment
    const payment = await call(f.db, 'POST', `/api/suppliers/bills/${bill.body.id}/payment`, {
      amount_minor: 50000,
      payment_method: 'mobile_money',
      business_date: '2026-10-30'
    });
    assert.equal(payment.status, 201);
    assert.equal(payment.body.bill.paid_minor, 50000);
    assert.equal(payment.body.bill.amount_minor - payment.body.bill.paid_minor, 100000);
  } finally {
    f.close();
  }
});

test('shift position calculates drawer float, cash sales, and close shift', async () => {
  const f = fixture();
  try {
    f.db.prepare('UPDATE shops SET opening_cash_minor=5000 WHERE id=1').run();
    const p = await call(f.db, 'POST', '/api/products', { name: 'Milk 500ml', selling_price_minor: 6000, cost_price_minor: 4500, stock_qty: 20 });

    // Cash sale of 2 milks (12000 cash)
    await call(f.db, 'POST', '/api/sales', {
      lines: [{ product_id: p.body.id, quantity: 2 }],
      cash_received_minor: 12000,
      business_date: '2026-10-30'
    });

    const shift = await call(f.db, 'GET', '/api/shifts/position?date=2026-10-30');
    assert.equal(shift.body.opening_float_minor, 5000);
    assert.equal(shift.body.cash_sales_minor, 12000);
    assert.equal(shift.body.expected_in_counter_minor, 17000); // 5000 + 12000

    // Close shift with balanced cash
    const close = await call(f.db, 'POST', '/api/shifts/close', {
      date: '2026-10-30',
      counted_cash_minor: 17000,
      notes: 'Shift balanced successfully'
    });
    assert.equal(close.body.is_balanced, true);
    assert.equal(close.body.difference_minor, 0);
  } finally {
    f.close();
  }
});

test('M-Pesa SMS parse, import, and match against transactions', async () => {
  const f = fixture();
  try {
    const rawSms = 'PK99ZZ11AA Confirmed. Ksh 2,500.00 received from ALICE NJERI 0722111222 on 30/10/26 at 3:15 PM.';
    const parseRes = await call(f.db, 'POST', '/api/mpesa/parse', { text: rawSms });
    assert.equal(parseRes.body.mpesa_code, 'PK99ZZ11AA');
    assert.equal(parseRes.body.amount_minor, 250000);

    const impRes = await call(f.db, 'POST', '/api/mpesa/import', { records: [parseRes.body] });
    assert.equal(impRes.body.imported, 1);

    const listRes = await call(f.db, 'GET', '/api/mpesa?status=unmatched');
    assert.equal(listRes.body.length, 1);

    // Insert a transaction to match against
    const txId = 'test-tx-mpesa-1';
    f.db.prepare("INSERT INTO transactions(id,type,description,amount_minor,currency,business_date,status) VALUES(?,'sale','M-Pesa sale',250000,'KES','2026-10-30','confirmed')").run(txId);

    // Match with the transaction ID
    const matchRes = await call(f.db, 'POST', `/api/mpesa/${listRes.body[0].id}/match`, { transaction_id: txId });
    assert.equal(matchRes.body.ok, true);

    const updated = f.db.prepare('SELECT status, matched_transaction_id FROM mpesa_records WHERE id=?').get(listRes.body[0].id);
    assert.equal(updated.status, 'matched');
    assert.equal(updated.matched_transaction_id, txId);
  } finally {
    f.close();
  }
});

test('backup export and restore preserves data integrity', async () => {
  const f = fixture();
  try {
    await call(f.db, 'POST', '/api/products', { name: 'Salt 500g', selling_price_minor: 2500, cost_price_minor: 1500, stock_qty: 10 });
    const backupRes = await call(f.db, 'GET', '/api/backup');
    assert.equal(backupRes.body.app, 'DukaSauti');
    assert.ok(backupRes.body.tables.products.length >= 1);

    // Add another item
    await call(f.db, 'POST', '/api/products', { name: 'Sugar 1kg', selling_price_minor: 15000, cost_price_minor: 12000, stock_qty: 5 });
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM products').get().n, 2);

    // Restore from first backup
    const restoreRes = await call(f.db, 'POST', '/api/backup/restore', backupRes.body);
    assert.equal(restoreRes.body.ok, true);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM products').get().n, 1);
    assert.equal(f.db.prepare('SELECT name FROM products').get().name, 'Salt 500g');
  } finally {
    f.close();
  }
});

test('staff PIN verification, unpack bulk stock, tax summary, and demo seeder', async () => {
  const f = fixture();
  try {
    // 1. PIN verification
    const pinCheck = await call(f.db, 'POST', '/api/auth/verify-pin', { pin: '1234' });
    assert.equal(pinCheck.status, 200);
    assert.equal(pinCheck.body.user.role, 'owner');

    const badPin = await call(f.db, 'POST', '/api/auth/verify-pin', { pin: '9999' });
    assert.equal(badPin.status, 401);

    // 2. Unpack bulk stock: Crate of 24 sodas unpacked into single bottles
    const pCrate = await call(f.db, 'POST', '/api/products', { name: 'Soda Crate', unit: 'crate', selling_price_minor: 120000, cost_price_minor: 96000, stock_qty: 2 });
    const pSingle = await call(f.db, 'POST', '/api/products', { name: 'Soda Single', unit: 'piece', selling_price_minor: 5000, cost_price_minor: 4000, stock_qty: 0 });

    const unpackRes = await call(f.db, 'POST', '/api/units/unpack', {
      from_product_id: pCrate.body.id,
      to_product_id: pSingle.body.id,
      quantity: 1, // unpack 1 crate
      factor: 24
    });
    assert.equal(unpackRes.status, 200);
    assert.equal(unpackRes.body.source_product.stock_qty, 1);
    assert.equal(unpackRes.body.target_product.stock_qty, 24);

    // 3. Tax summary & KRA eTIMS invoice
    const sale = await call(f.db, 'POST', '/api/sales', {
      lines: [{ product_id: pSingle.body.id, quantity: 2 }],
      cash_received_minor: 10000,
      business_date: '2026-10-30'
    });
    const taxSum = await call(f.db, 'GET', '/api/tax/summary?from=2026-10-30&to=2026-10-30');
    assert.equal(taxSum.status, 200);
    assert.equal(taxSum.body.vat_rate_percent, 16);
    assert.ok(taxSum.body.vat_payable_minor > 0);

    const etimsRes = await call(f.db, 'POST', '/api/tax/etims-invoice', { transaction_id: sale.body.transaction.id });
    assert.equal(etimsRes.status, 201);
    assert.ok(etimsRes.body.invoice_number.startsWith('KRA-ETIMS'));

    // 4. Statements
    const cust = await call(f.db, 'POST', '/api/customers', { name: 'Nduta', credit_limit_minor: 10000 });
    await call(f.db, 'POST', '/api/credits', { customer_id: cust.body.id, entry_type: 'charge', amount_minor: 3500 });
    const stmtRes = await call(f.db, 'GET', `/api/customers/${cust.body.id}/statement`);
    assert.equal(stmtRes.status, 200);
    assert.ok(stmtRes.body.text.includes('Nduta'));
    assert.ok(stmtRes.body.text.includes('35.00'));

    // 5. Demo Seeder
    const demoRes = await call(f.db, 'POST', '/api/demo/seed', {});
    assert.equal(demoRes.status, 200);
    const prodCount = f.db.prepare('SELECT COUNT(*) n FROM products').get().n;
    assert.ok(prodCount >= 8); // Seeder added standard products
  } finally {
    f.close();
  }
});
