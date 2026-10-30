# DukaSauti — Shopkeeper's Desk and Point of Sale

DukaSauti is an offline-first operating desk and point-of-sale (POS) workstation designed for retail enterprises, minimarts, kiosks, agrovets, and pharmacies operating in Kenya.

The platform unifies multi-item retail checkout, inventory stock management, customer credit (deni) subledgers, supplier bill tracking, Safaricom M-Pesa statement reconciliation, double-entry general ledger accounting, and end-of-day cash drawer reconciliation into an integrated Linux desktop workstation. DukaSauti operates entirely on local hardware with zero external cloud dependencies.

> Core Operating Principle: AI interprets. Business logic verifies. The shopkeeper decides.

---

## System Capabilities

### 1. Multi-Item Point of Sale (POS) Checkout
* Fast product catalog search by product name, category, or barcode/SKU scanner.
* Hardware barcode scanner support with sub-150ms buffer capture.
* Real-time shopping cart with quantity adjustments and instantaneous stock availability validation.
* Split-tender payment processing across Cash, M-Pesa, Bank Transfer, and Customer Credit (deni).
* Automatic stock decrementing and immutable stock movement logging.
* Formatted 58mm and 80mm thermal receipt printing via standard browser print services.

### 2. End-of-Day Cash Drawer Reconciliation (Shift Close)
* Accurate shift float accounting:
  Opening Float + Cash Sales + Customer Cash Repayments - Cash Expenses - Supplier Cash Disbursements = Expected Cash in Counter.
* Real-time variance detection comparing physical counted cash against computed drawer expectations.
* Shift closure audit recording with discrepancy notes and permanent shift ledger archiving.

### 3. Safaricom M-Pesa Statement Reconciler and Parser
* Ingests raw Safaricom confirmation SMS texts (Till, Paybill, Pochi la Biashara) and statement lines.
* Automated extraction engine identifies M-Pesa transaction reference code, transaction direction, KES minor units, sender or recipient details, customer phone number, and timestamp.
* Direct matching engine links received mobile payments against open sales records or unallocated customer deposits.

### 4. Inventory Valuation and Cost of Goods Sold (COGS)
* Perpetual inventory tracking supporting units of measure, reorder thresholds, and active stock levels.
* Weighted-average cost recalculation upon recording supplier restocking invoices.
* Real-time computation of Cost of Goods Sold (COGS) on every multi-item transaction.
* Financial reporting tracks:
  * Gross Sales Revenue
  * Cost of Goods Sold (COGS)
  * Gross Profit (Gross Sales minus COGS)
  * Operating Expenses
  * Net Operating Profit (Gross Profit minus Expenses)
  * Total Inventory Asset Valuation

### 5. Double-Entry General Ledger and Automatic Journals
* Pre-configured Kenyan retail Chart of Accounts:
  * 1000 Cash on Hand
  * 1010 M-Pesa Account
  * 1020 Bank Account
  * 1100 Accounts Receivable (Customer Credit)
  * 1200 Inventory Asset
  * 2000 Accounts Payable (Supplier Invoices)
  * 3000 Owner Equity / Capital
  * 4000 Sales Revenue
  * 5000 Cost of Goods Sold
  * 6000-6090 Operating Overheads (Rent, Transport, Utilities, Wages)
* Automatic balanced journal posting on all confirmed sales, inventory purchases, customer repayments, and supplier payments.
* Manual journal creation interface requiring strict total debit equals total credit balance.

### 6. Natural Language and Voice Bookkeeping (Sauti Entry)
* Rapid transaction capture through plain language text notes in English and Kiswahili.
* Integrated Web Speech API capturing spoken transactions in Swahili (sw-KE) and English (en-KE).
* Local QVAC inference adapter parses colloquial expressions into structured financial records.
* Mandatory human-in-the-loop draft review before any financial commitment.

### 7. Customer Credit (Deni) and Supplier Accounts Payable
* Customer ledger tracks individual balances, credit limits, transaction histories, and repayments.
* Supplier directory tracks incoming bills, payment terms, due dates, and settlement disbursements.
* Printable formal statement generation for customer accounts and supplier reconciliation.

### 8. Tax Breakdown and eTIMS Compliance
* Automated standard 16 percent Value Added Tax (VAT) calculation for taxable sales.
* Segregated reporting for Net Taxable Sales, VAT Collected, and Gross Amount.
* Standardized electronic invoice generation aligned with Kenya Revenue Authority (KRA) eTIMS parameters.

### 9. Bulk Inventory Unpacking
* Converts wholesale bulk stock (crates, cartons, sacks) into retail sale units (bottles, packets, pieces).
* Automatically maintains cost basis proportionality across bulk reductions and piece increments.

### 10. Staff Access Control and Security
* Dual-role staff hierarchy: Owner and Counter Attendant.
* 4-digit PIN lock utilizing SHA-256 cryptographic hashing to safeguard drawer positions, financial reports, and system settings.

