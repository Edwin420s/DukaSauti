import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase, audit } from './db.js';
import { validateProposal, computeDailySummary, cashExpected } from './domain.js';
import { QvacService } from './qvac.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const db = openDatabase();
const qvac = new QvacService();
const port = Number(process.env.PORT || 4173);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function bodyJson(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Request body too large.'); }
  return raw ? JSON.parse(raw) : {};
}
function getShop() { return db.prepare('SELECT * FROM shops WHERE id=1').get(); }
function listTransactions({ date, status = 'confirmed', q = '' } = {}) {
  let sql = 'SELECT * FROM transactions WHERE 1=1'; const args = [];
  if (date) { sql += ' AND business_date=?'; args.push(date); }
  if (status !== 'all') { sql += ' AND status=?'; args.push(status); }
  if (q) { sql += ' AND (description LIKE ? OR notes LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY business_date DESC, created_at DESC';
  return db.prepare(sql).all(...args);
}
function openingCashForDate(date) {
  const prior = db.prepare('SELECT counted_cash_minor FROM cash_counts WHERE business_date < ? ORDER BY business_date DESC, created_at DESC LIMIT 1').get(date);
  return prior ? prior.counted_cash_minor : getShop().opening_cash_minor;
}
function cashFlowForDate(date) {
  const rows = db.prepare("SELECT * FROM transactions WHERE business_date=? AND status='confirmed'").all(date);
  let cashIn = 0, cashOut = 0;
  for (const t of rows) {
    cashIn += t.cash_received_minor || 0;
    if (t.type === 'customer_payment' && t.payment_method === 'cash') cashIn += t.amount_minor;
    if (t.type === 'cash_deposit' && t.payment_method === 'cash') cashIn += t.amount_minor;
    cashOut += t.cash_paid_minor || 0;
  }
  return { rows, cashIn, cashOut };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, app: 'DukaSauti', qvac: qvac.status(), runtime: process.version });
    if (req.method === 'GET' && url.pathname === '/api/shop') return send(res, 200, getShop());
    if (req.method === 'PUT' && url.pathname === '/api/shop') {
      const b = await bodyJson(req); const name = String(b.name || '').trim();
      if (!name || name.length > 120) return send(res, 400, { error: 'Shop name is required (max 120 characters).' });
      const opening = Number(b.opening_cash_minor ?? 0);
      if (!Number.isSafeInteger(opening) || opening < 0) return send(res, 400, { error: 'Opening cash must be a non-negative integer in minor units.' });
      db.prepare("UPDATE shops SET name=?, currency='KES', timezone='Africa/Nairobi', opening_cash_minor=?, updated_at=CURRENT_TIMESTAMP WHERE id=1").run(name, opening);
      audit(db, 'shop', '1', 'settings_updated', { name, opening_cash_minor: opening });
      return send(res, 200, getShop());
    }
    if (req.method === 'GET' && url.pathname === '/api/transactions') {
      return send(res, 200, listTransactions({ date: url.searchParams.get('date') || undefined, status: url.searchParams.get('status') || 'confirmed', q: url.searchParams.get('q') || '' }));
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/extract') {
      const b = await bodyJson(req); if (typeof b.note !== 'string' || !b.note.trim()) return send(res, 400, { error: 'Enter a business note.' });
      if (b.note.length > 5000) return send(res, 400, { error: 'Note is too long (maximum 5,000 characters).' });
      const result = await qvac.extract(b.note);
      result.events = result.events.map(e => validateProposal(e));
      result.events = result.events.map(e => ({ ...e, status: 'draft' }));
      return send(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/load') {
      await qvac.load(); return send(res, 200, qvac.status());
    }
    if (req.method === 'POST' && url.pathname === '/api/transactions') {
      const b = await bodyJson(req); const p = validateProposal(b);
      const id = randomUUID(); const sourceText = String(b.source_text || '').slice(0, 5000); const source = b.source === 'qvac-local' ? 'qvac-local' : 'manual';
      db.prepare(`INSERT INTO transactions(id,type,description,amount_minor,currency,payment_method,cash_received_minor,cash_paid_minor,credit_amount_minor,business_date,notes,source_text,source,status,confirmed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed',CURRENT_TIMESTAMP)`)
        .run(id,p.type,p.description,p.amount_minor,p.currency,p.payment_method,p.cash_received_minor,p.cash_paid_minor,p.credit_amount_minor,p.business_date,p.notes,sourceText,source);
      audit(db, 'transaction', id, 'confirmed', { source, type: p.type, amount_minor: p.amount_minor });
      return send(res, 201, db.prepare('SELECT * FROM transactions WHERE id=?').get(id));
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/transactions\/[^/]+\/reverse$/)) {
      const id = url.pathname.split('/')[3]; const existing = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
      if (!existing) return send(res, 404, { error: 'Transaction not found.' });
      if (existing.status !== 'confirmed') return send(res, 409, { error: 'Only confirmed transactions can be reversed.' });
      db.prepare("UPDATE transactions SET status='reversed', reversed_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      audit(db, 'transaction', id, 'reversed', { amount_minor: existing.amount_minor });
      return send(res, 200, { ok: true, id });
    }
    if (req.method === 'GET' && url.pathname === '/api/summary') {
      const date = url.searchParams.get('date') || new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
      const rows = db.prepare('SELECT * FROM transactions WHERE business_date=?').all(date);
      return send(res, 200, { date, ...computeDailySummary(rows), openingCashMinor: getShop().opening_cash_minor, transactionCountAllStatuses: rows.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/reconcile/position') {
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0,10);
      const { cashIn, cashOut } = cashFlowForDate(date);
      const opening = openingCashForDate(date);
      return send(res, 200, { date, opening_cash_minor: opening, cash_in_minor: cashIn, cash_out_minor: cashOut, expected_cash_minor: opening + cashIn - cashOut });
    }
    if (req.method === 'POST' && url.pathname === '/api/reconcile') {
      const b = await bodyJson(req); const date = String(b.date || new Date().toISOString().slice(0,10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: 'Date must use YYYY-MM-DD.' });
      const counted = Number(b.counted_cash_minor);
      if (!Number.isSafeInteger(counted) || counted < 0) return send(res, 400, { error: 'Counted cash must be a non-negative integer in minor units.' });
      const { cashIn, cashOut } = cashFlowForDate(date);
      const expected = cashExpected({ openingCashMinor: openingCashForDate(date), cashInflowsMinor: cashIn, cashOutflowsMinor: cashOut, withdrawalsMinor: 0 });
      const difference = counted - expected; const id = randomUUID();
      db.prepare('INSERT INTO cash_counts(id,business_date,counted_cash_minor,expected_cash_minor,difference_minor,notes) VALUES(?,?,?,?,?,?)').run(id,date,counted,expected,difference,String(b.notes || '').slice(0,1000));
      audit(db, 'cash_count', id, 'created', { date, counted, expected, difference });
      return send(res, 201, { id, date, counted_cash_minor: counted, expected_cash_minor: expected, difference_minor: difference, cash_in_minor: cashIn, cash_out_minor: cashOut });
    }
    if (req.method === 'GET' && url.pathname === '/api/reconcile') return send(res, 200, db.prepare('SELECT * FROM cash_counts ORDER BY created_at DESC LIMIT 100').all());
    if (req.method === 'GET' && url.pathname === '/api/export.csv') {
      const rows = db.prepare("SELECT * FROM transactions WHERE status='confirmed' ORDER BY business_date,created_at").all();
      const fields = ['id','business_date','type','description','amount_minor','currency','payment_method','cash_received_minor','cash_paid_minor','credit_amount_minor','notes','source','created_at'];
      const esc = v => `"${String(v ?? '').replaceAll('"','""')}"`;
      const csv = [fields.join(','), ...rows.map(r => fields.map(f => esc(r[f])).join(','))].join('\r\n');
      res.writeHead(200, { 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition':'attachment; filename="dukasauti-transactions.csv"', 'Cache-Control':'no-store' }); return res.end(csv);
    }
    if (req.method === 'GET' && url.pathname === '/api/audit') return send(res, 200, db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200').all());
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) return send(res, 404, { error: 'API route not found.' });
    const requested = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, '');
    const file = path.resolve(publicDir, requested);
    if (!file.startsWith(publicDir + path.sep) && file !== path.join(publicDir, 'index.html')) return send(res, 403, { error: 'Forbidden.' });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const ext = path.extname(file); const type = ({ '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml' })[ext] || 'application/octet-stream';
    return send(res, 200, fs.readFileSync(file), type);
  } catch (error) {
    const status = /not ready|not loaded/i.test(error.message) ? 503 : /JSON|valid|amount|unsupported|cannot|must|too long|enter/i.test(error.message) ? 400 : 500;
    return send(res, status, { error: error.message || 'Unexpected error.' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`DukaSauti running locally at http://127.0.0.1:${server.address().port}`));
export { server };
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { server.close(); await qvac.close().catch(()=>{}); db.close(); process.exit(0); });
