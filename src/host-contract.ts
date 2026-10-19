/** Proposal v1: private local host contract; importing it starts no CLI or server. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Message = { id: string; sender: 'human' | 'agent'; text?: string; data?: { [key: string]: Json }; context?: { [key: string]: Json } };
export type Selection = { connection?: string };
export type Operations = {
  'discovery': { domain: string };
  'connection.start': { domain: string };
  'connection.list': Record<string, never>;
  'login.start': { scopes: string[] } & ({ connection: string; domain?: never; replaceConnection?: never } | { domain: string; replaceConnection?: string; connection?: never });
  'login.status': { operation: string };
  'login.cancel': { operation: string };
  'logout': Selection;
  'operation.status': { operation: string };
  'conversation.start': Selection & { sendOperation: string; message: Message; waitSeconds?: number };
  'conversation.send': Selection & { conversation: string; sendOperation: string; message: Message; waitSeconds?: number; cursor?: string };
  'conversation.read': Selection & { conversation: string; cursor?: string; waitSeconds?: number; consumer?: string };
  'conversation.ack': Selection & { conversation: string; consumer: string; cursor: string };
  'conversation.handoff': Selection & { conversation: string };
  'conversation.direct': Selection & { conversation: string; sendOperation: string; message: Message; waitSeconds?: number };
  'conversation.close': Selection & { conversation: string };
};
export type Operation = keyof Operations;
export type HostRequest = { [K in Operation]: { version: 1; requestId: string; operation: K; params: Operations[K] } }[Operation];
export type ErrorCategory = 'invalid_input' | 'unsupported_capability' | 'authorization_required' | 'permission_denied' | 'conflict' | 'history_gap' | 'transport_failure' | 'uncertain_outcome' | 'version_mismatch' | 'oversized_result';
export type ProtocolFailure = { status: number; code?: string; retryAfter?: string; extension?: string; conversation_id?: string };
export type NextAction = { type: 'inspect_operation'; operation: string } | { type: 'sign_in' } | { type: 'select_connection'; connections: string[] } | { type: 'retry'; afterSeconds?: number };
export type HostResponse = {
  version: 1;
  requestId: string;
  operation: Operation;
  status: 'succeeded' | 'accepted' | 'pending' | 'failed';
  result?: { [key: string]: Json };
  error?: { category: ErrorCategory; message: string; protocol?: ProtocolFailure };
  nextAction?: NextAction;
};
export type Profile = { name: string; pipe: string; connection?: string };


