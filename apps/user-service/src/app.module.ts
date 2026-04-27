import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { UserGrpcController } from './user.grpc.controller';
import { UserStoreService } from './user.store.service';

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
  controllers: [UserGrpcController],
  providers: [UserStoreService]
})
export class AppModule {}
