# DukaSauti — Product Specification Document

## 1. Executive Summary

DukaSauti is an offline-first retail operations desk, point-of-sale (POS) workstation, and double-entry bookkeeping platform engineered for Kenyan retail enterprises, including general dukas, minimarts, kiosks, agrovets, and retail pharmacies.

The platform provides small and medium retail proprietors with the tools necessary to record multi-item retail sales, manage real-time inventory valuations, control customer debt (deni), administer supplier payables, reconcile Safaricom M-Pesa statements, compute accurate Cost of Goods Sold (COGS), and execute end-of-day cash drawer balancing—all without depending on continuous internet connectivity.

### Core Operating Tenet
> AI interprets. Business logic verifies. The shopkeeper decides.

All artificial intelligence and natural language processing facilities serve as draft generation assistants. Financial postings, inventory adjustments, and ledger commits strictly require deterministic business rule validation and explicit operator approval.

---

## 2. Fundamental System and Financial Invariants

1. **Integer Minor Unit Currency Representation:**
   * All monetary figures are stored, transmitted, and calculated strictly as integer minor units representing KES cents (1 KES = 100 minor units).
   * Floating-point calculations are strictly forbidden within the persistence and business logic layers to eliminate IEEE 754 rounding artifacts.
2. **Deterministic Transactional Atomicity:**
   * All compound operations involving multiple table writes (such as POS checkout affecting stock levels, customer balances, and journal entries) execute within SQLite `BEGIN IMMEDIATE` transactions.
   * If any precondition or constraint fails, the entire transaction rolls back cleanly.
3. **Inventory Non-Negativity:**
   * Products cannot have negative stock quantities. Sales transactions or manual stock adjustments requesting a quantity greater than available inventory are rejected by domain guards.
4. **Credit Limit Protection:**
   * Customer debt cannot exceed an established positive credit limit. Transactions attempting to charge credit beyond this threshold are disallowed.
5. **Double-Entry Equilibrium:**
   * Every journal entry consists of a minimum of two journal lines.
   * Total debits must equal total credits exactly before the journal entry is committed to the ledger.
6. **Local Host Boundary:**
   * The application core binds exclusively to the local loopback interface (`127.0.0.1`), ensuring total isolation from external network exposure.
   * The platform operates autonomously with zero cloud dependencies.

---

## 3. Detailed Functional Modules

### 3.1 Module 1: Dashboard (Today View)
The primary operational overview displaying business performance for the active trading day:
* **Gross Sales:** Cumulative confirmed sales revenue.
* **Cash Collections:** Total physical cash collected through sales and customer credit repayments.
* **M-Pesa Collections:** Total mobile money recorded through POS checkout and direct deposits.
* **Operating Expenses:** Cumulative overhead expenses recorded for the date.
* **Live Feed:** Chronological activity stream of confirmed transactions with reversal triggers.
* **Shift Indicator:** Visual status indicating whether the current cash drawer shift is open or reconciled.

### 3.2 Module 2: Point of Sale (POS) Checkout
An optimized counter checkout interface designed for rapid retail throughput:
* **Product Discovery:** Instant search across the product catalog by item name, category, or barcode/SKU.
* **Hardware Barcode Integration:** Sub-150ms buffer listener that captures hardware USB barcode scans and automatically increments the cart item.
* **Multi-Line Cart Management:** Add items, alter quantities, verify unit prices, and inspect line subtotals.
* **Split Tender Processing:** Allows payment across four settlement channels:
  * Cash Received (in minor units)
  * M-Pesa Received (in minor units)
  * Bank Transfer (in minor units)
  * Customer Credit (Deni allocated to a selected registered customer)
* **Inventory Deduction:** Atomically deducts sold quantities from active stock upon confirmation.
* **Thermal Receipt Formatting:** Generates clean 58mm and 80mm monospace thermal receipts with browser print integration (`window.print()`).

