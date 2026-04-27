import { Body, ConflictException, Controller, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { AuthGrpcService, UserGrpcService } from './contracts';

@Controller('auth')
export class AuthController {
  private authService!: AuthGrpcService;
  private userService!: UserGrpcService;

  constructor(
    @Inject('AUTH_GRPC') private readonly authClient: ClientGrpc,
    @Inject('USER_GRPC') private readonly userClient: ClientGrpc
  ) {}

  onModuleInit() {
    this.authService = this.authClient.getService<AuthGrpcService>('AuthService');
    this.userService = this.userClient.getService<UserGrpcService>('UserService');
  }

  @Post('register')
  async register(
    @Body() body: { email: string; password: string; display_name: string }
  ): Promise<unknown> {
    try {
      const response = await lastValueFrom(this.authService.Register(body));
      await this.markOnlineBestEffort(response.user_id);
      return response;
    } catch (error: unknown) {
      const message = this.extractGrpcMessage(error);
      if (message === 'AUTH_EMAIL_EXISTS') {
        throw new ConflictException('AUTH_EMAIL_EXISTS');
      }
      throw error;
    }
  }

  @Post('login')
  async login(@Body() body: { email: string; password: string }): Promise<unknown> {
    try {
      const response = await lastValueFrom(this.authService.Login(body));
      await this.markOnlineBestEffort(response.user_id);
      return response;
    } catch (error: unknown) {
      const message = this.extractGrpcMessage(error);
      if (message === 'AUTH_INVALID_CREDENTIALS') {
        throw new UnauthorizedException('AUTH_INVALID_CREDENTIALS');
      }
      throw error;
    }
  }

  private extractGrpcMessage(error: unknown): string | null {
    if (typeof error === 'object' && error !== null && 'details' in error) {
      const details = (error as { details?: unknown }).details;
      if (typeof details === 'string') {
        return details;
      }
    }
    return null;
  }

  private async markOnlineBestEffort(userId: string) {
    if (!userId) {
      return;
    }
    try {
      await lastValueFrom(
        this.userService.SetPresence({
          user_id: userId,
          status: 'online'
        })
      );
    } catch {
      // No bloquear login/registro si presencia falla.
    }
  }
}
