import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinorUnits,
  formatKes,
  validateProposal,
  cashExpected,
  computeDailySummary,
  parseSimpleNote,
  parseMpesaSms,
  encryptBackup,
  decryptBackup,
  formatReceipt,
  hashPin,
  calculateTaxBreakdown,
  convertStockUnit,
  formatCustomerStatement,
  formatSupplierStatement
} from '../src/domain.js';

test('money parsing stores integer minor units', () => {
  assert.equal(toMinorUnits('1,234.50'.replaceAll(',', '')), 123450);
  assert.equal(toMinorUnits('0.5'), 50);
  assert.equal(formatKes(15000).includes('150.00'), true);
  assert.throws(() => toMinorUnits('-10'), /cannot be negative/);
  assert.throws(() => toMinorUnits('10.999'), /valid amount/);
});

test('sale allocation cannot exceed sale amount', () => {
  assert.throws(() => validateProposal({ type: 'sale', amount_minor: 10000, currency: 'KES', cash_received_minor: 8000, credit_amount_minor: 3000 }), /cannot exceed/);
  assert.equal(validateProposal({ type: 'sale', amount_minor: 10000, currency: 'KES', cash_received_minor: 7000, credit_amount_minor: 3000 }).amount_minor, 10000);
});

test('cash paid cannot exceed the transaction amount', () => {
  assert.throws(() => validateProposal({ type: 'expense', amount_minor: 1000, currency: 'KES', cash_paid_minor: 1200 }), /cannot exceed/);
});

test('cash reconciliation follows opening + inflows - outflows - withdrawals', () => {
  assert.equal(cashExpected({ openingCashMinor: 100000, cashInflowsMinor: 240000, cashOutflowsMinor: 30000, withdrawalsMinor: 50000 }), 260000);
});

test('daily summary includes confirmed only and computes COGS and gross profit', () => {
  const rows = [
    { status: 'confirmed', type: 'sale', amount_minor: 30000, cogs_minor: 18000, cash_received_minor: 20000, credit_amount_minor: 10000, payment_method: 'mixed', cash_paid_minor: 0 },
    { status: 'confirmed', type: 'expense', amount_minor: 5000, cash_received_minor: 0, cash_paid_minor: 5000, payment_method: 'cash' },
    { status: 'draft', type: 'sale', amount_minor: 99999, cash_received_minor: 99999, credit_amount_minor: 0, payment_method: 'cash', cash_paid_minor: 0 }
  ];
  const result = computeDailySummary(rows);
  assert.equal(result.salesMinor, 30000);
  assert.equal(result.creditSalesMinor, 10000);
  assert.equal(result.cashInMinor, 20000);
  assert.equal(result.cashOutMinor, 5000);
  assert.equal(result.cogsMinor, 18000);
  assert.equal(result.grossProfitMinor, 12000); // 30000 - 18000
  assert.equal(result.operatingSurplusMinor, 7000); // 12000 - 5000
  assert.equal(result.transactionCount, 2);
});

test('M-Pesa SMS parser correctly extracts code, amount, and sender details', () => {
  const sms = 'PK34TY89QR Confirmed. You have received Ksh 1,500.00 from JOHN MWANGI 0712345678 on 30/10/26 at 10:45 AM. New M-PESA balance is Ksh 12,400.00.';
  const parsed = parseMpesaSms(sms);
  assert.equal(parsed.mpesa_code, 'PK34TY89QR');
  assert.equal(parsed.amount_minor, 150000);
  assert.equal(parsed.direction, 'in');
  assert.equal(parsed.sender_or_recipient, 'JOHN MWANGI');
  assert.equal(parsed.phone, '0712345678');
  assert.equal(parsed.transaction_time, '30/10/26 10:45 AM');
});

