# Lodestar Backend HTTP API Reference

This document provides a comprehensive reference for the Lodestar backend HTTP API. It includes all endpoints across system health, registry, agents, and demo services.

---

## System Endpoints

### `GET /healthz`

**Description:** Check system health

**Parameters:** None

**Rate Limit:** None

**Response Example:**
```json
{ "status": "healthy" }
```

**Errors:** 503: Service Unavailable

**cURL Example:**
```bash
curl -X GET http://localhost:3001/healthz
```

---

## Registry Endpoints

### `GET /api/services`

**Description:** List registered services

**Parameters:** `category` (optional), `limit` (optional)

**Rate Limit:** 100/min

**Response Example:**
```json
[{"id":"1", "name":"Weather Service"}]
```

**Errors:** 500: Internal Error

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/services
```

---

### `GET /api/services/:id`

**Description:** Get service by ID

**Parameters:** `id` (path)

**Rate Limit:** 100/min

**Response Example:**
```json
{"id":"1", "name":"Weather Service"}
```

**Errors:** 404: Not Found

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/services/1
```

---

### `POST /api/services/:id/deactivate`

**Description:** Deactivate service

**Parameters:** `id` (path)

**Rate Limit:** 10/min

**Request Example:**
```json
{"signature":"..."}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 401: Unauthorized

**cURL Example:**
```bash
curl -X POST http://localhost:3001/api/services/1/deactivate
```

---

### `GET /api/services/:id/history`

**Description:** Get service reputation history

**Parameters:** `id` (path)

**Rate Limit:** 100/min

**Response Example:**
```json
[]
```

**Errors:** 404: Not Found

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/services/1/history
```

---

### `GET /api/stats`

**Description:** Get registry stats

**Parameters:** None

**Rate Limit:** 100/min

**Response Example:**
```json
{"totalServices": 10}
```

**Errors:** 500: Internal Error

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/stats
```

---

### `GET /api/registry/by-provider/:address`

**Description:** Get services by provider

**Parameters:** `address` (path)

**Rate Limit:** 100/min

**Response Example:**
```json
[]
```

**Errors:** 400: Invalid Address

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/registry/by-provider/GABC...
```

---

### `POST /api/registry/prepare-register`

**Description:** Prepare a registration transaction

**Parameters:** Body: `provider`, `endpoint`, `price`, `category`

**Rate Limit:** 10/min

**Request Example:**
```json
{"provider":"GABC...","endpoint":"https://...","price":10,"category":"data"}
```

**Response Example:**
```json
{"xdr":"..."}
```

**Errors:** 400: Invalid Input

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"provider":"GABC...","endpoint":"https://...","price":10,"category":"data"}' http://localhost:3001/api/registry/prepare-register
```

---

### `POST /api/registry/prepare-deactivate`

**Description:** Prepare a deactivation transaction

**Parameters:** Body: `provider`, `serviceId`

**Rate Limit:** 10/min

**Request Example:**
```json
{"provider":"GABC...","serviceId":"1"}
```

**Response Example:**
```json
{"xdr":"..."}
```

**Errors:** 400: Invalid Input

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"provider":"GABC...","serviceId":"1"}' http://localhost:3001/api/registry/prepare-deactivate
```

---

### `POST /api/registry/submit-signed-tx`

**Description:** Submit a signed transaction

**Parameters:** Body: `xdr`

**Rate Limit:** 10/min

**Request Example:**
```json
{"xdr":"..."}
```

**Response Example:**
```json
{"success":true, "hash":"..."}
```

**Errors:** 400: Tx Failed

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"xdr":"..."}' http://localhost:3001/api/registry/submit-signed-tx
```

---

### `POST /api/reputation/:id`

**Description:** Update reputation

**Parameters:** `id` (path), Body: `score`, `signature`

**Rate Limit:** 10/min

**Request Example:**
```json
{"score":10, "signature":"..."}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 401: Unauthorized

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"score":10, "signature":"..."}' http://localhost:3001/api/reputation/1
```

---

### `GET /api/health`

**Description:** API Health

**Parameters:** None

**Rate Limit:** None

**Response Example:**
```json
{"status":"ok"}
```

**Errors:** None

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/health
```

---

## Agents Endpoints

