import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { GroupGrpcController } from './group.grpc.controller';
import { GroupStoreService } from './group.store.service';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'AUTH_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'auth',
          protoPath: join(__dirname, '../../../packages/contracts/proto/auth.proto'),
          url: process.env.AUTH_SERVICE_GRPC_URL || 'localhost:50051',
          loader: {
            keepCase: true,
            longs: Number
          }
        }
      }
    ])
  ],
  controllers: [GroupGrpcController],
  providers: [GroupStoreService]
})
export class AppModule {}
