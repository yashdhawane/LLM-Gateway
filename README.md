# LLM Gateway

A developer-focused, OpenAI-compatible LLM gateway built with NestJS, TypeScript, Fastify, and Prisma (PostgreSQL/Neon).

## Requirements

- Node.js 20+
- npm

## Setup

```bash
npm install
cp .env.example .env
# add your Neon DATABASE_URL to .env
npm run prisma:migrate -- --name init
npm run db:seed
```

`db:seed` prints the raw API key once. Store it; only the bcrypt hash is persisted.

## Run

```bash
npm run start:dev      # watch mode
# or
npm run build && npm run start:prod
```

- API base: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/docs`

## Smoke test

```bash
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer <seeded-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"mock","messages":[{"role":"user","content":"hello"}]}'
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
| `npm run db:seed` | Seed a dev user, API key, and models |

## Current status

Working: startup env validation, API-key auth, routing, mock provider, OpenAI provider, request logging, Swagger.
Next: streaming pass-through, provider timeout cancellation, cost tracking.
