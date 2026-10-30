import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, audit, SCHEMA_VERSION } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

test('SQLite schema applies migrations and seeds base data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dukasauti-db-test-'));
  const file = path.join(dir, 'test.sqlite');
  const db = openDatabase(file);
  try {
    // Verify migrations table
    const migrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.equal(migrations.length >= 3, true);

    // Verify shops table
    const shop = db.prepare('SELECT * FROM shops WHERE id=1').get();
    assert.equal(shop.name, 'My Shop');
    assert.equal(shop.currency, 'KES');

    // Verify chart of accounts table seeded
    const accounts = db.prepare('SELECT * FROM chart_of_accounts').all();
    assert.equal(accounts.length >= 10, true);
    assert.ok(accounts.some(a => a.code === '1000' && a.name === 'Cash in Hand'));
    assert.ok(accounts.some(a => a.code === '4000' && a.name === 'Sales Revenue'));

    // Verify transactions and audit
    const id = randomUUID();
    db.prepare("INSERT INTO transactions(id,type,description,amount_minor,currency,payment_method,cash_received_minor,cash_paid_minor,credit_amount_minor,business_date,notes,source_text,source,status,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',CURRENT_TIMESTAMP)")
      .run(id, 'sale', 'Test sale', 10000, 'KES', 'cash', 10000, 0, 0, '2026-10-30', '', '', 'manual');
    audit(db, 'transaction', id, 'confirmed', { amount_minor: 10000 });

    assert.equal(db.prepare('SELECT amount_minor FROM transactions WHERE id=?').get(id).amount_minor, 10000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE entity_id=?').get(id).n, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
