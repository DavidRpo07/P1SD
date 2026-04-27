import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { MessageStoreService } from './message.store.service';

@Controller()
export class MessageGrpcController {
  constructor(private readonly messageStoreService: MessageStoreService) {}

  @GrpcMethod('MessageService', 'CreateAttachmentUpload')
  async createAttachmentUpload(data: {
    owner_user_id: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
  }) {
    try {
      return await this.messageStoreService.createAttachmentUpload(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  @GrpcMethod('MessageService', 'CompleteAttachmentUpload')
  async completeAttachmentUpload(data: { attachment_id: string; requester_user_id: string }) {
    try {
      return await this.messageStoreService.completeAttachmentUpload(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  @GrpcMethod('MessageService', 'GetAttachment')
  async getAttachment(data: { attachment_id: string; requester_user_id: string }) {
    try {
      return await this.messageStoreService.getAttachment(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  @GrpcMethod('MessageService', 'SendChannelMessage')
  async sendChannelMessage(data: {
    channel_id: string;
    sender_user_id: string;
    body: string;
    attachment_ids: string[];
    idempotency_key: string;
  }) {
    try {
      return await this.messageStoreService.sendChannelMessage(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  @GrpcMethod('MessageService', 'ListChannelMessages')
  async listChannelMessages(data: { channel_id: string; requester_user_id: string; limit: number }) {
    try {
      return await this.messageStoreService.listChannelMessages(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  @GrpcMethod('MessageService', 'SendDirectMessage')
  async sendDirectMessage(data: {
    sender_user_id: string;
    recipient_user_id: string;
    body: string;
    attachment_ids: string[];
    idempotency_key: string;
  }) {
    try {
      return await this.messageStoreService.sendDirectMessage(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  @GrpcMethod('MessageService', 'ListDirectMessages')
  async listDirectMessages(data: { requester_user_id: string; peer_user_id: string; limit: number }) {
    try {
      return await this.messageStoreService.listDirectMessages(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  @GrpcMethod('MessageService', 'MarkDelivered')
  async markDelivered(data: { message_id: string; user_id: string }) {
    try {
      return await this.messageStoreService.markDelivered(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  @GrpcMethod('MessageService', 'MarkRead')
  async markRead(data: { message_id: string; user_id: string }) {
    try {
      return await this.messageStoreService.markRead(data);
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  private toRpcException(error: unknown) {
    if (typeof error !== 'object' || error === null) {
      return new RpcException({ code: status.INTERNAL, message: 'Internal server error' });
    }

    const message = this.extractMessage(error);
    const httpStatus = this.extractHttpStatus(error);

    if (httpStatus === 400) {
      return new RpcException({ code: status.INVALID_ARGUMENT, message });
    }
    if (httpStatus === 403) {
      return new RpcException({ code: status.PERMISSION_DENIED, message });
    }
    if (httpStatus === 404) {
      return new RpcException({ code: status.NOT_FOUND, message });
    }

    return new RpcException({ code: status.INTERNAL, message: message || 'Internal server error' });
  }

  private extractMessage(error: { message?: unknown; response?: { message?: unknown } }) {
    if (typeof error.message === 'string' && error.message) {
      return error.message;
    }
    if (typeof error.response?.message === 'string' && error.response.message) {
      return error.response.message;
    }
    if (Array.isArray(error.response?.message) && typeof error.response.message[0] === 'string') {
      return error.response.message[0];
    }
    return 'Internal server error';
  }

  private extractHttpStatus(error: { status?: unknown }) {
    if (typeof error.status === 'number') {
      return error.status;
    }
    return null;
  }
}
