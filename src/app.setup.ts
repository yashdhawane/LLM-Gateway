import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DocumentBuilder,
  OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

export function configureApp(app: INestApplication, config: ConfigService): void {
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;

  /**
   * Browser access for the Next.js frontend.
   *
   * The origin list is exact and never a wildcard: `credentials: true` sends
   * the refresh cookie, and a wildcard would let any site make an
   * authenticated call and read the response. `x-trace-id` and `retry-after`
   * are exposed because the client needs them to report a failure and to know
   * how long to wait after a 429. With an empty list CORS stays off entirely,
   * which is the correct shape for a non-browser deployment.
   */
  const corsOrigins = config.get<string[]>('CORS_ORIGINS') ?? [];

  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'content-type',
        'authorization',
        'x-trace-id',
        'x-request-id',
      ],
      exposedHeaders: ['x-trace-id', 'retry-after'],
      maxAge: 600,
    });
  }

  // Use a Fastify hook rather than Nest middleware: Nest middleware receives
  // the raw Node request on Fastify, so a trace ID stored there would be lost
  // before guards and controllers run.
  fastify.addHook('onRequest', (request, reply, done) => {
    const incoming = request.headers['x-trace-id'];
    const headerValue = Array.isArray(incoming) ? incoming[0] : incoming;
    const traceId = (headerValue || uuidv4()).slice(0, 128);

    (request as any).traceId = traceId;
    reply.header('x-trace-id', traceId);
    done();
  });

  // `health` is excluded so a monitor can call the conventional `/health`
  // instead of the versioned `/api/v1/health`, which would change with every
  // API version bump.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(config));
}

/**
 * Builds the OpenAPI document.
 *
 * Shared by `setupSwagger` (local `/docs`) and `scripts/export-openapi.ts`
 * (the committed `contracts/openapi.json` the frontend generates types from),
 * so the published contract can never drift from what the dev UI shows.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('LLM Gateway API')
    .setDescription(
      'OpenAI-compatible text chat gateway. `/chat/completions` answers one JSON object, or a `text/event-stream` when `stream: true`. Unsupported request features return a structured UNSUPPORTED_FEATURE error.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Key',
        description: 'Enter your API key',
      },
      'api-key',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter the JWT returned by /auth/login or /auth/signup',
      },
      'jwt',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
}
