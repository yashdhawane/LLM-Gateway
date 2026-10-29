# LLM Gateway

A developer-focused, OpenAI-compatible LLM gateway built with NestJS, TypeScript, Fastify, and Prisma (PostgreSQL/Neon).

## Requirements

- Node.js 20+
- npm

## Setup

```bash
npm install
cp .env.example .env
# set DATABASE_URL (Neon) and a long random JWT_SECRET (32+ characters)
npm run prisma:migrate
npm run db:seed
```

`db:seed` creates the MVP admin account, seeds the mock/OpenAI/Anthropic models, and prints a raw API key once if one does not already exist.

Seeded admin credentials (MVP only; change before deploying):

```text
email:    dev@local.test
password: admin123
```

## Run

```bash
npm run start:dev      # watch mode
# or
npm run build && npm run start:prod
```

- API base: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/docs`

For the OpenAI SDK, use `http://localhost:3000/api/v1` as the base URL. The SDK appends `/chat/completions` and `/models` to it.

## Providers and credentials

All providers are normalized behind the same OpenAI-style chat contract. The current registry contains:

| Provider | Credential variable | Default base URL | Protocol |
| --- | --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | `https://api.openai.com` | OpenAI chat completions |
| `anthropic` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` | Anthropic Messages API |
| `mock` | none | local | deterministic echo response |

Credentials are resolved by `CredentialManager` from validated environment configuration. They are never stored in the database or written to request logs. A model row may override the provider's base URL, which is useful for OpenAI-compatible proxies or local endpoints.

The seed creates:

- `mock` (no key required)
- `gpt-4o-mini` (`openai`)
- `claude-3-5-haiku-latest` (`anthropic`)

Set the corresponding key in `.env` to enable a provider. Requests to unconfigured providers fail with HTTP `503` and `PROVIDER_NOT_CONFIGURED`; they do not fall back unless the model has an explicit fallback chain.

### Model routing and resilience

A model `name` is the public gateway alias. Routing and resilience settings live on each `Model` row:

| Field | Purpose |
| --- | --- |
| `upstreamName` | Provider's actual model identifier, when it differs from the alias |
| `fallbackModels` | Ordered model aliases to try after a retryable or provider-configuration failure |
| `timeoutMs` | Per-attempt upstream timeout |
| `maxRetries` | Opt-in retries per route; defaults to `0` |
| `cooldownMs` | Process-local cooldown after a retryable failure |

The router resolves an alias to an ordered target list and caches it for 30 seconds. A request then runs through the resilience layer:

- Upstream requests are aborted on timeout, not just abandoned.
- Retries use bounded exponential backoff and are disabled by default because chat completions are not idempotent.
- Timeouts, rate limits, upstream `5xx` responses, provider errors, and missing provider configuration can fall back to the next configured model.
- Provider-side `400` validation failures do not retry or fall back.
- Failed routes enter a process-local cooldown; cooldown state is intentionally not shared across instances in this foundation.

Fallbacks are explicit and one level deep. The seed does not configure cross-provider fallbacks by default; add them deliberately after checking model capabilities and cost.

The Anthropic adapter rejects parameters it cannot honor, such as `presence_penalty`, `frequency_penalty`, a non-empty `logit_bias`, and `seed`, with `PROVIDER_BAD_REQUEST` instead of silently dropping them.

## Authentication

JWT authentication is used for user account and dashboard operations. API keys are used for LLM traffic.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /auth/signup` | Public | Create a developer account and receive a JWT |
| `POST /auth/login` | Public | Log in and receive a JWT |
| `GET /auth/me` | JWT | Current user profile |
| `POST /auth/keys` | JWT | Create an API key |
| `GET /auth/keys` | JWT | List the current user's API keys |
| `DELETE /auth/keys/:id` | JWT | Revoke one of the current user's API keys |
| `GET /insights/me` | JWT | Current user's usage summary and recent requests |
| `GET /admin/insights` | JWT + `ADMIN` | All users' usage summaries |
| `GET /models` | API key | List active models in OpenAI-compatible format |
| `POST /chat/completions` | API key | OpenAI-compatible chat completion |

The JWT is sent as `Authorization: Bearer <token>`. The raw API key is returned only once by `POST /auth/keys`; only its bcrypt hash is stored.

## API contract

### Chat completions

`POST /chat/completions` currently supports **non-streaming text chat only**.

Supported request fields:

