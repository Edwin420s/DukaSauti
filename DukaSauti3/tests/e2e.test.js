import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const port = 45000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dukasauti-e2e-'));
const dbPath = path.join(dir, 'e2e.sqlite');
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

test('Comprehensive End-to-End Workflow: Frontend static assets, POS, Inventory, Credit, Shift, Tax, M-Pesa & Restore', async t => {
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 1000))]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForServer();

  // 1. Verify static frontend assets served
  const htmlRes = await fetch(`${base}/`);
  assert.equal(htmlRes.status, 200);
  const htmlText = await htmlRes.text();
  assert.ok(htmlText.includes('DukaSauti'));
  assert.ok(htmlText.includes('Point of Sale (POS)'));
  assert.ok(htmlText.includes('Close Current Shift'));

  const cssRes = await fetch(`${base}/styles.css`);
  assert.equal(cssRes.status, 200);

  const jsRes = await fetch(`${base}/app.js`);
  assert.equal(jsRes.status, 200);

  // 2. Health check
  const healthRes = await fetch(`${base}/api/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.app, 'DukaSauti');

  // 4. Seed demo Kenyan catalogue
  const seedRes = await fetch(`${base}/api/demo/seed`, { method: 'POST', body: '{}' });
  assert.equal(seedRes.status, 200);

  // Set opening float for today's shift testing
  const shopRes = await fetch(`${base}/api/shop`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Duka Bora Superette', opening_cash_minor: 75000 })
  });
  assert.equal(shopRes.status, 200);

  // 5. Fetch products
  const prodsRes = await fetch(`${base}/api/products`);
  const products = await prodsRes.json();
  assert.ok(products.length >= 8);
  const unga = products.find(p => p.sku === '616110001001');
  const milk = products.find(p => p.sku === '616110001003');
  const sodaCrate = products.find(p => p.sku === '616110001007');
  const sodaPiece = products.find(p => p.sku === '616110001008');
  assert.ok(unga && milk && sodaCrate && sodaPiece);

  // 6. Fetch customers
  const custRes = await fetch(`${base}/api/customers`);
  const customers = await custRes.json();
  assert.ok(customers.length >= 3);
  const mamaKevin = customers.find(c => c.name.includes('Mama Kevin'));
  assert.ok(mamaKevin);

  // 7. Multi-line POS sale: 2 Unga (2 * 160 = 320 KSh = 32000 minor) + 1 Milk (65 KSh = 6500 minor) = 38500 total
  // Split tender: 20000 cash + 10000 mpesa + 8500 credit
  const initialUngaStock = unga.stock_qty;
  const initialMilkStock = milk.stock_qty;

  const saleRes = await fetch(`${base}/api/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lines: [
        { product_id: unga.id, quantity: 2 },
        { product_id: milk.id, quantity: 1 }
      ],
      cash_received_minor: 20000,
      mobile_money_received_minor: 10000,
      bank_received_minor: 0,
      credit_amount_minor: 8500,
      customer_id: mamaKevin.id,
      business_date: '2026-10-30'
    })
  });
  assert.equal(saleRes.status, 201);
  const saleData = await saleRes.json();
  assert.equal(saleData.transaction.amount_minor, 38500);

  // Verify stock decremented
  const updatedProds = await (await fetch(`${base}/api/products`)).json();
  assert.equal(updatedProds.find(p => p.id === unga.id).stock_qty, initialUngaStock - 2);
  assert.equal(updatedProds.find(p => p.id === milk.id).stock_qty, initialMilkStock - 1);

  // Verify customer debt updated
  const updatedCusts = await (await fetch(`${base}/api/customers`)).json();
  assert.equal(updatedCusts.find(c => c.id === mamaKevin.id).balance_minor, 8500);

  // 8. Generate and verify thermal receipt
  const receiptRes = await fetch(`${base}/api/transactions/${saleData.transaction.id}/receipt`);
  assert.equal(receiptRes.status, 200);
  const receipt = await receiptRes.json();
  assert.ok(receipt.text.includes('Duka Bora Superette'));
  assert.ok(receipt.text.includes('Unga wa Mahindi Pembe 2kg'));
  assert.ok(receipt.text.includes('Brookside Fresh Milk 500ml'));
  assert.ok(receipt.text.includes('TOTAL AMOUNT'));

  // 9. Unpack bulk stock: 1 Crate of soda (24s) unpacked into 24 pieces
  const unpackRes = await fetch(`${base}/api/units/unpack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_product_id: sodaCrate.id,
      to_product_id: sodaPiece.id,
      quantity: 1,
      factor: 24
    })
  });
  assert.equal(unpackRes.status, 200);
  const unpackData = await unpackRes.json();
  assert.equal(unpackData.source_product.stock_qty, sodaCrate.stock_qty - 1);
  assert.equal(unpackData.target_product.stock_qty, sodaPiece.stock_qty + 24);

  // 10. Customer repayment: Mama Kevin repays 5000 via M-Pesa
  const repayRes = await fetch(`${base}/api/credits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: mamaKevin.id,
      entry_type: 'payment',
      amount_minor: 5000,
      payment_method: 'mobile_money',
      business_date: '2026-10-30',
      notes: 'Repaid via M-Pesa Till'
    })
  });
  assert.equal(repayRes.status, 201);
  const custAfterRepay = await (await fetch(`${base}/api/customers`)).json();
  assert.equal(custAfterRepay.find(c => c.id === mamaKevin.id).balance_minor, 3500); // 8500 - 5000

  // 11. Customer Statement
  const stmtRes = await fetch(`${base}/api/customers/${mamaKevin.id}/statement`);
  assert.equal(stmtRes.status, 200);
  const custStmt = await stmtRes.json();
  assert.ok(custStmt.text.includes('CUSTOMER STATEMENT'));
  assert.ok(custStmt.text.includes('Mama Kevin'));
  assert.ok(custStmt.text.includes('35.00')); // Remaining 35 KSh balance

  // 12. Supplier bill & payment
  const supps = await (await fetch(`${base}/api/suppliers`)).json();
  const bakery = supps.find(s => s.name.includes('Festive'));
  assert.ok(bakery);

  const billRes = await fetch(`${base}/api/suppliers/bills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      supplier_id: bakery.id,
      reference: 'INV-FESTIVE-101',
      amount_minor: 20000, // 200 KSh
      business_date: '2026-10-30'
    })
  });
  assert.equal(billRes.status, 201);
  const bill = await billRes.json();

  const billPayRes = await fetch(`${base}/api/suppliers/bills/${bill.id}/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_minor: 12000,
      payment_method: 'cash',
      business_date: '2026-10-30'
    })
  });
  assert.equal(billPayRes.status, 201);
  const billAfterPay = await billPayRes.json();
  assert.equal(billAfterPay.bill.paid_minor, 12000);

  // 13. M-Pesa SMS Parser & Match
  const rawMpesa = 'QW12ER34TY Confirmed. You have received Ksh 1,500.00 from PETER OMONDI 0711223344 on 30/10/26 at 2:30 PM.';
  const parseRes = await fetch(`${base}/api/mpesa/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: rawMpesa })
  });
  assert.equal(parseRes.status, 200);
  const parsed = await parseRes.json();
  assert.equal(parsed.mpesa_code, 'QW12ER34TY');
  assert.equal(parsed.amount_minor, 150000);

  const importRes = await fetch(`${base}/api/mpesa/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [parsed] })
  });
  assert.equal(importRes.status, 201);

  // 14. Cash Drawer Shift Position & Close
  // Float = 75000, Cash Sales = 20000, Supplier Cash Paid = 12000 -> Expected in Counter = 75000 + 20000 - 12000 = 83000
  const shiftRes = await fetch(`${base}/api/shifts/position?date=2026-10-30`);
  assert.equal(shiftRes.status, 200);
  const shiftPos = await shiftRes.json();
  assert.equal(shiftPos.opening_float_minor, 75000);
  assert.equal(shiftPos.cash_sales_minor, 20000);
  assert.equal(shiftPos.cash_supplier_paid_minor, 12000);
  assert.equal(shiftPos.expected_in_counter_minor, 83000);

  const closeShiftRes = await fetch(`${base}/api/shifts/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-30',
      counted_cash_minor: 83000,
      notes: 'Evening shift closed balanced'
    })
  });
  assert.equal(closeShiftRes.status, 201);
  const closeData = await closeShiftRes.json();
  assert.equal(closeData.is_balanced, true);
  assert.equal(closeData.difference_minor, 0);

  // 15. Reports: P&L with COGS
  const repRes = await fetch(`${base}/api/reports/overview?from=2026-10-30&to=2026-10-30`);
  assert.equal(repRes.status, 200);
  const rep = await repRes.json();
  assert.equal(rep.sales_minor, 38500);
  assert.ok(rep.cogs_minor > 0);
  assert.equal(rep.gross_profit_minor, rep.sales_minor - rep.cogs_minor);

  // 16. KRA eTIMS Tax Summary & Invoice
  const taxSumRes = await fetch(`${base}/api/tax/summary?from=2026-10-30&to=2026-10-30`);
  assert.equal(taxSumRes.status, 200);
  const taxSum = await taxSumRes.json();
  assert.equal(taxSum.vat_rate_percent, 16);
  assert.ok(taxSum.vat_payable_minor > 0);

  const etimsRes = await fetch(`${base}/api/tax/etims-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction_id: saleData.transaction.id })
  });
  assert.equal(etimsRes.status, 201);
  const etimsInv = await etimsRes.json();
  assert.ok(etimsInv.invoice_number.startsWith('KRA-ETIMS'));

  // 17. Double-Entry General Ledger
  const jnlRes = await fetch(`${base}/api/journals`);
  assert.equal(jnlRes.status, 200);
  const journals = await jnlRes.json();
  assert.ok(journals.length >= 3); // Auto-journals for sale, repayment, supplier bill & payment

  // 18. Staff PIN verification
  const pinRes = await fetch(`${base}/api/auth/verify-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '1234' })
  });
  assert.equal(pinRes.status, 200);
  const pinData = await pinRes.json();
  assert.equal(pinData.user.role, 'owner');

  // 19. CSV Export
  const csvRes = await fetch(`${base}/api/export.csv`);
  assert.equal(csvRes.status, 200);
  const csvText = await csvRes.text();
  assert.ok(csvText.includes('business_date,type'));
  assert.ok(csvText.includes('sale'));

  // 20. Backup & Transactional Restore
  const backupRes = await fetch(`${base}/api/backup`);
  assert.equal(backupRes.status, 200);
  const backup = await backupRes.json();
  assert.equal(backup.app, 'DukaSauti');
  assert.ok(backup.tables.products.length >= 8);

  const restoreRes = await fetch(`${base}/api/backup/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(backup)
  });
  assert.equal(restoreRes.status, 200);
});