test('AES-256-GCM encrypted backup encrypts and decrypts with passphrase', () => {
  const testData = { app: 'DukaSauti', testVal: 42, secrets: 'offline-local' };
  const pass = 'super-secret-passphrase';

  const encrypted = encryptBackup(testData, pass);
  assert.equal(encrypted.cipher, 'aes-256-gcm');
  assert.ok(encrypted.ciphertext);
  assert.ok(encrypted.salt);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.tag);

  const decrypted = decryptBackup(encrypted, pass);
  assert.deepEqual(decrypted, testData);

  // Reject wrong passphrase
  assert.throws(() => decryptBackup(encrypted, 'wrong-password'), /Unsupported state|auth tag|bad decrypt/i);
});

test('receipt formatter outputs structured thermal receipt text', () => {
  const shop = { name: 'Duka la Mwangi' };
  const tx = { id: 'test-tx-123456', business_date: '2026-10-30', amount_minor: 50000, cash_received_minor: 50000 };
  const items = [
    { product_name: 'Rice 2kg', quantity: 2, line_total_minor: 30000 },
    { product_name: 'Sugar 1kg', quantity: 1, line_total_minor: 20000 }
  ];
  const receipt = formatReceipt({ shop, transaction: tx, items });
  assert.ok(receipt.includes('Duka la Mwangi'));
  assert.ok(receipt.includes('Rice 2kg'));
  assert.ok(receipt.includes('Sugar 1kg'));
  assert.ok(receipt.includes('TOTAL AMOUNT'));
});

test('hashPin validates 4-8 digit pins and produces sha256 hex', () => {
  const hash = hashPin('1234');
  assert.equal(hash, '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4');
  assert.throws(() => hashPin('12'), /4 to 8 digits/);
  assert.throws(() => hashPin('abcd'), /4 to 8 digits/);
});

test('calculateTaxBreakdown computes Kenyan 16% standard VAT', () => {
  // 11,600 KES cents total -> Net = 10,000, VAT = 1,600
  const tax = calculateTaxBreakdown(11600, { rate: 0.16, isTaxable: true });
  assert.equal(tax.taxable_minor, 10000);
  assert.equal(tax.vat_minor, 1600);
  assert.equal(tax.vat_rate_percent, 16);

  const exempt = calculateTaxBreakdown(5000, { isTaxable: false });
  assert.equal(exempt.vat_minor, 0);
  assert.equal(exempt.tax_category, 'exempt');
});

test('convertStockUnit converts bulk crates, cartons and sacks to retail pieces', () => {
  assert.equal(convertStockUnit(2, 'crate', 'piece'), 48); // 2 * 24
  assert.equal(convertStockUnit(3, 'carton', 'piece'), 36); // 3 * 12
  assert.equal(convertStockUnit(1, 'bag_50kg', 'kg'), 50);
  assert.equal(convertStockUnit(2.5, 'kg', 'gram'), 2500);
  assert.throws(() => convertStockUnit(1, 'unknown', 'piece'), /No conversion factor/);
});

test('customer and supplier statement formatters generate clear account ledgers', () => {
  const cust = { name: 'Mama Kevin', credit_limit_minor: 100000 };
  const credits = [
    { business_date: '2026-10-25', entry_type: 'charge', amount_minor: 40000 },
    { business_date: '2026-10-28', entry_type: 'payment', amount_minor: 15000 }
  ];
  const cStmt = formatCustomerStatement({ customer: cust, credits });
  assert.ok(cStmt.includes('CUSTOMER STATEMENT'));
  assert.ok(cStmt.includes('Mama Kevin'));
  assert.ok(cStmt.includes('250.00')); // 400 - 150 = 250

  const supp = { name: 'Broadway Bakery' };
  const bills = [
    { business_date: '2026-10-20', reference: 'INV-10', amount_minor: 50000, paid_minor: 30000 }
  ];
  const sStmt = formatSupplierStatement({ supplier: supp, bills });
  assert.ok(sStmt.includes('SUPPLIER STATEMENT'));
  assert.ok(sStmt.includes('Broadway Bakery'));
  assert.ok(sStmt.includes('200.00')); // 500 - 300 = 200
});