- `model`
- `messages` with `system`, `user`, `assistant`, or `developer` roles and text `content`
- `temperature`, `top_p`
- `n: 1`
- `stream: false` or omitted
- `stop`
- `max_tokens`, `max_completion_tokens`
- `presence_penalty`, `frequency_penalty`
- `logit_bias`
- `user`, `seed`
- `timeout` as a gateway-specific request timeout in milliseconds

Features that are not implemented yet are rejected explicitly with HTTP `400` and `error.code = "UNSUPPORTED_FEATURE"`:

- `stream: true`
- `n > 1`
- tools and functions (`tools`, `tool_choice`, `parallel_tool_calls`, `functions`, `function_call`, tool/function messages)
- `response_format`
- multimodal message content arrays
- `logprobs`, `top_logprobs`
- `stream_options`
- `audio`, `modalities`, `prediction`
- `reasoning_effort`, `store`, `metadata`, `service_tier`, `verbosity`, `web_search_options`
- unknown request or message fields

This is deliberate: the gateway does not silently drop or pass through features it cannot guarantee across providers.

### Error envelope

Every error uses the same machine-readable shape:

```json
{
  "error": {
    "message": "Streaming is not supported yet. Set stream to false or omit it.",
    "type": "invalid_request_error",
    "param": "stream",
    "code": "UNSUPPORTED_FEATURE",
    "trace_id": "0f6f3d9d-5b6f-4b7e-9c2a-1f6f3d9d5b6f",
    "status_code": 400,
    "timestamp": "2026-10-24T15:20:16.452Z"
  }
}
```

Common status codes:

| Status | Meaning |
| --- | --- |
| `400` | Invalid input or unsupported feature |
| `401` | Missing/invalid API key or JWT |
| `403` | Authenticated but not permitted |
| `404` | Model not found |
| `409` | Account already exists |
| `429` | Provider rate limit exceeded |
| `502` | Provider request failed |
| `503` | Provider credentials are not configured or the provider is unsupported |
| `504` | Provider request timed out |

### Request correlation

- Every response includes an `x-trace-id` header.
- Clients may send `x-trace-id` to propagate their own trace.
- Clients may send `x-request-id`; it is stored with the request log. It falls back to the trace ID when omitted.
- If a provider succeeds but request-log persistence fails, the gateway still returns the provider response to avoid prompting a potentially billable duplicate retry. The failure is logged with the trace ID; usage insights may not include that request.

### Models

`GET /models` returns active models using the OpenAI list format:

```json
{
  "object": "list",
  "data": [
    {
      "id": "mock",
      "object": "model",
      "created": 1761319216,
      "owned_by": "mock"
    }
  ]
}
```

## End-to-end flow

```bash
# 1. Sign up (or log in) and capture the JWT
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"secret-password-123","name":"User"}'

# 2. Create an API key with the JWT
curl -X POST http://localhost:3000/api/v1/auth/keys \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app"}'

# 3. List available models
curl http://localhost:3000/api/v1/models \
  -H "Authorization: Bearer <rawKey>"

# 4. Use the returned rawKey for chat
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer <rawKey>" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock","messages":[{"role":"user","content":"hello"}]}'

# 5. View your own insights
curl http://localhost:3000/api/v1/insights/me \
  -H "Authorization: Bearer <jwt>"

# 6. View all user insights as the seeded admin
curl http://localhost:3000/api/v1/admin/insights \
  -H "Authorization: Bearer <admin-jwt>"
```

Set `OPENAI_API_KEY` in `.env` to use the seeded `gpt-4o-mini` route, or `ANTHROPIC_API_KEY` to use `claude-3-5-haiku-latest`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Generate Prisma client and compile to `dist/` |
| `npm run start:dev` | Nest watch mode |
| `npm run typecheck` | TypeScript check without emitting |
| `npm test` | Build and run the Node test suite |
| `npm run prisma:migrate` | Create/apply a dev migration |
| `npm run db:seed` | Seed the admin user, API key, and models |

## Current status

Working: validated startup config, JWT signup/login, per-user API keys, API-key guard, OpenAI-compatible non-streaming chat contract, structured error envelope, trace/request correlation, model listing, provider registry with centralized environment credentials, OpenAI and Anthropic normalization, alias/fallback routing, per-request timeout cancellation, opt-in retries, in-memory cooldowns, mock provider, request logging, user insights, admin user insights, Swagger.

MVP limitations: one seeded admin account, no refresh tokens/password reset, no role-management UI, no streaming, no shared cooldown/health state across instances, no database-backed credential store or key rotation, no rate limits/quotas, and cost tracking is not implemented. Retries are disabled by default because chat completions are not idempotent.
