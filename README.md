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

`db:seed` creates the MVP admin account, seeds the mock/OpenAI models, and prints a raw API key once if one does not already exist.

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
| `POST /chat/completions` | API key | OpenAI-compatible chat completion |

The JWT is sent as `Authorization: Bearer <token>`. The raw API key is returned only once by `POST /auth/keys`; only its bcrypt hash is stored.

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

# 3. Use the returned rawKey for chat
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer <rawKey>" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock","messages":[{"role":"user","content":"hello"}]}'

# 4. View your own insights
curl http://localhost:3000/api/v1/insights/me \
  -H "Authorization: Bearer <jwt>"

# 5. View all user insights as the seeded admin
curl http://localhost:3000/api/v1/admin/insights \
  -H "Authorization: Bearer <admin-jwt>"
```

Set `OPENAI_API_KEY` in `.env` to use the seeded `gpt-4o-mini` route.

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

Working: validated startup config, JWT signup/login, per-user API keys, API-key guard, routing, mock provider, OpenAI provider, request logging, user insights, admin user insights, Swagger.

MVP limitations: one seeded admin account, no refresh tokens/password reset, no role-management UI, no streaming, provider timeout cancellation is not implemented, and cost tracking is not implemented.
