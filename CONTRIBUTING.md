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

The contract job also checks the exact registry and agents WASM artifacts against a
128 KiB (`131072` byte) ceiling. Pull requests include the current size and the
delta from the base commit in the job summary. Each run uploads the same values as
a JSON artifact for 90 days, making size changes visible over time.

To run the check locally after building both contracts:

```bash
node scripts/check-wasm-size.mjs \
  --current-registry contract/target/wasm32v1-none/release/lodestar_registry.wasm \
  --current-agents contract/agents/target/wasm32v1-none/release/lodestar_agents.wasm
```

Set `MAX_WASM_SIZE_BYTES` to test a different ceiling.

## Code style

- Rust: run `cargo fmt` before committing; `cargo fmt --all --check` runs in CI under the `contract-build` job
- JS/TS: follow the existing ESLint and TypeScript configuration in each package (JS lint CI steps are a planned follow-up)

## Submitting a pull request

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes and ensure all tests pass locally
3. Open a PR against `main` with a clear description of what changed and why
