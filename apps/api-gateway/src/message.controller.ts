import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { MessageGrpcService } from './contracts';
import { RequestAuthService } from './request-auth.service';

@Controller('messages')
export class MessageController {
  private messageService!: MessageGrpcService;

  constructor(
    @Inject('MESSAGE_GRPC') private readonly messageClient: ClientGrpc,
    private readonly requestAuthService: RequestAuthService
  ) {}

  onModuleInit() {
    this.messageService = this.messageClient.getService<MessageGrpcService>('MessageService');
  }

  @Post('channels/:channelId')
  async sendChannelMessage(
    @Headers('authorization') authorization: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Param('channelId') channelId: string,
    @Body() body: { body: string; attachment_ids?: string[] }
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.messageService.SendChannelMessage({
          channel_id: channelId,
          sender_user_id: userId,
          body: body.body,
          attachment_ids: body.attachment_ids || [],
          idempotency_key: idempotencyKey || ''
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Get('channels/:channelId')
  async listChannelMessages(
    @Headers('authorization') authorization: string,
    @Param('channelId') channelId: string,
    @Query('limit') limit = '50'
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.messageService.ListChannelMessages({
          channel_id: channelId,
          requester_user_id: userId,
          limit: Number(limit)
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Post('direct/:userId')
  async sendDirectMessage(
    @Headers('authorization') authorization: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Param('userId') userId: string,
    @Body() body: { body: string; attachment_ids?: string[] }
  ): Promise<unknown> {
    const senderUserId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.messageService.SendDirectMessage({
          sender_user_id: senderUserId,
          recipient_user_id: userId,
          body: body.body,
          attachment_ids: body.attachment_ids || [],
          idempotency_key: idempotencyKey || ''
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Get('direct/:userId')
  async listDirectMessages(
    @Headers('authorization') authorization: string,
    @Param('userId') userId: string,
    @Query('limit') limit = '50'
  ): Promise<unknown> {
    const requesterUserId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.messageService.ListDirectMessages({
          requester_user_id: requesterUserId,
          peer_user_id: userId,
          limit: Number(limit)
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Post(':messageId/delivered')
  async markDelivered(
    @Headers('authorization') authorization: string,
    @Param('messageId') messageId: string
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.messageService.MarkDelivered({
          message_id: messageId,
          user_id: userId
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Post(':messageId/read')
  async markRead(
    @Headers('authorization') authorization: string,
    @Param('messageId') messageId: string
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.messageService.MarkRead({
          message_id: messageId,
          user_id: userId
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
    if (grpcCode === 7) {
      throw new ForbiddenException(message);
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
