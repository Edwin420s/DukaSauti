export const TRANSACTION_TYPES = new Set([
  'sale', 'expense', 'stock_purchase', 'customer_payment', 'supplier_payment',
  'cash_withdrawal', 'cash_deposit', 'refund', 'opening_balance', 'adjustment'
]);
export const PAYMENT_METHODS = new Set(['cash', 'mobile_money', 'bank', 'credit', 'mixed', 'other', 'none']);

export function toMinorUnits(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) throw new Error('Amount cannot be negative.');
    return Math.round((value + Number.EPSILON) * 100);
  }
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new Error('Enter a valid amount with up to two decimal places.');
  }
  const [whole, fraction = ''] = value.trim().split('.');
  const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  if (!Number.isSafeInteger(minor)) throw new Error('Amount is too large.');
  return minor;
}

export function formatKes(minor) {
  if (!Number.isSafeInteger(minor)) throw new Error('Money must be stored as integer minor units.');
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES' }).format(minor / 100);
}

export function validateProposal(p) {
  if (!p || typeof p !== 'object') throw new Error('Proposal must be an object.');
  if (!TRANSACTION_TYPES.has(p.type)) throw new Error('Unsupported transaction type.');
  if (!Number.isSafeInteger(p.amount_minor) || p.amount_minor < 0) throw new Error('Amount must be a non-negative integer in minor units.');
  if (p.currency !== 'KES') throw new Error('Only KES is configured for this release.');
  const method = p.payment_method ?? (p.type === 'expense' || p.type === 'stock_purchase' ? 'cash' : 'none');
  if (!PAYMENT_METHODS.has(method)) throw new Error('Unsupported payment method.');
  const cash = p.cash_received_minor ?? 0;
  const credit = p.credit_amount_minor ?? 0;
  const cashPaid = p.cash_paid_minor ?? 0;
  if (!Number.isSafeInteger(cash) || cash < 0 || !Number.isSafeInteger(credit) || credit < 0 || !Number.isSafeInteger(cashPaid) || cashPaid < 0) throw new Error('Payment values must be non-negative integer minor units.');
  if (p.type === 'sale' && cash + credit > p.amount_minor) throw new Error('Cash and credit allocations cannot exceed the sale amount.');
  if (['expense','stock_purchase','supplier_payment','refund','cash_withdrawal'].includes(p.type) && cashPaid > p.amount_minor) throw new Error('Cash paid cannot exceed the transaction amount.');
  return {
    type: p.type,
    description: String(p.description ?? '').trim().slice(0, 500),
    amount_minor: p.amount_minor,
    currency: 'KES',
    payment_method: method,
    cash_received_minor: cash,
    cash_paid_minor: cashPaid,
    credit_amount_minor: credit,
    business_date: /^\d{4}-\d{2}-\d{2}$/.test(p.business_date ?? '') ? p.business_date : new Date().toISOString().slice(0, 10),
    notes: String(p.notes ?? '').trim().slice(0, 2000)
  };
}

export function cashExpected({ openingCashMinor, cashInflowsMinor, cashOutflowsMinor, withdrawalsMinor }) {
  for (const v of [openingCashMinor, cashInflowsMinor, cashOutflowsMinor, withdrawalsMinor]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('Cash reconciliation inputs must be non-negative integer minor units.');
  }
  return openingCashMinor + cashInflowsMinor - cashOutflowsMinor - withdrawalsMinor;
}

export function computeDailySummary(transactions) {
  const confirmed = transactions.filter(t => t.status === 'confirmed');
  const sum = (fn) => confirmed.filter(fn).reduce((n, t) => n + t.amount_minor, 0);
  const salesMinor = sum(t => t.type === 'sale');
  const expensesMinor = sum(t => t.type === 'expense');
  const stockPurchasesMinor = sum(t => t.type === 'stock_purchase');
  const cashInMinor = confirmed.reduce((n, t) => n + (t.cash_received_minor || 0) + (t.type === 'customer_payment' ? t.amount_minor : 0) + (t.type === 'cash_deposit' ? t.amount_minor : 0), 0);
  const cashOutMinor = confirmed.reduce((n, t) => n + (t.type === 'expense' || t.type === 'stock_purchase' || t.type === 'supplier_payment' || t.type === 'refund' ? t.amount_minor : 0), 0);
  const creditSalesMinor = confirmed.reduce((n, t) => n + (t.type === 'sale' ? (t.credit_amount_minor || 0) : 0), 0);
  const cashPaidMinor = confirmed.reduce((n, t) => n + (t.cash_paid_minor || 0), 0);
  return { transactionCount: confirmed.length, salesMinor, expensesMinor, stockPurchasesMinor, cashInMinor, cashOutMinor, creditSalesMinor, cashPaidMinor };
}

export function parseSimpleNote(note, today = new Date().toISOString().slice(0, 10)) {
  // This is explicitly a deterministic demo parser, not an AI substitute.
  // The app only uses it when QVAC is unavailable and labels the result as a manual draft.
  const text = String(note ?? '').trim();
  if (!text) throw new Error('Enter a note first.');
  const moneyMatch = text.match(/(?:ksh\.?\s*|kes\s*)?(\d[\d,]*(?:\.\d{1,2})?)/i);
  if (!moneyMatch) return { events: [], questions: ['What amount should be recorded?'], status: 'needs_clarification', source_text: text };
  const amount = toMinorUnits(moneyMatch[1].replaceAll(',', ''));
  const lower = text.toLowerCase();
  let type = 'adjustment';
  if (/\b(sold|sale|selling)\b/.test(lower)) type = 'sale';
  else if (/\b(expense|spent|paid for transport|electricity bill|rent)\b/.test(lower)) type = 'expense';
  else if (/\b(bought|purchased|stock purchase|restock)\b/.test(lower)) type = 'stock_purchase';
  else if (/\b(customer paid|received payment|repaid)\b/.test(lower)) type = 'customer_payment';
  const cash = type === 'sale' ? amount : 0;
  const proposal = { type, description: text, amount_minor: amount, currency: 'KES', payment_method: type === 'sale' ? 'cash' : 'none', cash_received_minor: cash, credit_amount_minor: 0, business_date: today, notes: '' };
  return { events: [proposal], questions: type === 'adjustment' ? ['I could not confidently identify the transaction type. Please choose the correct type before saving.'] : [], status: 'needs_confirmation', source_text: text, parser: 'deterministic-fallback-not-ai' };
}
