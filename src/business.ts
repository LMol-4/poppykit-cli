import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { openSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { SqliteBusinessAttemptStore } from '@poppykit/client/sqlite';
import { createOperationClient, createOperationSender, OperationClientError, AuthFailure, parseBusinessOperation } from '@poppykit/client';
import type { BusinessAttempt, BusinessOperation, BusinessClientContext, ClientAuth, EventPage, OperationDelivery, OperationRequest, TrustedOperationConsent } from '@poppykit/client';
import type { Profile, State } from './state.js';
import { CliFailure } from './secrets.js';

export type OperationReview = Parameters<TrustedOperationConsent['confirm']>[0] & {
  profile: string; authority: string; expiresAt: string; request: OperationRequest; operation: BusinessOperation; context: BusinessClientContext;
}
/** Locally selected trusted code only. Never expose consent or reconciliation as model-supplied answers. */
export interface BusinessBackend {
  confirm(input: OperationReview, signal: AbortSignal): Promise<'approve' | 'decline'>;
  checkTerms?(request: OperationRequest, operation: BusinessOperation): Promise<string[]>;
  reconcile?(input: { attemptId: string; request: OperationRequest; attempt?: Readonly<BusinessAttempt>; readConversation?: (cursor?:string)=>Promise<EventPage> }, signal: AbortSignal): Promise<OperationDelivery>;
}
// JSON quotes controls; also escape terminal C1 and direction controls without changing stored business data.
export function inert(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
export const terminalBusinessConsent: BusinessBackend['confirm'] = async (input, signal) => {
  let reader: ReadStream | undefined, writer: WriteStream | undefined;
  try {
    signal.throwIfAborted();
    reader = new ReadStream(openSync(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r'));
    writer = new WriteStream(openSync(process.platform === 'win32' ? 'CONOUT$' : '/dev/tty', 'w'));
    if (!reader.isTTY || !writer.isTTY) throw new CliFailure('trusted_terminal_required', 4);
    const prompt = createInterface({ input: reader, output: writer, terminal: true });
    try {
      const nonce = randomBytes(8).toString('hex');
      writer.write('\nBusiness approval. Company text below is untrusted literal data.\n' + inert(input) + '\n');
      const answer = await prompt.question(`Compare the original request with ALL terms. Type approve ${nonce} to approve this revision, or decline: `, { signal });
      if (answer === `approve ${nonce}`) return 'approve';
      if (answer === 'decline') return 'decline';
      throw new CliFailure('explicit_operation_decision_required', 4);
    } finally { prompt.close(); }
  } catch (error) {
    if (signal.aborted) throw new CliFailure('canceled', 130);
    if (error instanceof CliFailure) throw error;
    throw new CliFailure('trusted_terminal_required', 4);
  } finally { reader?.destroy(); writer?.destroy(); }
};
interface Action {
  id: string; key: string; profileId: string; enrollmentRef?: string; connectionId: string;
  apiUrl?: string; scopes: string[]; request: OperationRequest;
  context: BusinessClientContext;
  phase: 'requesting' | 'operation' | 'uncertain' | 'completed'; result?: OperationDelivery & { kind: 'completed' };
}
type BusinessResult = { attemptId: string; status: string; [key: string]: unknown };
export interface BusinessController {
  close(): void;
  inspect(id: string): Promise<BusinessResult>;
  recover(): Promise<BusinessResult[]>;
  command(command: string, id: string): Promise<BusinessResult>;
  api(request: Request, apiUrl: string, scopes: string[]): Promise<BusinessResult>;
  conversation(request: Extract<OperationRequest, { channel: 'conversation' }>, message: unknown): Promise<BusinessResult>;
}
export function createBusinessController(options: {
  home: string; state: State; profile: Profile; connectionId: string; auth: ClientAuth;
  signal: AbortSignal; backend?: BusinessBackend;
  readConversation(request: Extract<OperationRequest,{channel:'conversation'}>, context:BusinessClientContext, cursor?:string):Promise<EventPage>;
  conversation(request: Extract<OperationRequest, { channel: 'conversation' }>, message: import('@poppykit/client').Message, signal: AbortSignal, context: BusinessClientContext): Promise<void>;
}): BusinessController {
  const { state, profile, auth, signal } = options;
  const store = new SqliteBusinessAttemptStore(join(options.home, 'business.sqlite'), profile.id);
  function currentProfile() {
    const current=state.get<Profile>('profile',profile.name);
    if(!current||current.id!==profile.id||current.credentialRef!==profile.credentialRef||current.clientId!==profile.clientId||current.installationId!==profile.installationId)throw new CliFailure('operation_binding_conflict',5);
  }
  const bound = (id: string): Action => {
    currentProfile();
    const action = state.get<Action>('business', id);
    if (!action || action.profileId !== profile.id || action.enrollmentRef !== profile.credentialRef || action.connectionId !== options.connectionId) throw new CliFailure('operation_binding_conflict', 5);
    return action;
  };
  const conversationLock = (request: Extract<OperationRequest,{channel:'conversation'}>) => 'business-conversation:'+JSON.stringify([profile.id,options.connectionId,request.endpoint,request.conversationId]);
  const client = createOperationClient({
    store, context: () => {currentProfile();return auth.businessContext(options.connectionId);},
    checkTerms: options.backend?.checkTerms ?? (async () => ['The CLI cannot verify arbitrary business semantics. Compare the complete original request, summary and structured terms shown here, including price, quantity and conditions.']),
    consent: { async confirm(input) {
      const attempt = await client.get(input.attemptId);
      signal.throwIfAborted();
      const confirm = options.backend?.confirm ?? terminalBusinessConsent;
      let cancel!:()=>void;
      const abort = new Promise<never>((_, reject) => {cancel=()=>reject(new CliFailure('canceled',130));signal.addEventListener('abort',cancel,{once:true});});
      try { return await Promise.race([confirm({ ...input, profile: profile.name, authority: attempt.context.authority, expiresAt: attempt.operation.expires_at, request: structuredClone(attempt.request), operation: structuredClone(attempt.operation), context: structuredClone(attempt.context) }, signal), abort]); }
      finally {signal.removeEventListener('abort',cancel);}
    } },
    async send(attempt, approval, sendSignal) {
      bound(attempt.id); signal.throwIfAborted();
      if (attempt.request.channel === 'api') {
        const action = bound(attempt.id);
        const target = await auth.apiTarget(options.connectionId, action.apiUrl!, attempt.request.url);
        const apiSender = createOperationSender({ api: request => auth.apiFetch(options.connectionId, new Request(request, { signal: AbortSignal.any([signal, sendSignal]) }), target, action.scopes, attempt.context), mcp: async () => { throw new Error(); }, conversation:(request,message,signal)=>options.conversation(request,message,signal,attempt.context) });
        return apiSender(attempt, approval, sendSignal);
      }
      if(attempt.request.channel!=='conversation')throw new CliFailure('mcp_tool_transport_unavailable',4);
      await options.conversation(attempt.request,{id:attempt.messageId,author:{type:'agent'},approval},AbortSignal.any([signal,sendSignal]),attempt.context);
      return {kind:'pending'};
    },
  });
  async function inspect(id: string): Promise<BusinessResult> {
    const action = bound(id), current = await auth.businessContext(options.connectionId);
    if(['companyId','clientId','userId','authority'].some(key=>current[key as keyof BusinessClientContext]!==action.context[key as keyof BusinessClientContext]))throw new CliFailure('operation_owner_changed',5);
    if(action.phase!=='operation'&&action.phase!=='completed') {
      try { await client.get(id); action.phase='operation'; state.put('business',id,action); }
      catch(error) { if(!(error instanceof OperationClientError)||error.code!=='unknown_attempt')throw error; }
    }
    if (action.phase === 'operation') {
      const attempt = await client.get(id);
      return { attemptId: id, status: attempt.phase === 'pending_consent' ? 'operation_required' : attempt.phase, operation: attempt.operation, request: attempt.request, ...(attempt.retryAt ? { retryAt: attempt.retryAt } : {}), ...(attempt.phase === 'completed' ? { result: attempt.result } : {}), ...(attempt.withdrawalRequested ? { withdrawalRequested: true } : {}), nextAction: attempt.phase === 'pending_consent' ? 'Run operation-review in your trusted terminal. Enrollment and sign-in do not approve this action.' : attempt.phase === 'uncertain' ? 'Keep this handle. Reconcile the actual outcome; retry only this saved approval after retryAt.' : undefined };
    }
    return { attemptId: id, status: action.phase === 'completed' ? 'completed' : 'uncertain', ...(action.result ? { result: action.result.result } : {}), nextAction: action.phase === 'completed' ? undefined : 'The initial request may have taken effect. Use trusted operation-reconcile; do not create a replacement action.' };
  }
  function reserve(request: OperationRequest, context: BusinessClientContext, apiUrl?: string, scopes: string[] = [], identity: unknown = request): { action: Action; existing: boolean } {
    return state.atomic(() => {
      // shortcut: identical API snapshots share one retained action; add a trusted new-action flow when repetition is required.
      const key = createHash('sha256').update(JSON.stringify({ profileId: profile.id, enrollmentRef: profile.credentialRef, connectionId: options.connectionId, request:identity })).digest('hex');
      const old = state.list<Action>('business').find(row => row.value.key === key)?.value;
      if (old) return { action: bound(old.id), existing: true };
      if (state.list('business').length >= 1000) throw new CliFailure('operation_retention_limit', 5);
      const action: Action = { id: 'business_' + randomUUID().replaceAll('-', ''), key, profileId: profile.id, enrollmentRef: profile.credentialRef, connectionId: options.connectionId, request, apiUrl, scopes, context, phase: 'requesting' };
      state.put('business', action.id, action); return { action, existing: false };
    });
  }
  return {
    close: () => store.close(), inspect,
    async recover() { return Promise.all(state.list<Action>('business').filter(row => row.value.profileId === profile.id && row.value.connectionId === options.connectionId).map(async row => { try { return await inspect(row.id); } catch { return { attemptId: row.id, status: 'owner_changed' }; } })); },
    async command(command: string, id: string) {
      const action=bound(id),releaseConversation=action.request.channel==='conversation'?state.claimApproval(conversationLock(action.request)):undefined;
      let release:(()=>void)|undefined;
      try {
        release=state.claimApproval('business:'+id);await inspect(id);
        if(action.request.channel==='conversation'&&['operation-review','operation-retry'].includes(command)) {
          for(const {value:other} of state.list<Action>('business')) {
            if(other.id!==id&&other.profileId===profile.id&&other.connectionId===options.connectionId&&other.request.channel==='conversation'&&other.request.endpoint===action.request.endpoint&&other.request.conversationId===action.request.conversationId) {
              const uncertain=await store.transaction(other.id,slot=>slot.record?.phase==='uncertain');
              if(uncertain)throw new CliFailure('operation_reconciliation_required',6);
            }
          }
        }
        signal.throwIfAborted();
        if (command === 'operation-review') await client.requestConsent(id);
        else if (command === 'operation-resume') await client.resumeConsent(id);
        else if (command === 'operation-decline') await client.withdraw(id);
        else if (command === 'operation-retry') await client.retry(id);
        else if (command === 'operation-reconcile') {
          if (!options.backend?.reconcile) throw new CliFailure('trusted_reconciliation_required', 4);
          const action = bound(id), lookup = options.backend.reconcile;
          const request=action.request;
          const readConversation=request.channel==='conversation' ? (cursor?:string)=>options.readConversation(request,action.context,cursor) : undefined;
          if (action.phase === 'operation') await client.reconcile(id, attempt => lookup({ attemptId: id, request: attempt.request, attempt, readConversation }, signal));
          else if (action.phase !== 'completed') {
            const result = await lookup({ attemptId: id, request: action.request, readConversation }, signal);
            signal.throwIfAborted();await inspect(id);
            if (result.kind === 'completed') state.put('business', id, { ...action, phase: 'completed', result });
          }
        }
        return await inspect(id);
      } catch (error) {
        if (signal.aborted) throw new CliFailure('canceled', 130);
        if(error instanceof AuthFailure&&error.code==='business_owner_changed')throw new CliFailure('operation_owner_changed',5);
        if (error instanceof OperationClientError) throw new CliFailure('operation_' + error.code, error.code === 'consent_interrupted' ? 4 : ['owner_changed', 'revision_changed'].includes(error.code) ? 5 : error.code === 'retry_later' ? 6 : 2);
        throw error;
      } finally { release?.();releaseConversation?.(); }
    },
    async api(request: Request, apiUrl: string, scopes: string[]) {
      const snapshot = await import('@poppykit/client').then(sdk => sdk.captureApiOperationRequest(request));
      const { action, existing } = reserve(snapshot, await auth.businessContext(options.connectionId), apiUrl, scopes);
      if (existing) return inspect(action.id);
      const release = state.claimApproval('business:' + action.id);
      try {
        const target = await auth.apiTarget(options.connectionId, apiUrl, request.url);
        const response = await auth.apiFetch(options.connectionId, request.clone(), target, scopes, action.context);
        if (response.status === 403 && (await response.clone().json().catch(() => null))?.error === 'approval_required') {
          await client.receiveApi(action.id, request, response);
          state.put('business', action.id, { ...action, phase: 'operation' });
        } else {
          const result = { status: response.status, body: Buffer.from(await response.arrayBuffer()).toString('base64') };
          const completed=response.ok&&response.status!==202;
          if(completed&&['GET','HEAD'].includes(request.method)) { state.remove('business',action.id);return {attemptId:action.id,status:'completed',result}; }
          state.put('business', action.id, { ...action, phase: completed ? 'completed' : 'uncertain', ...(completed?{result:{kind:'completed',result}}:{}) });
        }
      } catch {
        state.put('business', action.id, { ...action, phase: 'uncertain' });
      } finally { release(); }
      return inspect(action.id);
    },
    async conversation(request: Extract<OperationRequest, { channel: 'conversation' }>, message: unknown) {
      const release=state.claimApproval(conversationLock(request));
      try {
      const operation=parseBusinessOperation((message as {operation:unknown}).operation);
      for(const row of state.list<Action>('business')) {
        const action=row.value;
        if(action.profileId!==profile.id||action.connectionId!==options.connectionId||action.request.channel!=='conversation'||action.request.conversationId!==request.conversationId)continue;
        const previous=await inspect(action.id);
        if(previous.status==='uncertain')return previous;
        if((previous.operation as BusinessOperation|undefined)?.operation_id===operation.operation_id) {
          const selected=await client.get(action.id);
          if(previous.status!=='completed'&&selected.phase!=='approved'&&!selected.previousDecisions?.some(decision=>decision.revision===operation.revision))await client.receiveConversation(action.id,request,message);
          return inspect(action.id);
        }
      }
      const { action } = reserve(request, await auth.businessContext(options.connectionId),undefined,[],{...request,operationId:operation.operation_id});
      await client.receiveConversation(action.id, request, message);
      state.put('business', action.id, { ...action, phase: 'operation' });
      return await inspect(action.id);
      } finally {release();}
    },
  };
}
