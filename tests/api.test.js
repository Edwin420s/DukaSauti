import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 44000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dukasauti-api-test-'));
const dbPath = path.join(dir, 'app.sqlite');
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve('.'),
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

test('API endpoints: health, shop, sales, POS, receipt, shifts and reports', async t => {
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(r => setTimeout(r, 1000))]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await waitForServer();

  // Health check
  let res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(health.app, 'DukaSauti');
  assert.equal(health.ok, true);

  // Shop settings
  res = await fetch(`${base}/api/shop`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Duka la Majani', opening_cash_minor: 50000 })
  });
  assert.equal(res.status, 200);

  // Create product
  res = await fetch(`${base}/api/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Juice 1L', selling_price_minor: 12000, cost_price_minor: 8000, stock_qty: 10, unit: 'bottle' })
  });
  assert.equal(res.status, 201);
  const prod = await res.json();

  // Customer
  res = await fetch(`${base}/api/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Kiprono', credit_limit_minor: 50000 })
  });
  assert.equal(res.status, 201);
  const cust = await res.json();

  // POS multi-item checkout
  res = await fetch(`${base}/api/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lines: [{ product_id: prod.id, quantity: 2 }],
      cash_received_minor: 14000,
      credit_amount_minor: 10000,
      customer_id: cust.id,
      business_date: '2026-10-30'
    })
  });
  assert.equal(res.status, 201);
  const sale = await res.json();
  assert.equal(sale.transaction.amount_minor, 24000);

  // Receipt endpoint
  res = await fetch(`${base}/api/transactions/${sale.transaction.id}/receipt`);
  assert.equal(res.status, 200);
  const receipt = await res.json();
  assert.ok(receipt.text.includes('Duka la Majani'));
  assert.ok(receipt.text.includes('Juice 1L'));

  // Shift position
  res = await fetch(`${base}/api/shifts/position?date=2026-10-30`);
  assert.equal(res.status, 200);
  const shiftPos = await res.json();
  assert.equal(shiftPos.opening_float_minor, 50000);
  assert.equal(shiftPos.cash_sales_minor, 14000);
  assert.equal(shiftPos.expected_in_counter_minor, 64000);

  // Close shift
  res = await fetch(`${base}/api/shifts/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-30',
      counted_cash_minor: 64000,
      notes: 'End of test day'
    })
  });
  assert.equal(res.status, 201);
  const closeData = await res.json();
  assert.equal(closeData.is_balanced, true);

  // Reports with COGS & Gross Profit
  res = await fetch(`${base}/api/reports/overview?from=2026-10-30&to=2026-10-30`);
  assert.equal(res.status, 200);
  const report = await res.json();
  assert.equal(report.sales_minor, 24000);
  assert.equal(report.cogs_minor, 16000); // 2 * 8000
  assert.equal(report.gross_profit_minor, 8000); // 24000 - 16000
});
