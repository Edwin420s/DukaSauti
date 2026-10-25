import crypto from 'node:crypto';

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
  if (typeof value === 'string' && value.trim().startsWith('-')) {
    throw new Error('Amount cannot be negative.');
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
  const mobile = p.mobile_money_received_minor ?? 0;
  const bank = p.bank_received_minor ?? 0;
  const credit = p.credit_amount_minor ?? 0;
  const cashPaid = p.cash_paid_minor ?? 0;
  if (!Number.isSafeInteger(cash) || cash < 0 || !Number.isSafeInteger(mobile) || mobile < 0 || !Number.isSafeInteger(bank) || bank < 0 || !Number.isSafeInteger(credit) || credit < 0 || !Number.isSafeInteger(cashPaid) || cashPaid < 0) throw new Error('Payment values must be non-negative integer minor units.');
  if (p.type === 'sale' && cash + mobile + bank + credit > p.amount_minor) throw new Error('Payment allocations cannot exceed the sale amount.');
  if (['expense','stock_purchase','supplier_payment','refund','cash_withdrawal'].includes(p.type) && cashPaid > p.amount_minor) throw new Error('Cash paid cannot exceed the transaction amount.');
  return {
    type: p.type,
    category: String(p.category ?? '').trim().slice(0, 80),
    description: String(p.description ?? '').trim().slice(0, 500),
    amount_minor: p.amount_minor,
    currency: 'KES',
    payment_method: method,
    cash_received_minor: cash,
    mobile_money_received_minor: mobile,
    bank_received_minor: bank,
    cash_paid_minor: cashPaid,
    credit_amount_minor: credit,
    business_date: /^\d{4}-\d{2}-\d{2}$/.test(p.business_date ?? '') ? p.business_date : new Date().toISOString().slice(0, 10),
    notes: String(p.notes ?? '').trim().slice(0, 2000)
  };
}

export function cashExpected({ openingCashMinor, cashInflowsMinor, cashOutflowsMinor, withdrawalsMinor = 0 }) {
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
  const cashInMinor = confirmed.reduce((n, t) => n + (t.cash_received_minor || 0) + (t.type === 'cash_deposit' && !(t.cash_received_minor || 0) && t.payment_method === 'cash' ? t.amount_minor : 0), 0);
  const cashOutMinor = confirmed.reduce((n, t) => n + (t.cash_paid_minor || 0), 0);
  const mobileMoneyReceivedMinor = confirmed.reduce((n, t) => n + (t.mobile_money_received_minor || 0), 0);
  const bankReceivedMinor = confirmed.reduce((n, t) => n + (t.bank_received_minor || 0), 0);
  const creditSalesMinor = confirmed.reduce((n, t) => n + (t.type === 'sale' ? (t.credit_amount_minor || 0) : 0), 0);
  const cashPaidMinor = confirmed.reduce((n, t) => n + (t.cash_paid_minor || 0), 0);
  const cogsMinor = confirmed.reduce((n, t) => n + (t.cogs_minor || 0), 0);
  return {
    transactionCount: confirmed.length,
    salesMinor,
    expensesMinor,
    stockPurchasesMinor,
    cashInMinor,
    cashOutMinor,
    mobileMoneyReceivedMinor,
    bankReceivedMinor,
    creditSalesMinor,
    cashPaidMinor,
    cogsMinor,
    grossProfitMinor: salesMinor - cogsMinor,
    operatingSurplusMinor: (salesMinor - cogsMinor) - expensesMinor
  };
}

