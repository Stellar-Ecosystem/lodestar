# Lodestar — Contract Deployment

This guide covers the deployment of the Lodestar Service Registry. For detailed
instructions on the Agents credit scoring contract, see
[contract/agents/DEPLOY.md](./agents/DEPLOY.md).

## Prerequisites

- Rust toolchain (stable)
- Stellar CLI

## 1. Install Stellar CLI

```sh
curl -fsSL https://raw.githubusercontent.com/stellar/stellar-cli/main/install.sh | sh
```

Or via cargo (slower but also works):
```sh
cargo install --locked stellar-cli
```

## 2. Install Rust WASM target

```sh
rustup target add wasm32-unknown-unknown
```

## 3. Generate and fund deployer key

```sh
stellar keys generate deployer --network testnet
stellar keys fund deployer --network testnet
```

## 4. Build the contracts

```sh
# Service registry
cd contract
stellar contract build

# Agent credit scoring
cd agents
stellar contract build
```

The compiled WASM files will be at:
- `contract/target/wasm32-unknown-unknown/release/lodestar_registry.wasm`
- `contract/agents/target/wasm32v1-none/release/lodestar_agents.wasm`

## 5. Deploy the agents contract first

The registry is wired to the agents contract **at deploy time** (next step), so
the agents contract must exist first. See [contract/agents/DEPLOY.md](./agents/DEPLOY.md)
for full details on the agents contract.

```sh
stellar contract deploy \
  --wasm contract/agents/target/wasm32v1-none/release/lodestar_agents.wasm \
  --source deployer \
  --network testnet \
  -- --admin <ADMIN_ADDRESS>
```

Copy the printed agent contract ID — referred to below as `<AGENTS_CONTRACT_ID>`.

## 6. Deploy the registry contract

Pass the agents contract ID as the registry's **constructor argument**. This is
the only place reputation-voting authorization is configured: the agents address
is fixed at deployment and can never be changed or hijacked by a later caller, so
there is no separate (front-runnable) `init` step.

```sh
stellar contract deploy \
  --wasm contract/target/wasm32-unknown-unknown/release/lodestar_registry.wasm \
  --source deployer \
  --network testnet \
  -- --agents_contract <AGENTS_CONTRACT_ID>
```

Copy the printed registry contract ID — referred to below as `<CONTRACT_ID>`.

**Record the deployment** in `contract/deployments.json` so the team has a
shared source of truth:

```sh
# Compute the WASM hash (also printed by `stellar contract install`)
sha256sum contract/target/wasm32-unknown-unknown/release/lodestar_registry.wasm

# Update deployments.json with the new values:
#   - contractId: the printed contract ID
#   - wasmHash:  the sha256sum output
#   - deployer:  your deployer public key
#   - deploymentLedger: the ledger number printed during deploy
#   - deployedAt: ISO timestamp (date -u +"%Y-%m-%dT%H:%M:%SZ")
```

The file is checked into version control so every contributor points at the
same deployment and can independently verify the WASM hash on-chain.

## 7. Point the agents contract at the registry

The agents contract verifies service providers against the registry, so link it
back (one-time):

```sh
stellar contract invoke \
  --id <AGENTS_CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- init --registry_contract <CONTRACT_ID>
```

## 8. Configure environment

Copy both contract IDs into your `.env` files:

```sh
# backend/.env
CONTRACT_ID=<registry contract id>
AGENTS_CONTRACT_ID=<agent contract id>

# frontend/.env.local
NEXT_PUBLIC_CONTRACT_ID=<registry contract id>
NEXT_PUBLIC_AGENT_CONTRACT_ID=<agent contract id>
```

The hosted backend casts reputation votes as a registered demo agent — by
default its own server key (`SERVER_STELLAR_ADDRESS`), which `npm run seed-agents`
registers as an agent. Set `NEXT_PUBLIC_DEMO_AGENT_ADDRESS` (frontend) to that
address. To let other pre-funded demo agents vote, add their secrets to
`DEMO_VOTER_SECRETS` (backend).

## Registry Events

The registry emits one event after each successful public service **mutation**.
The first two topic values are symbols; the third topic value is the service ID.

| Action | Topics | Data |
| --- | --- | --- |
| Register | `("registry", "registered", service_id)` | `(provider, name, description, endpoint, category, price_usdc, pay_to)` |
| Reputation update | `("registry", "reputation", service_id)` | `(caller, positive, reputation)` |
| Deactivate | `("registry", "deactivated", service_id)` | `(provider, name, category, reputation)` |
| Reactivate | `("registry", "reactivated", service_id)` | `(provider, name, category, reputation)` |

Indexers can use the action symbol in the second topic to distinguish events
and should treat the data tuple as the action-specific schema shown above.

### Why the payload is self-sufficient

