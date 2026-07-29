# Contributing to Lodestar

## Prerequisites

- Node.js ≥ 22
- Rust (stable) with `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`
- Stellar CLI: `cargo install --locked stellar-cli --features opt`

## Running with Docker

Docker Desktop (or Docker Engine with the Compose plugin) is the only prerequisite
for the web application stack. From the repository root, run:

```bash
docker compose up --build
```

The frontend is available at http://localhost:3000 and the backend at
http://localhost:3001. The default values let the containers start for UI and API
development; they do not grant access to a Stellar account or deployed contracts.

To work against your own testnet deployment, create a root `.env` file and set the
backend variables from `backend/.env.example` (for example `CONTRACT_ID`,
`SERVER_STELLAR_ADDRESS`, and `SERVER_STELLAR_SECRET`). Docker Compose reads this
file automatically and passes those values to the backend. Do not commit it.

Stop the stack with `docker compose down`. Both images use multi-stage builds and
run as the unprivileged `node` user.

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

## Submitting a pull request

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Make your changes and ensure all tests pass locally
3. Open a PR against `main` with a clear description of what changed and why
