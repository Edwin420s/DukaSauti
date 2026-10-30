import test from 'node:test';
import assert from 'node:assert/strict';
import { toMinorUnits, formatKes, validateProposal, cashExpected, computeDailySummary } from '../src/domain.js';

test('money parsing stores integer minor units', () => {
  assert.equal(toMinorUnits('1,234.50'.replaceAll(',', '')), 123450);
  assert.equal(toMinorUnits('0.5'), 50);
  assert.equal(formatKes(15000).includes('150.00'), true);
  assert.throws(() => toMinorUnits('-10'), /valid amount/);
  assert.throws(() => toMinorUnits('10.999'), /valid amount/);
});

test('sale allocation cannot exceed sale amount', () => {
  assert.throws(() => validateProposal({ type:'sale', amount_minor:10000, currency:'KES', cash_received_minor:8000, credit_amount_minor:3000 }), /cannot exceed/);
  assert.equal(validateProposal({ type:'sale', amount_minor:10000, currency:'KES', cash_received_minor:7000, credit_amount_minor:3000 }).amount_minor, 10000);
});

test('cash paid cannot exceed the transaction amount', () => {
  assert.throws(() => validateProposal({ type:'expense', amount_minor:1000, currency:'KES', cash_paid_minor:1200 }), /cannot exceed/);
});

test('cash reconciliation follows opening + inflows - outflows - withdrawals', () => {
  assert.equal(cashExpected({ openingCashMinor:100000, cashInflowsMinor:240000, cashOutflowsMinor:30000, withdrawalsMinor:50000 }), 260000);
});

test('daily summary includes confirmed only and keeps sales, credit and cash separate', () => {
  const rows = [
    {status:'confirmed',type:'sale',amount_minor:30000,cash_received_minor:20000,credit_amount_minor:10000,payment_method:'mixed',cash_paid_minor:0},
    {status:'confirmed',type:'expense',amount_minor:5000,cash_received_minor:0,cash_paid_minor:5000,payment_method:'cash'},
    {status:'draft',type:'sale',amount_minor:99999,cash_received_minor:99999,credit_amount_minor:0,payment_method:'cash',cash_paid_minor:0}
  ];
  const result=computeDailySummary(rows);
  assert.equal(result.salesMinor,30000);
  assert.equal(result.creditSalesMinor,10000);
  assert.equal(result.cashInMinor,20000);
  assert.equal(result.cashOutMinor,5000);
  assert.equal(result.transactionCount,2);
});
