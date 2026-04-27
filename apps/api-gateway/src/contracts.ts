import { Observable } from 'rxjs';

export interface AuthGrpcService {
  Register(data: {
    email: string;
    password: string;
    display_name: string;
  }): Observable<AuthResponse>;
  Login(data: { email: string; password: string }): Observable<AuthResponse>;
  ValidateToken(data: { access_token: string }): Observable<ValidateTokenResponse>;
}

export interface GroupGrpcService {
  CreateGroup(data: {
    name: string;
    description: string;
    owner_user_id: string;
  }): Observable<{ group_id: string; name: string; description: string; owner_user_id: string }>;
  ListMyGroups(data: {
    user_id: string;
  }): Observable<{
    items: Array<{
      group_id: string;
      name: string;
      description: string;
      owner_user_id: string;
    }>;
  }>;
  AddMember(data: {
    group_id: string;
    requester_user_id: string;
    member_user_id: string;
  }): Observable<{ ok: boolean }>;
  RemoveMember(data: {
    group_id: string;
    requester_user_id: string;
    member_user_id: string;
  }): Observable<{ ok: boolean }>;
  ListGroupMembers(data: {
    group_id: string;
    requester_user_id: string;
  }): Observable<{
    items: Array<{
      user_id: string;
      display_name: string;
      email: string;
      is_admin: boolean;
    }>;
  }>;
  CreateChannel(data: {
    group_id: string;
    requester_user_id: string;
    name: string;
    description: string;
  }): Observable<{
    channel_id: string;
    group_id: string;
    name: string;
    description: string;
  }>;
  ListGroupChannels(data: {
    group_id: string;
    requester_user_id: string;
  }): Observable<{
    items: Array<{
      channel_id: string;
      group_id: string;
      name: string;
      description: string;
      is_default: boolean;
    }>;
  }>;
}

export interface MessageGrpcService {
  CreateAttachmentUpload(data: {
    owner_user_id: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
  }): Observable<{
    attachment_id: string;
    upload_url: string;
    method: string;
    headers?: Record<string, string>;
    expires_in_seconds: number;
    file_name: string;
    content_type: string;
    size_bytes: number;
  }>;
  CompleteAttachmentUpload(data: {
    attachment_id: string;
    requester_user_id: string;
  }): Observable<AttachmentItem>;
  GetAttachment(data: { attachment_id: string; requester_user_id: string }): Observable<AttachmentItem>;
  SendChannelMessage(data: {
    channel_id: string;
    sender_user_id: string;
    body: string;
    attachment_ids: string[];
    idempotency_key: string;
  }): Observable<{
    message_id: string;
    channel_id: string;
    sender_user_id: string;
    body: string;
    seq: number;
    created_at: string;
    delivered: boolean;
    read: boolean;
    delivered_count: number;
    read_count: number;
    attachments: AttachmentItem[];
  }>;
  ListChannelMessages(data: {
    channel_id: string;
    requester_user_id: string;
    limit: number;
  }): Observable<{
    items: Array<{
      message_id: string;
      channel_id: string;
      sender_user_id: string;
      body: string;
      seq: number;
      created_at: string;
      delivered: boolean;
      read: boolean;
      delivered_count: number;
      read_count: number;
      attachments: AttachmentItem[];
    }>;
  }>;
  SendDirectMessage(data: {
    sender_user_id: string;
    recipient_user_id: string;
    body: string;
    attachment_ids: string[];
    idempotency_key: string;
  }): Observable<{
    message_id: string;
    channel_id: string;
    sender_user_id: string;
    body: string;
    seq: number;
    created_at: string;
    delivered: boolean;
    read: boolean;
    delivered_count: number;
    read_count: number;
    attachments: AttachmentItem[];
  }>;
  ListDirectMessages(data: {
    requester_user_id: string;
    peer_user_id: string;
    limit: number;
  }): Observable<{
    items: Array<{
      message_id: string;
      channel_id: string;
      sender_user_id: string;
      body: string;
      seq: number;
      created_at: string;
      delivered: boolean;
      read: boolean;
      delivered_count: number;
      read_count: number;
      attachments: AttachmentItem[];
    }>;
  }>;
  MarkDelivered(data: { message_id: string; user_id: string }): Observable<{ ok: boolean }>;
  MarkRead(data: { message_id: string; user_id: string }): Observable<{ ok: boolean }>;
}

export interface AttachmentItem {
  attachment_id: string;
  owner_user_id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
  download_url: string;
}

export interface UserGrpcService {
  AddContact(data: { owner_user_id: string; contact_user_id: string }): Observable<{ ok: boolean }>;
  ListContacts(data: {
    owner_user_id: string;
  }): Observable<{
    items: Array<{
      user_id: string;
      display_name: string;
      email: string;
    }>;
  }>;
  BlockUser(data: { blocker_user_id: string; blocked_user_id: string }): Observable<{ ok: boolean }>;
  SetPresence(data: { user_id: string; status: string }): Observable<{ ok: boolean }>;
  GetPresence(data: { user_id: string }): Observable<{ online: boolean; state: string; ttl_seconds: number }>;
}

export interface AuthResponse {
  user_id: string;
  email: string;
  display_name: string;
  access_token: string;
}

export interface ValidateTokenResponse {
  valid: boolean;
  user_id: string;
  email: string;
}
