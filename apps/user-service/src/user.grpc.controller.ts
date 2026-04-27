import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { UserStoreService } from './user.store.service';

@Controller()
export class UserGrpcController {
  constructor(private readonly userStoreService: UserStoreService) {}

  @GrpcMethod('UserService', 'AddContact')
  addContact(data: { owner_user_id: string; contact_user_id: string }) {
    return this.wrap(() => this.userStoreService.addContact(data.owner_user_id, data.contact_user_id));
  }

  @GrpcMethod('UserService', 'ListContacts')
  listContacts(data: { owner_user_id: string }) {
    return this.wrap(() => this.userStoreService.listContacts(data.owner_user_id));
  }

  @GrpcMethod('UserService', 'BlockUser')
  blockUser(data: { blocker_user_id: string; blocked_user_id: string }) {
    return this.wrap(() => this.userStoreService.blockUser(data.blocker_user_id, data.blocked_user_id));
  }

  @GrpcMethod('UserService', 'CheckDirectMessagingPolicy')
  checkDirectMessagingPolicy(data: { requester_user_id: string; peer_user_id: string }) {
    return this.wrap(() => this.userStoreService.checkDirectMessagingPolicy(data.requester_user_id, data.peer_user_id));
  }

  @GrpcMethod('UserService', 'SetPresence')
  setPresence(data: { user_id: string; status: string }) {
    return this.wrap(() => this.userStoreService.setPresence(data.user_id, data.status));
  }

  @GrpcMethod('UserService', 'GetPresence')
  getPresence(data: { user_id: string }) {
    return this.wrap(() => this.userStoreService.getPresence(data.user_id));
  }

  private async wrap<T>(fn: () => Promise<T>) {
    try {
      return await fn();
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
    if (httpStatus === 404) {
      return new RpcException({ code: status.NOT_FOUND, message });
    }
    if (httpStatus === 409) {
      return new RpcException({ code: status.ALREADY_EXISTS, message });
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