export function parseSimpleNote(note, today = new Date().toISOString().slice(0, 10)) {
  const text = String(note ?? '').trim();
  if (!text) throw new Error('Enter a note first.');
  const moneyMatch = text.match(/(?:ksh\.?\s*|kes\s*)?(\d[\d,]*(?:\.\d{1,2})?)/i);
  if (!moneyMatch) return { events: [], questions: ['What amount should be recorded?'], status: 'needs_clarification', source_text: text };
  const amount = toMinorUnits(moneyMatch[1].replaceAll(',', ''));
  const lower = text.toLowerCase();
  let type = 'adjustment';
  let category = 'other';
  if (/\b(sold|sale|selling)\b/.test(lower)) type = 'sale';
  else if (/\b(rent)\b/.test(lower)) { type = 'expense'; category = 'rent'; }
  else if (/\b(transport|fare|matatu|boda)\b/.test(lower)) { type = 'expense'; category = 'transport'; }
  else if (/\b(electricity|kplc|water|tokens|utilities|wifi)\b/.test(lower)) { type = 'expense'; category = 'utilities'; }
  else if (/\b(wages|salary|casual|kibarua)\b/.test(lower)) { type = 'expense'; category = 'wages'; }
  else if (/\b(expense|spent|paid for)\b/.test(lower)) { type = 'expense'; category = 'other'; }
  else if (/\b(bought|purchased|stock purchase|restock)\b/.test(lower)) type = 'stock_purchase';
  else if (/\b(customer paid|received payment|repaid)\b/.test(lower)) type = 'customer_payment';

  let paymentMethod = 'cash';
  if (/\b(m-?pesa|mobile money|mpesa)\b/.test(lower)) paymentMethod = 'mobile_money';
  else if (/\b(bank|transfer|cheque)\b/.test(lower)) paymentMethod = 'bank';
  else if (/\b(credit|owes|deni)\b/.test(lower)) paymentMethod = 'credit';

  const cash = (type === 'sale' && paymentMethod === 'cash') ? amount : 0;
  const mobile = (type === 'sale' && paymentMethod === 'mobile_money') ? amount : 0;
  const bank = (type === 'sale' && paymentMethod === 'bank') ? amount : 0;
  const credit = (type === 'sale' && paymentMethod === 'credit') ? amount : 0;
  const cashPaid = (['expense','stock_purchase'].includes(type) && paymentMethod === 'cash') ? amount : 0;

  const proposal = {
    type,
    category,
    description: text,
    amount_minor: amount,
    currency: 'KES',
    payment_method: paymentMethod,
    cash_received_minor: cash,
    mobile_money_received_minor: mobile,
    bank_received_minor: bank,
    cash_paid_minor: cashPaid,
    credit_amount_minor: credit,
    business_date: today,
    notes: ''
  };
  return {
    events: [proposal],
    questions: type === 'adjustment' ? ['I could not confidently identify the transaction type. Please choose the correct type before saving.'] : [],
    status: 'needs_confirmation',
    source_text: text,
    parser: 'deterministic-fallback-not-ai'
  };
}

/**
 * Safaricom M-Pesa SMS / Statement Parser
 * Parses incoming and outgoing Kenyan M-Pesa messages
 */
export function parseMpesaSms(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('Enter an M-Pesa message or statement line.');

  // Extract M-Pesa code: 10 alphanumeric characters at start
  const codeMatch = text.match(/\b([A-Z0-9]{10})\b/);
  const code = codeMatch ? codeMatch[1] : null;

  // Extract amount: e.g. Ksh 1,500.00 or Ksh. 350
  const amountMatch = text.match(/(?:Ksh\.?|KES)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!amountMatch) throw new Error('Could not find a valid KES amount in the M-Pesa text.');
  const amountMinor = toMinorUnits(amountMatch[1].replaceAll(',', ''));

  // Direction: received vs sent
  const isReceived = /\breceived\b/i.test(text) || /\bgive\s+Ksh/i.test(text);
  const isSent = /\bsent\s+to\b/i.test(text) || /\bpaid\s+to\b/i.test(text);
  const direction = isReceived ? 'in' : isSent ? 'out' : 'in';

  // Sender or Recipient name & phone
  let party = '';
  let phone = '';
  if (isReceived) {
    const fromMatch = text.match(/(?:received(?:\s+(?:Ksh\.?|KES)\s*[\d,.]+)?\s+from|from)\s+([A-Za-z\s]+?)(?:\s+(\d{9,12}))?\s+on\b/i);
    if (fromMatch) {
      party = fromMatch[1].trim();
      phone = fromMatch[2] || '';
    }
  } else if (isSent) {
    const toMatch = text.match(/(?:sent(?:\s+(?:Ksh\.?|KES)\s*[\d,.]+)?\s+to|paid(?:\s+(?:Ksh\.?|KES)\s*[\d,.]+)?\s+to|to)\s+([A-Za-z\s]+?)(?:\s+(\d{9,12}))?\s+on\b/i);
    if (toMatch) {
      party = toMatch[1].trim();
      phone = toMatch[2] || '';
    }
  }

  // Date/Time
  let timeStr = new Date().toISOString();
  const dateMatch = text.match(/on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
  if (dateMatch) {
    timeStr = `${dateMatch[1]} ${dateMatch[2]}`;
  }

  return {
    mpesa_code: code || `MP-${Date.now().toString(36).toUpperCase()}`,
    direction,
    amount_minor: amountMinor,
    sender_or_recipient: party,
    phone,
    transaction_time: timeStr,
    raw_text: text
  };
}

/**
 * Encrypted Backup Helpers (AES-256-GCM with PBKDF2/scrypt key derivation)
 */
export function encryptBackup(dataObject, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 6) {
    throw new Error('Backup passphrase must be at least 6 characters long.');
  }
  const jsonStr = JSON.stringify(dataObject);
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    cipher: 'aes-256-gcm',
    app: 'DukaSauti',
    version: 2,
    created_at: new Date().toISOString(),
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: encrypted.toString('base64')
  };
}

