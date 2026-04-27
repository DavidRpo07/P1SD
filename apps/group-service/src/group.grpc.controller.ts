import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { GroupStoreService } from './group.store.service';

@Controller()
export class GroupGrpcController {
  constructor(private readonly groupStoreService: GroupStoreService) {}

  @GrpcMethod('GroupService', 'CreateGroup')
  createGroup(data: { name: string; description: string; owner_user_id: string }) {
    return this.wrap(() => this.groupStoreService.createGroup(data.name, data.description, data.owner_user_id));
  }

  @GrpcMethod('GroupService', 'ListMyGroups')
  listMyGroups(data: { user_id: string }) {
    return this.wrap(() => this.groupStoreService.listMyGroups(data.user_id));
  }

  @GrpcMethod('GroupService', 'AddMember')
  addMember(data: { group_id: string; requester_user_id: string; member_user_id: string }) {
    return this.wrap(() =>
      this.groupStoreService.addMember(data.group_id, data.requester_user_id, data.member_user_id)
    );
  }

  @GrpcMethod('GroupService', 'RemoveMember')
  removeMember(data: { group_id: string; requester_user_id: string; member_user_id: string }) {
    return this.wrap(() =>
      this.groupStoreService.removeMember(data.group_id, data.requester_user_id, data.member_user_id)
    );
  }

  @GrpcMethod('GroupService', 'ListGroupMembers')
  listGroupMembers(data: { group_id: string; requester_user_id: string }) {
    return this.wrap(() => this.groupStoreService.listGroupMembers(data.group_id, data.requester_user_id));
  }

  @GrpcMethod('GroupService', 'CreateChannel')
  createChannel(data: { group_id: string; requester_user_id: string; name: string; description: string }) {
    return this.wrap(() =>
      this.groupStoreService.createChannel(
        data.group_id,
        data.requester_user_id,
        data.name || '',
        data.description || ''
      )
    );
  }

  @GrpcMethod('GroupService', 'ListGroupChannels')
  listGroupChannels(data: { group_id: string; requester_user_id: string }) {
    return this.wrap(() => this.groupStoreService.listGroupChannels(data.group_id, data.requester_user_id));
  }

  @GrpcMethod('GroupService', 'CheckMembership')
  checkMembership(data: { group_id: string; user_id: string }) {
    return this.wrap(() => this.groupStoreService.checkMembership(data.group_id, data.user_id));
  }

  @GrpcMethod('GroupService', 'CheckChannelMembership')
  checkChannelMembership(data: { channel_id: string; user_id: string }) {
    return this.wrap(() => this.groupStoreService.checkChannelMembership(data.channel_id, data.user_id));
  }

  private async wrap<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      throw this.toRpcException(error);
    }
  }

  private toRpcException(error: unknown) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('status' in error) ||
      typeof error.status !== 'number'
    ) {
      return new RpcException({ code: status.INTERNAL, message: 'Internal server error' });
    }

    const typedError = error as { status: number; message?: unknown; response?: { message?: unknown } };
    const message = this.extractMessage(typedError);
    const httpStatus = typedError.status;

    if (httpStatus === 400) {
      return new RpcException({ code: status.INVALID_ARGUMENT, message });
    }
    if (httpStatus === 403) {
      return new RpcException({ code: status.PERMISSION_DENIED, message });
    }
    if (httpStatus === 404) {
      return new RpcException({ code: status.NOT_FOUND, message });
    }
    if (httpStatus === 409) {
      return new RpcException({ code: status.ALREADY_EXISTS, message });
    }

    return new RpcException({ code: status.INTERNAL, message });
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
}
