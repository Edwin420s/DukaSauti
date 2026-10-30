import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 43000 + Math.floor(Math.random() * 1000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dukasauti-api-'));
const dbPath = path.join(dir, 'app.sqlite');
const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port), DUKASAUTI_DB: dbPath }, stdio: ['ignore','pipe','pipe'] });
let logs=''; child.stdout.on('data',d=>logs+=d); child.stderr.on('data',d=>logs+=d);
const base=`http://127.0.0.1:${port}`;
async function waitForServer(){const deadline=Date.now()+7000;while(Date.now()<deadline){try{const r=await fetch(`${base}/api/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error(`server failed to start: ${logs}`)}

 test('API persists confirmed records and reconciles cash movements', async t => {
  t.after(async()=>{child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,1000))]);fs.rmSync(dir,{recursive:true,force:true});});
  await waitForServer();
  let response=await fetch(`${base}/api/shop`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'API Test Shop',opening_cash_minor:100000})});
  assert.equal(response.status,200);
  const date='2026-10-30';
  response=await fetch(`${base}/api/transactions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'sale',description:'Cash sale',amount_minor:30000,currency:'KES',payment_method:'cash',cash_received_minor:30000,cash_paid_minor:0,credit_amount_minor:0,business_date:date,source:'manual'})});
  assert.equal(response.status,201);
  response=await fetch(`${base}/api/transactions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'expense',description:'Transport',amount_minor:5000,currency:'KES',payment_method:'cash',cash_received_minor:0,cash_paid_minor:5000,credit_amount_minor:0,business_date:date,source:'manual'})});
  assert.equal(response.status,201);
  response=await fetch(`${base}/api/reconcile/position?date=${date}`);const position=await response.json();
  assert.equal(position.expected_cash_minor,125000);
  response=await fetch(`${base}/api/reconcile`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date,counted_cash_minor:120000,notes:'test discrepancy'})});
  const result=await response.json();assert.equal(response.status,201);assert.equal(result.difference_minor,-5000);
  response=await fetch(`${base}/api/summary?date=${date}`);const summary=await response.json();assert.equal(summary.salesMinor,30000);assert.equal(summary.expensesMinor,5000);assert.equal(summary.cashInMinor,30000);assert.equal(summary.cashOutMinor,5000);
 });
