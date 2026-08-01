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
http://localhost:3001. Ports are bound to `127.0.0.1` only. The default values let
the containers start for UI and API development; they do not grant access to a
Stellar account or deployed contracts.

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

- We use Husky and `lint-staged` to automatically run Prettier, ESLint, and `cargo fmt` on staged files before every commit.
- In an emergency, you can skip these hooks by passing `--no-verify` to your git commit command: `git commit --no-verify -m "..."`.
- Rust: `cargo fmt --all --check` runs in CI under the `contract-build` job
- JS/TS: follow the existing ESLint and TypeScript configuration in each package (JS lint CI steps are a planned follow-up)

## Dead-letter queue

Permanently failed on-chain submissions (e.g. txBAD_SEQ after exhausting retries) are captured in an in-memory dead-letter queue. Operators can inspect and clear them via admin endpoints.

`X-Admin-Key` is not an arbitrary key — it is the hex HMAC-SHA256 digest of the request body, keyed with `SERVER_STELLAR_SECRET`. Bodyless requests (both endpoints below) are signed over the canonical empty object `{}`:

```bash
# Compute the header for bodyless requests once:
ADMIN_KEY=$(printf '{}' | openssl dgst -sha256 -hmac "$SERVER_STELLAR_SECRET" | awk '{print $NF}')

# List all dead-letter entries
# Note: the port may differ if you set PORT in your .env file; the default is 3001
curl -H "X-Admin-Key: $ADMIN_KEY" http://localhost:${PORT:-3001}/api/admin/dead-letter

# Clear the dead-letter queue after resolving issues
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" http://localhost:${PORT:-3001}/api/admin/dead-letter/clear
```

**Replay path:** Each dead-letter entry contains `operation` (the contract function name), `hash` (the failed transaction hash, or `null` when the error carried none), `error` (the failure message), `code` (the error code), `type` (the error class name), and `timestamp`. To replay:
1. Inspect the entry to identify the root cause (e.g. `txBAD_SEQ` may indicate a sequence-number desync)
2. Fix the underlying issue (e.g. restart the server to re-fetch the account sequence)
3. Re-trigger the operation through its normal API endpoint or seed script

The dead-letter queue is bounded to 100 entries; oldest entries are evicted when the limit is reached.
## Branch naming

Use short-lived branches created from `main` with a clear prefix:

- `feat/` for new user-facing functionality
- `fix/` for bug fixes
- `docs/` for documentation-only changes
- `chore/` for maintenance or tooling updates
- `refactor/` for internal code cleanup

Use lowercase, hyphen-separated names such as `feat/add-agent-search`.

## Commit conventions

Write commits as concise, descriptive messages in the imperative mood. The preferred format is:

```text
type(scope): summary
```

Examples:

- `feat: add registry filtering`
- `fix(backend): handle empty agent list`
- `docs: clarify contribution workflow`

Keep the first line short and use the commit body when more context is helpful.

## Claiming an issue

Before starting work on an issue:

1. Read the issue carefully and confirm the scope.
2. Leave a comment saying you are taking it and, when helpful, outline your approach.
3. If the issue is not already assigned, ask a maintainer to assign it to you before opening a PR.
4. If something is unclear, ask for clarification in the issue thread rather than guessing.

## Submitting a pull request

1. Fork the repo and create a branch that follows the naming conventions above.
2. Make your changes and ensure the relevant tests pass locally.
3. Update documentation when behavior, configuration, or contributor workflows change.
4. Open a PR against `main` with:
   - a short summary of the change
   - why the change was needed
   - the tests you ran
   - any relevant docs or screenshots

## Review expectations

We aim to provide an initial review within 3-5 business days for well-scoped PRs. Larger changes, draft PRs, or work that needs design discussion may take longer. If you do not receive feedback after about a week, leaving a polite follow-up comment is welcome.
