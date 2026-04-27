import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: 'auth',
      protoPath: join(__dirname, '../../../packages/contracts/proto/auth.proto'),
      url: process.env.AUTH_GRPC_URL || '0.0.0.0:50051',
      loader: {
        keepCase: true,
        longs: Number
      }
    }
  });

  await app.listen();
  // eslint-disable-next-line no-console
  console.log('auth-service gRPC listening on', process.env.AUTH_GRPC_URL || '0.0.0.0:50051');
}

bootstrap();
