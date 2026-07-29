# Agent Event Schema

This document defines the structured event names emitted by the Lodestar Agent and their field schemas. All events are logged via Pino and include an `event` field identifying the event type.

## Event Definitions

### `agent_start`
Emitted when the agent starts up.

**Fields:**
- `event` (string): `"agent_start"`
- `agentAddress` (string): Stellar public key of the agent
- `agentName` (string): Configured name of the agent (default: "LodestarAgent")

**Example:**
```json
{
  "event": "agent_start",
  "agentAddress": "GABC...",
  "agentName": "LodestarAgent"
}
```

---

### `agent_registered`
Emitted during agent registration check/registration. May be emitted multiple times with different field combinations depending on the registration outcome.

**Fields:**
- `event` (string): `"agent_registered"`
- `agentAddress` (string): Stellar public key of the agent
- `score` (number, optional): Current agent score (when already registered or after successful registration)
- `dailyLimitUsdc` (string, optional): Daily spending limit in USDC (when policy is available)
- `scoringEnabled` (boolean): Whether credit scoring is enabled for this agent
- `err` (any, optional): Error object if registration failed

**Example (already registered):**
```json
{
  "event": "agent_registered",
  "agentAddress": "GABC...",
  "score": 95,
  "dailyLimitUsdc": "1.00",
  "scoringEnabled": true
}
```

**Example (contract not deployed):**
```json
{
  "event": "agent_registered",
  "agentAddress": "GABC...",
  "scoringEnabled": false
}
```

**Example (registration failed):**
```json
{
  "event": "agent_registered",
  "agentAddress": "GABC...",
  "scoringEnabled": false,
  "err": { "message": "API error" }
}
```

---

### `task_start`
Emitted when a task begins. May be emitted with different field combinations depending on task state.

**Fields:**
- `event` (string): `"task_start"`
- `category` (string): Service category being queried (e.g., "weather", "search")
- `agentAddress` (string, optional): Stellar public key of the agent
- `servicesFound` (number, optional): Number of services found for the category (when error occurs)
- `minReputation` (number, optional): Minimum reputation threshold (when no services meet threshold)
- `serviceId` (number, optional): ID of selected service (when sending payment)
- `endpointUrl` (string, optional): Full endpoint URL being called (when sending payment)

**Example (normal start):**
```json
{
  "event": "task_start",
  "category": "weather",
  "agentAddress": "GABC..."
}
```

**Example (no services found):**
```json
{
  "event": "task_start",
  "category": "weather",
  "servicesFound": 0
}
```

**Example (no services meet reputation threshold):**
```json
{
  "event": "task_start",
  "category": "weather",
  "servicesFound": 5,
  "minReputation": 50
}
```

---

### `service_selected`
Emitted when a service is selected for a task attempt.

**Fields:**
- `event` (string): `"service_selected"`
- `category` (string): Service category
- `serviceId` (number): ID of the selected service
- `serviceName` (string): Name of the selected service
- `priceUsdc` (string): Price in USDC for this service
- `servicesFound` (number): Total number of services found for the category
- `attempt` (number): Attempt number (1-indexed)

**Example:**
```json
{
  "event": "service_selected",
  "category": "weather",
  "serviceId": 1,
  "serviceName": "WeatherService",
  "priceUsdc": "0.001",
  "servicesFound": 5,
  "attempt": 1
}
```

---

### `spend_check_passed`
Emitted when the spending policy check allows a payment.

**Fields:**
- `event` (string): `"spend_check_passed"`
- `category` (string): Service category
- `serviceId` (number): ID of the service
- `serviceName` (string): Name of the service
- `priceUsdc` (string): Price in USDC

**Example:**
```json
{
  "event": "spend_check_passed",
  "category": "weather",
  "serviceId": 1,
  "serviceName": "WeatherService",
  "priceUsdc": "0.001"
}
```

---

### `spend_check_blocked`
Emitted when the spending policy check blocks a payment.

**Fields:**
- `event` (string): `"spend_check_blocked"`
- `category` (string): Service category
- `serviceId` (number): ID of the service
- `serviceName` (string): Name of the service
- `priceUsdc` (string): Price in USDC
- `reason` (string): Human-readable reason for blocking (e.g., "Daily limit reached")

**Example:**
```json
{
  "event": "spend_check_blocked",
  "category": "weather",
  "serviceId": 1,
  "serviceName": "WeatherService",
  "priceUsdc": "0.001",
  "reason": "Daily limit reached"
}
```

---

### `payment_success`
Emitted when a payment succeeds and the service returns a successful response.

**Fields:**
- `event` (string): `"payment_success"`
- `category` (string): Service category
- `serviceId` (number): ID of the service
- `serviceName` (string): Name of the service
- `priceUsdc` (string): Price in USDC
- `txHash` (string): Stellar transaction hash (may be "(no hash)" if header missing)
- `scoreBefore` (number, optional): Agent score before this payment (when scoring enabled)
- `taskDurationMs` (number): Duration of the task in milliseconds

