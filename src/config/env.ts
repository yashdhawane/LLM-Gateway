import { z } from 'zod';

/**
 * Splits a comma-separated list, dropping empty entries so a trailing comma or
 * a multi-line value is not a boot failure.
 */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Rejects anything that is not an exact browser origin.
 *
 * `@fastify/cors` is configured with `credentials: true` so the refresh cookie
 * can travel with requests. A wildcard is therefore refused: any site could
 * then make an authenticated request and read the response body. Paths and
 * queries are refused too, because they are silently dropped by the URL parser
 * and would make the configuration look broader than it is.
 */
function corsOriginProblems(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }

  const problems: string[] = [];

  for (const entry of splitList(raw)) {
    if (entry === '*') {
      problems.push(
        "'*' is not allowed because credentials are enabled; list explicit origins",
      );
      continue;
    }

    let url: URL;

    try {
      url = new URL(entry);
    } catch {
      problems.push(`'${entry}' is not an absolute URL such as https://app.example.com`);
      continue;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`'${entry}' must use http or https`);
      continue;
    }

    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      problems.push(
        `'${entry}' must be an origin without a path, query or fragment`,
      );
    }
  }

  return problems;
}

function resolveCorsOrigins(
  raw: string | undefined,
  nodeEnv: 'development' | 'staging' | 'production',
): string[] {
  const entries = raw === undefined ? [] : splitList(raw);

  if (entries.length > 0) {
    // `origin` is the normalised scheme + host + port, so a trailing slash or a
    // different host casing cannot produce a mismatch at match time.
    return entries.map((entry) => new URL(entry).origin);
  }

  // Local default: the Next.js app in its own repository. A deployed instance
  // must name its frontend explicitly, otherwise no browser origin is allowed
  // and the API stays usable only from non-browser clients.
  return nodeEnv === 'development' ? ['http://localhost:3000'] : [];
}

/**
 * Single source of truth for environment variables.
 *
 * Keep this schema small: only variables the application actually reads.
 * Add a variable here before using it anywhere else.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    // 4000 on purpose: the Next.js frontend in its own repository uses the
    // conventional 3000, so both can run side by side without a port clash.
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /**
     * Browser origins allowed to call the API, comma separated.
     *
     * Validated as exact origins; see `corsOriginProblems`. Empty means "no
     * browser origin", which is the safe default outside development.
     */
    CORS_ORIGINS: z.string().optional(),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
        'must be a PostgreSQL connection string',
      ),
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().min(1).default('7d'),
    /**
     * Swagger UI at /docs. Opt-in on purpose: it publishes every route, schema
     * and error contract, so a deployment reachable from the internet should
     * never serve it. Only a local development instance sets this to `true`.
     */
    SWAGGER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    OPENAI_API_KEY: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
    ANTHROPIC_API_KEY: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
  })
  .superRefine((env, ctx) => {
    for (const message of corsOriginProblems(env.CORS_ORIGINS)) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message });
    }
  })
  .transform((env) => ({
    ...env,
    CORS_ORIGINS: resolveCorsOrigins(env.CORS_ORIGINS, env.NODE_ENV),
  }));

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}
