# Frontend integration contract

Everything a client needs that `contracts/openapi.json` cannot express: which
token goes where, the exact error shape, and the behaviours that are easy to get
wrong from the outside.

The frontend lives in its own repository. This file and the generated contract
are the whole interface; no backend access or database access is required.

---

## 1. The contract file

| Artifact | Purpose |
| --- | --- |
| `contracts/openapi.json` | Machine-readable API. Generated, committed, never hand-edited. |
| This document | The rules behind it: auth, errors, retries, browser behaviour. |

```bash
npm run contract:export   # rebuild contracts/openapi.json from the code
npm run contract:check    # rebuild, then fail if the committed file differs
```

Both run the Nest application against `.env` (without listening), so
`contract:export` wakes the database once. Run it only when routes or DTOs
change, then commit the result. `test/contract.test.js` fails if the committed
file is stale or missing a route, so a forgotten regeneration cannot reach
`main`.

In the frontend repository, generate types from it:

```bash
npx openapi-typescript ../"LLM Gateway"/contracts/openapi.json -o src/api/schema.d.ts
```

Swagger UI (`/docs`) stays **off** on any instance reachable from the internet;
`SWAGGER_ENABLED=true` is a local-development switch only. The contract file is
the supported way to see the API. If you have no checkout beside the frontend
repository, fetch the raw file from the backend repository's `main` branch.

---

## 2. Base URL and versioning

```text
http://localhost:4000/api/v1          # local
```

- The API version is in the path (`/api/v1`). A breaking change ships as
  `/api/v2`; clients never have to guess.
- `/health` is the **only** route outside the prefix, on purpose: an uptime
  monitor should not care about the API version.
- Ports are split by convention: gateway **4000**, Next.js **3000**.

---

## 3. Authentication: two schemes, not interchangeable

| Route | Header | Credential |
| --- | --- | --- |
| `POST /api/v1/chat/completions` | `Authorization: Bearer lg_...` | **API key** |
| `GET /api/v1/models` | `Authorization: Bearer lg_...` | **API key** |
| `POST /api/v1/auth/signup` | none | — |
| `POST /api/v1/auth/login` | none | — |
| `POST /api/v1/auth/keys` | `Authorization: Bearer <jwt>` | **JWT** |
| `GET /api/v1/auth/keys` | `Authorization: Bearer <jwt>` | **JWT** |
| `DELETE /api/v1/auth/keys/{id}` | `Authorization: Bearer <jwt>` | **JWT** |
| `GET /api/v1/auth/me` | `Authorization: Bearer <jwt>` | **JWT** |
| `GET /api/v1/insights/me` | `Authorization: Bearer <jwt>` | **JWT** |
| `GET /api/v1/admin/insights` | `Authorization: Bearer <jwt>` | **JWT + `ADMIN` role** |

- The **JWT** is a user session. It never works on `/chat/completions`.
- The **API key** (`lg_` + 48 hex characters) is a program credential. It never
  works on the dashboard routes.
- Sending the wrong one returns `401` with `error.code = "API_KEY_INVALID"` (API
  key routes) or `AUTHENTICATION_ERROR` (JWT routes). It is not a silent downgrade.

### Sessions today

`POST /auth/login` and `POST /auth/signup` both return:

```json
{
  "accessToken": "<jwt>",
  "user": { "id": "uuid", "email": "user@example.com", "name": "Yash", "role": "DEVELOPER" }
}
```

`accessToken` is valid for **7 days** and is not revocable before it expires.
There is no refresh endpoint and no logout endpoint yet.

**Storage rule for now:** keep the token in memory (a React context or a store
that is not persisted) and re-login when it is gone. Do **not** put it in
`localStorage`: a 7-day XSS-exfiltratable token is the worst combination this
project can ship. If a page reload must survive, that is the signal for the
refresh-token phase, not for persisting a 7-day token.

> Planned (do not build against it yet): a 15-minute access token plus an
> `httpOnly` refresh cookie, `POST /auth/refresh`, `POST /auth/logout`. Only
> `src/lib/auth.ts` in the frontend should need to change.

---

## 4. Errors: one shape, always

Every failure — validation, auth, provider, 404, 500 — is wrapped by the same
filter:

