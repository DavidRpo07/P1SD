import { Observable } from 'rxjs';

export interface GroupGrpcService {
  CheckMembership(data: { group_id: string; user_id: string }): Observable<{ is_member: boolean }>;
  CheckChannelMembership(data: {
    channel_id: string;
    user_id: string;
  }): Observable<{ is_member: boolean; group_id: string }>;
}

export interface UserGrpcService {
  CheckDirectMessagingPolicy(data: {
    requester_user_id: string;
    peer_user_id: string;
  }): Observable<{ allowed: boolean; reason: string }>;
}
