# DukaSauti — Product Delivery Roadmap

This document outlines the architectural development phases, completed milestones, and engineering deliverables for the DukaSauti offline-first retail operations desk.

---

## Phase 1: Foundation and Infrastructure

* [x] **Node.js 22 LTS Engine:** Native `node:sqlite` DatabaseSync integration eliminating binary compilation issues and external native database drivers.
* [x] **Ordered Schema Migration Pipeline:** Version-controlled database migrations tracked via the `schema_migrations` table for reproducible schema lifecycle management.
* [x] **Integer Minor Unit Precision:** Universal enforcement of integer minor units (KES cents) across all schema definitions and domain arithmetic to prevent floating-point rounding errors.
* [x] **Network Security Boundary:** Strict loopback interface binding (`127.0.0.1`) and context-isolated Electron desktop shell protecting commercial data from unauthorized network exposure.
* [x] **Offline Machine Intelligence Adapter:** Local QVAC inference adapter and automated verification test script for on-device natural language understanding.

---

## Phase 2: Core Bookkeeping and Ledger System

* [x] **Shop Configuration and Profile:** Management of business trading name, default operating currency (KES), timezone (Africa/Nairobi), and opening drawer float.
* [x] **Sauti Natural Language Transaction Entry:** Conversational note interpretation in English and Kiswahili for rapid recording of sales, expenses, and debt repayments.
* [x] **Draft Review and Operator Confirmation Workflow:** Human-in-the-loop review mechanism requiring explicit operator approval before committing financial entries.
* [x] **Operational Business Ledger:** Chronological transaction log supporting date range filtering, category tagging, full-text search, and transaction reversals.
* [x] **Daily Activity Reporting:** Real-time metrics tracking gross sales, cash receipts, overhead expenditures, and active financial positions.
* [x] **RFC-4180 CSV Data Export:** Standardized tabular export formatted for external accounting packages and spreadsheet analysis.

---

## Phase 3: Retail Point of Sale and Business Operations

* [x] **Multi-Item POS Checkout Workstation:** Fast product discovery, category filtering, interactive shopping cart, and sub-150ms hardware barcode scanner integration.
* [x] **Split-Tender Payment Processing:** Allocation of retail checkout balances across Cash, M-Pesa, Bank Transfer, and Customer Credit (deni).
* [x] **Perpetual Inventory and Stock Control:** Catalog management with units of measure, purchase cost tracking, selling price settings, and low-stock reorder alerts.
* [x] **Customer Credit (Deni) Subledger:** Customer directory with positive credit limit enforcement, debt allocation at checkout, and repayments.
* [x] **Supplier Directory and Accounts Payable:** Inbound supplier invoice tracking, inventory quantity incrementing with weighted-average cost recalculation, and partial bill settlements.
* [x] **Inventory Valuation and COGS Accounting:** Real-time computation of Cost of Goods Sold and Gross Profit on every transaction.
* [x] **Cash Drawer Reconciliation (Shift Close):** Shift float accounting tracking opening float, cash sales, cash repayments, cash expenses, and supplier cash disbursements with real-time variance detection.

---

## Phase 4: Advanced Kenyan Retail Operations

* [x] **Safaricom M-Pesa Statement Reconciler:** Automated parsing of raw Safaricom confirmation texts (Till, Paybill, Pochi la Biashara) with automatic matching to sales records.
* [x] **Thermal POS Receipt Generator:** Formatted monospace text receipts for standard 58mm and 80mm roll printers with browser print support.
* [x] **Bilingual User Interface:** Complete localization toggle between English and Kiswahili across all user interface modules.
* [x] **Staff Access Control and Security:** Multi-attendant authorization with Owner and Cashier roles secured by 4-digit SHA-256 hashed PINs.
* [x] **Speech-to-Text Voice Recording:** Microphone-based voice transaction capture using the Web Speech API supporting Swahili (sw-KE) and English (en-KE).
* [x] **Printable Customer and Supplier Account Statements:** Generation of official, printable account statements with itemized histories and running balances.
* [x] **KRA Tax Compliance and eTIMS Invoicing:** 16 percent standard VAT calculation, net taxable sales segregation, and electronic invoice generation aligned with KRA eTIMS standards.
* [x] **Bulk Stock Conversion Utility:** Automated unpacking of wholesale inventory (crates, cartons, sacks) into retail sale pieces with proportional cost allocation.
* [x] **AES-256-GCM Encrypted Backup Engine:** Cryptographic backup generation using scrypt key derivation and tamper-proof transactional restore.
* [x] **Sample Retail Data Seeder:** One-click seeding of representative Kenyan retail catalogues, customer profiles, and supplier accounts for rapid deployment.

---

## Phase 5: Verification, Quality Assurance, and Packaging

* [x] **Comprehensive Automated Test Suite:** 21 automated unit, integration, and end-to-end tests validating accounting invariants, transactional integrity, and REST endpoints.
* [x] **End-to-End Workflow Verification:** Full lifecycle simulation covering POS sales, inventory decrements, customer credit, shift close, M-Pesa reconciliation, and backup restoration.
* [x] **Desktop Shell Packaging:** Linux desktop application configuration with isolated renderer sandboxing.
