import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

export function configureApp(app: INestApplication, config: ConfigService): void {
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;

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

  app.setGlobalPrefix('api/v1');

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

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('LLM Gateway API')
    .setDescription(
      'OpenAI-compatible, non-streaming text chat gateway. Unsupported request features return a structured UNSUPPORTED_FEATURE error.',
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

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
}
