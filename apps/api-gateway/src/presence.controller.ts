import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Put
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { RequestAuthService } from './request-auth.service';
import { UserGrpcService } from './contracts';

@Controller('presence')
export class PresenceController {
  private userService!: UserGrpcService;

  constructor(
    @Inject('USER_GRPC') private readonly userClient: ClientGrpc,
    private readonly requestAuthService: RequestAuthService
  ) {}

  onModuleInit() {
    this.userService = this.userClient.getService<UserGrpcService>('UserService');
  }

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@Headers('authorization') authorization: string): Promise<{ ok: boolean }> {
    await this.requestAuthService.extractUserIdFromBearer(authorization);
    return { ok: true };
  }

  @Put('me')
  async setMyPresence(
    @Headers('authorization') authorization: string,
    @Body() body: { status: string }
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    const status = (body.status || '').toLowerCase().trim();
    if (status !== 'online' && status !== 'offline') {
      throw new BadRequestException('PRESENCE_INVALID_STATUS');
    }

    try {
      return await lastValueFrom(
        this.userService.SetPresence({
          user_id: userId,
          status
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Get(':userId')
  async getPresence(
    @Headers('authorization') authorization: string,
    @Param('userId') userId: string
  ): Promise<unknown> {
    await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.userService.GetPresence({
          user_id: userId
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  private rethrowGrpcError(error: unknown): never {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number') {
      const code = error.code;
      const details = (error as { details?: unknown }).details;
      const message = typeof details === 'string' ? details : 'Internal server error';

      if (code === 3) {
        throw new BadRequestException(message);
      }
      if (code === 5) {
        throw new NotFoundException(message);
      }
    }

    throw new InternalServerErrorException('Internal server error');
  }
}
