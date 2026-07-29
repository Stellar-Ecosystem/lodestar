# Contributing to Lodestar

## Prerequisites

- Node.js ≥ 22
- Rust (stable) with `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`
- Stellar CLI: `cargo install --locked stellar-cli --features opt`

## Running tests locally

Each component has its own test command. Run them from the repo root:

```bash
# Soroban contracts
cd contract && cargo test
cd contract/agents && cargo test

# Backend (vitest)
cd backend && npm ci && npm test

# Frontend (jest + tsc)
cd frontend && npm ci && npx tsc --noEmit && npm test

# Agent (vitest)
cd agent && npm ci && npm test
```

## Building the contracts

```bash
cd contract && stellar contract build
cd contract/agents && stellar contract build
```

## CI

All of the above run automatically on every PR and push to `main` via GitHub Actions (`.github/workflows/ci.yml`). Branch protection requiring all jobs to pass before merge is a planned follow-up.

## Code style

- Rust: run `cargo fmt` before committing; `cargo fmt --all --check` runs in CI under the `contract-build` job
- JS/TS: follow the existing ESLint and TypeScript configuration in each package (JS lint CI steps are a planned follow-up)

## Dead-letter queue

Permanently failed on-chain submissions (e.g. txBAD_SEQ after exhausting retries) are captured in an in-memory dead-letter queue. Operators can inspect and clear them via admin endpoints.

```bash
# List all dead-letter entries (requires X-Admin-Key header)
curl -H "X-Admin-Key: <your-admin-key>" http://localhost:3001/api/admin/dead-letter

# Clear the dead-letter queue after resolving issues
curl -X POST -H "X-Admin-Key: <your-admin-key>" http://localhost:3001/api/admin/dead-letter/clear
```

**Replay path:** Each dead-letter entry contains `operation` (the contract function name), `error` (the failure message), `code` (the error code), `type` (the error class name), and `timestamp`. To replay:
1. Inspect the entry to identify the root cause (e.g. `txBAD_SEQ` may indicate a sequence-number desync)
2. Fix the underlying issue (e.g. restart the server to re-fetch the account sequence)
3. Re-trigger the operation through its normal API endpoint or seed script

The dead-letter queue is bounded to 100 entries; oldest entries are evicted when the limit is reached.

## Submitting a pull request

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes and ensure all tests pass locally
3. Open a PR against `main` with a clear description of what changed and why
