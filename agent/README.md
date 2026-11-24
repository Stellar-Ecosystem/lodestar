# Lodestar Agent

Autonomous x402 agent that discovers services, pays on Stellar testnet, and updates its on-chain credit score.

## Prerequisites

- Node.js ≥ 22
- A funded Stellar testnet account (secret key)
- Lodestar backend running with the registry contract deployed

## Setup

```sh
cp .env.example .env
# Edit .env and set AGENT_STELLAR_SECRET, STELLAR_RPC_URL, LODESTAR_API_URL
npm install
```

## Run

```sh
cd agent && node agent.js
```

Expected output when healthy:

```text
[2026-01-01 00:00:00.000 +0000] INFO  (index): Agent starting {"event":"agent_start","agentAddress":"G...","agentName":"LodestarAgent"}
[2026-01-01 00:00:00.150 +0000] INFO  (index): Already registered {"event":"agent_registered","agentAddress":"G...","score":100,"scoringEnabled":true}
[2026-01-01 00:00:00.160 +0000] INFO  (index): Task started {"event":"task_start","category":"weather","agentAddress":"G..."}
[2026-01-01 00:00:02.800 +0000] INFO  (index): Payment successful {"event":"payment_success","category":"weather","serviceId":1,"serviceName":"WeatherService","priceUsdc":"0.001","txHash":"abc123...","scoreBefore":100,"taskDurationMs":2640}
[2026-01-01 00:00:02.850 +0000] INFO  (index): Score updated {"event":"score_updated","agentAddress":"G...","scoreBefore":100,"scoreAfter":110}
[2026-01-01 00:00:02.900 +0000] INFO  (index): Agent run complete {"event":"agent_complete","agentAddress":"G...","totalTasks":1,"successCount":1,"failCount":0,"totalUsdcSpent":"0.001","finalScore":110,"scoreDelta":10,"runDurationMs":3800}
```

Common failures:

```text
Missing required env var: AGENT_STELLAR_SECRET
Invalid AGENT_STELLAR_SECRET: unable to parse secret key
Not registered — registering now
No services found for category {"event":"task_start","category":"weather","servicesFound":0}
No services meet minimum reputation threshold {"event":"task_start","category":"weather","servicesFound":0,"minReputation":50}
Endpoint inactive — no payment signed, skipping to next candidate {"event":"endpoint_inactive","category":"weather","serviceId":1,"serviceName":"WeatherService","priceUsdc":"0.001","httpStatus":503}
Payment failed — endpoint error {"event":"payment_failed","category":"weather","serviceId":1,"serviceName":"WeatherService","priceUsdc":"0.001","httpStatus":500}
Payment state unknown — signed payment sent but no response received {"event":"payment_unknown","category":"weather","serviceId":1,"serviceName":"WeatherService","priceUsdc":"0.001","idempotencyKey":"..."}
All candidate services exhausted {"event":"task_exhausted","category":"weather","servicesAttempted":2}
```

## Payment and retry safety

Each service selection goes through a two-phase x402 flow:

1. **Probe** — the endpoint is contacted without payment headers. If it returns anything other than `402 Payment Required` (or the connection fails), the service is treated as inactive, no payment is ever signed, and the agent moves on to the next candidate.
2. **Signed fetch** — only after a `402` is confirmed does the agent sign and submit the payment. If this second fetch throws (connection reset, timeout), the payment state is **unknown**: the transaction may or may not have reached the network.

An endpoint in the unknown state is excluded from further retries within the same run. The run summary records it under `unresolvedPayments` so an operator can verify on-chain status manually before restarting.

### Idempotency key

Every `POST /api/agents/:address/payment` call includes an `X-Idempotency-Key` header scoped to `{agentAddress}-svc{serviceId}-t{taskStartMs}`. The key is stable for the lifetime of a single task attempt, so if `recordOutcome` is called more than once for the same settled request (e.g. after a process restart that replays the run), the backend deduplicates it and no second on-chain record is written.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENT_STELLAR_SECRET` | Yes | — | Stellar secret key for the agent |
| `STELLAR_RPC_URL` | Yes | — | Horizon RPC URL |
| `LODESTAR_API_URL` | Yes | — | Base URL of the Lodestar backend |
| `LODESTAR_HMAC_SECRET` | No | `""` | HMAC secret for signing payment-record requests |
| `AGENT_NAME` | No | `LodestarAgent` | Display name |
| `AGENT_DESC` | No | `""` | Agent description |
| `AGENT_MAX_PER_TX` | No | `0.001` | Max USDC per transaction |
| `AGENT_MAX_PER_DAY` | No | `1.00` | Max USDC per day |
| `AGENT_ALLOWED_CATEGORIES` | No | `weather,search` | Comma-separated allowed categories |
| `AGENT_MIN_SERVICE_REPUTATION` | No | `0` | Minimum reputation to consider a service |
| `AGENT_MAX_SERVICE_RETRIES` | No | `3` | Max weighted retry attempts per task |
| `LOG_LEVEL` | No | `info` | pino log level |

## Event reference

| Event | Level | Meaning |
|-------|-------|---------|
| `agent_start` | info | Agent process started |
| `agent_registered` | info | Registration check complete |
| `task_start` | info | Task loop entered for a category |
| `service_selected` | info | A candidate service was chosen for this attempt |
| `spend_check_passed` | info | Spending policy allows this service |
| `spend_check_blocked` | warn | Spending policy blocked this service; moving to next candidate |
| `endpoint_inactive` | warn | Probe returned non-402 or threw; **no payment was signed**; moving to next candidate |
| `payment_unknown` | error | Probe returned 402, payment was signed, but signed fetch threw; this service is excluded from further retries in this run |
| `payment_failed` | error | Signed fetch returned a non-2xx; payment was settled but service returned an error |
| `payment_success` | info | Signed fetch returned 2xx; payment confirmed |
| `score_updated` | info | Backend confirmed the new credit score |
| `task_exhausted` | error | All candidates were tried (or excluded) without a successful outcome |
| `agent_complete` | info | All tasks finished; run summary follows |