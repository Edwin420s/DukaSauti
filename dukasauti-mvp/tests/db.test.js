import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, audit } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

test('SQLite schema persists a confirmed transaction and audit event', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dukasauti-test-')); const file=path.join(dir,'test.sqlite');
  const db=openDatabase(file);
  try {
    const id=randomUUID();
    db.prepare("INSERT INTO transactions(id,type,description,amount_minor,currency,payment_method,cash_received_minor,cash_paid_minor,credit_amount_minor,business_date,notes,source_text,source,status,confirmed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',CURRENT_TIMESTAMP)")
      .run(id,'sale','Test sale',10000,'KES','cash',10000,0,0,'2026-10-30','','','manual');
    audit(db,'transaction',id,'confirmed',{amount_minor:10000});
    assert.equal(db.prepare('SELECT amount_minor FROM transactions WHERE id=?').get(id).amount_minor,10000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE entity_id=?').get(id).n,1);
  } finally { db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});
