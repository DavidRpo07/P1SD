import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  await app.listen(3000);
  // eslint-disable-next-line no-console
  console.log('api-gateway running on http://localhost:3000/api/v1');
}

bootstrap();