```json
{
  "error": {
    "message": "Unsupported request field 'tools'.",
    "type": "invalid_request_error",
    "param": "tools",
    "code": "UNSUPPORTED_FEATURE",
    "trace_id": "0f6f3d9d-5b6f-4b7e-9c2a-1f6f3d9d5b6f",
    "status_code": 400,
    "timestamp": "2026-11-03T09:35:02.307Z"
  }
}
```

- `code` is the stable, machine-readable value. Switch on it, never on
  `message`.
- `type` groups it: `invalid_request_error`, `authentication_error`,
  `permission_error`, `not_found_error`, `conflict_error`, `rate_limit_error`,
  `server_error`.
- `param` names the offending field when there is one, otherwise `null`.
- `trace_id` is always present and is also returned in the `x-trace-id` header.
  Show it in any error surface; it is the only way to find the row in the
  gateway's request log.

### Codes

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Body failed schema validation |
| `UNSUPPORTED_FEATURE` | 400 | Valid JSON, but the gateway refuses the feature (see §6) |
| `AUTHENTICATION_ERROR` | 401 | Bad login, missing/invalid JWT |
| `API_KEY_INVALID` | 401 | Unknown or revoked API key |
| `API_KEY_INACTIVE` | 401 | Key exists but is disabled |
| `AUTHORIZATION_ERROR` | 403 | Resource belongs to another user |
| `EMAIL_ALREADY_EXISTS` | 409 | Signup with a taken email |
| `RATE_LIMIT_ERROR` | 429 | Gateway rate limit (planned) |
| `MODEL_NOT_FOUND` | 404 | Unknown or inactive model |
| `NOT_FOUND` | 404 | No such route |
| `PROVIDER_ERROR` | 502 | Upstream provider failed |
| `PROVIDER_TIMEOUT` | 504 | Upstream provider timed out |
| `PROVIDER_RATE_LIMIT` | 429 | Upstream provider rate-limited the gateway |
| `PROVIDER_UNAVAILABLE` | 503 | Provider unreachable or all routes unavailable |
| `PROVIDER_NOT_CONFIGURED` | 503 | No credential for that provider |
| `PROVIDER_BAD_REQUEST` | 400 | Provider rejected the request |
| `INTERNAL_ERROR` | 500 | Gateway bug |

Treat `429` and `5xx` as retryable with backoff; `4xx` otherwise is not.

---

## 5. Headers

| Header | Direction | Notes |
| --- | --- | --- |
| `x-trace-id` | request + response | Send your own to correlate with client logs, otherwise generated. Echoed on every response, including errors. |
| `x-request-id` | request | Optional client-side request identifier, stored with the request log. |
| `retry-after` | response | Seconds to wait, on `429`. Exposed through CORS. |
| `content-type` | request | `application/json` for every write. |

---

## 6. Chat completions

`POST /api/v1/chat/completions` — currently **non-streaming text chat only**.

### Accepted request

```json
{
  "model": "mock",
  "messages": [{ "role": "user", "content": "Hello" }],
  "temperature": 0.7,
  "top_p": 1,
  "stop": ["END"],
  "max_tokens": 256,
  "presence_penalty": 0,
  "frequency_penalty": 0,
  "logit_bias": { "50256": -100 },
  "user": "end-user-123",
  "seed": 42,
  "timeout": 30000
}
```

`model`, `messages` required. `messages[].role` ∈ `system | user | assistant |
developer`, `content` must be a **string** (multimodal arrays are rejected).
`timeout` is gateway-specific (milliseconds) and is stripped before the provider
call. `n` must be `1`.

### Response

```json
{
  "id": "chatcmpl_mock_1761319216452",
  "object": "chat.completion",
  "created": 1761319216,
  "model": "mock",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Mock response: Hello" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10 },
  "trace_id": "0f6f3d9d-..."
}
```

`usage` is **optional** — it comes from the provider and is absent often enough
that the UI must not assume it. `totalCost` is not part of this response.

### Explicitly rejected (400 + `UNSUPPORTED_FEATURE`)

`stream` (see below), `tools`, `tool_choice`, `parallel_tool_calls`,
`functions`, `function_call`, `response_format`, `stream_options`, `logprobs`,
`top_logprobs`, `modalities`, `audio`, `prediction`, `reasoning_effort`,
`store`, `metadata`, `service_tier`, `verbosity`, `web_search_options`, `n > 1`,
`role: "tool" | "function"`, non-string message content, and any unknown field.

Unknown fields are rejected rather than ignored, so a typo in the frontend is a
400 with the exact `param` — not a silently different request.

### Streaming

