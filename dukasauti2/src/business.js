import { randomUUID } from 'node:crypto';
import {
  parseMpesaSms,
  encryptBackup,
  decryptBackup,
  hashPin,
  calculateTaxBreakdown,
  convertStockUnit,
  formatCustomerStatement,
  formatSupplierStatement
} from './domain.js';

const id = () => randomUUID();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const integer = (v, label, { min = 0 } = {}) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${label} must be a whole number of at least ${min}.`);
  return n;
};
const quantity = (v, label = 'Quantity') => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw new Error(`${label} must be greater than zero.`);
  return n;
};
const date = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : today();

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

// Helper to post automatic double-entry journal entries
export function postAutoJournal(db, { businessDate, description, reference, lines, sourceType = 'auto' }) {
  if (!lines || lines.length < 2) return null;
  const totalDebit = lines.reduce((sum, l) => sum + (l.debit_minor || 0), 0);
  const totalCredit = lines.reduce((sum, l) => sum + (l.credit_minor || 0), 0);
  if (totalDebit <= 0 || totalDebit !== totalCredit) return null;

  const jid = id();
  db.prepare(`
    INSERT INTO journal_entries(id, business_date, description, reference, status, source_type, posted_at)
    VALUES(?, ?, ?, ?, 'posted', ?, CURRENT_TIMESTAMP)
  `).run(jid, businessDate, description, reference || '', sourceType);

  const insLine = db.prepare(`
    INSERT INTO journal_lines(id, entry_id, account_code, account_name, debit_minor, credit_minor)
    VALUES(?, ?, ?, ?, ?, ?)
  `);

  for (const l of lines) {
    if ((l.debit_minor || 0) > 0 || (l.credit_minor || 0) > 0) {
      insLine.run(id(), jid, l.account_code, l.account_name, l.debit_minor || 0, l.credit_minor || 0);
    }
  }
  return jid;
}

export async function handleBusinessApi(req, res, url, db, bodyJson, audit) {
  const path = url.pathname;
  const method = req.method;

  try {
    // -------------------------------------------------------------
    // MULTI-LINE CHECKOUT SALE
    // -------------------------------------------------------------
    if (path === '/api/sales' && method === 'POST') {
      const b = await bodyJson(req);
      const lines = Array.isArray(b.lines) ? b.lines : [];
      if (!lines.length || lines.length > 100) throw new Error('A sale requires 1–100 product lines.');

      const prepared = lines.map(line => {
        const product = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(text(line.product_id, 80));
        if (!product) throw new Error(`Product not found or inactive: ${line.product_id}`);
        const qty = quantity(line.quantity);
        if (product.stock_qty < qty) {
          throw new Error(`Not enough stock for "${product.name}". Available: ${product.stock_qty}, Requested: ${qty}.`);
        }
        const unitPrice = integer(line.unit_price_minor ?? product.selling_price_minor, 'Unit selling price');
        const unitCost = product.cost_price_minor || 0;
        const lineTotal = Math.round(qty * unitPrice);
        const lineCogs = Math.round(qty * unitCost);
        return { product, qty, unitPrice, unitCost, lineTotal, lineCogs };
      });

      const total = prepared.reduce((n, l) => n + l.lineTotal, 0);
      const totalCogs = prepared.reduce((n, l) => n + l.lineCogs, 0);
      if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Sale total must be greater than zero.');

      const cash = integer(b.cash_received_minor ?? 0, 'Cash received');
      const mobile = integer(b.mobile_money_received_minor ?? 0, 'Mobile money received');
      const bank = integer(b.bank_received_minor ?? 0, 'Bank received');
      const credit = integer(b.credit_amount_minor ?? 0, 'Credit amount');

      if (cash + mobile + bank + credit !== total) {
        throw new Error(`Allocations must equal sale total (KSh ${(total/100).toFixed(2)}). Current sum: KSh ${((cash+mobile+bank+credit)/100).toFixed(2)}.`);
      }

      let customer = null;
      if (credit > 0) {
        customer = db.prepare('SELECT * FROM customers WHERE id=?').get(text(b.customer_id, 80));
        if (!customer) throw new Error('Select a customer for a credit sale.');
        const balance = db.prepare(`SELECT COALESCE(SUM(CASE WHEN entry_type='charge' THEN amount_minor ELSE -amount_minor END),0) balance FROM customer_credits WHERE customer_id=?`).get(customer.id).balance;
        if (customer.credit_limit_minor > 0 && balance + credit > customer.credit_limit_minor) {
          throw new Error(`This sale would exceed the credit limit of KSh ${(customer.credit_limit_minor/100).toFixed(2)}. Current balance: KSh ${(balance/100).toFixed(2)}.`);
        }
      }

      const tid = id();
      const businessDate = date(b.business_date);
      const activeMethods = [cash > 0 && 'cash', mobile > 0 && 'mobile_money', bank > 0 && 'bank', credit > 0 && 'credit'].filter(Boolean);
      const methodStr = activeMethods.length > 1 ? 'mixed' : (activeMethods[0] || 'cash');

      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          INSERT INTO transactions(
            id, type, category, description, amount_minor, currency, payment_method,
            cash_received_minor, mobile_money_received_minor, bank_received_minor, cash_paid_minor,
            credit_amount_minor, cogs_minor, business_date, notes, source, status, confirmed_at
          ) VALUES(?, 'sale', 'retail', ?, ?, 'KES', ?, ?, ?, ?, 0, ?, ?, ?, ?, 'manual', 'confirmed', CURRENT_TIMESTAMP)
        `).run(tid, text(b.description, 500) || `Sale · ${prepared.length} item(s)`, total, methodStr, cash, mobile, bank, credit, totalCogs, businessDate, text(b.notes, 1000));

        const itemInsert = db.prepare('INSERT INTO sale_items(id, transaction_id, product_id, product_name, quantity, unit_price_minor, unit_cost_minor, line_total_minor) VALUES(?,?,?,?,?,?,?,?)');
        const movementInsert = db.prepare("INSERT INTO stock_movements(id, product_id, movement_type, quantity, unit_cost_minor, reference, business_date, notes) VALUES(?,?, 'sale', ?,?,?,?, 'Sold through checkout')");

        for (const l of prepared) {
          itemInsert.run(id(), tid, l.product.id, l.product.name, l.qty, l.unitPrice, l.unitCost, l.lineTotal);
          db.prepare('UPDATE products SET stock_qty=stock_qty-?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(l.qty, l.product.id);
          movementInsert.run(id(), l.product.id, l.qty, l.unitCost, tid, businessDate);
        }

        if (credit > 0) {
          db.prepare("INSERT INTO customer_credits(id, customer_id, transaction_id, entry_type, amount_minor, business_date, notes) VALUES(?,?,?,'charge',?,?,?)")
            .run(id(), customer.id, tid, credit, businessDate, 'Credit from checkout');
        }

        // Automatic double-entry posting for sale
        const journalLines = [];
        if (cash > 0) journalLines.push({ account_code: '1000', account_name: 'Cash in Hand', debit_minor: cash, credit_minor: 0 });
        if (mobile > 0) journalLines.push({ account_code: '1010', account_name: 'M-Pesa Account', debit_minor: mobile, credit_minor: 0 });
        if (bank > 0) journalLines.push({ account_code: '1020', account_name: 'Bank Account', debit_minor: bank, credit_minor: 0 });
        if (credit > 0) journalLines.push({ account_code: '1100', account_name: 'Accounts Receivable (Customer Credit)', debit_minor: credit, credit_minor: 0 });
        journalLines.push({ account_code: '4000', account_name: 'Sales Revenue', debit_minor: 0, credit_minor: total });

        // COGS posting if inventory has recorded cost
        if (totalCogs > 0) {
          journalLines.push({ account_code: '5000', account_name: 'Cost of Goods Sold (COGS)', debit_minor: totalCogs, credit_minor: 0 });
          journalLines.push({ account_code: '1200', account_name: 'Inventory Asset', debit_minor: 0, credit_minor: totalCogs });
        }
        postAutoJournal(db, { businessDate, description: `Auto journal for sale ${tid.slice(0,8)}`, reference: tid, lines: journalLines });

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      audit(db, 'transaction', tid, 'sale_checkout', { total, lines: prepared.length, cash, mobile, bank, credit, customer_id: customer?.id || null, totalCogs });
      return json(res, 201, {
        transaction: db.prepare('SELECT * FROM transactions WHERE id=?').get(tid),
        items: db.prepare('SELECT * FROM sale_items WHERE transaction_id=?').all(tid)
      });
    }

    // -------------------------------------------------------------
    // PRODUCTS & STOCK MANAGEMENT
    // -------------------------------------------------------------
    if (path === '/api/products' && method === 'GET') {
      const q = text(url.searchParams.get('q') || '');
      let sql = 'SELECT * FROM products WHERE active=1';
      const args = [];
      if (q) {
        sql += ' AND (name LIKE ? OR sku LIKE ? OR category LIKE ?)';
        args.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      sql += ' ORDER BY name';
      return json(res, 200, db.prepare(sql).all(...args));
    }

    if (path === '/api/products' && method === 'POST') {
      const b = await bodyJson(req);
      const name = text(b.name, 160);
      if (!name) throw new Error('Product name is required.');
      const pid = id();
      const stockQty = Number(b.stock_qty ?? 0);
      const costPrice = integer(b.cost_price_minor ?? 0, 'Cost price');
      const sellingPrice = integer(b.selling_price_minor ?? 0, 'Selling price');

      db.prepare(`
        INSERT INTO products(id, sku, name, category, unit, selling_price_minor, cost_price_minor, stock_qty, reorder_level)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pid, text(b.sku, 60) || null, name, text(b.category, 80), text(b.unit, 30) || 'piece', sellingPrice, costPrice, stockQty, Number(b.reorder_level ?? 0));

      if (stockQty > 0) {
        db.prepare(`
          INSERT INTO stock_movements(id, product_id, movement_type, quantity, unit_cost_minor, business_date, notes)
          VALUES(?, ?, 'opening', ?, ?, ?, 'Opening stock')
        `).run(id(), pid, quantity(stockQty), costPrice, today());
      }
      audit(db, 'product', pid, 'created', { name, stockQty, costPrice, sellingPrice });
      return json(res, 201, db.prepare('SELECT * FROM products WHERE id=?').get(pid));
    }

    const mProduct = path.match(/^\/api\/products\/([^/]+)$/);
    if (mProduct && method === 'PATCH') {
      const b = await bodyJson(req);
      const p = db.prepare('SELECT * FROM products WHERE id=?').get(mProduct[1]);
      if (!p) return json(res, 404, { error: 'Product not found.' });
      const next = {
        name: text(b.name ?? p.name, 160),
        sku: text(b.sku ?? p.sku, 60) || null,
        category: text(b.category ?? p.category, 80),
        unit: text(b.unit ?? p.unit, 30),
        selling_price_minor: integer(b.selling_price_minor ?? p.selling_price_minor, 'Selling price'),
        cost_price_minor: integer(b.cost_price_minor ?? p.cost_price_minor, 'Cost price'),
        reorder_level: Number(b.reorder_level ?? p.reorder_level)
      };
      db.prepare(`
        UPDATE products SET name=?, sku=?, category=?, unit=?, selling_price_minor=?, cost_price_minor=?, reorder_level=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(...Object.values(next), p.id);
      audit(db, 'product', p.id, 'updated', next);
      return json(res, 200, db.prepare('SELECT * FROM products WHERE id=?').get(p.id));
    }

    if (mProduct && method === 'DELETE') {
      db.prepare('UPDATE products SET active=0 WHERE id=?').run(mProduct[1]);
      audit(db, 'product', mProduct[1], 'archived');
      return json(res, 200, { ok: true });
    }

    if (path === '/api/stock/movements' && method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT sm.*, p.name product_name, p.sku, p.unit
        FROM stock_movements sm
        JOIN products p ON p.id = sm.product_id
        ORDER BY sm.business_date DESC, sm.created_at DESC
        LIMIT 500
      `).all());
    }

    if (path === '/api/stock/movements' && method === 'POST') {
      const b = await bodyJson(req);
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(b.product_id);
      if (!p) throw new Error('Select an active product.');
      const type = text(b.movement_type, 20);
      if (!['purchase', 'return', 'damage', 'adjustment'].includes(type)) throw new Error('Unsupported stock movement type.');
      const qty = quantity(b.quantity);
      const next = p.stock_qty + (type === 'purchase' || type === 'return' ? qty : -qty);
      if (next < 0) throw new Error('Stock cannot become negative.');

      const movementId = id();
      const cost = integer(b.unit_cost_minor ?? p.cost_price_minor, 'Unit cost');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          INSERT INTO stock_movements(id, product_id, movement_type, quantity, unit_cost_minor, reference, notes, business_date)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        `).run(movementId, p.id, type, qty, cost, text(b.reference, 100), text(b.notes, 500), date(b.business_date));

        // If restock/purchase, recalculate weighted average cost price
        let newCostPrice = p.cost_price_minor;
        if (type === 'purchase' && cost > 0) {
          const totalOldVal = p.stock_qty * p.cost_price_minor;
          const totalNewVal = qty * cost;
          newCostPrice = next > 0 ? Math.round((totalOldVal + totalNewVal) / next) : cost;
        }

        db.prepare('UPDATE products SET stock_qty=?, cost_price_minor=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next, newCostPrice, p.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      audit(db, 'stock_movement', movementId, 'created', { product_id: p.id, type, qty, next_stock: next });
      return json(res, 201, { id: movementId, product_id: p.id, stock_qty: next });
    }

    if (path === '/api/stock/low' && method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM products WHERE active=1 AND stock_qty <= reorder_level ORDER BY stock_qty ASC').all());
    }

    // -------------------------------------------------------------
    // CUSTOMER ACCOUNTS & CREDIT
    // -------------------------------------------------------------
    if (path === '/api/customers' && method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT c.*,
          COALESCE((SELECT SUM(CASE WHEN entry_type='charge' THEN amount_minor ELSE -amount_minor END)
                    FROM customer_credits cc WHERE cc.customer_id=c.id), 0) balance_minor
        FROM customers c ORDER BY c.name
      `).all());
    }

    if (path === '/api/customers' && method === 'POST') {
      const b = await bodyJson(req);
      const name = text(b.name, 160);
      if (!name) throw new Error('Customer name is required.');
      const cid = id();
      db.prepare('INSERT INTO customers(id, name, phone, notes, credit_limit_minor) VALUES(?,?,?,?,?)')
        .run(cid, name, text(b.phone, 40), text(b.notes, 1000), integer(b.credit_limit_minor ?? 0, 'Credit limit'));
      audit(db, 'customer', cid, 'created', { name });
      return json(res, 201, db.prepare('SELECT * FROM customers WHERE id=?').get(cid));
    }

    if (path === '/api/credits' && method === 'POST') {
      const b = await bodyJson(req);
      const cid = text(b.customer_id, 80);
      const type = text(b.entry_type, 20);
      const amount = integer(b.amount_minor, 'Amount', { min: 1 });
      const customer = db.prepare('SELECT id, name FROM customers WHERE id=?').get(cid);
      if (!customer) throw new Error('Customer not found.');
      if (!['charge', 'payment', 'adjustment'].includes(type)) throw new Error('Invalid credit entry type.');

      const cid2 = id();
      const dateValue = date(b.business_date);
      let transactionId = null;

      db.exec('BEGIN IMMEDIATE');
      try {
        if (type === 'payment') {
          const methodStr = text(b.payment_method, 20);
          if (!['cash', 'mobile_money', 'bank'].includes(methodStr)) throw new Error('Choose cash, mobile money or bank for a repayment.');
          transactionId = id();
          db.prepare(`
            INSERT INTO transactions(
              id, type, category, description, amount_minor, currency, payment_method,
              cash_received_minor, mobile_money_received_minor, bank_received_minor,
              business_date, notes, source, status, confirmed_at
            ) VALUES(?, 'customer_payment', 'credit_repayment', ?, ?, 'KES', ?, ?, ?, ?, ?, ?, 'manual', 'confirmed', CURRENT_TIMESTAMP)
          `).run(
            transactionId,
            `Customer repayment · ${customer.name}`,
            amount,
            methodStr,
            methodStr === 'cash' ? amount : 0,
            methodStr === 'mobile_money' ? amount : 0,
            methodStr === 'bank' ? amount : 0,
            dateValue,
            text(b.notes, 1000)
          );

          // Auto journal entry for customer repayment
          const debitAcct = methodStr === 'cash' ? '1000' : (methodStr === 'mobile_money' ? '1010' : '1020');
          const debitName = methodStr === 'cash' ? 'Cash in Hand' : (methodStr === 'mobile_money' ? 'M-Pesa Account' : 'Bank Account');
          postAutoJournal(db, {
            businessDate: dateValue,
            description: `Auto journal: Repayment from ${customer.name}`,
            reference: transactionId,
            lines: [
              { account_code: debitAcct, account_name: debitName, debit_minor: amount, credit_minor: 0 },
              { account_code: '1100', account_name: 'Accounts Receivable (Customer Credit)', debit_minor: 0, credit_minor: amount }
            ]
          });
        }

        db.prepare('INSERT INTO customer_credits(id, customer_id, transaction_id, entry_type, amount_minor, business_date, notes) VALUES(?,?,?,?,?,?,?)')
          .run(cid2, cid, transactionId, type, amount, dateValue, text(b.notes, 1000));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      audit(db, 'customer_credit', cid2, type, { customer_id: cid, amount, transaction_id: transactionId });
      return json(res, 201, db.prepare('SELECT * FROM customer_credits WHERE id=?').get(cid2));
    }

    if (path === '/api/credits' && method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT cc.*, c.name customer_name
        FROM customer_credits cc
        JOIN customers c ON c.id = cc.customer_id
        ORDER BY cc.business_date DESC, cc.created_at DESC
        LIMIT 500
      `).all());
    }

    // -------------------------------------------------------------
    // SUPPLIERS & BILLS
    // -------------------------------------------------------------
    if (path === '/api/suppliers' && method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM suppliers ORDER BY name').all());
    }

    if (path === '/api/suppliers' && method === 'POST') {
      const b = await bodyJson(req);
      const name = text(b.name, 160);
      if (!name) throw new Error('Supplier name is required.');
      const sid = id();
      db.prepare('INSERT INTO suppliers(id, name, phone, email, notes) VALUES(?,?,?,?,?)')
        .run(sid, name, text(b.phone, 40), text(b.email, 160), text(b.notes, 1000));
      audit(db, 'supplier', sid, 'created', { name });
      return json(res, 201, db.prepare('SELECT * FROM suppliers WHERE id=?').get(sid));
    }

    if (path === '/api/suppliers/bills' && method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT b.*, s.name supplier_name, (amount_minor - paid_minor) balance_minor
        FROM supplier_bills b
        JOIN suppliers s ON s.id = b.supplier_id
        ORDER BY b.business_date DESC
      `).all());
    }

    if (path === '/api/suppliers/bills' && method === 'POST') {
      const b = await bodyJson(req);
      const sid = text(b.supplier_id, 80);
      const amount = integer(b.amount_minor, 'Bill amount', { min: 1 });
      const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id=?').get(sid);
      if (!supplier) throw new Error('Supplier not found.');

      const bid = id();
      const businessDate = date(b.business_date);
      const items = Array.isArray(b.items) ? b.items : [];

      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO supplier_bills(id, supplier_id, reference, amount_minor, paid_minor, due_date, business_date, notes, items_json) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(bid, sid, text(b.reference, 100), amount, 0, b.due_date || null, businessDate, text(b.notes, 1000), JSON.stringify(items));

        // If bill includes stock lines, automatically restock items!
        for (const it of items) {
          if (it.product_id && it.quantity > 0) {
            const p = db.prepare('SELECT * FROM products WHERE id=?').get(it.product_id);
            if (p) {
              const qty = Number(it.quantity);
              const cost = integer(it.unit_cost_minor ?? p.cost_price_minor, 'Unit cost');
              const next = p.stock_qty + qty;
              const newCostPrice = Math.round(((p.stock_qty * p.cost_price_minor) + (qty * cost)) / (next || 1));
              db.prepare('UPDATE products SET stock_qty=?, cost_price_minor=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next, newCostPrice, p.id);
              db.prepare("INSERT INTO stock_movements(id, product_id, movement_type, quantity, unit_cost_minor, reference, notes, business_date) VALUES(?,?, 'purchase', ?, ?, ?, 'Supplier bill restock', ?)")
                .run(id(), p.id, qty, cost, bid, businessDate);
            }
          }
        }

        // Auto journal entry for supplier bill: Debit Inventory/Expense, Credit Accounts Payable
        postAutoJournal(db, {
          businessDate,
          description: `Auto journal: Bill from ${supplier.name} (${b.reference || bid.slice(0,8)})`,
          reference: bid,
          lines: [
            { account_code: '1200', account_name: 'Inventory Asset', debit_minor: amount, credit_minor: 0 },
            { account_code: '2000', account_name: 'Accounts Payable (Suppliers)', debit_minor: 0, credit_minor: amount }
          ]
        });

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      audit(db, 'supplier_bill', bid, 'created', { supplier_id: sid, amount, items_count: items.length });
      return json(res, 201, db.prepare('SELECT * FROM supplier_bills WHERE id=?').get(bid));
    }

    const billPay = path.match(/^\/api\/suppliers\/bills\/([^/]+)\/payment$/);
    if (billPay && method === 'POST') {
      const b = await bodyJson(req);
      const bill = db.prepare('SELECT b.*, s.name supplier_name FROM supplier_bills b JOIN suppliers s ON s.id=b.supplier_id WHERE b.id=?').get(billPay[1]);
      if (!bill) throw new Error('Supplier bill not found.');
      const amount = integer(b.amount_minor, 'Payment amount', { min: 1 });
      const balance = bill.amount_minor - bill.paid_minor;
      if (amount > balance) throw new Error(`Payment cannot exceed the outstanding balance of KSh ${(balance/100).toFixed(2)}.`);
      const methodStr = text(b.payment_method, 20);
      if (!['cash', 'mobile_money', 'bank'].includes(methodStr)) throw new Error('Choose cash, mobile money or bank.');

      const tid = id();
      const dateValue = date(b.business_date);

      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE supplier_bills SET paid_minor = paid_minor + ? WHERE id=?').run(amount, bill.id);
        db.prepare(`
          INSERT INTO transactions(
            id, type, category, description, amount_minor, currency, payment_method,
            cash_paid_minor, business_date, notes, source, status, confirmed_at
          ) VALUES(?, 'supplier_payment', 'supplier_bill_payment', ?, ?, 'KES', ?, ?, ?, ?, 'manual', 'confirmed', CURRENT_TIMESTAMP)
        `).run(tid, `Supplier bill payment · ${bill.supplier_name} (${bill.reference || bill.id})`, amount, methodStr, methodStr === 'cash' ? amount : 0, dateValue, text(b.notes, 1000));

        // Auto journal entry for supplier payment
        const creditAcct = methodStr === 'cash' ? '1000' : (methodStr === 'mobile_money' ? '1010' : '1020');
        const creditName = methodStr === 'cash' ? 'Cash in Hand' : (methodStr === 'mobile_money' ? 'M-Pesa Account' : 'Bank Account');
        postAutoJournal(db, {
          businessDate: dateValue,
          description: `Auto journal: Payment to ${bill.supplier_name}`,
          reference: tid,
          lines: [
            { account_code: '2000', account_name: 'Accounts Payable (Suppliers)', debit_minor: amount, credit_minor: 0 },
            { account_code: creditAcct, account_name: creditName, debit_minor: 0, credit_minor: amount }
          ]
        });

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      audit(db, 'supplier_bill', bill.id, 'payment_recorded', { amount, method: methodStr, transaction_id: tid });
      return json(res, 201, {
        bill: db.prepare('SELECT * FROM supplier_bills WHERE id=?').get(bill.id),
        transaction: db.prepare('SELECT * FROM transactions WHERE id=?').get(tid)
      });
    }

    // -------------------------------------------------------------
    // M-PESA STATEMENTS & RECONCILIATION
    // -------------------------------------------------------------
    if (path === '/api/mpesa/parse' && method === 'POST') {
      const b = await bodyJson(req);
      const parsed = parseMpesaSms(b.text || '');
      return json(res, 200, parsed);
    }

    if (path === '/api/mpesa/import' && method === 'POST') {
      const b = await bodyJson(req);
      const records = Array.isArray(b.records) ? b.records : [b];
      const inserted = [];

      db.exec('BEGIN IMMEDIATE');
      try {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO mpesa_records(id, mpesa_code, direction, amount_minor, sender_or_recipient, phone, transaction_time, raw_text, status)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'unmatched')
        `);
        for (const r of records) {
          const recId = id();
          const parsed = parseMpesaSms(r.text || r.raw_text || '');
          stmt.run(recId, parsed.mpesa_code, parsed.direction, parsed.amount_minor, parsed.sender_or_recipient, parsed.phone, parsed.transaction_time, parsed.raw_text);
          inserted.push(parsed);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return json(res, 201, { imported: inserted.length, records: inserted });
    }

    if (path === '/api/mpesa' && method === 'GET') {
      const status = url.searchParams.get('status') || 'all';
      let sql = 'SELECT * FROM mpesa_records';
      const args = [];
      if (status !== 'all') {
        sql += ' WHERE status=?';
        args.push(status);
      }
      sql += ' ORDER BY transaction_time DESC, created_at DESC LIMIT 200';
      return json(res, 200, db.prepare(sql).all(...args));
    }

    const mMpesaMatch = path.match(/^\/api\/mpesa\/([^/]+)\/match$/);
    if (mMpesaMatch && method === 'POST') {
      const b = await bodyJson(req);
      const rec = db.prepare('SELECT * FROM mpesa_records WHERE id=?').get(mMpesaMatch[1]);
      if (!rec) throw new Error('M-Pesa record not found.');

      const targetTxId = b.transaction_id;
      db.prepare("UPDATE mpesa_records SET status='matched', matched_transaction_id=? WHERE id=?").run(targetTxId, rec.id);
      audit(db, 'mpesa_record', rec.id, 'matched', { transaction_id: targetTxId });
      return json(res, 200, { ok: true, id: rec.id, matched_transaction_id: targetTxId });
    }

    // -------------------------------------------------------------
    // SHIFTS & STOKA CASH RECONCILIATION
    // -------------------------------------------------------------
    if (path === '/api/shifts/position' && method === 'GET') {
      const targetDate = date(url.searchParams.get('date'));
      const rows = db.prepare("SELECT * FROM transactions WHERE business_date=? AND status='confirmed'").all(targetDate);
      const shop = db.prepare('SELECT * FROM shops WHERE id=1').get();

      // Find opening float: previous closed shift cash or shop opening cash
      const priorCount = db.prepare('SELECT counted_cash_minor FROM cash_counts WHERE business_date < ? ORDER BY business_date DESC, created_at DESC LIMIT 1').get(targetDate);
      const openingFloat = priorCount ? priorCount.counted_cash_minor : shop.opening_cash_minor;

      let cashSales = 0;
      let mpesaReceived = 0;
      let bankReceived = 0;
      let cashRepayments = 0;
      let cashExpenses = 0;
      let cashSupplierPaid = 0;

      for (const t of rows) {
        if (t.type === 'sale') {
          cashSales += t.cash_received_minor || 0;
          mpesaReceived += t.mobile_money_received_minor || 0;
          bankReceived += t.bank_received_minor || 0;
        } else if (t.type === 'customer_payment' && t.payment_method === 'cash') {
          cashRepayments += t.cash_received_minor || t.amount_minor;
        } else if (t.type === 'expense') {
          cashExpenses += t.cash_paid_minor || 0;
        } else if (t.type === 'supplier_payment') {
          cashSupplierPaid += t.cash_paid_minor || 0;
        } else if (t.type === 'cash_deposit' && t.payment_method === 'cash') {
          cashSales += t.cash_received_minor || t.amount_minor;
        }
      }

      const totalSales = rows.filter(t => t.type === 'sale').reduce((n, t) => n + t.amount_minor, 0);
      const salesCount = rows.filter(t => t.type === 'sale').length;
      const expectedInCounter = openingFloat + cashSales + cashRepayments - cashExpenses - cashSupplierPaid;

      return json(res, 200, {
        date: targetDate,
        opening_float_minor: openingFloat,
        total_sales_minor: totalSales,
        sales_count: salesCount,
        cash_sales_minor: cashSales,
        mpesa_received_minor: mpesaReceived,
        bank_received_minor: bankReceived,
        cash_repayments_minor: cashRepayments,
        cash_expenses_minor: cashExpenses,
        cash_supplier_paid_minor: cashSupplierPaid,
        expected_in_counter_minor: expectedInCounter
      });
    }

    if (path === '/api/shifts/close' && method === 'POST') {
      const b = await bodyJson(req);
      const targetDate = date(b.date);
      const counted = integer(b.counted_cash_minor, 'Counted cash in counter');
      const notes = text(b.notes, 1000);

      // Re-fetch expected cash position
      const rows = db.prepare("SELECT * FROM transactions WHERE business_date=? AND status='confirmed'").all(targetDate);
      const shop = db.prepare('SELECT * FROM shops WHERE id=1').get();
      const priorCount = db.prepare('SELECT counted_cash_minor FROM cash_counts WHERE business_date < ? ORDER BY business_date DESC, created_at DESC LIMIT 1').get(targetDate);
      const openingFloat = priorCount ? priorCount.counted_cash_minor : shop.opening_cash_minor;

      let cashIn = 0, cashOut = 0;
      for (const t of rows) {
        cashIn += t.cash_received_minor || 0;
        if (t.type === 'cash_deposit' && t.payment_method === 'cash' && !(t.cash_received_minor || 0)) cashIn += t.amount_minor;
        cashOut += t.cash_paid_minor || 0;
      }
      const expected = openingFloat + cashIn - cashOut;
      const difference = counted - expected;
      const countId = id();

      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO cash_counts(id, business_date, counted_cash_minor, expected_cash_minor, difference_minor, notes) VALUES(?,?,?,?,?,?)')
          .run(countId, targetDate, counted, expected, difference, notes);

        db.prepare('INSERT INTO shifts(id, opened_at, closed_at, opening_float_minor, closing_cash_minor, expected_cash_minor, difference_minor, status, notes) VALUES(?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, \'closed\', ?)')
          .run(id(), openingFloat, counted, expected, difference, notes);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      audit(db, 'shift', countId, 'closed', { targetDate, counted, expected, difference });
      return json(res, 201, {
        id: countId,
        date: targetDate,
        counted_cash_minor: counted,
        expected_cash_minor: expected,
        difference_minor: difference,
        is_balanced: difference === 0
      });
    }

    // -------------------------------------------------------------
    // REPORTS WITH FULL INVENTORY VALUATION & COGS
    // -------------------------------------------------------------
    if (path === '/api/reports/overview' && method === 'GET') {
      const from = date(url.searchParams.get('from'));
      const to = date(url.searchParams.get('to') || from);
      if (from > to) throw new Error('Start date must not be after end date.');

      const rows = db.prepare("SELECT * FROM transactions WHERE status='confirmed' AND business_date BETWEEN ? AND ? ORDER BY business_date").all(from, to);
      const sum = (type) => rows.filter(r => r.type === type).reduce((n, r) => n + r.amount_minor, 0);

      const sales = sum('sale');
      const expenses = sum('expense');
      const purchases = sum('stock_purchase');
      const refunds = sum('refund');
      const creditSales = rows.filter(r => r.type === 'sale').reduce((n, r) => n + (r.credit_amount_minor || 0), 0);
      const totalCogs = rows.filter(r => r.type === 'sale').reduce((n, r) => n + (r.cogs_minor || 0), 0);
      const netSales = sales - refunds;
      const grossProfit = netSales - totalCogs;
      const operatingSurplus = grossProfit - expenses;

      // Current inventory on-hand valuation
      const inventoryValuation = db.prepare('SELECT COALESCE(SUM(stock_qty * cost_price_minor), 0) val FROM products WHERE active=1').get().val;

      return json(res, 200, {
        from,
        to,
        sales_minor: sales,
        expenses_minor: expenses,
        stock_purchases_minor: purchases,
        refunds_minor: refunds,
        credit_sales_minor: creditSales,
        net_sales_minor: netSales,
        cogs_minor: totalCogs,
        gross_profit_minor: grossProfit,
        operating_surplus_minor: operatingSurplus,
        current_inventory_valuation_minor: inventoryValuation,
        transaction_count: rows.length,
        is_complete_cogs: true
      });
    }

    if (path === '/api/reports/daily' && method === 'GET') {
      const rows = db.prepare(`
        SELECT business_date,
          COUNT(*) count,
          SUM(CASE WHEN type='sale' THEN amount_minor ELSE 0 END) sales_minor,
          SUM(CASE WHEN type='expense' THEN amount_minor ELSE 0 END) expenses_minor,
          SUM(CASE WHEN type='sale' THEN cogs_minor ELSE 0 END) cogs_minor
        FROM transactions
        WHERE status='confirmed'
        GROUP BY business_date
        ORDER BY business_date DESC
        LIMIT 90
      `).all();
      return json(res, 200, rows);
    }

    // -------------------------------------------------------------
    // JOURNALS & GENERAL LEDGER
    // -------------------------------------------------------------
    if (path === '/api/journals' && method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT j.*, COUNT(l.id) line_count,
          COALESCE(SUM(l.debit_minor), 0) debit_minor,
          COALESCE(SUM(l.credit_minor), 0) credit_minor
        FROM journal_entries j
        LEFT JOIN journal_lines l ON l.entry_id = j.id
        GROUP BY j.id
        ORDER BY j.business_date DESC, j.created_at DESC
      `).all());
    }

    if (path === '/api/journals' && method === 'POST') {
      const b = await bodyJson(req);
      const lines = Array.isArray(b.lines) ? b.lines : [];
      if (lines.length < 2 || lines.length > 50) throw new Error('A journal requires 2–50 lines.');

      const normalized = lines.map(l => ({
        account_code: text(l.account_code, 20),
        account_name: text(l.account_name, 100),
        debit: integer(l.debit_minor ?? 0, 'Debit'),
        credit: integer(l.credit_minor ?? 0, 'Credit')
      }));

      if (normalized.some(l => !l.account_code || !l.account_name || ((l.debit === 0) === (l.credit === 0)))) {
        throw new Error('Each journal line must specify an account and exactly one positive debit or credit.');
      }

      const totalDebit = normalized.reduce((n, l) => n + l.debit, 0);
      const totalCredit = normalized.reduce((n, l) => n + l.credit, 0);
      if (totalDebit === 0 || totalDebit !== totalCredit) {
        throw new Error(`Journal is not balanced: Total debits (KSh ${(totalDebit/100).toFixed(2)}) must equal total credits (KSh ${(totalCredit/100).toFixed(2)}).`);
      }

      const jid = id();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("INSERT INTO journal_entries(id, business_date, description, reference, status, source_type, posted_at) VALUES(?,?,?,?,'posted','manual',CURRENT_TIMESTAMP)")
          .run(jid, date(b.business_date), text(b.description, 500) || 'Manual journal', text(b.reference, 100));

        const ins = db.prepare('INSERT INTO journal_lines(id, entry_id, account_code, account_name, debit_minor, credit_minor) VALUES(?,?,?,?,?,?)');
        for (const l of normalized) {
          ins.run(id(), jid, l.account_code, l.account_name, l.debit, l.credit);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      audit(db, 'journal', jid, 'posted', { debit: totalDebit, credit: totalCredit, lines: lines.length });
      return json(res, 201, { id: jid, debit_minor: totalDebit, credit_minor: totalCredit, status: 'posted' });
    }

    if (path === '/api/accounts' && method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM chart_of_accounts WHERE active=1 ORDER BY code').all());
    }

    // -------------------------------------------------------------
    // BACKUP & RESTORE (Plain & Encrypted)
    // -------------------------------------------------------------
    const BACKUP_TABLES = [
      'shops', 'transactions', 'cash_counts', 'audit_events', 'products',
      'customers', 'suppliers', 'stock_movements', 'sale_items',
      'customer_credits', 'supplier_bills', 'expense_categories',
      'journal_entries', 'journal_lines', 'app_settings',
      'chart_of_accounts', 'mpesa_records', 'shifts', 'schema_migrations'
    ];

    function createBackupData() {
      return {
        app: 'DukaSauti',
        format_version: 2,
        exported_at: new Date().toISOString(),
        tables: Object.fromEntries(
          BACKUP_TABLES.map(t => {
            try { return [t, db.prepare(`SELECT * FROM ${t}`).all()]; }
            catch { return [t, []]; }
          })
        )
      };
    }

    if (path === '/api/backup' && method === 'GET') {
      const backup = createBackupData();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="dukasauti-backup.json"',
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify(backup, null, 2));
    }

    if (path === '/api/backup/export-encrypted' && method === 'POST') {
      const b = await bodyJson(req);
      const backup = createBackupData();
      const encrypted = encryptBackup(backup, b.passphrase);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="dukasauti-backup.enc.json"',
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify(encrypted, null, 2));
    }

    if (path === '/api/backup/restore' && method === 'POST') {
      const b = await bodyJson(req);
      let backupData = b;

      // Handle encrypted backup restoration
      if (b.cipher === 'aes-256-gcm' && b.ciphertext) {
        if (!b.passphrase) throw new Error('Passphrase required to restore encrypted backup.');
        backupData = decryptBackup(b, b.passphrase);
      }

      if (!backupData || backupData.app !== 'DukaSauti' || !backupData.tables) {
        throw new Error('Invalid backup file. Must be a valid DukaSauti backup.');
      }

      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [tbl, rows] of Object.entries(backupData.tables)) {
          if (!BACKUP_TABLES.includes(tbl)) continue;
          db.exec(`DELETE FROM ${tbl}`);
          if (!Array.isArray(rows) || !rows.length) continue;

          const cols = Object.keys(rows[0]);
          const placeholders = cols.map(() => '?').join(',');
          const ins = db.prepare(`INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${placeholders})`);
          for (const row of rows) {
            ins.run(...cols.map(c => row[c]));
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`Restore failed: ${e.message}`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }

      audit(db, 'system', '1', 'backup_restored', { exported_at: backupData.exported_at });
      return json(res, 200, { ok: true, message: 'Database restored successfully from backup.' });
    }

    // -------------------------------------------------------------
    // STAFF USERS & PIN LOCK
    // -------------------------------------------------------------
    if (path === '/api/auth/users' && method === 'GET') {
      const users = db.prepare('SELECT id, name, role, active, created_at FROM staff_users WHERE active=1').all();
      return json(res, 200, users);
    }

    if (path === '/api/auth/verify-pin' && method === 'POST') {
      const b = await bodyJson(req);
      const pin = String(b.pin || '').trim();
      if (!pin) throw new Error('Enter a PIN.');
      const hashed = hashPin(pin);
      const user = db.prepare('SELECT id, name, role FROM staff_users WHERE pin_hash=? AND active=1').get(hashed);
      if (!user) return json(res, 401, { error: 'Incorrect PIN.' });
      audit(db, 'staff_user', user.id, 'pin_verified', { role: user.role });
      return json(res, 200, { ok: true, user });
    }

    if (path === '/api/auth/change-pin' && method === 'POST') {
      const b = await bodyJson(req);
      const userId = text(b.user_id, 80);
      const oldPin = String(b.old_pin || '').trim();
      const newPin = String(b.new_pin || '').trim();
      const user = db.prepare('SELECT * FROM staff_users WHERE id=? AND active=1').get(userId);
      if (!user) throw new Error('User not found.');
      if (user.pin_hash !== hashPin(oldPin)) throw new Error('Current PIN is incorrect.');
      const newHash = hashPin(newPin);
      db.prepare('UPDATE staff_users SET pin_hash=? WHERE id=?').run(newHash, user.id);
      audit(db, 'staff_user', user.id, 'pin_changed', {});
      return json(res, 200, { ok: true, message: 'PIN updated successfully.' });
    }

    // -------------------------------------------------------------
    // UNIT CONVERSIONS & BULK UNPACKING
    // -------------------------------------------------------------
    if (path === '/api/units' && method === 'GET') {
      return json(res, 200, db.prepare('SELECT * FROM unit_conversions').all());
    }

    if (path === '/api/units' && method === 'POST') {
      const b = await bodyJson(req);
      const fromU = text(b.from_unit, 40).toLowerCase();
      const toU = text(b.to_unit, 40).toLowerCase();
      const factor = Number(b.factor);
      if (!fromU || !toU || !Number.isFinite(factor) || factor <= 0) throw new Error('Specify valid from_unit, to_unit, and positive factor.');
      const uId = id();
      db.prepare('INSERT INTO unit_conversions(id, from_unit, to_unit, factor, description) VALUES(?,?,?,?,?)')
        .run(uId, fromU, toU, factor, text(b.description, 200));
      return json(res, 201, { id: uId, from_unit: fromU, to_unit: toU, factor });
    }

    if (path === '/api/units/unpack' && method === 'POST') {
      const b = await bodyJson(req);
      const fromPid = text(b.from_product_id, 80);
      const toPid = text(b.to_product_id, 80);
      const unpackQty = quantity(b.quantity, 'Unpack quantity');
      const factor = Number(b.factor);
      if (!Number.isFinite(factor) || factor <= 0) throw new Error('Conversion factor must be greater than zero.');

      const pFrom = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(fromPid);
      const pTo = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(toPid);
      if (!pFrom || !pTo) throw new Error('Source or target product not found.');
      if (pFrom.stock_qty < unpackQty) throw new Error(`Not enough stock in source product. Available: ${pFrom.stock_qty}.`);

      const resultingRetailQty = unpackQty * factor;
      const unitCost = Math.round(pFrom.cost_price_minor / factor);
      const dateVal = today();

      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE products SET stock_qty=stock_qty-?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(unpackQty, pFrom.id);
        db.prepare('UPDATE products SET stock_qty=stock_qty+?, cost_price_minor=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(resultingRetailQty, unitCost, pTo.id);

        db.prepare("INSERT INTO stock_movements(id, product_id, movement_type, quantity, unit_cost_minor, reference, notes, business_date) VALUES(?,?,'damage',?,?,?,'Unpacked to piece',?)")
          .run(id(), pFrom.id, unpackQty, pFrom.cost_price_minor, pTo.id, dateVal);
        db.prepare("INSERT INTO stock_movements(id, product_id, movement_type, quantity, unit_cost_minor, reference, notes, business_date) VALUES(?,?,'return',?,?,?,'Unpacked from bulk',?)")
          .run(id(), pTo.id, resultingRetailQty, unitCost, pFrom.id, dateVal);

        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      audit(db, 'product', pTo.id, 'bulk_unpacked', { from_product: pFrom.name, unpackQty, resultingRetailQty });
      return json(res, 200, {
        ok: true,
        source_product: db.prepare('SELECT * FROM products WHERE id=?').get(pFrom.id),
        target_product: db.prepare('SELECT * FROM products WHERE id=?').get(pTo.id)
      });
    }

    // -------------------------------------------------------------
    // TAX & KRA eTIMS COMPLIANCE
    // -------------------------------------------------------------
    if (path === '/api/tax/summary' && method === 'GET') {
      const from = date(url.searchParams.get('from'));
      const to = date(url.searchParams.get('to') || from);
      const sales = db.prepare("SELECT * FROM transactions WHERE status='confirmed' AND type='sale' AND business_date BETWEEN ? AND ?").all(from, to);
      const totalSalesMinor = sales.reduce((sum, s) => sum + s.amount_minor, 0);

      // Kenyan standard VAT calculation (16%)
      const { taxable_minor, vat_minor } = calculateTaxBreakdown(totalSalesMinor, { rate: 0.16, isTaxable: true });
      return json(res, 200, {
        from,
        to,
        total_sales_minor: totalSalesMinor,
        taxable_sales_minor: taxable_minor,
        vat_payable_minor: vat_minor,
        vat_rate_percent: 16,
        sales_count: sales.length,
        etims_status: 'ready'
      });
    }

    if (path === '/api/tax/etims-invoice' && method === 'POST') {
      const b = await bodyJson(req);
      const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(text(b.transaction_id, 80));
      if (!tx) throw new Error('Transaction not found.');
      const items = db.prepare('SELECT * FROM sale_items WHERE transaction_id=?').all(tx.id);
      const tax = calculateTaxBreakdown(tx.amount_minor, { rate: 0.16, isTaxable: true });

      const invoiceNum = `KRA-ETIMS-${Date.now().toString(36).toUpperCase()}-${tx.id.slice(0, 4).toUpperCase()}`;
      const qrData = `https://itax.kra.go.ke/KRA-Portal/invoiceDetails.htm?inv=${invoiceNum}&amt=${(tx.amount_minor/100).toFixed(2)}`;

      db.prepare(`
        INSERT OR REPLACE INTO tax_invoices(id, transaction_id, invoice_number, total_minor, taxable_minor, vat_minor, qr_code_url, status)
        VALUES(?, ?, ?, ?, ?, ?, ?, 'generated')
      `).run(id(), tx.id, invoiceNum, tax.total_minor, tax.taxable_minor, tax.vat_minor, qrData);

      // Update vat_minor on transaction
      db.prepare('UPDATE transactions SET vat_minor=? WHERE id=?').run(tax.vat_minor, tx.id);

      return json(res, 201, {
        invoice_number: invoiceNum,
        total_minor: tax.total_minor,
        taxable_minor: tax.taxable_minor,
        vat_minor: tax.vat_minor,
        qr_code_url: qrData,
        items_count: items.length
      });
    }

    // -------------------------------------------------------------
    // STATEMENTS (CUSTOMER & SUPPLIER)
    // -------------------------------------------------------------
    const mCustStmt = path.match(/^\/api\/customers\/([^/]+)\/statement$/);
    if (mCustStmt && method === 'GET') {
      const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(mCustStmt[1]);
      if (!cust) return json(res, 404, { error: 'Customer not found.' });
      const credits = db.prepare('SELECT * FROM customer_credits WHERE customer_id=? ORDER BY business_date ASC, created_at ASC').all(cust.id);
      const stmtText = formatCustomerStatement({ customer: cust, credits });
      return json(res, 200, { customer: cust, credits, text: stmtText });
    }

    const mSuppStmt = path.match(/^\/api\/suppliers\/([^/]+)\/statement$/);
    if (mSuppStmt && method === 'GET') {
      const supp = db.prepare('SELECT * FROM suppliers WHERE id=?').get(mSuppStmt[1]);
      if (!supp) return json(res, 404, { error: 'Supplier not found.' });
      const bills = db.prepare('SELECT * FROM supplier_bills WHERE supplier_id=? ORDER BY business_date ASC, created_at ASC').all(supp.id);
      const stmtText = formatSupplierStatement({ supplier: supp, bills });
      return json(res, 200, { supplier: supp, bills, text: stmtText });
    }

    // -------------------------------------------------------------
    // SAMPLE WORKSPACE / DEMO DATA SEEDER
    // -------------------------------------------------------------
    if (path === '/api/demo/seed' && method === 'POST') {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('BEGIN IMMEDIATE');
      try {
        // Sample Kenyan Products
        const sampleProducts = [
          { id: 'p-unga-2kg', sku: '616110001001', name: 'Unga wa Mahindi Pembe 2kg', category: 'Cereals', unit: 'packet', cost: 13000, sell: 16000, qty: 45, reorder: 10 },
          { id: 'p-sukari-1kg', sku: '616110001002', name: 'Sukari Ndhiwa White Sugar 1kg', category: 'General', unit: 'kg', cost: 12000, sell: 15000, qty: 30, reorder: 8 },
          { id: 'p-maziwa-500ml', sku: '616110001003', name: 'Brookside Fresh Milk 500ml', category: 'Dairy', unit: 'pouch', cost: 5000, sell: 6500, qty: 25, reorder: 12 },
          { id: 'p-mafuta-1l', sku: '616110001004', name: 'Salit Cooking Oil 1 Litre', category: 'Cooking Oil', unit: 'bottle', cost: 24000, sell: 29000, qty: 18, reorder: 5 },
          { id: 'p-omo-500g', sku: '616110001005', name: 'Omo Detergent Washing Powder 500g', category: 'Soap', unit: 'packet', cost: 14000, sell: 17500, qty: 15, reorder: 4 },
          { id: 'p-mkate-400g', sku: '616110001006', name: 'Festive White Bread 400g', category: 'Bakery', unit: 'loaf', cost: 5500, sell: 6500, qty: 20, reorder: 6 },
          { id: 'p-soda-crate', sku: '616110001007', name: 'Coca Cola 300ml Glass Crate (24s)', category: 'Beverages', unit: 'crate', cost: 96000, sell: 120000, qty: 8, reorder: 2 },
          { id: 'p-soda-piece', sku: '616110001008', name: 'Coca Cola 300ml Glass Bottle Single', category: 'Beverages', unit: 'piece', cost: 4000, sell: 5000, qty: 48, reorder: 12 }
        ];

        for (const p of sampleProducts) {
          db.prepare(`
            INSERT OR REPLACE INTO products(id, sku, name, category, unit, selling_price_minor, cost_price_minor, stock_qty, reorder_level, active)
            VALUES(?,?,?,?,?,?,?,?,?,1)
          `).run(p.id, p.sku, p.name, p.category, p.unit, p.sell, p.cost, p.qty, p.reorder);
        }

        // Sample Customers
        const sampleCustomers = [
          { id: 'c-mama-kevin', name: 'Mama Kevin', phone: '0712345678', limit: 80000 },
          { id: 'c-kamau-boda', name: 'Kamau Boda Boda', phone: '0722334455', limit: 40000 },
          { id: 'c-teacher-grace', name: 'Teacher Grace', phone: '0733889900', limit: 100000 }
        ];
        for (const c of sampleCustomers) {
          db.prepare('INSERT OR REPLACE INTO customers(id, name, phone, notes, credit_limit_minor) VALUES(?,?,?,?,?)')
            .run(c.id, c.name, c.phone, 'Regular duka customer', c.limit);
        }

        // Sample Suppliers
        const sampleSuppliers = [
          { id: 's-millers', name: 'Unga Holdings Ltd', phone: '0206978000', email: 'sales@ungagroup.com' },
          { id: 's-bakery', name: 'Festive Bakeries Ltd', phone: '0700112233', email: 'orders@festive.co.ke' }
        ];
        for (const s of sampleSuppliers) {
          db.prepare('INSERT OR REPLACE INTO suppliers(id, name, phone, email, notes) VALUES(?,?,?,?,?)')
            .run(s.id, s.name, s.phone, s.email, 'Weekly stock distributor');
        }

        // Starter shift & shop name
        db.prepare("UPDATE shops SET name='Duka Bora Superette', opening_cash_minor=100000 WHERE id=1").run();

        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON;');
      }

      audit(db, 'system', '1', 'demo_seeded', {});
      return json(res, 200, { ok: true, message: 'Sample Duka workspace loaded with Kenyan retail catalogue, customers and suppliers!' });
    }

    return false;
  } catch (e) {
    return json(res, 400, { error: e.message || 'Invalid request.' });
  }
}