export function decryptBackup(payload, passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('Passphrase is required to decrypt backup.');
  }
  if (!payload || payload.cipher !== 'aes-256-gcm' || !payload.ciphertext || !payload.salt || !payload.iv || !payload.tag) {
    throw new Error('Invalid or corrupted encrypted backup payload.');
  }
  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Formats a clean thermal receipt for printing
 */
export function formatReceipt({ shop, transaction, items = [], customer = null }) {
  const line = '='.repeat(38);
  const dash = '-'.repeat(38);
  const pad = (left, right, width = 38) => {
    const l = String(left || '');
    const r = String(right || '');
    const space = Math.max(1, width - l.length - r.length);
    return l + ' '.repeat(space) + r;
  };

  const receiptLines = [
    `          ${shop?.name || 'DUKASAUTI SHOP'}          `,
    '      SALES RECEIPT / STAKABADHI      ',
    line,
    pad('Date:', transaction.business_date || new Date().toISOString().slice(0, 10)),
    pad('Receipt #:', (transaction.id || '').slice(0, 8).toUpperCase()),
    customer ? pad('Customer:', customer.name) : '',
    dash,
    'ITEMS SOLD:',
    ...items.map(it => pad(`${it.quantity}x ${it.product_name}`, formatKes(it.line_total_minor))),
    dash,
    pad('TOTAL AMOUNT:', formatKes(transaction.amount_minor)),
    dash,
    'PAYMENT DETAILS:',
    transaction.cash_received_minor > 0 ? pad('Cash:', formatKes(transaction.cash_received_minor)) : '',
    transaction.mobile_money_received_minor > 0 ? pad('M-Pesa:', formatKes(transaction.mobile_money_received_minor)) : '',
    transaction.bank_received_minor > 0 ? pad('Bank:', formatKes(transaction.bank_received_minor)) : '',
    transaction.credit_amount_minor > 0 ? pad('Credit / Deni:', formatKes(transaction.credit_amount_minor)) : '',
    line,
    '   Ahsante kwa Kazi Yako Karibu Tena!   ',
    '       Powered by DukaSauti Desk       '
  ].filter(Boolean);

  return receiptLines.join('\n');
}

/**
 * SHA-256 PIN hashing helper for staff authentication
 */
export function hashPin(pin) {
  const p = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(p)) throw new Error('PIN must be 4 to 8 digits.');
  return crypto.createHash('sha256').update(p).digest('hex');
}

/**
 * Kenyan KRA eTIMS / VAT Tax calculation (Standard 16% VAT)
 */
export function calculateTaxBreakdown(totalMinor, { rate = 0.16, isTaxable = true } = {}) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
    throw new Error('Total amount must be a non-negative integer in minor units.');
  }
  if (!isTaxable || totalMinor === 0) {
    return {
      total_minor: totalMinor,
      taxable_minor: totalMinor,
      vat_minor: 0,
      vat_rate_percent: 0,
      tax_category: 'exempt'
    };
  }
  // Net taxable = Total / (1 + rate)
  const netMinor = Math.round(totalMinor / (1 + rate));
  const vatMinor = totalMinor - netMinor;
  return {
    total_minor: totalMinor,
    taxable_minor: netMinor,
    vat_minor: vatMinor,
    vat_rate_percent: Math.round(rate * 100),
    tax_category: 'standard_16'
  };
}

/**
 * Stock Pack / Unit conversion helper
 */
