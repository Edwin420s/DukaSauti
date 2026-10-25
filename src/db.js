import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 4;

export function openDatabase(filename = process.env.DUKASAUTI_DB || path.resolve('data/dukasauti.sqlite')) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  // Schema migrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Apply migrations in order
  runMigrations(db);

  return db;
}

function runMigrations(db) {
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version)
  );

  // Migration 1: Base schema (v1)
  if (!applied.has(1)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shops (
        id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'KES',
        timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi', opening_cash_minor INTEGER NOT NULL DEFAULT 0 CHECK(opening_cash_minor >= 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO shops(id, name) VALUES(1, 'My Shop');

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
        currency TEXT NOT NULL DEFAULT 'KES', payment_method TEXT NOT NULL DEFAULT 'none',
        cash_received_minor INTEGER NOT NULL DEFAULT 0 CHECK(cash_received_minor >= 0),
        cash_paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(cash_paid_minor >= 0),
        mobile_money_received_minor INTEGER NOT NULL DEFAULT 0 CHECK(mobile_money_received_minor >= 0),
        bank_received_minor INTEGER NOT NULL DEFAULT 0 CHECK(bank_received_minor >= 0),
        credit_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(credit_amount_minor >= 0),
        business_date TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL CHECK(status IN ('draft','confirmed','reversed')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TEXT, reversed_at TEXT, correction_of TEXT REFERENCES transactions(id)
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL DEFAULT 'piece', selling_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(selling_price_minor>=0),
        cost_price_minor INTEGER NOT NULL DEFAULT 0 CHECK(cost_price_minor>=0), stock_qty REAL NOT NULL DEFAULT 0 CHECK(stock_qty>=0),
        reorder_level REAL NOT NULL DEFAULT 0 CHECK(reorder_level>=0), active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        credit_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK(credit_limit_minor>=0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS suppliers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
        movement_type TEXT NOT NULL CHECK(movement_type IN ('opening','purchase','sale','return','damage','adjustment')),
        quantity REAL NOT NULL CHECK(quantity>0), unit_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK(unit_cost_minor>=0),
        reference TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', business_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_stock_product_date ON stock_movements(product_id,business_date);

      CREATE TABLE IF NOT EXISTS sale_items (
        id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES transactions(id), product_id TEXT NOT NULL REFERENCES products(id),
        product_name TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity>0), unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor>=0),
        unit_cost_minor INTEGER NOT NULL CHECK(unit_cost_minor>=0), line_total_minor INTEGER NOT NULL CHECK(line_total_minor>=0)
      );

      CREATE TABLE IF NOT EXISTS customer_credits (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), transaction_id TEXT REFERENCES transactions(id),
        entry_type TEXT NOT NULL CHECK(entry_type IN ('charge','payment','adjustment')), amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
        business_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS supplier_bills (
        id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id), reference TEXT NOT NULL DEFAULT '',
        amount_minor INTEGER NOT NULL CHECK(amount_minor>0), paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(paid_minor>=0 AND paid_minor<=amount_minor),
        due_date TEXT, business_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS expense_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
      INSERT OR IGNORE INTO expense_categories(id,name) VALUES ('rent','Rent'),('transport','Transport'),('utilities','Utilities'),('wages','Wages'),('inventory','Inventory/Stock'),('other','Other');

      CREATE TABLE IF NOT EXISTS journal_entries (
        id TEXT PRIMARY KEY, business_date TEXT NOT NULL, description TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('draft','posted','reversed')) DEFAULT 'draft',
        source_type TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, posted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS journal_lines (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        account_code TEXT NOT NULL, account_name TEXT NOT NULL, debit_minor INTEGER NOT NULL DEFAULT 0 CHECK(debit_minor>=0),
        credit_minor INTEGER NOT NULL DEFAULT 0 CHECK(credit_minor>=0), CHECK((debit_minor=0) != (credit_minor=0))
      );

      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(business_date);
      CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

      CREATE TABLE IF NOT EXISTS cash_counts (
        id TEXT PRIMARY KEY, business_date TEXT NOT NULL, counted_cash_minor INTEGER NOT NULL CHECK(counted_cash_minor >= 0),
        expected_cash_minor INTEGER NOT NULL, difference_minor INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '',
        shift_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare('INSERT INTO schema_migrations(version, name) VALUES(1, ?)').run('initial_base_schema');
  }

  // Migration 2: Chart of Accounts & COGS support
  if (!applied.has(2)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chart_of_accounts (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
        active INTEGER NOT NULL DEFAULT 1
      );

      INSERT OR IGNORE INTO chart_of_accounts(code, name, type) VALUES
        ('1000', 'Cash in Hand', 'asset'),
        ('1010', 'M-Pesa Account', 'asset'),
        ('1020', 'Bank Account', 'asset'),
        ('1100', 'Accounts Receivable (Customer Credit)', 'asset'),
        ('1200', 'Inventory Asset', 'asset'),
        ('2000', 'Accounts Payable (Suppliers)', 'liability'),
        ('3000', 'Owner Equity / Capital', 'equity'),
        ('4000', 'Sales Revenue', 'revenue'),
        ('5000', 'Cost of Goods Sold (COGS)', 'expense'),
        ('6000', 'Rent Expense', 'expense'),
        ('6010', 'Transport Expense', 'expense'),
        ('6020', 'Utilities Expense', 'expense'),
        ('6030', 'Wages Expense', 'expense'),
        ('6090', 'General & Admin Expense', 'expense');
    `);

    // Add category and COGS tracking columns if not already existing
    const txCols = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
    if (!txCols.includes('category')) db.exec("ALTER TABLE transactions ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    if (!txCols.includes('cogs_minor')) db.exec("ALTER TABLE transactions ADD COLUMN cogs_minor INTEGER NOT NULL DEFAULT 0 CHECK(cogs_minor >= 0)");

    // Add items_json column to supplier_bills
    const billCols = db.prepare('PRAGMA table_info(supplier_bills)').all().map(c => c.name);
    if (!billCols.includes('items_json')) db.exec("ALTER TABLE supplier_bills ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]'");

    db.prepare('INSERT INTO schema_migrations(version, name) VALUES(2, ?)').run('chart_of_accounts_and_cogs');
  }

  // Migration 3: M-Pesa statements and shift tracking
  if (!applied.has(3)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mpesa_records (
        id TEXT PRIMARY KEY,
        mpesa_code TEXT UNIQUE,
        direction TEXT NOT NULL CHECK(direction IN ('in','out')),
        amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
        sender_or_recipient TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        transaction_time TEXT NOT NULL,
        raw_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('unmatched','matched','ignored')) DEFAULT 'unmatched',
        matched_transaction_id TEXT REFERENCES transactions(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_mpesa_code ON mpesa_records(mpesa_code);
      CREATE INDEX IF NOT EXISTS idx_mpesa_status ON mpesa_records(status);

      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY,
        opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TEXT,
        opening_float_minor INTEGER NOT NULL DEFAULT 0 CHECK(opening_float_minor >= 0),
        closing_cash_minor INTEGER,
        expected_cash_minor INTEGER,
        difference_minor INTEGER,
        status TEXT NOT NULL CHECK(status IN ('open','closed')) DEFAULT 'open',
        notes TEXT NOT NULL DEFAULT ''
      );
    `);
    db.prepare('INSERT INTO schema_migrations(version, name) VALUES(3, ?)').run('mpesa_and_shifts');
  }

  // Migration 4: Staff roles & PIN lock, Unit conversions, Tax/eTIMS
  if (!applied.has(4)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','attendant')),
        pin_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- Default owner PIN is 1234 (sha256 hash), attendant PIN is 0000
      INSERT OR IGNORE INTO staff_users(id, name, role, pin_hash) VALUES
        ('usr-owner-1', 'Shop Owner', 'owner', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'),
        ('usr-attendant-1', 'Counter Attendant', 'attendant', '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0');

      CREATE TABLE IF NOT EXISTS unit_conversions (
        id TEXT PRIMARY KEY,
        from_unit TEXT NOT NULL,
        to_unit TEXT NOT NULL,
        factor REAL NOT NULL CHECK(factor > 0),
        description TEXT NOT NULL DEFAULT ''
      );

      INSERT OR IGNORE INTO unit_conversions(id, from_unit, to_unit, factor, description) VALUES
        ('uc-crate-piece', 'crate', 'piece', 24.0, '1 Crate = 24 Pieces (Soda/Drinks)'),
        ('uc-carton-piece', 'carton', 'piece', 12.0, '1 Carton = 12 Pieces (Flour/Soap)'),
        ('uc-bag50-kg', 'bag_50kg', 'kg', 50.0, '1 Bag = 50 Kilograms (Rice/Sugar)'),
        ('uc-bundle-piece', 'bundle', 'piece', 10.0, '1 Bundle = 10 Pieces (Bale)'),
        ('uc-kg-gram', 'kg', 'gram', 1000.0, '1 Kilogram = 1000 Grams');

      CREATE TABLE IF NOT EXISTS tax_invoices (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id),
        invoice_number TEXT UNIQUE,
        total_minor INTEGER NOT NULL,
        taxable_minor INTEGER NOT NULL,
        vat_minor INTEGER NOT NULL,
        qr_code_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'generated',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const txCols = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
    if (!txCols.includes('vat_minor')) db.exec("ALTER TABLE transactions ADD COLUMN vat_minor INTEGER NOT NULL DEFAULT 0 CHECK(vat_minor >= 0)");

    db.prepare('INSERT INTO schema_migrations(version, name) VALUES(4, ?)').run('staff_units_etims');
  }
}

export function audit(db, entityType, entityId, action, details = {}) {
  db.prepare('INSERT INTO audit_events(id, entity_type, entity_id, action, details_json) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), entityType, entityId, action, JSON.stringify(details));
}