A consumer that wants to know which services are listed would otherwise have to
poll `get_service` / `list_services_page` after every change. The lifecycle
payloads carry the fields that decide *where* a service appears, so a local
replica can be maintained from events alone:

- `provider` and `name` — identity and display, without a follow-up read.
- `category` — which category index the service belongs to. Registration adds the
  id to `ServiceIdsByCategory(category)`, deactivation removes it, and
  reactivation re-adds it, so a category-filtered listing cannot be tracked
  without this field.
- `reputation` — the only field besides `active` that can change after
  registration, so each lifecycle event carries the current value.

`description`, `endpoint`, `price_usdc`, and `pay_to` are immutable after
registration (there is no `update_service`), so they only appear in `registered`.
`active` is implied by the action symbol: `registered` and `reactivated` mean
`true`, `deactivated` means `false`.

> **Schema change:** `deactivated` and `reactivated` previously carried a bare
> `(provider)` tuple. Indexers built against the old shape must read the payload
> as the 4-tuple above.

### Read-only entrypoints emit no events

`get_service`, `list_services`, `list_services_page`, `list_categories`,
`get_service_count`, `get_reputation_bounds`, and `get_agents_contract` are
read-only and intentionally publish nothing. Soroban executes read-only calls
through `simulateTransaction`: the events from a simulation are returned to the
calling client but never written to a ledger, so no indexer can observe them and
emitting would only add cost for every caller. Consumers observe changes to the
listing through the four mutation events above.

## 9. Run seed script

```sh
cd backend
npm install
SEEDING_MODE=true node scripts/seed.js
```

This pre-populates the registry with demo services.

## Registry Error Codes

The registry contract returns typed `RegistryError` values for application-level
failures. These discriminants are stable API surface and must not be reordered:

| Numeric code | Variant | Backend code | Meaning |
| --- | --- | --- | --- |
| 1 | `InvalidName` | `INVALID_NAME` | Service name is outside the 3-64 character range. |
| 2 | `InvalidDescription` | `INVALID_DESCRIPTION` | Service description is outside the 10-256 character range. |
| 3 | `DuplicateActiveService` | `DUPLICATE_SERVICE` | The provider already has an active service with the same endpoint. |
| 4 | `ServiceNotFound` | `SERVICE_NOT_FOUND` | The requested service id does not exist. |
| 5 | `AgentsContractNotConfigured` | `AGENTS_CONTRACT_NOT_CONFIGURED` | Registry storage is missing the configured agents contract address. |
| 6 | `CallerNotRegisteredAgent` | `CALLER_NOT_REGISTERED_AGENT` | The reputation voter is not registered in the agents contract. |
| 7 | `ReputationVoteCooldown` | `REPUTATION_VOTE_COOLDOWN` | The same agent voted on the same service too recently. |
| 8 | `ProviderMismatch` | `PROVIDER_MISMATCH` | A non-provider attempted to deactivate the service. |
| 9 | `CategoryIndexNotFound` | `CATEGORY_INDEX_NOT_FOUND` | Registry storage is missing the service category index. |
| 10 | `InvalidEndpoint` | `INVALID_ENDPOINT` | Service endpoint is longer than 256 characters. |
| 11 | `InvalidCategory` | `INVALID_CATEGORY` | Service category is unsupported or outside the 1-32 character range. |

## 10. (Optional) Set demo agent secrets

Generate three funded testnet keypairs for richer seed data:

```sh
stellar keys generate new-agent --network testnet
stellar keys fund new-agent --network testnet
stellar keys generate established-agent --network testnet
stellar keys fund established-agent --network testnet
stellar keys generate trusted-agent --network testnet
stellar keys fund trusted-agent --network testnet
```

Add their secrets to `backend/.env`:

```sh
DEMO_AGENT_1_SECRET=<new-agent secret>
DEMO_AGENT_2_SECRET=<established-agent secret>
DEMO_AGENT_3_SECRET=<trusted-agent secret>
```

If omitted, the seed script generates ephemeral random keypairs.

## 11. Run agent seed script

```sh
cd backend && npm run seed-agents
```

This registers three demo agents (NewAgent ~110, EstablishedAgent ~600, TrustedAgent ~1000) and builds their payment histories on-chain.

## Registration Field Limits

The `register_service` function enforces the following field limits on-chain:

| Field | Min | Max | Notes |
|-------|-----|-----|-------|
| `name` | 3 | 64 | |
| `description` | 10 | 256 | |
| `endpoint` | — | 256 | |
| `category` | 1 | 32 | |

Submissions outside these limits are rejected with typed `RegistryError` values.
The same limits are enforced client-side in the RegisterForm and server-side
by the `POST /api/registry/prepare-register` route.

## Network Details

- Network: Stellar Testnet
- RPC URL: https://soroban-testnet.stellar.org
- Network Passphrase: `Test SDF Network ; September 2015`
- Explorer: https://stellar.expert/explorer/testnet
