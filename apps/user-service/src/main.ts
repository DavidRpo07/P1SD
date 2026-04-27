import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: 'users',
      protoPath: join(__dirname, '../../../packages/contracts/proto/user.proto'),
      url: process.env.USER_GRPC_URL || '0.0.0.0:50054',
      loader: {
        keepCase: true,
        longs: Number
      }
    }
  });

  await app.listen();
  // eslint-disable-next-line no-console
  console.log('user-service gRPC listening on', process.env.USER_GRPC_URL || '0.0.0.0:50054');
}

void bootstrap();
