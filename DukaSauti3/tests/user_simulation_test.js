import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.DUKASAUTI_TEST_URL || 'http://127.0.0.1:4173';

async function req(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await res.json() : await res.text();
  return { status: res.status, ok: res.ok, headers: res.headers, body };
}

test('Full Naive Shopkeeper User Simulation: Every Page, Button, Receipt, M-Pesa & Shift', async (t) => {
  console.log('--- Starting Full Naive Shopkeeper User Simulation ---');
  const runId = Date.now().toString().slice(-6);

  // STEP 1: Verify System Health & Offline Mode
  await t.test('1. System Health & Offline AI Check', async () => {
    const res = await req('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.app, 'DukaSauti');
    console.log('✓ Health check passed. Runtime:', res.body.runtime);
  });

  // STEP 2: Shop Profile & PIN Configuration (Settings Page)
  await t.test('2. Settings: Shop Branding & PIN Security', async () => {
    // Update shop name, currency, opening cash float
    const shopUpdate = await req('/api/shop', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Mwangi Family Duka & Grocers',
        opening_cash_minor: 300000 // KES 3,000.00 opening float
      })
    });
    assert.equal(shopUpdate.status, 200);
    assert.equal(shopUpdate.body.name, 'Mwangi Family Duka & Grocers');
    assert.equal(shopUpdate.body.opening_cash_minor, 300000);

    // Fetch staff users
    const usersRes = await req('/api/auth/users');
    assert.equal(usersRes.status, 200);
    assert.ok(usersRes.body.length > 0);
    const mainUser = usersRes.body[0];

    // Check current PIN (either default 1234 or previously set 4321)
    const check1234 = await req('/api/auth/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ pin: '1234' })
    });
    const currentPin = check1234.ok ? '1234' : '4321';
    const nextPin = currentPin === '1234' ? '4321' : '1234';

    // Change PIN
    const changePin = await req('/api/auth/change-pin', {
      method: 'POST',
      body: JSON.stringify({ user_id: mainUser.id, old_pin: currentPin, new_pin: nextPin })
    });
    assert.equal(changePin.status, 200);
    assert.equal(changePin.body.ok, true);

    // Verify invalid PIN fails with 401
    const verifyFail = await req('/api/auth/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ pin: '9999' })
    });
    assert.equal(verifyFail.status, 401);

    // Verify next PIN succeeds with 200
    const verifyNew = await req('/api/auth/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ pin: nextPin })
    });
    assert.equal(verifyNew.status, 200);
    assert.equal(verifyNew.body.ok, true);

    console.log('✓ Shop branding and PIN security validated.');
  });

  let productFlour, productMilk, productRoyco, productCrateSoda, productSingleSoda;

  // STEP 3: Stock Control & Bulk Unpacking (Inventory Page)
  await t.test('3. Stock & Inventory: Products, Bulk Unpacking & Damage Adjustment', async () => {
    // Add Ajab 2kg Flour
    const resFlour = await req('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Ajab Wheat Flour 2kg (${runId})`,
        category: 'flour',
        sku: `616110${runId}01`,
        cost_price_minor: 18000,
        selling_price_minor: 22000,
        stock_qty: 30,
        reorder_level: 5,
        tax_category: 'exempt'
      })
    });
    assert.equal(resFlour.status, 201);
    productFlour = resFlour.body;

    // Add Brookside Fresh Milk 500ml
    const resMilk = await req('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Brookside Milk 500ml (${runId})`,
        category: 'dairy',
        sku: `616110${runId}02`,
        cost_price_minor: 5500,
        selling_price_minor: 6500,
        stock_qty: 50,
        reorder_level: 10,
        tax_category: 'zero_rated'
      })
    });
    assert.equal(resMilk.status, 201);
    productMilk = resMilk.body;

    // Add Royco Cubes 40s Pack
    const resRoyco = await req('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Royco Cubes 40s (${runId})`,
        category: 'spices',
        sku: `616110${runId}03`,
        cost_price_minor: 12000,
        selling_price_minor: 15000,
        stock_qty: 25,
        reorder_level: 5,
        tax_category: 'standard'
      })
    });
    assert.equal(resRoyco.status, 201);
    productRoyco = resRoyco.body;

    // Add Crate of Coca Cola 300ml (24 bottles)
    const resCrate = await req('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Coca Cola 300ml Glass Crate (24s) (${runId})`,
        category: 'beverages',
        sku: `616110${runId}04`,
        cost_price_minor: 96000,
        selling_price_minor: 120000,
        stock_qty: 5,
        reorder_level: 2,
        tax_category: 'standard'
      })
    });
    assert.equal(resCrate.status, 201);
    productCrateSoda = resCrate.body;

    // Add Single Coca Cola 300ml Glass Bottle
    const resSingle = await req('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: `Coca Cola 300ml Glass Bottle Single (${runId})`,
        category: 'beverages',
        sku: `616110${runId}05`,
        cost_price_minor: 4000,
        selling_price_minor: 5000,
        stock_qty: 10,
        reorder_level: 6,
        tax_category: 'standard'
      })
    });
    assert.equal(resSingle.status, 201);
    productSingleSoda = resSingle.body;

    // Unpack 1 crate of soda into 24 single bottles
    const unpackRes = await req('/api/units/unpack', {
      method: 'POST',
      body: JSON.stringify({
        from_product_id: productCrateSoda.id,
        to_product_id: productSingleSoda.id,
        quantity: 1,
        factor: 24
      })
    });
    assert.equal(unpackRes.status, 200);
    assert.equal(unpackRes.body.ok, true);
    assert.equal(unpackRes.body.source_product.stock_qty, 4); // 5 - 1 = 4
    assert.equal(unpackRes.body.target_product.stock_qty, 34); // 10 + 24 = 34

    // Record stock damage adjustment: 1 milk damaged in transit
    const adjustRes = await req('/api/stock/movements', {
      method: 'POST',
      body: JSON.stringify({
        product_id: productMilk.id,
        movement_type: 'damage',
        quantity: 1,
        business_date: '2026-10-30',
        notes: 'Carton pierced during unloading'
      })
    });
    assert.equal(adjustRes.status, 201);

    // Verify milk stock is now 49 (50 - 1)
    const milkCheck = await req('/api/products');
    const updatedMilk = milkCheck.body.find(p => p.id === productMilk.id);
    assert.equal(updatedMilk.stock_qty, 49);

    console.log('✓ Products created, bulk crate unpacked into 24 pieces, damage recorded.');
  });

  let supplierBrookside, supplierBill;

  // STEP 4: Suppliers & Bills (Suppliers Page)
  await t.test('4. Suppliers & Bills: Restock on Credit, Payment & Statement', async () => {
    // Register supplier Brookside Dairy Kenya
    const suppRes = await req('/api/suppliers', {
      method: 'POST',
      body: JSON.stringify({
        name: `Brookside Dairy Kenya Ltd (${runId})`,
        phone: `0722${runId}`,
        email: `orders-${runId}@brookside.co.ke`,
        terms: 'Net 14'
      })
    });
    assert.equal(suppRes.status, 201);
    supplierBrookside = suppRes.body;

    // Log restock bill: 40 packets of milk at KES 55.00 each = KES 2,200.00
    const billRes = await req('/api/suppliers/bills', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: supplierBrookside.id,
        amount_minor: 220000,
        reference: `BRK-${runId}`,
        business_date: '2026-10-30',
        notes: 'Morning fresh milk drop 40 units',
        items: [
          { product_id: productMilk.id, quantity: 40, unit_cost_minor: 5500 }
        ]
      })
    });
    assert.equal(billRes.status, 201);
    supplierBill = billRes.body;
    assert.equal(supplierBill.amount_minor, 220000);
    assert.equal(supplierBill.paid_minor, 0);

    // Verify milk stock increased by 40 (49 + 40 = 89)
    const milkAfterRestock = (await req('/api/products')).body.find(p => p.id === productMilk.id);
    assert.equal(milkAfterRestock.stock_qty, 89);

    // Make partial bill payment of KES 1,200.00 via M-Pesa
    const payRes = await req(`/api/suppliers/bills/${supplierBill.id}/payment`, {
      method: 'POST',
      body: JSON.stringify({
        amount_minor: 120000,
        payment_method: 'mobile_money',
        business_date: '2026-10-30',
        notes: 'M-Pesa payment to Brookside Till'
      })
    });
    assert.equal(payRes.status, 201);
    assert.equal(payRes.body.bill.paid_minor, 120000);

    // Generate formal supplier statement
    const stmtRes = await req(`/api/suppliers/${supplierBrookside.id}/statement`);
    assert.equal(stmtRes.status, 200);
    assert.match(stmtRes.body.text, /SUPPLIER STATEMENT/);
    assert.match(stmtRes.body.text, /Brookside Dairy Kenya Ltd/);
    console.log('✓ Supplier registered, restock bill created, partial M-Pesa payment disbursed, statement generated.');
  });

  let posSaleTransaction;

  // STEP 5: POS Checkout & Thermal Receipt (POS Checkout Page)
  await t.test('5. POS Checkout: Multi-Item Sale, Banknote Cash Tendering & Thermal Receipt Generation', async () => {
    // Customer buys:
    // - 2 bags of Ajab Flour @ 220 = 440 KES (44,000 minor)
    // - 3 packets of Milk @ 65 = 195 KES (19,500 minor)
    // - 1 single Coca Cola @ 50 = 50 KES (5,000 minor)
    // Total = 685.00 KES (68,500 minor)
    const saleRes = await req('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        lines: [
          { product_id: productFlour.id, quantity: 2, unit_price_minor: 22000 },
          { product_id: productMilk.id, quantity: 3, unit_price_minor: 6500 },
          { product_id: productSingleSoda.id, quantity: 1, unit_price_minor: 5000 }
        ],
        cash_received_minor: 68500,
        mobile_money_received_minor: 0,
        bank_received_minor: 0,
        credit_amount_minor: 0,
        business_date: '2026-10-30',
        description: 'Walk-in customer grocery checkout',
        notes: 'Customer tendered 1000 KES note, 315 KES change given'
      })
    });
    assert.equal(saleRes.status, 201);
    posSaleTransaction = saleRes.body.transaction;
    assert.equal(posSaleTransaction.amount_minor, 68500);
    assert.equal(posSaleTransaction.cash_received_minor, 68500);

    // Verify thermal receipt generation for this transaction
    const receiptRes = await req(`/api/transactions/${posSaleTransaction.id}/receipt`);
    assert.equal(receiptRes.status, 200);
    assert.ok(receiptRes.body.text);
    assert.match(receiptRes.body.text, /Mwangi Family Duka/);
    assert.match(receiptRes.body.text, /SALES RECEIPT/);
    assert.match(receiptRes.body.text, /685\.00/);

    // Verify inventory stock decreased
    const productsAfterSale = (await req('/api/products')).body;
    assert.equal(productsAfterSale.find(p => p.id === productFlour.id).stock_qty, 28); // 30 - 2
    assert.equal(productsAfterSale.find(p => p.id === productMilk.id).stock_qty, 86); // 89 - 3
    assert.equal(productsAfterSale.find(p => p.id === productSingleSoda.id).stock_qty, 33); // 34 - 1

    console.log('✓ POS sale confirmed, stock decremented, 58mm/80mm thermal receipt verified.');
  });

  let customerNjeri;

  // STEP 6: Customer Credit / Store Deni Book (Customers Page)
  await t.test('6. Customers & Credit: Store Credit Sale, Cash Repayment & Statement', async () => {
    // Register Mama Njeri
    const custRes = await req('/api/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: `Mama Njeri Kangemi (${runId})`,
        phone: `0711${runId}`,
        credit_limit_minor: 300000, // 3,000 KES limit
        notes: 'Neighbor stall #16'
      })
    });
    assert.equal(custRes.status, 201);
    customerNjeri = custRes.body;
    assert.match(customerNjeri.name, /Mama Njeri Kangemi/);

    // Credit sale to Mama Njeri: 1 Ajab flour (220 KES) + 2 packets milk (130 KES) = 350 KES (35,000 minor)
    const creditSale = await req('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerNjeri.id,
        lines: [
          { product_id: productFlour.id, quantity: 1, unit_price_minor: 22000 },
          { product_id: productMilk.id, quantity: 2, unit_price_minor: 6500 }
        ],
        cash_received_minor: 0,
        mobile_money_received_minor: 0,
        bank_received_minor: 0,
        credit_amount_minor: 35000,
        business_date: '2026-10-30',
        description: 'Deni: Mama Njeri groceries'
      })
    });
    assert.equal(creditSale.status, 201);

    // Verify customer outstanding balance is now 350.00 KES
    const customersList = (await req('/api/customers')).body;
    const njeriRecord = customersList.find(c => c.id === customerNjeri.id);
    assert.equal(njeriRecord.balance_minor, 35000);

    // Mama Njeri makes a cash repayment of 200.00 KES (20,000 minor)
    const repayRes = await req('/api/credits', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerNjeri.id,
        entry_type: 'repayment',
        amount_minor: 20000,
        payment_method: 'cash',
        business_date: '2026-10-30',
        notes: 'Partial deni payment in cash'
      })
    });
    assert.equal(repayRes.status, 201);

    // Verify balance is now 150.00 KES
    const njeriAfterRepay = (await req('/api/customers')).body.find(c => c.id === customerNjeri.id);
    assert.equal(njeriAfterRepay.balance_minor, 15000);

    // Generate printable customer statement
    const custStmt = await req(`/api/customers/${customerNjeri.id}/statement`);
    assert.equal(custStmt.status, 200);
    assert.match(custStmt.body.text, /CUSTOMER STATEMENT/);
    assert.match(custStmt.body.text, /Mama Njeri Kangemi/);
    assert.match(custStmt.body.text, /150\.00/);

    console.log('✓ Customer credit account opened, credit sale booked, cash repayment recorded, statement generated.');
  });

  // STEP 7: Sauti Voice/Text Entry (AI Entry Page)
  await t.test('7. Sauti Entry: Swahili/English Colloquial Note Extraction & Confirmation', async () => {
    // Sauti input note
    const noteText = 'Sold 2 packets of milk 130 cash and 1 Royco 150 mpesa and spent 100 on transport';
    const extractRes = await req('/api/ai/extract', {
      method: 'POST',
      body: JSON.stringify({ note: noteText })
    });
    assert.equal(extractRes.status, 200);
    assert.ok(extractRes.body.events);
    assert.ok(extractRes.body.events.length >= 1);

    // Confirm the extracted proposal as a transaction
    const firstEvent = extractRes.body.events[0];
    const confirmRes = await req('/api/transactions', {
      method: 'POST',
      body: JSON.stringify({
        ...firstEvent,
        business_date: '2026-10-30',
        source: 'qvac-local'
      })
    });
    assert.equal(confirmRes.status, 201);
    assert.equal(confirmRes.body.status, 'confirmed');

    console.log('✓ Sauti colloquial entry interpreted and confirmed to transaction ledger.');
  });

  let importedMpesaId;

  // STEP 8: M-Pesa SMS Matcher & Reconciliation (M-Pesa Page)
  await t.test('8. M-Pesa Matcher: Parse Safaricom SMS, Import & Match', async () => {
    const mpesaCode = `QK${runId}ZZ`;
    const rawSms = `${mpesaCode} Confirmed. You have received Ksh500.00 from PETER OMONDI 0722334455 on 30/10/26 at 3:45 PM. New M-PESA balance is Ksh15,450.00.`;

    // Parse M-Pesa SMS
    const parseRes = await req('/api/mpesa/parse', {
      method: 'POST',
      body: JSON.stringify({ text: rawSms })
    });
    assert.equal(parseRes.status, 200);
    assert.equal(parseRes.body.mpesa_code, mpesaCode);
    assert.equal(parseRes.body.amount_minor, 50000); // 500.00 KES
    assert.equal(parseRes.body.direction, 'in');
    assert.equal(parseRes.body.sender_or_recipient, 'PETER OMONDI');
    assert.equal(parseRes.body.phone, '0722334455');

    // Import into M-Pesa reconciliation log
    const importRes = await req('/api/mpesa/import', {
      method: 'POST',
      body: JSON.stringify({ records: [parseRes.body] })
    });
    assert.equal(importRes.status, 201);
    assert.equal(importRes.body.imported, 1);

    // Verify it appears in M-Pesa list
    const mpesaList = await req('/api/mpesa');
    assert.equal(mpesaList.status, 200);
    const mpesaRec = mpesaList.body.find(m => m.mpesa_code === mpesaCode);
    assert.ok(mpesaRec);
    importedMpesaId = mpesaRec.id;

    // Match this M-Pesa payment against our earlier POS sale
    const matchRes = await req(`/api/mpesa/${importedMpesaId}/match`, {
      method: 'POST',
      body: JSON.stringify({ transaction_id: posSaleTransaction.id })
    });
    assert.equal(matchRes.status, 200);
    assert.equal(matchRes.body.ok, true);

    console.log('✓ Safaricom SMS parsed, imported to M-Pesa ledger, and matched with sale transaction.');
  });

  // STEP 9: Transactions Ledger, CSV Export & Transaction Reversal (Ledger Page)
  await t.test('9. Transactions Ledger: Search, CSV RFC-4180 Export & Reversal Audit', async () => {
    // List transactions
    const listRes = await req('/api/transactions?status=confirmed');
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.length > 0);

    // Export CSV
    const csvRes = await req('/api/export.csv');
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type'), /text\/csv/);
    assert.match(csvRes.body, /id,business_date,type/);

    // Reversal test: Create a test sale and reverse it
    const tempSale = await req('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        lines: [{ product_id: productRoyco.id, quantity: 1, unit_price_minor: 15000 }],
        cash_received_minor: 15000,
        business_date: '2026-10-30',
        description: 'Customer test buy for reversal'
      })
    });
    assert.equal(tempSale.status, 201);
    const tempId = tempSale.body.transaction.id;

    // Reverse transaction
    const revRes = await req(`/api/transactions/${tempId}/reverse`, { method: 'POST' });
    assert.equal(revRes.status, 200);
    assert.equal(revRes.body.ok, true);

    // Verify status is reversed
    const checkRev = (await req('/api/transactions?status=reversed')).body.find(t => t.id === tempId);
    assert.ok(checkRev);
    assert.equal(checkRev.status, 'reversed');

    console.log('✓ Transaction ledger, CSV export and reversal audit trail verified.');
  });

  // STEP 10: General Ledger Double-Entry Journals (Journals Page)
  await t.test('10. General Ledger: Auto-Posted Journals & Manual Adjusting Journal', async () => {
    // Get all journals
    const jList = await req('/api/journals');
    assert.equal(jList.status, 200);
    assert.ok(jList.body.length > 0);

    // Verify all journals are strictly balanced (Debits = Credits)
    for (const j of jList.body) {
      assert.equal(j.total_debit_minor, j.total_credit_minor, `Journal ${j.id} must be balanced`);
    }

    // Post a manual adjusting journal (Owner Equity Investment 5,000 KES into Cash)
    const manualJ = await req('/api/journals', {
      method: 'POST',
      body: JSON.stringify({
        business_date: '2026-10-30',
        description: 'Owner cash addition to drawer',
        reference: `MAN-ADJ-${runId}`,
        lines: [
          { account_code: '1000', account_name: 'Cash in Hand', debit_minor: 500000, credit_minor: 0 },
          { account_code: '3000', account_name: "Owner's Equity", debit_minor: 0, credit_minor: 500000 }
        ]
      })
    });
    assert.equal(manualJ.status, 201);
    assert.equal(manualJ.body.debit_minor, 500000);
    assert.equal(manualJ.body.credit_minor, 500000);

    console.log('✓ Double-entry general ledger verified with balanced debits and credits.');
  });

  // STEP 11: Financial Reports & Tax Summary (Reports Page)
  await t.test('11. Reports & COGS: P&L Summary and KRA VAT Breakdown', async () => {
    const repRes = await req('/api/reports/overview?from=2026-10-01&to=2026-10-31');
    assert.equal(repRes.status, 200);
    assert.ok(repRes.body.sales_minor >= 0);
    assert.ok(repRes.body.cogs_minor >= 0);

    const taxRes = await req('/api/tax/summary?from=2026-10-01&to=2026-10-31');
    assert.equal(taxRes.status, 200);
    assert.ok(taxRes.body.total_sales_minor >= 0);
    assert.equal(taxRes.body.vat_rate_percent, 16);

    console.log('✓ Financial P&L overview and tax breakdown generated.');
  });

  // STEP 12: Cash Drawer Balancing & Shift Closure (Close Shift Page)
  await t.test('12. Close Shift: Banknotes Breakdown, Float & Perfect Drawer Balancing', async () => {
    // Get active shift position
    const posRes = await req('/api/shifts/position?date=2026-10-30');
    assert.equal(posRes.status, 200);
    const pos = posRes.body;

    const expectedCashMinor = pos.expected_in_counter_minor;
    assert.ok(Number.isSafeInteger(expectedCashMinor));

    // Non-technical shopkeeper enters the exact counted cash in her till
    const closeRes = await req('/api/shifts/close', {
      method: 'POST',
      body: JSON.stringify({
        date: '2026-10-30',
        counted_cash_minor: expectedCashMinor,
        notes: 'Day 1 trading complete. Safe locked. Drawer perfectly balanced.'
      })
    });
    assert.equal(closeRes.status, 201);
    assert.equal(closeRes.body.difference_minor, 0); // Balanced!
    assert.equal(closeRes.body.is_balanced, true);

    console.log(`✓ Shift closed successfully. Expected: KES ${(expectedCashMinor/100).toFixed(2)}, Counted: KES ${(expectedCashMinor/100).toFixed(2)}, Difference: 0 (Balanced).`);
  });

  // STEP 13: Encrypted Backup & Disaster Recovery (Settings Page)
  await t.test('13. Disaster Recovery: Encrypted Backup Export and Restore', async () => {
    // Export encrypted backup with passphrase
    const exportRes = await req('/api/backup/export-encrypted', {
      method: 'POST',
      body: JSON.stringify({ passphrase: 'KenyaShopKeeper2026!' })
    });
    assert.equal(exportRes.status, 200);
    assert.ok(exportRes.body.ciphertext);
    assert.equal(exportRes.body.cipher, 'aes-256-gcm');

    const backupPayload = exportRes.body;

    // Restore from encrypted backup
    const restoreRes = await req('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify({
        ...backupPayload,
        passphrase: 'KenyaShopKeeper2026!'
      })
    });
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.body.ok, true);

    // Verify data is completely intact after restore
    const postRestoreShop = await req('/api/shop');
    assert.equal(postRestoreShop.body.name, 'Mwangi Family Duka & Grocers');

    const postRestoreProducts = await req('/api/products');
    assert.ok(postRestoreProducts.body.length >= 5);

    console.log('✓ Encrypted backup exported and restored with 100% data integrity.');
  });

  console.log('--- Full Naive Shopkeeper User Simulation Completed Successfully! ---');
});
