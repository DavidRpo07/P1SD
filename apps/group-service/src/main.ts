import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: 'groups',
      protoPath: join(__dirname, '../../../packages/contracts/proto/group.proto'),
      url: process.env.GROUP_GRPC_URL || '0.0.0.0:50052',
      loader: {
        keepCase: true,
        longs: Number
      }
    }
  });

  await app.listen();
  // eslint-disable-next-line no-console
  console.log('group-service gRPC listening on', process.env.GROUP_GRPC_URL || '0.0.0.0:50052');
}

bootstrap();
