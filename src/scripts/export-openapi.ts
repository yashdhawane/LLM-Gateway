/**
 * Writes `contracts/openapi.json`, the machine-readable half of the API
 * contract consumed by the frontend repository.
 *
 * The frontend generates its TypeScript types from this file, so it must be
 * the same document `/docs` serves locally - both come from
 * `buildOpenApiDocument`. Serving Swagger on a public instance is still off:
 * this is a build-time artifact, not a route.
 *
 * The script boots the Nest application (without listening) because route
 * metadata only exists once modules are initialised, which means it connects
 * to the database named in `.env`. That costs one free-tier compute wake; run
 * it when routes or DTOs change, then commit the result.
 *
 * Usage: npm run contract:export
 */
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from '../app.module';
import { buildOpenApiDocument, configureApp } from '../app.setup';

// Works both from `src/scripts` (ts-node) and `dist/scripts` (compiled).
const OUTPUT = path.resolve(__dirname, '..', '..', 'contracts', 'openapi.json');

async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: false },
  );

  try {
    // The global prefix lives in `configureApp`, so the document is built only
    // after it has been applied; otherwise every path would lose `/api/v1`.
    configureApp(app, app.get(ConfigService));

    const document = buildOpenApiDocument(app);

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    console.log(
      JSON.stringify({
        written: path.relative(process.cwd(), OUTPUT),
        paths: Object.keys(document.paths).length,
        schemas: Object.keys(document.components?.schemas ?? {}).length,
      }),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
