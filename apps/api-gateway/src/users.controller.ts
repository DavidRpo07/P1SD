import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Post
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { RequestAuthService } from './request-auth.service';
import { UserGrpcService } from './contracts';

@Controller('users')
export class UsersController {
  private userService!: UserGrpcService;

  constructor(
    @Inject('USER_GRPC') private readonly userClient: ClientGrpc,
    private readonly requestAuthService: RequestAuthService
  ) {}

  onModuleInit() {
    this.userService = this.userClient.getService<UserGrpcService>('UserService');
  }

  @Post('contacts')
  async addContact(
    @Headers('authorization') authorization: string,
    @Body() body: { contact_user_id: string }
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.userService.AddContact({
          owner_user_id: userId,
          contact_user_id: body.contact_user_id
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Get('contacts')
  async listContacts(@Headers('authorization') authorization: string): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.userService.ListContacts({
          owner_user_id: userId
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Post('blocks')
  async blockUser(
    @Headers('authorization') authorization: string,
    @Body() body: { blocked_user_id: string }
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.userService.BlockUser({
          blocker_user_id: userId,
          blocked_user_id: body.blocked_user_id
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  private rethrowGrpcError(error: unknown): never {
    const grpcCode = this.extractGrpcCode(error);
    const message = this.extractGrpcMessage(error);

    if (grpcCode === 3) {
      throw new BadRequestException(message);
    }
    if (grpcCode === 5) {
      throw new NotFoundException(message);
    }

    throw new InternalServerErrorException(message || 'Internal server error');
  }

  private extractGrpcCode(error: unknown): number | null {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number') {
      return error.code;
    }
    return null;
  }

  private extractGrpcMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'details' in error && typeof error.details === 'string') {
      return error.details;
    }
    return 'Internal server error';
  }
}
