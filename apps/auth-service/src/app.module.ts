import { Module } from '@nestjs/common';
import { AuthGrpcController } from './auth.grpc.controller';
import { AuthStoreService } from './auth.store.service';

@Module({
  controllers: [AuthGrpcController],
  providers: [AuthStoreService]
})
export class AppModule {}