### 3.3 Module 3: Sauti Entry (Natural Language and Voice Capture)
A rapid transaction entry mechanism for owner-operators who prefer free-form inputs over multi-step forms:
* **Multilingual Text Note Parser:** Interprets notes written in conversational English, Kiswahili, or Sheng (e.g., "Sold 3 unga packets for 480 cash", "Ameleta 500 kwa deni").
* **Integrated Voice Recognition:** Employs the Web Speech API with dual dialect support: Swahili (`sw-KE`) and Kenyan English (`en-KE`).
* **Offline AI Adapter (QVAC):** Connects to on-device QVAC inference models or deterministic fallbacks to parse transaction type, amount, category, customer/supplier name, and payment method.
* **Human-in-the-Loop Confirmation:** Outputs a structured draft card showing proposed fields. The transaction is never committed until the shopkeeper clicks "Confirm and Post".

### 3.4 Module 4: Transaction Ledger and RFC-4180 CSV Export
The central operational transaction log:
* **Filtering and Search:** Query transactions by date, status (confirmed, draft, reversed), category, or keyword search.
* **Transaction Reversal:** Provides a clean reversal flow for erroneously entered records, creating countervailing double-entry journal entries.
* **RFC-4180 CSV Export:** Exports the ledger to compliant CSV files compatible with spreadsheet tools and external auditing workflows.

### 3.5 Module 5: Stock Control, Inventory Valuation, and Bulk Unpacking
Comprehensive inventory asset tracking:
* **Catalog Management:** SKU, barcode, title, category, unit of measure, cost price, selling price, and reorder levels.
* **Weighted-Average Costing:** Automatically recalculates unit cost basis whenever new stock is added through supplier bills.
* **Low-Stock Alerts:** Automatically flags items whose stock has dropped to or below the reorder threshold.
* **Total Inventory Valuation:** Continuously computes the aggregate cost value of on-hand inventory.
* **Bulk Unpacking Utility:** Converts wholesale packaging (such as a 24-bottle soda crate or a 50kg grain sack) into retail piece units. The total cost of the bulk unit is distributed proportionally to individual pieces.

### 3.6 Module 6: Customer Accounts and Credit (Deni) Subledger
Manages customer debt and credit arrangements:
* **Customer Directory:** Name, telephone number, address/notes, credit limit, and current debt balance.
* **Debt Allocation:** Seamlessly records debt during POS split tender or via Sauti credit transactions.
* **Debt Repayments:** Accepts debt payments via Cash, M-Pesa, or Bank, immediately reducing the customer's balance and posting to the general ledger.
* **Customer Account Statements:** Generates formal, printable ledger statements showing chronologically sorted purchases, payments, and running balances.

### 3.7 Module 7: Suppliers and Accounts Payable
Administers supplier commercial relationships:
* **Supplier Directory:** Contact details, supplier company name, and payment records.
* **Supplier Bills:** Records inbound delivery invoices with due dates and line-item notes. Offers automatic inventory quantity incrementing and cost-basis adjustment.
* **Bill Settlement:** Accepts partial or full invoice payments from Cash, M-Pesa, or Bank accounts, reducing Accounts Payable.
* **Supplier Statements:** Produces official transaction statements detailing deliveries, disbursements, and net balance due.

### 3.8 Module 8: Safaricom M-Pesa Statement Reconciler
Automates mobile money reconciliation:
* **SMS and Statement Ingestion:** Accepts raw Safaricom confirmation texts from Till numbers (Buy Goods), Paybills, and Pochi la Biashara accounts.
* **Field Extraction:** Accurately isolates M-Pesa reference code (e.g., `SJD8912KL3`), transaction direction, amount in KES cents, sender name, phone number, and timestamp.
* **Ledger Matching:** Reconciles unverified M-Pesa records against recorded POS sales, marking the M-Pesa transaction as verified.

### 3.9 Module 9: Financial Performance and Cost of Goods Sold (COGS)
Provides real-time visibility into actual operating profitability:
* **Recorded Gross Sales:** Total revenue earned from confirmed sales.
* **Cost of Goods Sold (COGS):** Total acquisition cost of products sold during the period.
* **Gross Profit:** Computed as Gross Sales minus COGS.
* **Operating Overheads:** Total categorized expenses (rent, electricity, transport, casual labor).
* **Net Operating Surplus / Profit:** Computed as Gross Profit minus Operating Overheads.

