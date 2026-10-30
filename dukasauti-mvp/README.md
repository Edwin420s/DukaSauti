# DukaSauti

Offline-first shop record assistant for Kenyan microbusinesses. The product principle is: **AI interprets. Business logic verifies. The owner decides.**

## Current implementation status

This repository is an early working MVP, not the complete product vision. Implemented: local Node HTTP app, SQLite persistence, shop settings, manual transaction entry, confirmed ledger, local CSV export, basic daily totals, cash count reconciliation, reversal/audit events, and a QVAC SDK adapter/proof script. Not yet implemented: product catalogue, stock movements, supplier/customer accounts, complete double-entry accounting, staff roles, multi-device sync, speech input, tax reports, and packaged desktop installer.

**QVAC inference has not been verified in this environment.** The official QVAC v0.22 documentation currently requires a newer Node.js runtime than the available Node v22.16.0 here. Install a supported runtime, install dependencies, load the model while online, then run the proof script again with the network disconnected. Do not submit a claim of offline inference until that proof passes.

## Requirements

- Node.js `>=22.21.0` (or a supported newer release; check current QVAC requirements)
- npm 10.9+
- Linux x64/arm64 supported by QVAC; sufficient RAM and disk for the selected model

## Run in local browser mode

```bash
npm install
npm start
```

Open `http://127.0.0.1:4173`. The server binds only to loopback. SQLite data is created in `data/dukasauti.sqlite`.

## Desktop shell

The repository includes an Electron shell for Linux desktop use. Install dependencies and run `npm run desktop`. The shell stores the database in Electron's user-data directory. A distributable AppImage can be attempted with `npm run build:desktop`. Packaging and QVAC compatibility must be verified on the target machine; they are not yet release-validated.

On first run, set the shop name and opening cash. Manual transaction entry works without QVAC. The AI button remains unavailable until the QVAC model is loaded; the app does not pretend that a rule-based parser is AI.

## QVAC proof (must be run on a supported Node version)

```bash
npm install
npm run qvac:proof
```

The first run loads/downloads the model. After the model is cached, disconnect the internet and run `npm run qvac:proof` again. A successful result must print `QVAC_INFERENCE_PROOF=PASS` while offline. Record the device, OS, Node version, SDK version and model details in the submission.

The proof script uses QVAC's documented `loadModel`, `completion`, and `unloadModel` API with `LLAMA_3_2_1B_INST_Q4_0`. Model size and hardware compatibility must be checked on the actual target machine.

## Tests

```bash
npm test
npm run check
```

The tests cover amount parsing, validation, cash reconciliation, confirmed-only summary calculations and SQLite/audit persistence. The Node runtime in this development environment emits an experimental warning for `node:sqlite`; verify this on the supported release before packaging.

## Data safety notes

- Money is stored in integer minor units (KES cents).
- Drafts are not saved to the ledger by the current UI; confirmed transactions are persisted only after explicit user action.
- Reversal marks the original record as reversed and writes an audit event; it is not yet a complete double-entry reversal journal.
- Current cash reconciliation supports cash amounts captured by the MVP. Mixed-payment allocation, mobile-money reconciliation and full accounting require further work.
- Back up `data/dukasauti.sqlite` only when the app is stopped, or use a SQLite-aware backup tool. Backup/restore UI is not implemented yet.
- This early MVP has no authentication; keep it on a trusted local machine. It binds to `127.0.0.1` and should not be exposed to a LAN or public network.

## Architecture

- `src/server.js` — loopback HTTP server and API
- `src/db.js` — SQLite schema and audit helper
- `src/domain.js` — deterministic validation and money calculations
- `src/qvac.js` — local QVAC model adapter
- `scripts/qvac-proof.js` — offline inference proof
- `public/` — responsive UI
- `tests/` — domain and SQLite tests

## AI Yako submission checklist

- [ ] QVAC proof passes with internet disconnected
- [ ] Record exact device and OS, supported Node version, SDK version and model
- [ ] Capture the working offline flow on video
- [ ] Repository has setup instructions and clear disclosure of implemented vs planned features
- [ ] Verify all repository/video links are accessible to judges
- [ ] Submit the Build on DoraHacks (Luma registration is not a submission)