### `GET /api/agents`

**Description:** List agents

**Parameters:** `page`, `pageSize`, `sort`

**Rate Limit:** 100/min

**Response Example:**
```json
{"agents":[]}
```

**Errors:** 500: Internal Error

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/agents
```

---

### `GET /api/agents/count`

**Description:** Get agent count

**Parameters:** None

**Rate Limit:** 100/min

**Response Example:**
```json
{"count": 5}
```

**Errors:** 500: Internal Error

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/agents/count
```

---

### `GET /api/agents/stats`

**Description:** Get agent stats

**Parameters:** None

**Rate Limit:** 100/min

**Response Example:**
```json
{"active": 3}
```

**Errors:** 500: Internal Error

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/agents/stats
```

---

### `GET /api/agents/:address`

**Description:** Get agent by address

**Parameters:** `address` (path)

**Rate Limit:** 100/min

**Response Example:**
```json
{"address":"GABC..."}
```

**Errors:** 404: Not Found

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/agents/GABC...
```

---

### `GET /api/agents/:address/policy`

**Description:** Get agent policy

**Parameters:** `address` (path)

**Rate Limit:** 100/min

**Response Example:**
```json
{"dailyLimit":100}
```

**Errors:** 404: Not Found

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/agents/GABC.../policy
```

---

### `GET /api/agents/:address/score`

**Description:** Get agent score

**Parameters:** `address` (path)

**Rate Limit:** 100/min

**Response Example:**
```json
{"score":850}
```

**Errors:** 404: Not Found

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/agents/GABC.../score
```

---

### `GET /api/agents/:address/eligible`

**Description:** Check if agent is eligible

**Parameters:** `address` (path), `requiredScore` (query)

**Rate Limit:** 100/min

**Response Example:**
```json
{"eligible":true}
```

**Errors:** 400: Missing query

**cURL Example:**
```bash
curl -X GET "http://localhost:3001/api/agents/GABC.../eligible?requiredScore=500"
```

---

### `GET /api/agents/:address/can-spend`

**Description:** Check spend allowance

**Parameters:** `address` (path), `amount` (query)

**Rate Limit:** 100/min

**Response Example:**
```json
{"allowed":true}
```

**Errors:** 400: Missing query

**cURL Example:**
```bash
curl -X GET "http://localhost:3001/api/agents/GABC.../can-spend?amount=10"
```

---

### `POST /api/agents/register`

**Description:** Register a new agent

**Parameters:** Body: `address`, `signature`

**Rate Limit:** 10/min

**Request Example:**
```json
{"address":"GABC...", "signature":"..."}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 400: Invalid Input

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"address":"GABC...","signature":"..."}' http://localhost:3001/api/agents/register
```

---

### `POST /api/agents/:address/authorize-payment`

**Description:** Authorize a payment

**Parameters:** `address` (path), Body: `amount`, `serviceId`

**Rate Limit:** 20/min

**Request Example:**
```json
{"amount":10, "serviceId":"1"}
```

**Response Example:**
```json
{"authorized":true}
```

**Errors:** 403: Policy Rejected

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"amount":10,"serviceId":"1"}' http://localhost:3001/api/agents/GABC.../authorize-payment
```

---

### `GET /api/agents/:address/payment-history`

**Description:** Get payment history

**Parameters:** `address` (path)

**Rate Limit:** 100/min

**Response Example:**
```json
[]
```

**Errors:** 404: Not Found

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/agents/GABC.../payment-history
```

---

### `GET /api/agents/:address/check`

**Description:** Check agent status

**Parameters:** `address` (path)

**Rate Limit:** 100/min

**Response Example:**
```json
{"active":true}
```

**Errors:** 404: Not Found

**cURL Example:**
```bash
curl -X GET http://localhost:3001/api/agents/GABC.../check
```

---

### `POST /api/agents/:address/build-tx`

**Description:** Build agent transaction

**Parameters:** `address` (path), Body: `operation`

**Rate Limit:** 20/min

**Request Example:**
```json
{"operation":"..."}
```

**Response Example:**
```json
{"xdr":"..."}
```

