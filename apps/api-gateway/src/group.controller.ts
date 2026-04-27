import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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
import { GroupGrpcService } from './contracts';
import { RequestAuthService } from './request-auth.service';

@Controller('groups')
export class GroupController {
  private groupService!: GroupGrpcService;

  constructor(
    @Inject('GROUP_GRPC') private readonly groupClient: ClientGrpc,
    private readonly requestAuthService: RequestAuthService
  ) {}

  onModuleInit() {
    this.groupService = this.groupClient.getService<GroupGrpcService>('GroupService');
  }

  @Post()
  async createGroup(
    @Headers('authorization') authorization: string,
    @Body() body: { name: string; description: string }
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.groupService.CreateGroup({
          name: body.name,
          description: body.description || '',
          owner_user_id: userId
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Get()
  async listMyGroups(@Headers('authorization') authorization: string): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.groupService.ListMyGroups({
          user_id: userId
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Post(':groupId/members')
  async addMember(
    @Headers('authorization') authorization: string,
    @Param('groupId') groupId: string,
    @Body() body: { member_user_id: string }
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.groupService.AddMember({
          group_id: groupId,
          requester_user_id: userId,
          member_user_id: body.member_user_id
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Delete(':groupId/members/:memberUserId')
  async removeMember(
    @Headers('authorization') authorization: string,
    @Param('groupId') groupId: string,
    @Param('memberUserId') memberUserId: string
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.groupService.RemoveMember({
          group_id: groupId,
          requester_user_id: userId,
          member_user_id: memberUserId
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Get(':groupId/members')
  async listGroupMembers(
    @Headers('authorization') authorization: string,
    @Param('groupId') groupId: string
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.groupService.ListGroupMembers({
          group_id: groupId,
          requester_user_id: userId
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Post(':groupId/channels')
  async createChannel(
    @Headers('authorization') authorization: string,
    @Param('groupId') groupId: string,
    @Body() body: { name: string; description?: string }
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.groupService.CreateChannel({
          group_id: groupId,
          requester_user_id: userId,
          name: body.name || '',
          description: body.description || ''
        })
      );
    } catch (error) {
      this.rethrowGrpcError(error);
    }
  }

  @Get(':groupId/channels')
  async listGroupChannels(
    @Headers('authorization') authorization: string,
    @Param('groupId') groupId: string
  ): Promise<unknown> {
    const userId = await this.requestAuthService.extractUserIdFromBearer(authorization);
    try {
      return await lastValueFrom(
        this.groupService.ListGroupChannels({
          group_id: groupId,
          requester_user_id: userId
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
      if (code === 6) {
        throw new ConflictException(message);
      }
      if (code === 7) {
        throw new ForbiddenException(message);
      }
    }

    throw new InternalServerErrorException('Internal server error');
  }
}
