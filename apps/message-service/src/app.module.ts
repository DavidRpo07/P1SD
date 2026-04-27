import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { MessageGrpcController } from './message.grpc.controller';
import { MessageStoreService } from './message.store.service';
import { OutboxRelayService } from './outbox-relay.service';
import { RabbitEventPublisher } from './rabbit-event.publisher';
import { S3AttachmentsService } from './s3-attachments.service';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'GROUP_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'groups',
          protoPath: join(__dirname, '../../../packages/contracts/proto/group.proto'),
          url: process.env.GROUP_SERVICE_GRPC_URL || 'localhost:50052',
          loader: {
            keepCase: true,
            longs: Number
          }
        }
      },
      {
        name: 'USER_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'users',
          protoPath: join(__dirname, '../../../packages/contracts/proto/user.proto'),
          url: process.env.USER_SERVICE_GRPC_URL || 'localhost:50054',
          loader: {
            keepCase: true,
            longs: Number
          }
        }
      }
    ])
  ],
  controllers: [MessageGrpcController],
  providers: [MessageStoreService, RabbitEventPublisher, OutboxRelayService, S3AttachmentsService]
})
export class AppModule {}
