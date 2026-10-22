import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  const config = app.get(ConfigService);

  configureApp(app, config);
  setupSwagger(app);

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port, '0.0.0.0');
  console.log(`LLM Gateway listening on port ${port}`);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
