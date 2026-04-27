export interface DomainEvent {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  trace_id: string;
  producer: string;
  payload: Record<string, unknown>;
}