export function convertStockUnit(qty, fromUnit, toUnit, customConversions = []) {
  if (typeof qty !== 'number' || qty <= 0) throw new Error('Quantity must be greater than zero.');
  const f = String(fromUnit || '').toLowerCase().trim();
  const t = String(toUnit || '').toLowerCase().trim();
  if (f === t) return qty;

  const defaultFactors = {
    'crate->piece': 24,
    'carton->piece': 12,
    'bag_50kg->kg': 50,
    'bundle->piece': 10,
    'kg->gram': 1000
  };

  const key = `${f}->${t}`;
  const custom = customConversions.find(c => c.from_unit === f && c.to_unit === t);
  const factor = custom ? custom.factor : defaultFactors[key];

  if (!factor) {
    // Check inverse
    const invKey = `${t}->${f}`;
    const invCustom = customConversions.find(c => c.from_unit === t && c.to_unit === f);
    const invFactor = invCustom ? invCustom.factor : defaultFactors[invKey];
    if (invFactor) return qty / invFactor;
    throw new Error(`No conversion factor found between ${f} and ${t}.`);
  }

  return qty * factor;
}

/**
 * Formats a clean, printable customer statement of account
 */
export function formatCustomerStatement({ customer, transactions = [], credits = [], asOfDate = new Date().toISOString().slice(0, 10) }) {
  const line = '='.repeat(48);
  const dash = '-'.repeat(48);
  const pad = (left, right, width = 48) => {
    const l = String(left || '');
    const r = String(right || '');
    const space = Math.max(1, width - l.length - r.length);
    return l + ' '.repeat(space) + r;
  };

  const rows = [...credits].sort((a, b) => a.business_date.localeCompare(b.business_date));
  let runningBalance = 0;

  const lines = [
    '               CUSTOMER STATEMENT               ',
    '             DUKASAUTI SHOP DESK                ',
    line,
    pad('Customer:', customer.name),
    customer.phone ? pad('Phone:', customer.phone) : '',
    pad('As of Date:', asOfDate),
    pad('Credit Limit:', formatKes(customer.credit_limit_minor || 0)),
    dash,
    'DATE       TYPE         AMOUNT      BALANCE     ',
    dash
  ];

  for (const r of rows) {
    const isCharge = r.entry_type === 'charge';
    if (isCharge) runningBalance += r.amount_minor;
    else runningBalance -= r.amount_minor;

    const dt = r.business_date.slice(5); // MM-DD
    const typeLabel = isCharge ? '+Debt Charge' : '-Repayment ';
    const amtStr = formatKes(r.amount_minor).padStart(11);
    const balStr = formatKes(runningBalance).padStart(12);
    lines.push(`${dt}   ${typeLabel}  ${amtStr} ${balStr}`);
  }

  lines.push(dash);
  lines.push(pad('TOTAL OUTSTANDING BALANCE:', formatKes(runningBalance)));
  lines.push(line);
  lines.push('   Kumbukumbu ya Madeni na Malipo Rasmi   ');

  return lines.filter(Boolean).join('\n');
}

/**
 * Formats a clean, printable supplier statement of account
 */
export function formatSupplierStatement({ supplier, bills = [], asOfDate = new Date().toISOString().slice(0, 10) }) {
  const line = '='.repeat(50);
  const dash = '-'.repeat(50);
  const pad = (left, right, width = 50) => {
    const l = String(left || '');
    const r = String(right || '');
    const space = Math.max(1, width - l.length - r.length);
    return l + ' '.repeat(space) + r;
  };

  const lines = [
    '               SUPPLIER STATEMENT               ',
    '             BILLS & PAYABLES DESK              ',
    line,
    pad('Supplier:', supplier.name),
    supplier.phone ? pad('Phone:', supplier.phone) : '',
    pad('Statement Date:', asOfDate),
    dash,
    'DATE       REF        BILL AMT   PAID SO FAR   DUE ',
    dash
  ];

  let totalDue = 0;
  for (const b of bills) {
    const due = b.amount_minor - b.paid_minor;
    totalDue += due;
    const dt = b.business_date.slice(5);
    const ref = (b.reference || b.id.slice(0, 8)).padEnd(9).slice(0, 9);
    const billAmt = formatKes(b.amount_minor).padStart(10);
    const paidAmt = formatKes(b.paid_minor).padStart(11);
    const dueAmt = formatKes(due).padStart(10);
    lines.push(`${dt}  ${ref} ${billAmt} ${paidAmt} ${dueAmt}`);
  }

  lines.push(dash);
  lines.push(pad('TOTAL AMOUNT PAYABLE TO SUPPLIER:', formatKes(totalDue)));
  lines.push(line);

  return lines.filter(Boolean).join('\n');
}

