# Backend

Node.js/Express API for the registry service.

## Getting started

```bash
npm install
npm run dev
```

## API specification

The OpenAPI fragments below are assembled into the specification for the whole API.

### `POST /registry/submit-signed-tx`

Submit a client-signed transaction to the registry. The caller signs the transaction
locally and posts the serialized signed payload; the backend broadcasts it and returns
the resulting transaction hash.

#### Request body

`Content-Type: application/json`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `signedTx` | string | yes | Hex-encoded, serialized signed transaction. |
| `chainId` | integer | no | Chain the transaction targets. Defaults to the server-configured chain. |

```json
{
  "signedTx": "0x02f8...",
  "chainId": 1
}
```

#### Responses

| Status | Description | Body schema |
| --- | --- | --- |
| `200` | Transaction accepted and broadcast. | `{ "txHash": string }` |
| `400` | Malformed request or invalid signed transaction. | `{ "error": string, "code": string }` |
| `401` | Missing or invalid authentication. | `{ "error": string, "code": string }` |
| `409` | Transaction conflicts with an already-known transaction (e.g. nonce reuse). | `{ "error": string, "code": string }` |
| `422` | Signed transaction failed validation (bad signature, unsupported chain). | `{ "error": string, "code": string }` |
| `500` | Unexpected server or upstream node error. | `{ "error": string, "code": string }` |

Success example (`200`):

```json
{
  "txHash": "0xabc123..."
}
```

Error example (`400`):

```json
{
  "error": "signedTx is required",
  "code": "INVALID_REQUEST"
}
```

#### Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_REQUEST` | `400` | Request body missing or malformed. |
| `INVALID_SIGNED_TX` | `400` | `signedTx` could not be decoded. |
| `UNAUTHORIZED` | `401` | Authentication required or failed. |
| `TX_CONFLICT` | `409` | Transaction conflicts with a known transaction. |
| `INVALID_SIGNATURE` | `422` | Signature verification failed. |
| `UNSUPPORTED_CHAIN` | `422` | `chainId` is not supported. |
| `UPSTREAM_ERROR` | `500` | Node/broadcast provider returned an error. |
| `INTERNAL_ERROR` | `500` | Unexpected server error. |