### 3.10 Module 10: General Ledger and Double-Entry Chart of Accounts
Complete double-entry accounting engine:
* **Kenyan Standard Chart of Accounts:**
  * Assets: 1000 Cash on Hand, 1010 M-Pesa Account, 1020 Bank Account, 1100 Accounts Receivable, 1200 Inventory Asset.
  * Liabilities: 2000 Accounts Payable.
  * Equity: 3000 Owner Capital / Retained Earnings.
  * Revenue: 4000 Sales Revenue.
  * Cost: 5000 Cost of Goods Sold.
  * Expenses: 6000 Rent, 6010 Utilities, 6020 Transport, 6030 Casual Labor, 6040 Licenses, 6090 Miscellaneous.
* **Automated Postings:** Standard operational workflows post balancing debits and credits automatically.
* **Manual Journals:** Allows verified manual double-entry journals for capital injection, depreciation, or manual asset adjustments.

### 3.11 Module 11: End-of-Day Shift Close and Cash Drawer Reconciliation
Enforces strict physical cash discipline inspired by retail cash management standards:
* **Expected Drawer Calculation:**
  Opening Counter Float + Cash Sales + Cash Debt Repayments - Cash Overheads - Supplier Cash Disbursements = Expected Cash in Drawer.
* **Physical Cash Count:** Operator enters the actual physical currency counted in the till.
* **Real-Time Variance Status:** Displays a clear status badge:
  * "Balanced" when physical count matches expected cash exactly.
  * "Over" or "Short" when a discrepancy is detected.
* **Shift Archival:** Persists shift record with timestamp, operator notes, expected amount, counted amount, and variance.

### 3.12 Module 12: Tax Compliance and KRA eTIMS Reporting
Facilitates compliance with the Kenya Revenue Authority (KRA):
* **16 Percent Standard VAT Computation:** Accurately decomposes gross sales into Net Taxable Amount and VAT Collected.
* **eTIMS Invoice Generator:** Produces standardized invoice payloads and printables containing business KRA PIN, buyer PIN, tax breakdown, and verification control numbers.

### 3.13 Module 13: Staff Access Control and Security
Protects commercial data in multi-attendant retail environments:
* **Role Separation:**
  * Owner: Full administrative rights, report access, shift configuration, and backup restoration.
  * Cashier / Counter Attendant: Access restricted to POS checkout, Sauti entry, and receipt printing.
* **4-Digit Cryptographic PIN:** Protects administrative views using SHA-256 password hashing.

### 3.14 Module 14: Cryptographic Backup and Safe Restoration
Guarantees business continuity against hardware failure:
* **Unencrypted JSON Snapshot:** Complete export of database tables in standard JSON format.
* **AES-256-GCM Encrypted Backups:** Derives a 256-bit encryption key using `scrypt` from a user passphrase, producing an authenticated, tamper-proof backup package.
* **Transactional Restore Engine:** Restores database contents inside an atomic transaction, validating schema versioning and re-enabling foreign key integrity checks.

---

## 4. Hardware Integration Specifications

1. **Thermal POS Printers:**
   * Interfaces: USB, Serial, or Loopback Network Printer.
   * Format: Standard 58mm (32 columns) and 80mm (48 columns) monospace font layouts.
   * Execution: Client-side print triggering via CSS print styles.
2. **Barcode Scanners:**
   * Device Interface: USB HID Keyboard emulation.
   * Capture Technique: High-speed keystroke listener buffering characters received within 150 milliseconds ending in an Enter keystroke.
3. **Microphone Audio Input:**
   * Audio Capture: Standard OS audio input through browser Web Speech API.
   * Locales: `sw-KE` (Kiswahili Kenya) and `en-KE` (English Kenya).

---

## 5. Non-Functional and Operational Requirements

* **Zero Cloud Dependency:** The software functions completely without internet connectivity.
* **Sub-50ms Transaction Latency:** Local SQLite execution ensures all operational queries complete in under 50 milliseconds.
* **Platform Support:** Linux Desktop (Debian, Ubuntu, Fedora, Arch) packaged as an Electron desktop application or system service.
* **Data Longevity:** WAL-mode SQLite persistence guarantees ACID properties even during abrupt power loss.
