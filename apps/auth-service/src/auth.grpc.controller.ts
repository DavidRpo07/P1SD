import { status as GrpcStatus } from '@grpc/grpc-js';
import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { AuthStoreService } from './auth.store.service';

@Controller()
export class AuthGrpcController {
  constructor(private readonly authStoreService: AuthStoreService) {}

  @GrpcMethod('AuthService', 'Register')
  async register(data: { email: string; password: string; display_name: string }) {
    try {
      return await this.authStoreService.register(data.email, data.password, data.display_name);
    } catch (error) {
      if (error instanceof Error && error.message === 'AUTH_EMAIL_EXISTS') {
        throw new RpcException({
          code: GrpcStatus.ALREADY_EXISTS,
          message: 'AUTH_EMAIL_EXISTS'
        });
      }
      throw error;
    }
  }

  @GrpcMethod('AuthService', 'Login')
  async login(data: { email: string; password: string }) {
    return this.authStoreService.login(data.email, data.password);
  }

  @GrpcMethod('AuthService', 'ValidateToken')
  validateToken(data: { access_token: string }) {
    return this.authStoreService.validateToken(data.access_token);
  }

  @GrpcMethod('AuthService', 'GetUserById')
  getUserById(data: { user_id: string }) {
    return this.authStoreService.getUserById(data.user_id);
  }

  @GrpcMethod('AuthService', 'GetUsersByIds')
  getUsersByIds(data: { user_ids: string[] }) {
    return this.authStoreService.getUsersByIds(data.user_ids || []);
  }
}
