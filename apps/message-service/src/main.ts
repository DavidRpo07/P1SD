import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: 'messaging',
      protoPath: join(__dirname, '../../../packages/contracts/proto/message.proto'),
      url: process.env.MESSAGE_GRPC_URL || '0.0.0.0:50053',
      loader: {
        keepCase: true,
        longs: Number
      }
    }
  });

  await app.listen();
  // eslint-disable-next-line no-console
  console.log('message-service gRPC listening on', process.env.MESSAGE_GRPC_URL || '0.0.0.0:50053');
}

bootstrap();