**Not available yet.** `"stream": true` returns:

```json
{ "error": { "code": "UNSUPPORTED_FEATURE", "param": "stream",
  "message": "Streaming is not supported yet. Set stream to false or omit it." } }
```

Build the chat screen against the blocking response for now. When streaming
lands it will be the same route and the same body with `stream: true`, so only
the transport changes.

---

## 7. Models

`GET /api/v1/models` (API key) — OpenAI-compatible list:

```json
{
  "object": "list",
  "data": [{ "id": "mock", "object": "model", "created": 1761319216, "owned_by": "mock" }]
}
```

Only active models appear. A model can be listed and still fail at chat time
with `PROVIDER_NOT_CONFIGURED` (503) when the operator has not supplied that
provider's key — surface that as "provider not configured", not as "model
missing".

---

## 8. API keys

| Endpoint | Result |
| --- | --- |
| `POST /auth/keys` `{ "name": "my-app" }` | `201` with `rawKey` — **the only time the plaintext key is ever returned** |
| `GET /auth/keys` | Array of `{ id, prefix, name, isActive, lastUsedAt, createdAt, updatedAt }` |
| `DELETE /auth/keys/{id}` | `204`, no body. `403` if the key belongs to another user. |

The list never contains `key` or `rawKey`, only `prefix` (11 characters). Revoked
keys stay in the list with `isActive: false`. Show the `rawKey` once in a modal
with a copy button, then drop it; there is no way to retrieve it later.

---

## 9. Insights

`GET /api/v1/insights/me` (JWT):

```json
{
  "summary": {
    "totalRequests": 18,
    "promptTokens": 240,
    "completionTokens": 191,
    "totalTokens": 431,
    "lastRequestAt": "2026-11-03T09:35:04.722Z"
  },
  "recentRequests": [
    {
      "traceId": "0f6f3d9d-...",
      "provider": "mock",
      "statusCode": 200,
      "latencyMs": 908,
      "promptTokens": 14,
      "completionTokens": 14,
      "totalTokens": 28,
      "errorCode": null,
      "createdAt": "2026-11-03T09:35:02.307Z",
      "model": { "name": "mock" }
    }
  ]
}
```

`recentRequests` is capped at the last 10. Token fields are `0` when the provider
reported no usage; they are not `null`. `lastRequestAt` can be `null` for a new
account.

`GET /api/v1/admin/insights` (JWT, role `ADMIN`): `{ totalUsers, users[] }` where
each user carries `apiKeyCount`, `totalRequests`, token sums and
`lastRequestAt`. A non-admin gets `403` with `AUTHORIZATION_ERROR`.

---

## 10. Health

`GET /health` — public, outside `/api/v1`, no auth, no throttle (planned exempt).

```json
{ "status": "ok", "db": "up", "uptimeSeconds": 12 }
```

`503` with `{"status":"degraded","db":"down"}` when the database is unusable.
Do not poll it more often than every 10–15 minutes: the database is a free-tier
Neon instance that suspends after 5 idle minutes, and a 30-second monitor keeps
the compute awake around the clock until the monthly allowance is gone.

---

## 11. Browser behaviour (CORS)

- The gateway allows an **exact** list of browser origins (`CORS_ORIGINS`),
  never a wildcard — the refresh cookie will be credentialed.
- Local default: `http://localhost:3000`. A deployed instance must name the
  Vercel domain explicitly; otherwise the browser sees no
  `access-control-allow-origin` header and every call fails, even though `curl`
  works.
- `credentials: 'include'` is required on every `fetch`, because the refresh
  cookie will be sent with it. Cookies do not work from `localhost` to a
  different site with `SameSite=Lax`; the cookie attributes are part of the
  refresh-token phase.
- `HEAD`/`PATCH`/`PUT` are not allowed; use the documented methods.
- `x-trace-id` and `retry-after` are the only readable response headers.

---

## 12. Frontend rules of thumb

1. Keep `fetch` in one module. Auth header, `credentials`, error parsing and
   trace-id capture belong there, once.
2. Parse the error envelope, not the status text; branch on `error.code`.
3. Never store the API key in a browser bundle. The dashboard creates keys for
   the user's other applications; the gateway UI itself calls chat with a key the
   user pastes in, kept in memory only.
4. Do not call `/chat/completions` with the JWT.
5. Do not assume `usage` exists.
6. Streaming is a later phase; build the blocking path first.
