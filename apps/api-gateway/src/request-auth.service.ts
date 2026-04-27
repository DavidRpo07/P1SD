import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { AuthGrpcService, UserGrpcService } from './contracts';

@Injectable()
export class RequestAuthService {
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

  async extractUserIdFromBearer(authHeader?: string): Promise<string> {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.slice('Bearer '.length);
    if (!token) {
      throw new BadRequestException('Token vacío');
    }

    const res = await lastValueFrom(this.authService.ValidateToken({ access_token: token }));
    if (!res.valid) {
      throw new UnauthorizedException('Token inválido');
    }

    this.touchPresenceBestEffort(res.user_id).catch(() => undefined);
    return res.user_id;
  }

  private async touchPresenceBestEffort(userId: string) {
    try {
      await lastValueFrom(
        this.userService.SetPresence({
          user_id: userId,
          status: 'online'
        })
      );
    } catch {
      // Presencia es best-effort: no debe tumbar la solicitud principal.
    }
  }
}
