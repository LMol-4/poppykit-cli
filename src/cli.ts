#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { State, Profile } from './state.js';
import { CliFailure, openBackend, hiddenInput } from './secrets.js';
import type { SecureBackend } from './secrets.js';
import type { ClientAuth, HttpTransport } from '@poppykit/client';
import { openApprovalBrowser, waitForApproval } from './approval.js';

export const HELP = `Usage: poppykit <command> [--json] [--profile NAME] [--unlock]
Node >=24.12.0. Direct SDK execution; no daemon. Native Windows DPAPI/macOS Keychain custody.
  setup --provider HTTPS_URL --company DOMAIN [--enrollment HTTPS_URL] [--profile NAME]
  backend --module ABSOLUTE_TRUSTED_MODULE
  storage migrate                 adopt attended storage into the native vault
  profile list | profile remove NAME
  enroll | enroll-status | enroll-cancel  browser enrollment when configured
  discovery | connect [--anonymous] | connections | scopes [--scope S]
  auth-start --method direct|device|mediated --scope S [--scope S]
  auth-status OP | auth-continue OP | auth-cancel OP | sign-out
  auth-wait OP                    resume a bounded browser approval wait
  enroll/auth-start wait up to 300s; --wait-timeout SECONDS (1-300)
  --no-open shows the link only; --no-wait preserves the low-level start result
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
Windows uses current-user DPAPI and macOS uses Keychain by default. Other unattended use requires a configured secure backend. --unlock explicitly uses
attended encrypted storage with a hidden terminal passphrase each invocation.
Exit: 0 complete/pending, 1 runtime/remote, 2 usage, 3 authorization, 4 secure
backend/trusted input unavailable, 5 binding conflict, 6 uncertain, 130 canceled.
`;
type Reply = { version: 1; command: string; status: 'ok' | 'error'; result?: unknown; sendOperation?: string; error?: { code: string; nextAction?: string; httpStatus?: number }; requestId: string };
interface Dependencies { sdk?: typeof import('@poppykit/client'); transport?: HttpTransport; backend?: SecureBackend; openBrowser?:(url:string)=>Promise<void>; progress?:(value:unknown)=>void }
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
  let releaseApproval:(()=>void)|undefined, approvalTimer:ReturnType<typeof setTimeout>|undefined, approvalTimedOut=false, resume:{command:string;profile:string;operationId?:string;requestId?:string}|undefined, inspectApproval:(()=>Promise<any>)|undefined;
  const abort = new AbortController(), canceled = () => {boundedWatchComplete=false;abort.abort();};
  process.once('SIGINT', canceled); process.once('SIGTERM', canceled);
  try {
    if (!runtimeSupported(process.versions.node)) fail('node_24_12_or_newer_required', 1);
    if (argv.length === 0 || argv.length === 1 && ['help','--help'].includes(command)) return { out: HELP, code: 0 };
    const options = { json: { type: 'boolean' }, profile: { type: 'string' }, unlock: { type: 'boolean' }, 'no-wait': {type:'boolean'}, 'no-open': {type:'boolean'}, 'wait-timeout': {type:'string'}, provider: { type: 'string' }, enrollment: { type: 'string' }, company: { type: 'string' }, module: { type: 'string' }, scope: { type: 'string', multiple: true }, method: { type: 'string' }, connection: { type: 'string' }, text: { type: 'string' }, 'send-operation': { type: 'string' }, cursor: { type: 'string' }, consumer: { type: 'string' }, anonymous: { type: 'boolean' }, api: { type: 'string' }, destination: { type: 'string' }, 'return-to': { type: 'string' }, task: { type: 'string' }, description: { type: 'string' } } as const;
    let parsed; try { parsed = parseArgs({ args: argv.slice(1), options, allowPositionals: true }); } catch { return fail('invalid_arguments'); }
    const v = parsed.values, pos = parsed.positionals, str = (key: keyof typeof options) => v[key] as string | undefined;
    const need = (count: number) => { if (pos.length !== count || pos.some(x => !x || x.includes('\0'))) fail('invalid_arguments'); };
    const required = (key: keyof typeof options) => str(key) ?? fail(`required_--${key}`);
    const timeoutSeconds = Number(str('wait-timeout') ?? 300);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) fail('invalid_wait_timeout');
    const waiting = !v['no-wait'] && ['enroll','auth-start','auth-wait'].includes(command);
    const announce = async (value:{browserUrl?:string;[key:string]:unknown}) => {
      deps.progress?.(clean({...value,resume,notice:'Waiting for your browser decision. No chat reply is needed. Ctrl+C stops waiting; saved approval can be resumed.'}));
      if (value.browserUrl && !v['no-open']) try { await (deps.openBrowser ?? openApprovalBrowser)(value.browserUrl); } catch { deps.progress?.({notice:'Open the approval link in your browser.'}); }
    };
    const beginWait = (handle:NonNullable<typeof resume>) => { resume=handle; approvalTimer=setTimeout(()=>{approvalTimedOut=true;abort.abort();},timeoutSeconds*1000); };
    const commands = ['setup','backend','storage','profile','enroll','enroll-status','enroll-cancel','discovery','connect','connections','scopes','auth-start','auth-status','auth-continue','auth-wait','auth-cancel','sign-out','start','send','retry','status','retry-remove','read','watch','ack','handoff','close','api-target','api-request','browser-join','feedback','diagnostics','enrollment-revoke'];
    if (!commands.includes(command)) fail('unknown_command');
    const home = resolve(env.POPPYKIT_HOME ?? join(homedir(), '.poppykit'));
    const {State: StateStore}=await import('./state.js');
    await mkdir(home, { recursive: true, mode: 0o700 }); state = new StateStore(join(home, 'cli.sqlite'));
    if (command === 'setup') {
      need(0); const provider = url(required('provider')), domain = required('company');
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) || domain.includes('..')) fail('invalid_company_domain');
      const enrollmentUrl = str('enrollment') ? url(required('enrollment')) : undefined;
      if (enrollmentUrl && new URL(enrollmentUrl).origin !== new URL(provider).origin) fail('provider_identity_mismatch',5);
      let profile: Profile = state.createProfile(str('profile') ?? 'default', provider, domain);
      if (enrollmentUrl) profile = state.update(profile,{enrollmentUrl});
      return reply({ profile: publicProfile(profile), nextAction: enrollmentUrl ? 'Run enroll and approve in your browser; the command waits for the decision. Company access requires separate consent.' : 'Configure backend, then enroll through a trusted user route' });
    }
    if (command === 'backend') { need(0); state.put('config','backend',{ module: resolve(required('module')) }); return reply({ configured: true }); }
    if (command === 'storage') {
      need(1); if (pos[0] !== 'migrate' || v.unlock) fail('usage_storage_migrate');
      if (state.get('config','backend')) fail('native_migration_requires_default_backend', 5);
      if (!['win32','darwin'].includes(process.platform)) fail('secure_backend_required', 4);
      await (await import('./native.js')).migrateNativeStorage(join(home, 'encrypted-secrets'));
      return reply({ migrated: true, nextAction: 'Run subsequent commands without --unlock. Existing profiles and approvals are preserved.' });
    }
    if (command === 'profile') {
      if (pos[0] === 'list' && pos.length === 1) return reply({ profiles: state.list<Profile>('profile').map(row => publicProfile(row.value)) });
      if (pos[0] === 'remove' && pos.length === 2) { state.remove('profile', pos[1]); return reply({ removed: pos[1], notice: 'Local profile removed; remote authorization and backend secrets require explicit cleanup' }); }
      return fail('profile_list_or_remove_required');
    }
    if (command === 'diagnostics') { need(0); const custom = !!state.get('config','backend'); return reply({ node: process.versions.node, platform: process.platform, storage: home, secureBackendConfigured: custom, defaultSecureBackend: custom ? 'custom' : process.platform === 'win32' ? 'windows-dpapi' : process.platform === 'darwin' ? 'macos-keychain' : 'none', secureBackendAvailability: 'not-probed', headless: !process.stdin.isTTY, execution: 'direct-sdk', browserOpening: 'best-effort-with-link' }); }
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
    if (['enroll','enroll-status','enroll-cancel'].includes(command) && p.enrollmentUrl) {
      need(0);
      releaseApproval=state.claimApproval(`enrollment:${p.id}`);
      if (p.credentialRef) {
        if (command === 'enroll-cancel') fail('already_enrolled',5);
        if (JSON.stringify(state.get('enrollment',p.id)) !== JSON.stringify({provider:p.provider,domain:p.domain,installationId:p.installationId,clientId:p.clientId,callbackUrl:p.callbackUrl,credentialRef:p.credentialRef})) fail('enrollment_binding_conflict',5);
        if (!await backend.secrets.read(p.credentialRef)) fail('secure_store_locked',4);
        return reply({enrolled:true,clientId:p.clientId,nextAction:'Enrollment is already saved. Run connect, then auth-start for separate company consent.'});
      }
      const { createBrowserEnrollmentClient } = await import('@poppykit/client/provider');
      const enrollment = createBrowserEnrollmentClient({url:p.enrollmentUrl,provider:p.provider,company:p.domain,installationId:p.installationId,transport});
      let pending = state.get<{requestId:string;secretRef:string;profileId:string;provider:string;domain:string;installationId:string;enrollmentUrl:string;browserUrl?:string;expiresAt?:number;cleanupOnly?:boolean;retrieving?:boolean;resultRef?:string}>('browser-enrollment',p.id);
      if (pending && (pending.profileId !== p.id || pending.provider !== p.provider || pending.domain !== p.domain || pending.installationId !== p.installationId || pending.enrollmentUrl !== p.enrollmentUrl)) fail('enrollment_binding_conflict',5);
      if (command === 'enroll' && !pending) {
        const verifier = randomBytes(32).toString('base64url'), secretRef = await backend.secrets.stage(verifier);
        try {
          const started = await enrollment.start(createHash('sha256').update(verifier).digest('base64url'));
          pending={...started,secretRef,profileId:p.id,provider:p.provider,domain:p.domain,installationId:p.installationId,enrollmentUrl:p.enrollmentUrl};
          state.put('browser-enrollment',p.id,pending);
          if (!waiting) return reply({...started,nextAction:'Open browserUrl, then retrieve with enroll-status or resume waiting with enroll.'});
        } catch (error) { await backend.secrets.remove(secretRef); throw error; }
      }
      if (!pending) fail('enrollment_required',3);
      resume={command:'enroll',profile:p.name,requestId:pending.requestId};
      const savedPending=pending;
      const verifier = await backend.secrets.read(pending.secretRef) ?? fail('secure_store_locked',4);
      const discard = async () => { await backend!.secrets.remove(savedPending.secretRef); const latest=state!.get<typeof savedPending>('browser-enrollment',p.id);if(latest?.resultRef)await backend!.secrets.remove(latest.resultRef);state!.remove('browser-enrollment',p.id); };
      const cancelEnrollment = async () => {
        state!.put('browser-enrollment',p.id,{...state!.get<typeof savedPending>('browser-enrollment',p.id),cleanupOnly:true});
        try { await enrollment.cancel(savedPending.requestId,verifier); }
        catch { fail('enrollment_cleanup_required_run_enroll-cancel',6); }
        await discard();
      };
      if (command === 'enroll-cancel') { await cancelEnrollment(); return reply({canceled:true}); }
      if(pending.cleanupOnly)fail('enrollment_cleanup_required_run_enroll-cancel',6);
      if (waiting) { beginWait({command:'enroll',profile:p.name,requestId:pending.requestId}); await announce({browserUrl:pending.browserUrl,requestId:pending.requestId,installationId:p.installationId,expiresAt:pending.expiresAt}); }
      const poll=async()=>{
        const current=state!.get<typeof savedPending>('browser-enrollment',p.id)!;
        if(current.resultRef)return JSON.parse(await backend!.secrets.read(current.resultRef)??fail('secure_store_locked',4)) as Awaited<ReturnType<typeof enrollment.status>>;
        if(current.retrieving)fail('approval_result_uncertain',6);
        state!.put('browser-enrollment',p.id,{...current,retrieving:true});
        let value;
        try { value=await enrollment.status(current.requestId,verifier); }
        catch(error){if((error as {code?:string}).code==='rate_limited')state!.put('browser-enrollment',p.id,{...current,retrieving:false});throw error;}
        if(value.status==='ready'){
          const resultRef=await backend!.secrets.stage(JSON.stringify(value));
          state!.put('browser-enrollment',p.id,{...current,retrieving:false,resultRef});
        }else state!.put('browser-enrollment',p.id,{...current,retrieving:false});
        return value;
      };
      let result;
      try { result = waiting ? await waitForApproval(poll,{signal:abort.signal,pending:value=>value.status==='pending',timeoutMs:timeoutSeconds*1000}) : await poll(); }
      catch (error) {
        if (abort.signal.aborted) throw error;
        if(waiting&&state.get<typeof savedPending>('browser-enrollment',p.id)?.retrieving)throw new CliFailure('approval_result_uncertain',6);
        if(error && typeof error==='object' && 'code' in error && error.code==='rate_limited')return reply({status:'pending',nextAction:'Wait at least two seconds before enroll-status.'});
        await cancelEnrollment(); throw error;
      }
      if (!result) return reply({status:'pending',resume,nextAction:'Wait ended. Run enroll to resume the saved request, or enroll-cancel to revoke it.'});
      if (result.status === 'pending') return reply({status:'pending'});
      if (result.status === 'denied') { await discard(); return reply({status:'denied'}); }
      let credentialRef: string | undefined;
      const resultRef=state.get<typeof savedPending>('browser-enrollment',p.id)?.resultRef;
      try {
        credentialRef = await backend.secrets.stage(result.credential!);
        const {clientId,callbackUrl} = result;
        state.atomic(() => {
          const current = state!.get<Profile>('profile',p.name);
          if (current?.id !== p.id || current.credentialRef) fail('profile_changed',5);
          state!.put('profile',p.name,{...current,credentialRef,clientId,callbackUrl});
          state!.put('enrollment',p.id,{provider:p.provider,domain:p.domain,installationId:p.installationId,clientId,callbackUrl,credentialRef});
          state!.remove('browser-enrollment',p.id);
        });
      } catch (error) { if(credentialRef)await backend.secrets.remove(credentialRef); await cancelEnrollment(); throw error; }
      await backend.secrets.remove(pending.secretRef);
      if(resultRef)await backend.secrets.remove(resultRef);
      return reply({enrolled:true,clientId:result.clientId,nextAction:'Run connect and discovery, then auth-start with the advertised scopes for separate company consent.'});
    }
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
    let connectionId = str('connection') ?? p.connectionId ?? fail('connection_required',2), connection = await auth.get(connectionId);
    if (!connection || connection.domain !== p.domain) fail('connection_binding_conflict',5);
    if (command === 'scopes') { need(0); return reply(await auth.authorization(connectionId, v.scope ?? [])); }
    if (command === 'sign-out') { need(0); return reply(await auth.signOut(connectionId)); }
    if (command === 'auth-start') {
      need(0); const method = str('method') ?? 'direct'; if (!['direct','device','mediated'].includes(method)) fail('invalid_auth_method');
      releaseApproval=state.claimApproval(`auth:${p.id}:${connectionId}`);
      const access=await auth.authorization(connectionId,v.scope??[]);
      if (waiting && connection.status==='signed_in' && access.sufficient) return reply({status:'completed',connection,reused:true});
      const browserBinding = randomUUID() + randomUUID();
      const result = await auth.beginSignIn(connectionId,{method: method as any, scopes: v.scope ?? [],redirectUri:p.callbackUrl,browserBinding});
      resume={command:'auth-wait',profile:p.name,operationId:result.outcome.operationId};
      if (result.authorizationUrl) {
        const secretRef = await backend.secrets.stage(JSON.stringify({ browserBinding, authorizationUrl: result.authorizationUrl }));
        state.put('direct',result.outcome.operationId,{profileId:p.id,connectionId:result.outcome.connection.id,issuer:result.outcome.connection.issuer,sessionId:result.outcome.connection.sessionId,secretRef});
        await provider.beginDirect({operationId:result.outcome.operationId,issuer:result.outcome.connection.issuer,sessionId:result.outcome.connection.sessionId!,state:new URL(result.authorizationUrl).searchParams.get('state')!});
      }
      if (result.outcome.connection.id !== connectionId) { state.update(p,{connectionId:result.outcome.connection.id}); connectionId=result.outcome.connection.id; connection=result.outcome.connection; }
      if (!waiting || result.outcome.status!=='pending') return reply({ ...result, nextAction: result.outcome.status==='pending' ? 'Open the approval link, then use auth-wait OP to wait or auth-continue OP to retrieve once.' : undefined });
      beginWait({command:'auth-wait',profile:p.name,operationId:result.outcome.operationId});
      inspectApproval=()=>auth.operation(result.outcome.operationId);
      await announce({operationId:result.outcome.operationId,browserUrl:result.authorizationUrl??result.device?.verificationUriComplete??result.device?.verificationUri,...(result.device?{userCode:result.device.userCode}:{})});
      // Use the same callback retrieval path as an interrupted invocation.
      pos.push(result.outcome.operationId);
    }
    if (['auth-start','auth-status','auth-continue','auth-wait','auth-cancel'].includes(command)) {
      need(1); const op = await auth.operation(pos[0]); if (!op || op.connection.id !== connectionId) fail('operation_binding_conflict',5);
      if (command === 'auth-status') return reply(op);
      resume={command:'auth-wait',profile:p.name,operationId:pos[0]};
      releaseApproval??=state.claimApproval(`auth:${p.id}:${connectionId}`);
      let direct = state.get<any>('direct',pos[0]);
      if (direct && (direct.profileId !== p.id || direct.connectionId !== connectionId || direct.issuer !== connection.issuer || direct.sessionId !== connection.sessionId)) fail('operation_binding_conflict',5);
      if (command === 'auth-cancel') { const outcome=await auth.cancelSignIn(pos[0]); if (direct) { await provider.cancel(pos[0]); await backend.secrets.remove(direct.secretRef);if(direct.resultRef)await backend.secrets.remove(direct.resultRef);state.remove('direct',pos[0]); } return reply(outcome); }
      if (op.status !== 'pending') return reply(op);
      const material=direct?JSON.parse(await backend.secrets.read(direct.secretRef)??fail('secure_store_locked',4)):undefined;
      if (command==='auth-wait') { beginWait({command:'auth-wait',profile:p.name,operationId:pos[0]}); inspectApproval=()=>auth.operation(pos[0]); await announce({operationId:pos[0],browserUrl:material?.authorizationUrl}); }
      const poll=async()=>{
        const current=await auth.operation(pos[0]);
        if (!current || current.status!=='pending') return current??fail('operation_binding_conflict',5);
        if (!direct) return auth.continueSignIn(pos[0]);
        if(direct.retrieving)fail('approval_result_uncertain',6);
        if(!direct.resultRef){
          await provider.beginDirect({operationId:pos[0],issuer:direct.issuer,sessionId:direct.sessionId,state:new URL(material.authorizationUrl).searchParams.get('state')!});
          direct={...direct,retrieving:true};state!.put('direct',pos[0],direct);
          let result;
          try { result=await provider.takeResult({operationId:pos[0],issuer:direct.issuer,sessionId:direct.sessionId}); }
          catch(error){if((error as {code?:string}).code==='rate_limited'){direct={...direct,retrieving:false};state!.put('direct',pos[0],direct);}throw error;}
          if(result.status==='pending'){direct={...direct,retrieving:false};state!.put('direct',pos[0],direct);return current;}
          const resultRef=await backend!.secrets.stage(result.callbackUrl);
          direct={...direct,retrieving:false,resultRef};state!.put('direct',pos[0],direct);
        }
        const callbackUrl=await backend!.secrets.read(direct.resultRef)??fail('secure_store_locked',4);
        const outcome=await auth.completeSignIn({callbackUrl,browserBinding:material.browserBinding});
        if (outcome.status!=='pending') { await backend!.secrets.remove(direct.secretRef);await backend!.secrets.remove(direct.resultRef);state!.remove('direct',pos[0]); }
        return outcome;
      };
      const outcome=waiting?await waitForApproval(poll,{signal:abort.signal,pending:value=>value.status==='pending',timeoutMs:timeoutSeconds*1000}):await poll();
      return reply(outcome??{status:'pending',resume,nextAction:'Wait ended. Run auth-wait with the saved operationId, or auth-cancel to cancel it.'});
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
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(handle)) fail('invalid_send_operation');
      const payload = command==='retry'?undefined:{command,conversationId:command==='send'?pos[0]:null,text:required('text')};
      const row = state.prepareRetry(handle,binding,payload);
      retryHandle=handle;
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
    const enrollmentProfile=resume?.command==='enroll'&&state?.list<Profile>('profile').find(row=>row.value.name===resume!.profile)?.value;
    const retrievalUncertain=!!(resume?.operationId?state?.get<any>('direct',resume.operationId)?.retrieving:enrollmentProfile&&state?.get<any>('browser-enrollment',enrollmentProfile.id)?.retrieving);
    if(retrievalUncertain)return {out:{version:1,command,status:'error',requestId,result:{status:'uncertain',resume},error:{code:abort.signal.aborted&&!approvalTimedOut?'canceled':'approval_result_uncertain',nextAction:'One-time retrieval may have completed remotely. Do not retry retrieval. Inspect the saved request, then explicitly cancel it before starting a fresh authorization.'}},code:abort.signal.aborted&&!approvalTimedOut?130:6};
    if (approvalTimedOut) {
      const outcome=await inspectApproval?.();
      if(outcome&&outcome.status!=='pending')return {out:{version:1,command,status:'ok',requestId,result:clean(outcome)},code:outcome.status==='uncertain'?6:['denied','expired','failed'].includes(outcome.status)?3:outcome.status==='cancelled'?130:0};
      return {out:{version:1,command,status:'ok',requestId,result:{status:'pending',resume,nextAction:'Wait ended. Resume the saved request; no agent is woken after its process exits.'}},code:0};
    }
    const known = error instanceof CliFailure, safe = error as { code?: string; retryAfterMs?: number; status?: number };
    if(!abort.signal.aborted&&safe.code==='renewal_pending'&&retryHandle)return reply({status:'pending',sendOperation:retryHandle,nextAction:'retry_after_live_auth_finishes'});
    const authCodes = ['anonymous_unavailable','sign_in_required','insufficient_scope','invalid_scope','unsupported_method','direct_unavailable','device_unavailable','mediated_unavailable','trusted_input_required','provider_unavailable','provider_unauthorized','provider_rate_limited','provider_network_error','provider_invalid_response','provider_assertion_expired','provider_clock_skew','disconnected','invalid_grant','rate_limited','secure_store_locked','secure_store_unavailable','unauthorized','expired','canceled','consumed','binding_conflict'];
    const sdkCode = safe.code && authCodes.includes(safe.code) ? safe.code : undefined;
    const httpStatus = safe.code==='http_error' && typeof safe.status==='number' && Number.isInteger(safe.status) && safe.status>=500 && safe.status<=599 ? safe.status : undefined;
    const code = abort.signal.aborted ? 'canceled' : known ? error.code : httpStatus ? 'company_unavailable' : sdkCode ?? 'operation_failed';
    // Fixed failure vocabulary: raw remote/provider/module/OS diagnostics never reach a harness.
    const hints: Record<string,string> = {
      storage_migration_required: 'Run poppykit storage migrate in your own terminal once, then omit --unlock. Keep the passphrase out of chat.',
      provider_clock_skew: 'Check automatic date/time on this computer. The provider assertion is too far in the future; retry after synchronizing the clock.',
      provider_assertion_expired: 'Check automatic date/time on this computer and retry. The provider assertion has already expired.',
      provider_unauthorized: 'This provider rejected the saved enrollment. Review its status or revocation before enrolling again.',
      provider_rate_limited: 'The provider rate-limited this request. Wait before retrying.',
      provider_network_error: 'Could not complete a secure provider request. Check connectivity and retry.',
      provider_invalid_response: 'The provider returned an invalid response. Report the command, error code and approximate UTC time; do not share credentials.',
      provider_unavailable: 'The provider could not complete this request. Report the command, error code and approximate UTC time.',
      secure_store_locked: process.platform === 'darwin' ? 'Unlock your Keychain. After a CLI upgrade, run poppykit storage migrate in your own terminal to permit one-time OS access approval, then retry without --unlock. Never send credentials in chat.' : 'Unlock your OS vault, or use the correct attended passphrase. Do not put credentials in chat.',
      native_helper_unavailable: 'Reinstall the published CLI package; its bundled native helper is missing or failed its integrity check. Do not download a helper from company metadata.',
      company_unavailable: 'The company service is unavailable or paused. Ask its operator to check availability before retrying; enrollment does not need to be repeated.',
    };
    const nextAction=[hints[code],retryHandle?'Delivery is unconfirmed. Keep this sendOperation and use retry with the same handle when ready; do not create a replacement message.':undefined].filter(Boolean).join(' ');
    return {out:{version:1,command,status:'error',requestId,...(retryHandle?{sendOperation:retryHandle}:{}),...(resume?{result:{resume}}:{}),error:{code,...(httpStatus?{httpStatus}:{}),...(nextAction?{nextAction}:{})}},code:abort.signal.aborted?130:known?error.exitCode:code==='consumed'?6:code==='binding_conflict'?5:['trusted_input_required','provider_unavailable','secure_store_locked','secure_store_unavailable'].includes(code)?4:['sign_in_required','insufficient_scope','unauthorized','invalid_grant','provider_unauthorized'].includes(code)?3:1};
  } finally { if(approvalTimer)clearTimeout(approvalTimer);process.off('SIGINT',canceled);process.off('SIGTERM',canceled);for(const dispose of [()=>releaseApproval?.(),()=>authStore?.close(),()=>conversationStore?.close(),()=>transport?.close?.(),()=>backend?.close?.(),()=>state?.close()])try{await dispose();}catch{/* Cleanup adapters cannot expose private errors. */} }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const {out,code}=await main(process.argv.slice(2),process.env,{progress:value=>process.stderr.write(JSON.stringify(value)+'\n')});
  const structured=process.argv.includes('--json');
  process.stdout.write(typeof out==='string'?out:structured?JSON.stringify(out)+'\n':out.status==='error'?`poppykit: ${out.error?.code}\n${out.sendOperation?`sendOperation: ${out.sendOperation}\n`:''}${out.error?.nextAction?`${out.error.nextAction}\n`:''}`:JSON.stringify(out.result,null,2)+'\n');
  process.exitCode=code;
}