**Example:**
```json
{
  "event": "payment_success",
  "category": "weather",
  "serviceId": 1,
  "serviceName": "WeatherService",
  "priceUsdc": "0.001",
  "txHash": "abc123...",
  "scoreBefore": 100,
  "taskDurationMs": 1234
}
```

---

### `payment_failed`
Emitted when a payment fails. May be emitted with different field combinations depending on failure mode.

**Fields:**
- `event` (string): `"payment_failed"`
- `category` (string): Service category
- `serviceId` (number, optional): ID of the service (when specific service fails)
- `serviceName` (string, optional): Name of the service (when specific service fails)
- `priceUsdc` (string, optional): Price in USDC (when specific service fails)
- `httpStatus` (number, optional): HTTP status code (when endpoint returns non-2xx)
- `err` (Error, optional): Error object (when network error occurs)
- `servicesAttempted` (number, optional): Number of services attempted (when all candidates exhausted)
- `taskDurationMs` (number): Duration of the task in milliseconds

**Example (network error):**
```json
{
  "event": "payment_failed",
  "category": "weather",
  "serviceId": 1,
  "serviceName": "WeatherService",
  "priceUsdc": "0.001",
  "err": { "message": "Network error" },
  "taskDurationMs": 500
}
```

**Example (HTTP error):**
```json
{
  "event": "payment_failed",
  "category": "weather",
  "serviceId": 1,
  "serviceName": "WeatherService",
  "priceUsdc": "0.001",
  "httpStatus": 500,
  "taskDurationMs": 800
}
```

**Example (all services exhausted):**
```json
{
  "event": "payment_failed",
  "category": "weather",
  "servicesAttempted": 3,
  "taskDurationMs": 5000
}
```

---

### `score_updated`
Emitted when the agent's credit score is updated after a payment outcome.

**Fields:**
- `event` (string): `"score_updated"`
- `agentAddress` (string): Stellar public key of the agent
- `scoreBefore` (number): Score before the update
- `scoreAfter` (number): Score after the update

**Example:**
```json
{
  "event": "score_updated",
  "agentAddress": "GABC...",
  "scoreBefore": 100,
  "scoreAfter": 105
}
```

---

### `agent_complete`
Emitted when the agent completes its run (all tasks finished).

**Fields:**
- `event` (string): `"agent_complete"`
- `agentAddress` (string): Stellar public key of the agent
- `totalTasks` (number): Total number of tasks attempted
- `successCount` (number): Number of successful tasks
- `failCount` (number): Number of failed tasks
- `totalUsdcSpent` (string): Total USDC spent across all tasks (formatted as string)
- `finalScore` (number, optional): Final agent score (when scoring enabled)
- `scoreDelta` (number, optional): Change in score during the run (when scoring enabled)
- `runDurationMs` (number): Total duration of the agent run in milliseconds

**Example:**
```json
{
  "event": "agent_complete",
  "agentAddress": "GABC...",
  "totalTasks": 2,
  "successCount": 2,
  "failCount": 0,
  "totalUsdcSpent": "0.002000",
  "finalScore": 105,
  "scoreDelta": 5,
  "runDurationMs": 5000
}
```

---

## Sample Log Consumer

Here's a sample Node.js script that consumes agent logs and processes events:

```javascript
import pino from 'pino';
import { EVENT } from './agent.js';

// Create a pino instance that reads from a log file or stream
const logger = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Or read from an existing log file:
// const logStream = fs.createReadStream('./agent.log');
// const logger = pino(logStream);

// Process logs
logger.stream.on('data', (line) => {
  try {
    const parsed = JSON.parse(line);
    
    switch (parsed.event) {
      case EVENT.AGENT_START:
        console.log(`Agent ${parsed.agentName} started at ${parsed.agentAddress}`);
        break;
        
      case EVENT.PAYMENT_SUCCESS:
        console.log(`Payment successful: ${parsed.serviceName} (${parsed.priceUsdc} USDC)`);
        break;
        
      case EVENT.PAYMENT_FAILED:
        console.log(`Payment failed: ${parsed.serviceName} - ${parsed.httpStatus || parsed.err?.message || 'Unknown error'}`);
        break;
        
      case EVENT.AGENT_COMPLETE:
        console.log(`Agent run complete: ${parsed.successCount}/${parsed.totalTasks} tasks successful`);
        console.log(`Total spent: ${parsed.totalUsdcSpent} USDC`);
        if (parsed.scoreDelta !== null) {
          console.log(`Score change: ${parsed.scoreDelta > 0 ? '+' : ''}${parsed.scoreDelta}`);
        }
        break;
        
      default:
        // Handle other events as needed
        break;
    }
  } catch (err) {
    console.error('Failed to parse log line:', err);
  }
});
```

For a more advanced consumer, consider:
- Using a log aggregation service (e.g., Elasticsearch, Loki, Datadog)
- Filtering by specific event types
- Aggregating metrics (success rates, spending patterns, score trends)
- Setting up alerts for critical failures
