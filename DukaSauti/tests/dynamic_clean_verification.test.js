import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const port = 46000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dukasauti-clean-test-'));
const dbPath = path.join(dir, 'clean.sqlite');

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: projectRoot,
  env: { ...process.env, PORT: String(port), DUKASAUTI_DB: dbPath },
  stdio: ['ignore', 'pipe', 'pipe']
});

let logs = '';
child.stdout.on('data', d => logs += d);
child.stderr.on('data', d => logs += d);

const base = `http://127.0.0.1:${port}`;

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server failed to start within timeout. Logs:\n${logs}`);
}

test('Zero Static or Mock Data Verification: Clean empty state, dynamic population, and frontend UI text completeness', async t => {
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 1000))]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForServer();

  // 1. Verify Clean Empty Database State (Zero Mock Data)
  const prodsRes = await fetch(`${base}/api/products`);
  const products = await prodsRes.json();
  assert.equal(products.length, 0, 'Fresh database must have zero products (no mock products)');

  const custsRes = await fetch(`${base}/api/customers`);
  const customers = await custsRes.json();
  assert.equal(customers.length, 0, 'Fresh database must have zero customers (no mock customers)');

  const suppsRes = await fetch(`${base}/api/suppliers`);
  const suppliers = await suppsRes.json();
  assert.equal(suppliers.length, 0, 'Fresh database must have zero suppliers (no mock suppliers)');

  const txsRes = await fetch(`${base}/api/transactions`);
  const transactions = await txsRes.json();
  assert.equal(transactions.length, 0, 'Fresh database must have zero transactions (no mock transactions)');

  const billsRes = await fetch(`${base}/api/suppliers/bills`);
  const bills = await billsRes.json();
  assert.equal(bills.length, 0, 'Fresh database must have zero bills (no mock bills)');

  const mpesaRes = await fetch(`${base}/api/mpesa`);
  const mpesaRecords = await mpesaRes.json();
  assert.equal(mpesaRecords.length, 0, 'Fresh database must have zero M-Pesa records (no mock mpesa)');

  // 2. Verify Frontend HTML Text Completeness & Absence of Hardcoded Data
  const htmlRes = await fetch(`${base}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();

  // Check required UI sections and clear user text
  assert.ok(html.includes("Point of Sale (POS)"), 'POS Checkout view must be present');
  assert.ok(html.includes("What happened in the shop?"), 'Sauti Entry prompt must be present');
  assert.ok(html.includes("Close Current Shift"), 'Close Shift section must be present');
  assert.ok(html.includes("All Business Records"), 'Ledger section must be present');
  assert.ok(html.includes("Banknotes Breakdown"), 'Banknote counting breakdown must be present');
  assert.ok(html.includes("CHANGE TO RETURN"), 'Change return card must be present');

  // Verify that table bodies contain no hardcoded table rows
  assert.ok(html.includes('<tbody id="ledgerBody">'), 'Dynamic ledger tbody exists');
  assert.ok(html.includes('<tbody id="productsBody"></tbody>'), 'Products tbody is empty in static markup');
  assert.ok(html.includes('<tbody id="customersBody"></tbody>'), 'Customers tbody is empty in static markup');
  assert.ok(html.includes('<tbody id="billsBody"></tbody>'), 'Bills tbody is empty in static markup');

  // 3. Dynamic Creation: Create Real Product and Customer
  const addProdRes = await fetch(`${base}/api/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Fresh Mandazi Single',
      sku: 'MAN-001',
      category: 'Bakery',
      unit: 'piece',
      selling_price_minor: 2000, // 20.00 KSh
      cost_price_minor: 1200,    // 12.00 KSh
      stock_qty: 100,
      reorder_level: 15
    })
  });
  assert.equal(addProdRes.status, 201);
  const createdProd = await addProdRes.json();
  assert.equal(createdProd.name, 'Fresh Mandazi Single');
  assert.equal(createdProd.stock_qty, 100);

  const addCustRes = await fetch(`${base}/api/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Alice Wanjiku',
      phone: '0711223344',
      credit_limit_minor: 50000, // 500.00 KSh
      notes: 'Local customer'
    })
  });
  assert.equal(addCustRes.status, 201);
  const createdCust = await addCustRes.json();
  assert.equal(createdCust.name, 'Alice Wanjiku');
  assert.equal(createdCust.balance_minor, 0);

  // 4. Dynamic POS Sale with Split Tender & Customer Debt
  // 5 Mandazis @ 20.00 = 100.00 KSh (10000 minor)
  // Tender: 60.00 KSh cash (6000 minor) + 40.00 KSh credit (4000 minor)
  const saleRes = await fetch(`${base}/api/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lines: [{ product_id: createdProd.id, quantity: 5, unit_price_minor: 2000 }],
      cash_received_minor: 6000,
      mobile_money_received_minor: 0,
      bank_received_minor: 0,
      credit_amount_minor: 4000,
      customer_id: createdCust.id,
      business_date: '2026-10-30'
    })
  });
  assert.equal(saleRes.status, 201);
  const sale = await saleRes.json();
  assert.equal(sale.transaction.amount_minor, 10000);

  // 5. Verify Real Stock Decrement in Database (100 - 5 = 95)
  const verifyProds = await (await fetch(`${base}/api/products`)).json();
  assert.equal(verifyProds.length, 1);
  assert.equal(verifyProds[0].stock_qty, 95);

  // 6. Verify Customer Debt Recorded in Database (0 + 4000 = 4000 minor)
  const verifyCusts = await (await fetch(`${base}/api/customers`)).json();
  assert.equal(verifyCusts.length, 1);
  assert.equal(verifyCusts[0].balance_minor, 4000);

  // 7. Dynamic Customer Debt Repayment
  const repayRes = await fetch(`${base}/api/credits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: createdCust.id,
      entry_type: 'repayment',
      amount_minor: 2500, // 25.00 KSh repaid
      payment_method: 'cash',
      notes: 'Partial debt payment'
    })
  });
  assert.equal(repayRes.status, 201);

  // Verify updated customer balance (4000 - 2500 = 1500 minor)
  const updatedCust = (await (await fetch(`${base}/api/customers`)).json())[0];
  assert.equal(updatedCust.balance_minor, 1500);

  // 8. Verify Shift Cash Reconciliation Calculation
  // Opening float = 0
  // Cash sales = 6000 minor (60 KSh)
  // Customer cash repayment = 2500 minor (25 KSh)
  // Expected in drawer = 8500 minor (85 KSh)
  const shiftPos = await (await fetch(`${base}/api/shifts/position?date=2026-10-30`)).json();
  assert.equal(shiftPos.cash_sales_minor, 6000);
  assert.equal(shiftPos.expected_in_counter_minor, 8500);

  // Close shift balanced
  const closeRes = await fetch(`${base}/api/shifts/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-30',
      counted_cash_minor: 8500,
      notes: 'Clean shift close verification'
    })
  });
  assert.equal(closeRes.status, 201);
  const closedShift = await closeRes.json();
  assert.equal(closedShift.is_balanced, true);
  assert.equal(closedShift.difference_minor, 0);

  // 9. Verify General Ledger & Journals dynamically balanced
  const journals = await (await fetch(`${base}/api/journals`)).json();
  assert.ok(journals.length >= 2, 'Must have auto-generated double-entry journal records');
  for (const j of journals) {
    assert.equal(j.debit_minor, j.credit_minor, 'Every journal entry must have equal debits and credits');
  }

  // 10. Verify P&L Overview
  // Gross sales = 10000 minor (100 KSh)
  // COGS = 5 * 1200 = 6000 minor (60 KSh)
  // Gross profit = 10000 - 6000 = 4000 minor (40 KSh)
  const overview = await (await fetch(`${base}/api/reports/overview?from=2026-10-30&to=2026-10-30`)).json();
  assert.equal(overview.sales_minor, 10000);
  assert.equal(overview.cogs_minor, 6000);
  assert.equal(overview.gross_profit_minor, 4000);
});
