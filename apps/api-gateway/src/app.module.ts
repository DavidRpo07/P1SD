import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AuthController } from './auth.controller';
import { FilesController } from './files.controller';
import { GroupController } from './group.controller';
import { MessageController } from './message.controller';
import { PresenceController } from './presence.controller';
import { RequestAuthService } from './request-auth.service';
import { UsersController } from './users.controller';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'AUTH_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'auth',
          protoPath: join(__dirname, '../../../packages/contracts/proto/auth.proto'),
          url: process.env.AUTH_GRPC_URL || 'localhost:50051',
          loader: {
            keepCase: true,
            longs: Number
          }
        }
      },
      {
        name: 'GROUP_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'groups',
          protoPath: join(__dirname, '../../../packages/contracts/proto/group.proto'),
          url: process.env.GROUP_GRPC_URL || 'localhost:50052',
          loader: {
            keepCase: true,
            longs: Number
          }
        }
      },
      {
        name: 'MESSAGE_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'messaging',
          protoPath: join(__dirname, '../../../packages/contracts/proto/message.proto'),
          url: process.env.MESSAGE_GRPC_URL || 'localhost:50053',
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
          url: process.env.USER_GRPC_URL || 'localhost:50054',
          loader: {
            keepCase: true,
            longs: Number
          }
        }
      }
    ])
  ],
  controllers: [AuthController, GroupController, MessageController, UsersController, PresenceController, FilesController],
  providers: [RequestAuthService]
})
export class AppModule {}
