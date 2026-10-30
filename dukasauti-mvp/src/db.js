import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename = process.env.DUKASAUTI_DB || path.resolve('data/dukasauti.sqlite')) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'KES',
      timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi', opening_cash_minor INTEGER NOT NULL DEFAULT 0 CHECK(opening_cash_minor >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO shops(id, name) VALUES(1, 'My Shop');
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
      currency TEXT NOT NULL DEFAULT 'KES', payment_method TEXT NOT NULL DEFAULT 'none', cash_received_minor INTEGER NOT NULL DEFAULT 0 CHECK(cash_received_minor >= 0), cash_paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(cash_paid_minor >= 0),
      credit_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(credit_amount_minor >= 0), business_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '', source_text TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL CHECK(status IN ('draft','confirmed','reversed')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TEXT, reversed_at TEXT, correction_of TEXT REFERENCES transactions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(business_date);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE TABLE IF NOT EXISTS cash_counts (
      id TEXT PRIMARY KEY, business_date TEXT NOT NULL, counted_cash_minor INTEGER NOT NULL CHECK(counted_cash_minor >= 0),
      expected_cash_minor INTEGER NOT NULL, difference_minor INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Lightweight forward-compatible migration for databases created by earlier MVP snapshots.
  const columns = db.prepare('PRAGMA table_info(transactions)').all().map(c => c.name);
  if (!columns.includes('cash_paid_minor')) db.exec('ALTER TABLE transactions ADD COLUMN cash_paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(cash_paid_minor >= 0)');
  return db;
}

export function audit(db, entityType, entityId, action, details = {}) {
  db.prepare('INSERT INTO audit_events(id, entity_type, entity_id, action, details_json) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), entityType, entityId, action, JSON.stringify(details));
}
