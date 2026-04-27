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
  Post
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { MessageGrpcService } from './contracts';
import { RequestAuthService } from './request-auth.service';

@Controller('files')
export class FilesController {
  private messageService!: MessageGrpcService;

  constructor(
    @Inject('MESSAGE_GRPC') private readonly messageClient: ClientGrpc,
    private readonly requestAuthService: RequestAuthService
  ) {}

  onModuleInit() {
    this.messageService = this.messageClient.getService<MessageGrpcService>('MessageService');
  }

  @Post('upload-url')
  async createUploadUrl(
    @Headers('authorization') authorization: string,
    @Body()
    body: {
      file_name: string;
      content_type: string;
      size_bytes: number;
    }
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);

    try {
      return await lastValueFrom(
        this.messageService.CreateAttachmentUpload({
          owner_user_id: userId,
          file_name: body.file_name || '',
          content_type: body.content_type || '',
          size_bytes: Number(body.size_bytes || 0)
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Post(':attachmentId/complete')
  async completeUpload(
    @Headers('authorization') authorization: string,
    @Param('attachmentId') attachmentId: string
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);

    try {
      return await lastValueFrom(
        this.messageService.CompleteAttachmentUpload({
          attachment_id: attachmentId,
          requester_user_id: userId
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Get(':attachmentId')
  async getAttachment(
    @Headers('authorization') authorization: string,
    @Param('attachmentId') attachmentId: string
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);

    try {
      return await lastValueFrom(
        this.messageService.GetAttachment({
          attachment_id: attachmentId,
          requester_user_id: userId
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
