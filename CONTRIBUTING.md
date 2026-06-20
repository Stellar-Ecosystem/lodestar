# Contributing to Lodestar

Thanks for helping improve Lodestar. This repository contains four independently validated areas: Soroban contracts, the Express backend, the Next.js frontend, and the standalone demo agent.

## Local prerequisites

- Node.js 22 or newer
- Rust stable with the `wasm32-unknown-unknown` target
- Stellar CLI
- A funded Stellar testnet key only when running deployment or live x402 flows

Do not commit private keys, seed phrases, API keys, `.env` files, or production credentials. Use the checked-in example environment files as templates.

## Validation commands

Run the checks that match the area you changed before opening a pull request.

### Contracts

```sh
rustup target add wasm32-unknown-unknown
cd contract
stellar contract build
cargo test

cd agents
stellar contract build
cargo test
```

### Backend

```sh
cd backend
npm install
find src scripts test -name "*.js" -print0 | xargs -0 -n 1 node --check
npm test
```

### Frontend

```sh
cd frontend
npm install
npx tsc --noEmit
npm test -- --runInBand
npm run build
```

### Agent

```sh
cd agent
npm install
node --check agent.js
```

## Continuous integration

The CI workflow runs on pushes to `main` and on pull requests. It checks:

- both Soroban contracts build and run their Rust tests
- backend JavaScript syntax and Vitest coverage
- frontend TypeScript, Jest tests, and Next.js build
- demo agent syntax
- contract ABI compatibility against the latest git tag when a release tag exists

The ABI compatibility job skips cleanly when the repository has no release tag yet. Once releases are tagged, breaking contract interface changes should include an explicit versioning or migration note in the pull request.

## Pull request checklist

- Keep changes scoped to one issue or one related improvement.
- Link the issue with `Closes #ISSUE_NUMBER` when the issue asks for it.
- Include the validation commands you ran, or explain why a check was not run.
- Add or update tests for changed behavior.
- Update docs when API routes, contract interfaces, environment variables, or operational steps change.
- Do not include wallet secrets, private keys, raw signatures, or production credentials in commits, logs, screenshots, or issue comments.

## Branch protection recommendation

For production branches, repository maintainers should require the CI jobs to pass before merge. Recommended required checks are:

- `Contract build and test (contract)`
- `Contract build and test (contract/agents)`
- `Backend tests`
- `Frontend typecheck and build`
- `Agent script smoke check`
- `Contract ABI compatibility check`

GitHub branch protection is a repository setting, so it cannot be enforced from a pull request alone.