**Errors:** 400: Invalid Input

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"operation":"..."}' http://localhost:3001/api/agents/GABC.../build-tx
```

---

### `POST /api/agents/:address/submit-signed-tx`

**Description:** Submit signed tx for agent

**Parameters:** `address` (path), Body: `xdr`

**Rate Limit:** 20/min

**Request Example:**
```json
{"xdr":"..."}
```

**Response Example:**
```json
{"success":true, "hash":"..."}
```

**Errors:** 400: Tx Failed

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"xdr":"..."}' http://localhost:3001/api/agents/GABC.../submit-signed-tx
```

---

### `POST /api/agents/:address/flag`

**Description:** Flag agent (user)

**Parameters:** `address` (path)

**Rate Limit:** 5/min

**Request Example:**
```json
{"reason":"spam"}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 401: Unauthorized

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"reason":"spam"}' http://localhost:3001/api/agents/GABC.../flag
```

---

### `POST /api/admin/agents/:address/flag`

**Description:** Flag agent (admin)

**Parameters:** `address` (path)

**Rate Limit:** None

**Request Example:**
```json
{"reason":"spam"}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 403: Forbidden

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"reason":"spam"}' http://localhost:3001/api/admin/agents/GABC.../flag
```

---

### `POST /api/admin/agents/:address/deactivate`

**Description:** Deactivate agent (admin)

**Parameters:** `address` (path)

**Rate Limit:** None

**Request Example:**
```json
{}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 403: Forbidden

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{}' http://localhost:3001/api/admin/agents/GABC.../deactivate
```

---

### `POST /api/agents/:address/deactivate`

**Description:** Deactivate agent (owner)

**Parameters:** `address` (path)

**Rate Limit:** 5/min

**Request Example:**
```json
{"signature":"..."}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 401: Unauthorized

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"signature":"..."}' http://localhost:3001/api/agents/GABC.../deactivate
```

---

### `POST /api/agents/:address/update-policy`

**Description:** Update agent policy

**Parameters:** `address` (path), Body: `policy`

**Rate Limit:** 10/min

**Request Example:**
```json
{"policy":{"dailyLimit":200}}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 401: Unauthorized

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"policy":{"dailyLimit":200}}' http://localhost:3001/api/agents/GABC.../update-policy
```

---

### `PUT /api/agents/:address/policy`

**Description:** Put agent policy

**Parameters:** `address` (path), Body: `policy`

**Rate Limit:** 10/min

**Request Example:**
```json
{"policy":{"dailyLimit":200}}
```

**Response Example:**
```json
{"success":true}
```

**Errors:** 401: Unauthorized

**cURL Example:**
```bash
curl -X PUT -H "Content-Type: application/json" -d '{"policy":{"dailyLimit":200}}' http://localhost:3001/api/agents/GABC.../policy
```

---

## Demo Endpoints

### `POST /api/demo-run`

**Description:** Trigger demo run

**Parameters:** Body: `agentAddress`, `serviceId`

**Rate Limit:** 5/min

**Request Example:**
```json
{"agentAddress":"GABC...", "serviceId":"1"}
```

**Response Example:**
```json
{"status":"running"}
```

**Errors:** 400: Invalid Input

**cURL Example:**
```bash
curl -X POST -H "Content-Type: application/json" -d '{"agentAddress":"GABC...","serviceId":"1"}' http://localhost:3001/api/demo-run
```

---

## Services Endpoints

### `GET /demo/weather`

**Description:** Demo weather service

**Parameters:** `location` (query)

**Rate Limit:** 100/min

**Response Example:**
```json
{"temperature": 22}
```

**Errors:** 402: Payment Required

**cURL Example:**
```bash
curl -X GET "http://localhost:3001/demo/weather?location=Paris"
```

---

### `GET /demo/search`

**Description:** Demo search service

**Parameters:** `q` (query)

**Rate Limit:** 100/min

**Response Example:**
```json
{"results": []}
```

**Errors:** 402: Payment Required

**cURL Example:**
```bash
curl -X GET "http://localhost:3001/demo/search?q=test"
```

---

### `GET /demo/activity`

**Description:** Demo activity service

**Parameters:** None

**Rate Limit:** 100/min

**Response Example:**
```json
{"activity": "running"}
```

**Errors:** 402: Payment Required

**cURL Example:**
```bash
curl -X GET http://localhost:3001/demo/activity
```

---