### 11. Cryptographic Backup and Safe Restoration
* Full database JSON backup export.
* AES-256-GCM encrypted backup with PBKDF2/scrypt key derivation using a personal passphrase.
* Transactional database restoration engine validating foreign keys and schema integrity before commitment.

---

## System Architecture and Engineering Principles

1. **Integer Minor Unit Currency (KES Cents):** All monetary values are strictly represented and calculated as integer minor units (1 KES = 100 minor units). Floating-point values are never used in database columns or domain arithmetic.
2. **Transactional Atomicity:** All multi-entity modifications execute inside SQLite `BEGIN IMMEDIATE` transactions, ensuring consistent state across inventory, ledger lines, and credit tables.
3. **Loopback Binding Security:** The internal HTTP backend binds exclusively to `127.0.0.1`, guaranteeing that network sockets remain inaccessible from external interfaces.
4. **Offline Autonomy:** Designed without third-party cloud runtime dependencies. All business logic, storage, and natural language interpretation run locally.

---

## Getting Started

### System Prerequisites
* Operating System: Linux (x86_64 or arm64)
* Runtime: Node.js v22.14.0 or later (Node 22 LTS with native `node:sqlite`)
* Package Manager: npm 10.9 or later

### Installation and Verification

```bash
# Navigate to the project root
cd DukaSauti

# Perform static syntax validation and run the test suite
npm run check

# Launch the local HTTP service
npm start
```

Access the application in your browser at:
`http://127.0.0.1:3000` (or `http://127.0.0.1:4173` if configured via custom PORT)

### Launching the Desktop Shell

```bash
npm run desktop
```

### Running Offline AI Proof

```bash
npm run qvac:proof
```

---

## API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/health` | GET | Returns system operational status, database status, and node runtime version. |
| `/api/shop` | GET, PUT | Retrieves or updates business identity, currency, and opening cash float. |
| `/api/products` | GET, POST | Lists products or creates a new catalog item with cost and selling prices. |
| `/api/sales` | POST | Executes multi-item POS checkout with split-tender allocation and stock decrement. |
| `/api/transactions` | GET, POST | Queries business transactions or logs a draft bookkeeping note. |
| `/api/transactions/:id/confirm` | POST | Confirms a draft transaction and commits double-entry journal entries. |
| `/api/transactions/:id/receipt` | GET | Formats a monospace thermal receipt for the specified transaction. |
| `/api/shifts/position` | GET | Calculates current drawer position, float, cash inflows, and expected cash. |
| `/api/shifts/close` | POST | Records physical counted cash, detects variances, and archives shift. |
| `/api/customers` | GET, POST | Manages customer profiles, debt balances, and credit limits. |
| `/api/customers/:id/statement` | GET | Generates a printable account ledger statement for a customer. |
| `/api/suppliers` | GET, POST | Manages supplier profiles and payment records. |
| `/api/suppliers/bills` | GET, POST | Queries or logs supplier purchase bills with optional inventory restock. |
| `/api/suppliers/bills/:id/payment` | POST | Records partial or full settlement payment against an open supplier bill. |
| `/api/mpesa/parse` | POST | Parses raw Safaricom M-Pesa SMS text into structured transaction fields. |
| `/api/mpesa/import` | POST | Ingests parsed M-Pesa records into the local reconciliation table. |
| `/api/mpesa/:id/match` | POST | Links an imported M-Pesa payment to a recorded sale or customer debt. |
| `/api/tax/summary` | GET | Computes 16 percent standard VAT totals, taxable turnover, and collected tax. |
| `/api/tax/etims-invoice` | POST | Generates an electronic tax invoice compliant with KRA eTIMS structure. |
| `/api/units/unpack` | POST | Unpacks bulk inventory units into retail pieces with proportional cost allocation. |
| `/api/backup/export` | GET | Exports unencrypted database tables in JSON format. |
| `/api/backup/export-encrypted` | POST | Generates AES-256-GCM encrypted backup package with passphrase. |
| `/api/backup/restore` | POST | Restores system state from JSON or decrypted backup payload. |
| `/api/demo/seed` | POST | Populates workspace with representative Kenyan retail catalogue and ledger data. |
| `/api/export.csv` | GET | Downloads RFC-4180 compliant CSV export of business transactions. |

---

## Quality Assurance and Testing

The automated test suite runs through Node's native test runner (`node:test`) and verifies all operational workflows and domain calculations:

```bash
npm test
```

Verification covers:
* Database schema migration ordering and integrity.
* Strict minor unit currency representation.
* Split payment allocation and credit limit enforcement.
* POS sale stock decrement and COGS journal posting.
* Supplier bill processing and inventory restock valuation.
* Cash shift float reconciliation and variance identification.
* Safaricom M-Pesa SMS parsing and reconciliation matching.
* AES-256-GCM backup encryption, decryption, and transactional restoration.
* KRA 16 percent VAT breakdown and eTIMS invoice generation.
* Comprehensive End-to-End integration simulating full shop workflow.

---

## License

Proprietary enterprise software developed for Kenyan retail enterprises. All rights reserved.
