#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { State, Profile } from './state.js';
import { CliFailure, openBackend, hiddenInput } from './secrets.js';
import type { SecureBackend } from './secrets.js';
import type { ClientAuth, HttpTransport } from '@poppykit/client';

export const HELP = `Usage: poppykit <command> [--json] [--profile NAME] [--unlock]
Node >=24.12.0. Direct SDK execution; no daemon or PowerShell required.
  setup --provider HTTPS_URL --company DOMAIN [--profile NAME]
  backend --module ABSOLUTE_TRUSTED_MODULE
  profile list | profile remove NAME
  enroll                         operator-authenticated trusted enrollment
  discovery | connect [--anonymous] | connections | scopes [--scope S]
  auth-start --method direct|device|mediated --scope S [--scope S]
  auth-status OP | auth-continue OP | auth-cancel OP | sign-out
  start --text TEXT [--send-operation HANDLE]
  send CONVERSATION --text TEXT [--send-operation HANDLE]
  retry HANDLE | status HANDLE | retry-remove HANDLE
  read CONVERSATION [--cursor CURSOR] | watch CONVERSATION [--consumer NAME]
  ack DELIVERY                   acknowledge a delivered consumer batch
  handoff CONVERSATION | close CONVERSATION
  api-target --api DISCOVERED_URL [--destination VERIFIED_URL]
  api-request --api DISCOVERED_URL --destination VERIFIED_URL [--method GET]
  browser-join --return-to HTTPS_URL | feedback --task TASK --description TEXT
  diagnostics | enrollment-revoke
Unattended use requires a configured secure backend. --unlock explicitly uses
attended encrypted storage with a hidden terminal passphrase each invocation.
Exit: 0 complete/pending, 1 runtime/remote, 2 usage, 3 authorization, 4 secure
backend/trusted input unavailable, 5 binding conflict, 6 uncertain, 130 canceled.
`;
type Reply = { version: 1; command: string; status: 'ok' | 'error'; result?: unknown; error?: { code: string }; requestId: string };
interface Dependencies { sdk?: typeof import('@poppykit/client'); transport?: HttpTransport; backend?: SecureBackend }
function fail(code: string, exitCode = 2): never { throw new CliFailure(code, exitCode); }
const clean = (value: any): any => {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:authorization|dpop|cookie|set-cookie|credential|credentialRef|secret|secretRef|dpopKeyRef|access_token|refresh_token|device_code|code_verifier|assertion|callbackUrl|browserBinding)$/i.test(key)).map(([key, item]) => [key, clean(item)]));
};
const publicProfile = (p: Profile) => ({ id: p.id, name: p.name, provider: p.provider, domain: p.domain, installationId: p.installationId, enrolled: !!p.credentialRef, connectionId: p.connectionId });
function url(value: string): string { try { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search || /[\s\\]/.test(value)) fail('https_url_required'); return u.href; } catch { return fail('https_url_required'); } }
function runtimeSupported(version: string): boolean { const [major, minor] = version.split('.').map(Number); return major > 24 || major === 24 && minor >= 12; }
export { runtimeSupported };
function cancelable(transport:HttpTransport,signal:AbortSignal):HttpTransport {
  const call=(request:Request,options?:Parameters<HttpTransport['fetch']>[1],stream=false)=>new Promise<Response>((resolve,reject)=>{
    const combined=AbortSignal.any([signal,request.signal]);combined.throwIfAborted();
    const cancel=()=>reject(new DOMException('Canceled','AbortError'));combined.addEventListener('abort',cancel,{once:true});
    const next=new Request(request,{signal:combined}),task=stream&&transport.stream?transport.stream(next):transport.fetch(next,options);
    task.then(response=>{if(combined.aborted){void response.body?.cancel().catch(()=>{});cancel();}else resolve(response);},reject).finally(()=>combined.removeEventListener('abort',cancel));
  });
  return {fetch:call,...(transport.stream?{stream:(request:Request)=>call(request,undefined,true)}:{}),close:()=>transport.close?.()};
}
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, deps: Dependencies = {}): Promise<{ out: Reply | string; code: number }> {
  const command = argv[0] ?? 'help', requestId = randomUUID();
  const reply = (result: any) => {if(abort.signal.aborted&&!boundedWatchComplete)throw new CliFailure('canceled',130); const status = result?.outcome?.status ?? result?.status; return { out: { version: 1 as const, command, status: 'ok' as const, result: clean(result), requestId }, code: status === 'uncertain' ? 6 : ['denied','expired','failed'].includes(status) ? 3 : status === 'cancelled' ? 130 : 0 }; };
  let state: State | undefined, backend: SecureBackend | undefined, transport: HttpTransport | undefined, authStore: any, conversationStore: any;
  let retryHandle:string|undefined;
  let boundedWatchComplete=false;
  const abort = new AbortController(), canceled = () => {boundedWatchComplete=false;abort.abort();};
  process.once('SIGINT', canceled); process.once('SIGTERM', canceled);
  try {
    if (!runtimeSupported(process.versions.node)) fail('node_24_12_or_newer_required', 1);
    if (argv.length === 0 || argv.length === 1 && ['help','--help'].includes(command)) return { out: HELP, code: 0 };
    const options = { json: { type: 'boolean' }, profile: { type: 'string' }, unlock: { type: 'boolean' }, provider: { type: 'string' }, company: { type: 'string' }, module: { type: 'string' }, scope: { type: 'string', multiple: true }, method: { type: 'string' }, connection: { type: 'string' }, text: { type: 'string' }, 'send-operation': { type: 'string' }, cursor: { type: 'string' }, consumer: { type: 'string' }, anonymous: { type: 'boolean' }, api: { type: 'string' }, destination: { type: 'string' }, 'return-to': { type: 'string' }, task: { type: 'string' }, description: { type: 'string' } } as const;
    let parsed; try { parsed = parseArgs({ args: argv.slice(1), options, allowPositionals: true }); } catch { return fail('invalid_arguments'); }
    const v = parsed.values, pos = parsed.positionals, str = (key: keyof typeof options) => v[key] as string | undefined;
    const need = (count: number) => { if (pos.length !== count || pos.some(x => !x || x.includes('\0'))) fail('invalid_arguments'); };
    const required = (key: keyof typeof options) => str(key) ?? fail(`required_--${key}`);
    const commands = ['setup','backend','profile','enroll','discovery','connect','connections','scopes','auth-start','auth-status','auth-continue','auth-cancel','sign-out','start','send','retry','status','retry-remove','read','watch','ack','handoff','close','api-target','api-request','browser-join','feedback','diagnostics','enrollment-revoke'];
    if (!commands.includes(command)) fail('unknown_command');
    const home = resolve(env.POPPYKIT_HOME ?? join(homedir(), '.poppykit'));
    const {State: StateStore}=await import('./state.js');
    await mkdir(home, { recursive: true, mode: 0o700 }); state = new StateStore(join(home, 'cli.sqlite'));
    if (command === 'setup') {
      need(0); const provider = url(required('provider')), domain = required('company');
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) || domain.includes('..')) fail('invalid_company_domain');
      return reply({ profile: publicProfile(state.createProfile(str('profile') ?? 'default', provider, domain)), nextAction: 'Configure backend, then enroll through a trusted user route' });
    }
    if (command === 'backend') { need(0); state.put('config','backend',{ module: resolve(required('module')) }); return reply({ configured: true }); }
    if (command === 'profile') {
      if (pos[0] === 'list' && pos.length === 1) return reply({ profiles: state.list<Profile>('profile').map(row => publicProfile(row.value)) });
      if (pos[0] === 'remove' && pos.length === 2) { state.remove('profile', pos[1]); return reply({ removed: pos[1], notice: 'Local profile removed; remote authorization and backend secrets require explicit cleanup' }); }
      return fail('profile_list_or_remove_required');
    }
    if (command === 'diagnostics') { need(0); return reply({ node: process.versions.node, platform: process.platform, storage: home, secureBackendConfigured: !!state.get('config','backend'), headless: !process.stdin.isTTY, execution: 'direct-sdk', browserOpening: 'manual-link' }); }
    if (command === 'retry-remove') {
      need(1);const row=state.get<any>('retry',pos[0]);if(!row)fail('unknown_retry');
      const {SqliteConversationStore}=await import('@poppykit/client/sqlite');const store=new SqliteConversationStore(join(home,'conversations.sqlite'));
      try{store.removeOutbound({connectionId:row.binding.connectionId,issuer:row.binding.issuer,endpoint:row.binding.endpoint},row.messageId);}finally{store.close();}
      state.remove('retry',pos[0]);return reply({removed:pos[0],notice:'Retry payload forgotten; remote accepted work is unaffected'});
    }
    const p = state.profile(str('profile'));
    if(command==='ack') {
      need(1);const delivery=state.get<any>('delivery',pos[0]);if(!delivery||delivery.binding.profileId!==p.id||delivery.binding.enrollmentRef!==p.credentialRef)fail('delivery_binding_conflict',5);
      const {SqliteConversationStore}=await import('@poppykit/client/sqlite');const store=new SqliteConversationStore(join(home,'conversations.sqlite'));
      try{await store.advanceCheckpoint(delivery.key,{connectionId:delivery.key.connectionId,issuer:delivery.key.issuer,conversationId:delivery.conversationId,name:delivery.consumer,cursor:delivery.cursor},[delivery.previous]);}finally{store.close();}
      state.remove('delivery',pos[0]);return reply({acknowledged:true,cursor:delivery.cursor});
    }
    if (command === 'status') { need(1); const row = state.get<any>('retry',pos[0]); if (!row || row.binding.profileId !== p.id) fail('unknown_retry'); return reply({ operation: pos[0], createdAt: row.createdAt, messageId: row.messageId, binding: row.binding }); }
    const sdk = deps.sdk ?? await import('@poppykit/client');
    transport = cancelable(deps.transport ?? sdk.createNodeTransport(),abort.signal);
    let metadata = sdk.createMetadataResolver(transport);
    if (command === 'discovery') { need(0); const found = await metadata.resolveCompany(p.domain); return reply({ organization: found.document.organization, issuer: found.authorization?.issuer, authMethods: ['direct','device','mediated'].filter(method => !!found.document.auth?.[method]), apis: found.document.apis?.map(api => ({ type: api.type, url: api.url, resource: api.resource })), browser: !!found.document.web?.browser_session_endpoint, feedback: !!found.document.feedback }); }
    const config = state.get<{ module: string }>('config','backend');
    backend = deps.backend ?? await openBackend({ module: config?.module, unlock: v.unlock, directory: join(home, 'encrypted-secrets') });
    if (deps.backend) await backend.healthCheck();
    if(backend.transport&&!deps.transport){transport.close?.();transport=cancelable(backend.transport,abort.signal);metadata=sdk.createMetadataResolver(transport);}
    if (command === 'enroll') {
      need(0); if (p.credentialRef) fail('already_enrolled',5);
      const headers = new Headers(await (backend.enrollmentAuth ? backend.enrollmentAuth({ url: p.provider, installationId: p.installationId }) : Promise.resolve({ authorization: `Bearer ${await hiddenInput('Operator enrollment credential')}` })));
      headers.set('content-type', 'application/json');
      const response = await transport.fetch(new Request(`${p.provider.replace(/\/$/,'')}/enroll`, { method: 'POST', headers, body: JSON.stringify({ version: 1, installationId: p.installationId, idempotencyKey: randomUUID() }), signal: abort.signal }));
      if (!response.ok) fail('enrollment_denied',3);
      const result = await response.json() as any;
      if (typeof result.credential !== 'string' || typeof result.clientId !== 'string' || typeof result.callbackUrl !== 'string') fail('invalid_provider_response',1);
      const clientId = url(result.clientId), callbackUrl = url(result.callbackUrl);
      if (new URL(clientId).hostname !== new URL(p.provider).hostname || new URL(callbackUrl).hostname !== new URL(clientId).hostname) fail('provider_identity_mismatch',5);
      const credentialRef = await backend.secrets.stage(result.credential);
      try { state.atomic(() => { const current = state!.get<Profile>('profile',p.name); if (current?.id !== p.id || current.credentialRef) fail('profile_changed',5); state!.put('profile',p.name,{...current,credentialRef,clientId,callbackUrl});state!.put('enrollment',p.id,{provider:p.provider,domain:p.domain,installationId:p.installationId,clientId,callbackUrl,credentialRef}); }); }
      catch (error) { await backend.secrets.remove(credentialRef); throw error; }
      return reply({ enrolled: true, clientId });
    }
    if (!p.credentialRef || !p.clientId || !p.callbackUrl) fail('enrollment_required',3);
    if(JSON.stringify(state.get('enrollment',p.id))!==JSON.stringify({provider:p.provider,domain:p.domain,installationId:p.installationId,clientId:p.clientId,callbackUrl:p.callbackUrl,credentialRef:p.credentialRef}))fail('enrollment_binding_conflict',5);
    const enrollmentCredential=await backend.secrets.read(p.credentialRef)??fail('secure_store_locked',4);
    const { createProviderClient } = await import('@poppykit/client/provider');
    const provider = createProviderClient({ url: p.provider, domain: p.domain, installationId: p.installationId, transport, credential: async () => enrollmentCredential });
    if (command === 'enrollment-revoke') { need(0); await provider.revokeEnrollment(); return reply({ revoked: true, notice: 'Already-issued company credentials remain subject to company expiry/revocation. Revoke company authorization separately.' }); }
    const { SqliteAuthStore, SqliteConversationStore } = await import('@poppykit/client/sqlite');
    authStore = new SqliteAuthStore(join(home, `auth-${p.id}.sqlite`));
    const auth: ClientAuth = sdk.createClientAuth({ namespace: p.id, localUserId: p.installationId, clientId: p.clientId, redirectUris: [p.callbackUrl], identity:backend.identity,assertions: provider, providerIdentity: provider, trustedInput: backend.trustedInput, store: authStore, secrets: backend.secrets, transport, metadata });
    await auth.recover(); // SDK checks actual owner liveness; startup never cancels a live invocation.
    if (command === 'connect') { need(0);if(v.anonymous&&!backend.identity)fail('anonymous_unavailable',4); const outcome = await auth.start(p.domain, { anonymous: v.anonymous }); state.update(p, { connectionId: outcome.connection.id }); return reply(outcome); }
    if (command === 'connections') { need(0); return reply({ connections: await auth.list() }); }
    const connectionId = str('connection') ?? p.connectionId ?? fail('connection_required',2), connection = await auth.get(connectionId);
    if (!connection || connection.domain !== p.domain) fail('connection_binding_conflict',5);
    if (command === 'scopes') { need(0); return reply(await auth.authorization(connectionId, v.scope ?? [])); }
    if (command === 'sign-out') { need(0); return reply(await auth.signOut(connectionId)); }
    if (command === 'auth-start') {
      need(0); const method = str('method') ?? 'direct'; if (!['direct','device','mediated'].includes(method)) fail('invalid_auth_method');
      const browserBinding = randomUUID() + randomUUID();
      const result = await auth.beginSignIn(connectionId,{method: method as any, scopes: v.scope ?? [],redirectUri:p.callbackUrl,browserBinding});
      if (result.authorizationUrl) {
        const secretRef = await backend.secrets.stage(JSON.stringify({ browserBinding, authorizationUrl: result.authorizationUrl }));
        state.put('direct',result.outcome.operationId,{profileId:p.id,connectionId:result.outcome.connection.id,issuer:result.outcome.connection.issuer,sessionId:result.outcome.connection.sessionId,secretRef});
        await provider.beginDirect({operationId:result.outcome.operationId,issuer:result.outcome.connection.issuer,sessionId:result.outcome.connection.sessionId!,state:new URL(result.authorizationUrl).searchParams.get('state')!});
      }
      if (result.outcome.connection.id !== connectionId) state.update(p,{connectionId:result.outcome.connection.id});
      return reply({ ...result, nextAction: result.authorizationUrl ? 'Open authorizationUrl in your browser, then run auth-continue OP' : result.device ? 'Open the verification link on your own device, then run auth-continue OP' : undefined });
    }
    if (['auth-status','auth-continue','auth-cancel'].includes(command)) {
      need(1); const op = await auth.operation(pos[0]); if (!op || op.connection.id !== connectionId) fail('operation_binding_conflict',5);
      if (command === 'auth-status') return reply(op);
      const direct = state.get<any>('direct',pos[0]);
      if (direct && (direct.profileId !== p.id || direct.connectionId !== connectionId || direct.issuer !== connection.issuer || direct.sessionId !== connection.sessionId)) fail('operation_binding_conflict',5);
      if (command === 'auth-cancel') { const outcome=await auth.cancelSignIn(pos[0]); if (direct) { await provider.cancel(pos[0]); await backend.secrets.remove(direct.secretRef); state.remove('direct',pos[0]); } return reply(outcome); }
      if (op.status !== 'pending') return reply(op);
      if (!direct) return reply(await auth.continueSignIn(pos[0]));
      const saved = await backend.secrets.read(direct.secretRef); if (!saved) fail('secure_store_locked',4);
      const material = JSON.parse(saved);
      await provider.beginDirect({operationId:pos[0],issuer:direct.issuer,sessionId:direct.sessionId,state:new URL(material.authorizationUrl).searchParams.get('state')!});
      const result = await provider.takeResult({operationId:pos[0],issuer:direct.issuer,sessionId:direct.sessionId});
      if (result.status === 'pending') return reply(op);
      const outcome = await auth.completeSignIn({callbackUrl:result.callbackUrl,browserBinding:material.browserBinding});
      if (outcome.status !== 'pending') { await backend.secrets.remove(direct.secretRef); state.remove('direct',pos[0]); }
      return reply(outcome);
    }
    if (command === 'api-target' || command === 'api-request') {
      need(0); const target = await auth.apiTarget(connectionId, required('api'), str('destination'));
      if (command === 'api-target') return reply(target);
      const destination = required('destination'), method = str('method') ?? 'GET';
      if (!['GET','HEAD'].includes(method)) fail('api_request_read_methods_only');
      const response = await auth.apiFetch(connectionId,new Request(destination,{method,signal:abort.signal}),target,v.scope ?? []);
      await response.body?.cancel(); return reply({ status: response.status, target });
    }
    if (command === 'browser-join') { need(0); if (!backend.browserController) fail('trusted_browser_controller_required',4); await auth.joinBrowser(connectionId,required('return-to'),backend.browserController); return reply({ joined:true }); }
    if (command === 'feedback') { need(0); await auth.feedback(connectionId,{kind:'missing',task:required('task'),description:required('description')}); return reply({ accepted:true }); }
    const target = await auth.target(connectionId);
    const binding = { profileId:p.id,provider:p.provider,installationId:p.installationId,enrollmentRef:p.credentialRef,connectionId,issuer:target.issuer,endpoint:target.endpoint,resource:target.resource ?? null };
    const bindConversation=(id:string)=>state!.atomic(()=>{const saved=state!.get('conversation',id);if(saved&&JSON.stringify(saved)!==JSON.stringify(binding))fail('conversation_binding_conflict',5);state!.put('conversation',id,binding);});
    if(['send','read','watch','handoff','close'].includes(command)) {const saved=state.get('conversation',pos[0]);if(!saved||JSON.stringify(saved)!==JSON.stringify(binding))fail('conversation_binding_conflict',5);}
    conversationStore = new SqliteConversationStore(join(home, 'conversations.sqlite'));
    const conversation = sdk.createConversationClient({ connectionId,issuer:target.issuer,endpoint:target.endpoint,store:conversationStore,clock:{now:Date.now},authorization:(id,scopes)=>auth.authorization(id,scopes),authorizedRequest:request=>auth.authorizedFetch(connectionId,request,target),maxAttempts:1 });
    const consumer=str('consumer'),key={connectionId,issuer:target.issuer,endpoint:target.endpoint};
    if(consumer&&str('cursor'))fail('consumer_and_cursor_are_exclusive');
    if(consumer&&!/^[A-Za-z0-9_-]{1,128}$/.test(consumer))fail('invalid_consumer');
    const previous=consumer?await conversationStore.getCheckpoint(key,pos[0],consumer):str('cursor');
    const delivery=(cursor:string|null|undefined)=>{
      if(!consumer||!cursor)return undefined;
      if(state!.list('delivery').length>=1000)fail('delivery_limit_ack_existing_batches',5);
      const id=randomUUID();state!.put('delivery',id,{binding,key,conversationId:pos[0],consumer,cursor,previous});return id;
    };
    if (command === 'start' || command === 'send' || command === 'retry') {
      need(command==='start'?0:1);
      const handle = command==='retry'?pos[0]:str('send-operation') ?? randomUUID();
      retryHandle=handle;
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(handle)) fail('invalid_send_operation');
      const payload = command==='retry'?undefined:{command,conversationId:command==='send'?pos[0]:null,text:required('text')};
      const row = state.prepareRetry(handle,binding,payload);
      abort.signal.throwIfAborted();
      const message = {id:row.messageId,sender:'agent' as const,text:row.payload.text};
      const result = row.payload.command==='start'?await conversation.start(message,{signal:abort.signal}):await conversation.send(row.payload.conversationId,message,{signal:abort.signal});
      bindConversation(result.conversation_id);
      return reply({sendOperation:handle,...result});
    }
    if (command === 'read') { need(1);const page=await conversation.read(pos[0],{cursor:previous,signal:abort.signal});return reply({...page,delivery:delivery(page.cursor)}); }
    if (command === 'watch') {
      need(1); const events:unknown[]=[];let cursor=previous,timedOut=false;const timer=setTimeout(()=>{timedOut=true;boundedWatchComplete=true;abort.abort();},30000);
      try { for await(const item of conversation.watch(pos[0],{cursor,signal:abort.signal,maxReconnects:0})) { events.push(item.event);cursor=item.event.id;if(events.length>=100)break; } }
      catch(error){if(!timedOut)throw error;}finally{clearTimeout(timer);}
      if(abort.signal.aborted&&!timedOut)fail('canceled',130);
      return reply({events,cursor,delivery:delivery(cursor),notice:'Bounded watch; resume with cursor or acknowledge the delivery for a named consumer.'});
    }
    if (command === 'handoff' || command === 'close') { need(1); return reply(await conversation[command](pos[0],{signal:abort.signal})); }
    return fail('unknown_command');
  } catch(error) {
    const known = error instanceof CliFailure, safe = error as { code?: string; retryAfterMs?: number };
    if(!abort.signal.aborted&&safe.code==='renewal_pending'&&retryHandle)return reply({status:'pending',sendOperation:retryHandle,nextAction:'retry_after_live_auth_finishes'});
    const authCodes = ['anonymous_unavailable','sign_in_required','insufficient_scope','invalid_scope','unsupported_method','direct_unavailable','device_unavailable','mediated_unavailable','trusted_input_required','provider_unavailable','disconnected','invalid_grant','rate_limited','secure_store_locked','secure_store_unavailable','unauthorized','expired','canceled','consumed','binding_conflict'];
    const sdkCode = safe.code && authCodes.includes(safe.code) ? safe.code : undefined;
    const code = abort.signal.aborted ? 'canceled' : known ? error.code : sdkCode ?? 'operation_failed';
    // Fixed failure vocabulary: raw remote/provider/module/OS diagnostics never reach a harness.
    return {out:{version:1,command,status:'error',requestId,error:{code}},code:abort.signal.aborted?130:known?error.exitCode:code==='consumed'?6:code==='binding_conflict'?5:['trusted_input_required','provider_unavailable','secure_store_locked','secure_store_unavailable'].includes(code)?4:['sign_in_required','insufficient_scope','unauthorized','invalid_grant'].includes(code)?3:1};
  } finally { process.off('SIGINT',canceled);process.off('SIGTERM',canceled);for(const dispose of [()=>authStore?.close(),()=>conversationStore?.close(),()=>transport?.close?.(),()=>backend?.close?.(),()=>state?.close()])try{await dispose();}catch{/* Cleanup adapters cannot expose private errors. */} }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const {out,code}=await main(process.argv.slice(2));
  const structured=process.argv.includes('--json');
  process.stdout.write(typeof out==='string'?out:structured?JSON.stringify(out)+'\n':out.status==='error'?`poppykit: ${out.error?.code}\n`:JSON.stringify(out.result,null,2)+'\n');
  process.exitCode=code;
}

