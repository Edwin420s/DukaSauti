# Architecture decisions

## Scope
The first release is a local single-shop application. It is not yet a full accounting package or multi-user product.

## Trust boundaries
1. The model returns an untrusted proposal.
2. The application validates the proposal against allow-listed types, currency, integer amounts and payment allocation rules.
3. The owner reviews and explicitly confirms the proposal.
4. The domain layer calculates totals from stored confirmed records.
5. SQLite persists records and audit events.

## Money
Store KES values as integer minor units. Never use floating point for persisted amounts. Do not treat a stock purchase as operating expense automatically. Do not count credit sales as cash received.

## Offline requirement
QVAC is expected to run locally. Model download/initial setup may require connectivity; inference must be tested after the model is cached and the network is disconnected. The app's manual-entry path is independent of QVAC availability.

## Known gaps
- QVAC runtime and model inference must be verified on a supported machine.
- Current schema is MVP-level and needs versioned migrations before broader use.
- No full double-entry journal, inventory valuation, customer/supplier subledgers, staff access control, sync or tax support yet.
- No backup/restore interface yet.
