import { fileURLToPath } from 'node:url';
import {expectValue,publicEcJwk,reply} from '../test-support/cli-output.mjs';
import type {SecureBackend} from '../dist/secrets.js';
import type {MetadataResolver,HttpTransport} from '@poppykit/client';
import { AuthFailure } from '@poppykit/client';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { main, runtimeSupported } from '../dist/cli.js';
import { waitForApproval } from '../dist/approval.js';
import { encryptedBackend, openBackend } from '../dist/secrets.js';
import { nativeBackend, migrateNativeStorage, publishNativeReference } from '../dist/native.js';
import { State } from '../dist/state.js';
import { createProvider, createResultCipher } from '@poppykit/client/provider';
import { SqliteProviderStore } from '@poppykit/client/provider/sqlite';
import { SqliteAuthStore } from '@poppykit/client/sqlite';

const clientId='https://identity.example/client.json',callbackUrl='https://identity.example/callback',issuer='https://company.example/issuer';
test('browser enrollment stages verifier before public start, resumes, binds once and cancels lost delivery',async()=>{
  for(const mode of ['ready','lost','lost-cancel','locked','denied']){
    const home=await mkdtemp(join(tmpdir(),'browser enrollment ü ')),secrets=new Map<string,string>();let challenge='',canceled=false,locked=false,cancelAttempts=0,statusAttempts=0;
    const backend:SecureBackend={secrets:{async stage(value){if(locked)throw new Error('PRIVATE_LOCKED');const ref=randomUUID();secrets.set(ref,value);return ref;},async read(ref){return secrets.get(ref)??null;},async remove(ref){secrets.delete(ref);}},async healthCheck(){}};
    const transport:HttpTransport={async fetch(request){const input=await request.json();assert.ok(!request.url.includes('PRIVATE'));assert.equal(request.headers.has('authorization'),false);
      if(request.url.endsWith('/start')){challenge=input.challenge;assert.ok([...secrets.values()].some(value=>createHash('sha256').update(value).digest('base64url')===challenge));return Response.json({requestId:'r'.repeat(43),browserUrl:'https://identity.example/approve?id=public',expiresAt:Date.now()+300000});}
      assert.equal(createHash('sha256').update(input.verifier).digest('base64url'),challenge);
      if(request.url.endsWith('/cancel')){cancelAttempts++;if(mode==='lost-cancel'&&cancelAttempts===1)throw new Error('PRIVATE_CANCEL_FAILURE');canceled=true;return Response.json({canceled:true});}
      statusAttempts++;
      if(mode==='lost'||mode==='lost-cancel')throw new Error('PRIVATE_NETWORK_FAILURE');
      if(mode==='locked')locked=true;
      return Response.json(mode==='denied'?{status:'denied'}:{status:'ready',credential:'PRIVATE_CREDENTIAL',clientId,callbackUrl});
    }};
    const run=async(args:string[])=>{const result=await main([...args,'--json'],{POPPYKIT_HOME:home},{backend,transport});assert.ok(!JSON.stringify(result).includes('PRIVATE_'));return result;};
    try{
      assert.equal((await run(['setup','--provider','https://identity.example/v1','--enrollment','https://identity.example/enrollment','--company','company.example'])).code,0);
      assert.equal((await run(['enroll','--no-wait'])).code,0);
      const completed=await run(['enroll-status']);
      const state=new State(join(home,'cli.sqlite'));
      try{assert.equal(!!state.profile().credentialRef,mode==='ready');assert.equal(state.list('browser-enrollment').length,['lost','lost-cancel','locked'].includes(mode)?1:0);}finally{state.close();}
      if(mode==='ready'){
        assert.equal(completed.code,0);assert.deepEqual([...secrets.values()],['PRIVATE_CREDENTIAL']);
        const attempts=statusAttempts;
        assert.equal((await run(['enroll-status'])).code,0);
        assert.equal(statusAttempts,attempts,'saved enrollment retry does not redeem again');
        secrets.clear();assert.equal((await run(['enroll-status'])).code,4,'missing saved credential fails closed');
      }
      else if(['lost','lost-cancel','locked'].includes(mode)){
        assert.equal(completed.code,6);assert.equal(secrets.size,1);
        assert.equal((await run(['enroll','--no-wait'])).code,6);
        assert.equal((await run(['enroll-status'])).code,6);assert.equal(statusAttempts,1);
        if(mode==='lost-cancel')assert.equal((await run(['enroll-cancel'])).code,6);
        assert.equal((await run(['enroll-cancel'])).code,0);assert.equal(cancelAttempts,mode==='lost-cancel'?2:1);assert.equal(secrets.size,0);
      }else{assert.equal(secrets.size,0);assert.equal(canceled,false);}
    }finally{await rm(home,{recursive:true,force:true});}
  }
});

test('initiating enrollment waits, tolerates rate limiting, preserves cancellation and resumes without another start',async()=>{
  const home=await mkdtemp(join(tmpdir(),'enrollment wait ')),secrets=new Map<string,string>();let starts=0,polls=0,approved=false,cancels=0;
  const backend:SecureBackend={async healthCheck(){},secrets:{async stage(value){const id=randomUUID();secrets.set(id,value);return id;},async read(id){return secrets.get(id)??null;},async remove(id){secrets.delete(id);}}};
  const transport:HttpTransport={async fetch(request){
    if(request.url.endsWith('/start')){starts++;return Response.json({requestId:'r'.repeat(43),browserUrl:'https://identity.example/approve',expiresAt:Date.now()+300000});}
    if(request.url.endsWith('/cancel')){cancels++;return Response.json({canceled:true});}
    polls++;if(polls===1)return Response.json({error:'rate_limited'},{status:429});
    return Response.json(approved?{status:'ready',credential:'PRIVATE_CREDENTIAL',clientId,callbackUrl}:{status:'pending'});
  }};
  const env={POPPYKIT_HOME:home};
  try {
    await main(['setup','--provider','https://identity.example/v1','--enrollment','https://identity.example/enrollment','--company','company.example'],env);
    const timeout=await main(['enroll','--no-open','--wait-timeout','1'],env,{backend,transport});assert.equal(reply(timeout.out).result.status,'pending');assert.equal(starts,1);assert.equal(cancels,0);
    const interrupted=await main(['enroll'],env,{backend,transport,openBrowser:async()=>{process.emit('SIGINT');}});assert.equal(interrupted.code,130);assert.equal(cancels,0);assert.equal(secrets.size,1);
    approved=true;
    const result=await main(['enroll','--no-open'],env,{backend,transport});assert.equal(result.code,0);assert.equal(reply(result.out).result.toJSON().enrolled,true);assert.equal(starts,1);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
    assert.equal((await main(['enroll','--no-open'],env,{backend,transport})).code,0);assert.equal(starts,1);
  }finally{await rm(home,{recursive:true,force:true});}
});
async function fixture(){
  const home=await mkdtemp(join(tmpdir(),'poppy ü spaces ')),secrets=new Map<string,string>(),store=new SqliteProviderStore(join(home,'provider.sqlite'));
  const backend:SecureBackend={secrets:{async stage(v){const id=randomUUID();secrets.set(id,v);return id;},async read(id){return secrets.get(id)??null;},async remove(id){secrets.delete(id);}},async healthCheck(){},async enrollmentAuth(){return {'x-human':'yes'};},trustedInput:{async collect(req):Promise<Record<string,string>>{return req.challenge?{code:'PRIVATE_OTP'}:{password:'PRIVATE_PASSWORD'};}}};
  const doc:Awaited<ReturnType<MetadataResolver['resolveCompany']>>['document']={protocol_version:'0.3',organization:{name:'Generic',domain:'company.example'},auth:{issuer,scopes:{'orders:read':'Read orders'},mediated:{endpoint:'https://company.example/mediated',fields:[{name:'password',label:'Password',secret:true}],scopes:['orders:read']}},agent:{protocols:[{type:'poppy',endpoint:'https://company.example/conversations'}]}};
  const authorization={issuer,token_endpoint:'https://company.example/token',revocation_endpoint:'https://company.example/revoke',protected_resources:['https://company.example'],grant_types_supported:['urn:ietf:params:oauth:grant-type:jwt-bearer','refresh_token','authorization_code','urn:ietf:params:oauth:grant-type:device_code'],scopes_supported:['orders:read'],authorization_endpoint:'https://company.example/authorize',device_authorization_endpoint:'https://company.example/device'};
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const metadata:MetadataResolver={resolveClient:async()=>{throw new Error('unexpected client lookup');},resolveJwks:async()=>{throw new Error('unexpected JWKS lookup');},resolveCompany:async()=>({url:'https://company.example/.well-known/poppy.json',document:doc,authorization})};
  const provider=createProvider({clientId,callbackUrl,jwksUri:'https://identity.example/jwks',clientName:'Generic',store,cipher:createResultCipher(randomBytes(32)),metadata,signer:{kid:'key',publicJwk:()=>publicEcJwk(key.publicKey),sign:async bytes=>new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,new Uint8Array(bytes)))},authenticateEnrollment:async request=>request.headers.get('x-human')==='yes'?{subject:'human',allowedCompanies:['company.example']}:null});
  const sent:unknown[]=[];let loseSend=false,unavailable=false,mediated=0;
  const token=(signedIn:boolean,session='session1')=>({access_token:signedIn?'PRIVATE_ACCESS':'PRIVATE_SESSION',token_type:'DPoP',expires_in:300,session_id:session,signed_in:signedIn,scope:signedIn?'orders:read':'',...(signedIn?{refresh_token:'PRIVATE_ACCOUNT'}:{})});
  const transport:HttpTransport={async fetch(request){const u=new URL(request.url);if(u.hostname==='identity.example')return provider.handle(request);if(u.pathname==='/.well-known/poppy.json')return Response.json(doc);if(u.pathname==='/.well-known/oauth-authorization-server/issuer')return Response.json(authorization);if(u.pathname==='/token'){const form=new URLSearchParams(await request.text());return Response.json(token(form.get('grant_type')!=='urn:ietf:params:oauth:grant-type:jwt-bearer',form.get('session_id')??'session1'));}if(u.pathname==='/device')return Response.json({device_code:'PRIVATE_DEVICE',user_code:'USER-CODE',verification_uri:'https://company.example/verify',expires_in:600,interval:1});if(u.pathname.startsWith('/mediated')){mediated++;const body=await request.json();if(mediated===1){assert.equal(body.credentials.password,'PRIVATE_PASSWORD');return Response.json({status:'code_required',sign_in_id:'challenge1',code:{sent_to:'email'},expires_at:new Date(Date.now()+600000).toISOString()});}assert.equal(body.code,'PRIVATE_OTP');return Response.json({status:'complete',...token(true)});}if(u.pathname==='/revoke')return new Response(null,{status:200});if(u.pathname.startsWith('/conversations')){if(request.method==='POST'){sent.push(await request.json());if(unavailable)return Response.json({error:'PRIVATE_REMOTE_BODY'},{status:503});if(loseSend){loseSend=false;throw new Error('PRIVATE_FAILURE');}return Response.json({conversation_id:'conversation1',status:'idle',responder:'agent'});}return Response.json({conversation_id:'conversation1',status:'idle',responder:'agent',events:[],cursor:null,has_more:false});}throw new Error('unexpected fixture destination '+request.url);}};
  const run=async (args:string[])=>{const r=await main([...args,'--no-wait','--json'],{POPPYKIT_HOME:home},{backend,transport});return {...r,out:reply(r.out)};};
  const ok=async (args:string[])=>{const result=await run(args);assert.equal(result.code,0,JSON.stringify(result.out));assert.equal(typeof result.out,'object');return result.out.result;};
  await ok(['setup','--provider','https://identity.example/v1','--company','company.example']);await ok(['enroll']);
  return {home,backend,provider,transport,run,ok,sent,secrets,setLoseSend:()=>loseSend=true,setUnavailable:(value:boolean)=>unavailable=value,close:async()=>{store.close();await rm(home,{recursive:true,force:true});}};
}
test('offline startup, runtime floor, stable JSON and no secure backend fallback',async()=>{
  const minimum=(await readFile(new URL('../.node-version',import.meta.url),'utf8')).trim();
  assert.equal(runtimeSupported(minimum),true);
  const [major,minor,patch]=minimum.split('.').map(Number);
  assert.equal(runtimeSupported(patch?`${major}.${minor}.${patch-1}`:`${major}.${minor-1}.99`),false);
  for(const version of ['24.12.0','24.20.99','25.0.0','26.22.1','24.21.0-rc.1','24.22','broken'])assert.equal(runtimeSupported(version),false,version);for(const version of ['24.21.0','24.21.1','24.22.0','24.22.2','24.23.0'])assert.equal(runtimeSupported(version),true,version);
  const home=await mkdtemp(join(tmpdir(),'startup ü '));try{
    const help=await main(['--help'],{POPPYKIT_HOME:join(home,'absent')});assert.equal(help.code,0);assert.ok(typeof help.out==='string');assert.match(help.out,/no daemon/);assert.deepEqual(await readdir(home),[]);
    const invalid=await main(['send','--password','SECRET'],{POPPYKIT_HOME:home});assert.equal(invalid.code,2);assert.ok(!JSON.stringify(invalid).includes('SECRET'));
    await main(['setup','--provider','https://identity.example/v1','--company','company.example'],{POPPYKIT_HOME:home});
    const missing=await main(['enroll','--json'],{POPPYKIT_HOME:home}, {backend:{secrets:{stage:async()=>{throw new Error();},read:async()=>null,remove:async()=>{}},healthCheck:async()=>{throw new Error('PRIVATE_UNAVAILABLE');}}});assert.notEqual(missing.code,0);assert.ok(!JSON.stringify(missing).includes('PRIVATE_UNAVAILABLE'));
    const unattended=await main(['enroll','--unlock','--json'],{POPPYKIT_HOME:home});assert.equal(unattended.code,4);assert.equal(reply(unattended.out).error.code,'trusted_terminal_required');
  }finally{await rm(home,{recursive:true,force:true});}
});
test('encrypted attended backend persists only ciphertext, rejects wrong unlock and unavailable modules',async()=>{
  const home=await mkdtemp(join(tmpdir(),'encrypted ü '));try{
    const first=await encryptedBackend(home,'a long independent passphrase');await first.healthCheck();const ref=await first.secrets.stage('PRIVATE_SECRET');expectValue(first.close).call(first);
    const files=await readdir(home);assert.equal(files.length,3);assert.ok(files.includes('unlock-check'));assert.equal((await readFile(join(home,ref+'.enc'))).includes(Buffer.from('PRIVATE_SECRET')),false);
    const second=await encryptedBackend(home,'a long independent passphrase');assert.equal(await second.secrets.read(ref),'PRIVATE_SECRET');expectValue(second.close).call(second);
    const wrong=await encryptedBackend(home,'a totally different passphrase');await assert.rejects(wrong.secrets.read(ref),{code:'secure_store_locked'});expectValue(wrong.close).call(wrong);
    await assert.rejects(openBackend({module:join(home,'missing.mjs'),directory:home}),{code:'secure_store_unavailable'});
    const module=join(home,'locked.mjs');await writeFile(module,await readFile(new URL('../test-support/locked-backend.mjs',import.meta.url)));await assert.rejects(openBackend({module,directory:home}),{code:'secure_store_unavailable'});
  }finally{await rm(home,{recursive:true,force:true});}
});

test('native adoption preserves ciphertext through wrong unlock, interrupted custody and retry',async()=>{
  for(const crash of ['none','before','after']){
    const home=await mkdtemp(join(tmpdir(),'native adoption ü ')),directory=join(home,'vault');
    let saved:string|null=null,attempts=0;
    const keys={async load(){return saved;},async adopt(value:string){attempts++;if(crash==='before'&&attempts===1)throw new Error('simulated interruption');saved??=value;if(crash==='after'&&attempts===1)throw new Error('simulated interruption');return saved;}};
    try{
      const legacy=await encryptedBackend(directory,'a private test passphrase ü');await legacy.healthCheck();const ref=await legacy.secrets.stage('PRIVATE_MIGRATION_SENTINEL');legacy.close?.();
      const files=await readdir(directory),before=await Promise.all(files.map(file=>readFile(join(directory,file))));
      await assert.rejects(nativeBackend(directory,keys),{code:'storage_migration_required'});
      await assert.rejects(migrateNativeStorage(directory,async()=> 'the wrong passphrase',keys),{code:'secure_store_locked'});assert.equal(saved,null);assert.equal(attempts,0);
      if(crash!=='none')await assert.rejects(migrateNativeStorage(directory,async()=> 'a private test passphrase ü',keys));
      await migrateNativeStorage(directory,async()=> 'a private test passphrase ü',keys);
      await migrateNativeStorage(directory,async()=>{throw new Error('must not prompt after migration');},keys);
      const current=await nativeBackend(directory,keys);assert.equal(await current.secrets.read(ref),'PRIVATE_MIGRATION_SENTINEL');assert.equal(await current.secrets.read('mem:foreign'),null);await current.close?.();
      assert.deepEqual(await readdir(directory),files);assert.deepEqual(await Promise.all(files.map(file=>readFile(join(directory,file)))),before,'migration never rewrites original data');
    }finally{await rm(home,{recursive:true,force:true});}
  }
});

test('native fresh vault uses a single custody key across concurrent opens',async()=>{
  const home=await mkdtemp(join(tmpdir(),'native concurrent ü ')),directory=join(home,'vault');let saved:string|null=null;
  const keys={async load(){return saved;},async adopt(value:string){return saved??=value;}};
  try{const [a,b]=await Promise.all([nativeBackend(directory,keys),nativeBackend(directory,keys)]);const ref=await a.secrets.stage('PRIVATE_NATIVE_SECRET');assert.equal(await b.secrets.read(ref),'PRIVATE_NATIVE_SECRET');await a.close?.();await b.close?.();}finally{await rm(home,{recursive:true,force:true});}
});

test('native reference publication survives a partial staging file and keeps one complete concurrent winner',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native pointer ü ')),a=randomUUID(),b=randomUUID();
  try{
    const abandoned=join(directory,'native-unlock-interrupted.tmp');await writeFile(abandoned,a.slice(0,7),{flag:'wx'});
    const outcomes=await Promise.all([publishNativeReference(directory,a),publishNativeReference(directory,b)]);
    assert.equal(outcomes.filter(Boolean).length,1);
    const winner=await readFile(join(directory,'native-unlock'),'utf8');assert.equal(winner.length,36);assert.equal(winner,outcomes[0]?a:b);
    assert.equal(await publishNativeReference(directory,randomUUID()),false);assert.equal(await readFile(join(directory,'native-unlock'),'utf8'),winner);
    assert.equal(await readFile(abandoned,'utf8'),a.slice(0,7));assert.equal((await readdir(directory)).length,2,'only the old abandoned staging file remains');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('Direct enrollment, callback, restart completion and sign-out redact all credentials',async()=>{
  const f=await fixture();try{
    const connection=await f.ok(['connect']);assert.equal(connection.connection.status,'signed_out');
    const start=await f.ok(['auth-start','--method','direct','--scope','orders:read']);const op=start.outcome.operationId;
    const authorization=new URL(start.authorizationUrl);assert.equal(authorization.hostname,'company.example');
    const callback=new URL(callbackUrl);callback.searchParams.set('state',expectValue(authorization.searchParams.get('state')));callback.searchParams.set('iss',issuer);callback.searchParams.set('code','PRIVATE_CODE');await f.provider.callback(callback.href);
    const result=await f.ok(['auth-continue',op]);assert.equal(result.status,'completed');assert.equal(result.connection.status,'signed_in');
    assert.ok(!JSON.stringify([connection,start,result]).includes('PRIVATE_'));
    const scopes=await f.ok(['scopes','--scope','orders:read']);assert.equal(scopes.sufficient,true);
    const signedOut=await f.ok(['sign-out']);assert.equal(signedOut.connection.status,'disconnected');
  }finally{await f.close();}
});

test('old saved Direct work retires locally before provider callback retrieval', async () => {
  const f = await fixture();
  try {
    await f.ok(['connect']); const start = await f.ok(['auth-start','--scope','orders:read']), op = start.outcome.operationId;
    const state = new State(join(f.home,'cli.sqlite')), profile = state.profile(), direct = state.get<any>('direct',op)!;
    delete direct.sessionKey; state.put('direct',op,direct); state.close();
    const store = new SqliteAuthStore(join(f.home,`auth-${profile.id}.sqlite`));
    try { await store.transaction({operationId:op},draft=>{ delete draft.operations[op].signInSessionKey; }); } finally { store.close(); }
    let takes = 0; const fetch = f.transport.fetch; f.transport.fetch = async request => { if(request.url.endsWith('/takeResult')) takes++; return fetch(request); };
    const result = await f.run(['auth-continue',op]); assert.equal(result.out.result.status,'failed'); assert.equal(result.out.result.toJSON().error,'restart_required'); assert.equal(takes,0);
    const reopened = new State(join(f.home,'cli.sqlite')); try { assert.equal(reopened.get('direct',op),undefined); } finally { reopened.close(); }
    assert.equal(f.secrets.has(direct.secretRef),false);
  } finally { await f.close(); }
});

test('initiating direct command returns approval or denial automatically and reuses only sufficient grants',async()=>{
  for(const decision of ['approve','deny']) {
    const f=await fixture();try {
      await f.ok(['connect']);let links=0;
      const run=()=>main(['auth-start','--scope','orders:read','--json'],{POPPYKIT_HOME:f.home},{backend:f.backend,transport:f.transport,progress:value=>assert.ok(!JSON.stringify(value).includes('PRIVATE_')),openBrowser:async link=>{
        links++;const callback=new URL(callbackUrl);callback.searchParams.set('state',new URL(link).searchParams.get('state')!);callback.searchParams.set('iss',issuer);callback.searchParams.set(decision==='approve'?'code':'error',decision==='approve'?'PRIVATE_CODE':'access_denied');await f.provider.callback(callback.href);
      }});
      const result=await run();assert.equal(result.code,decision==='approve'?0:3);
      assert.equal(reply(result.out).result.status,decision==='approve'?'completed':'denied');
      assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(links,1);
      if(decision==='approve') { const again=await run();assert.equal(reply(again.out).result.toJSON().reused,true);assert.equal(links,1); }
    }finally{await f.close();}
  }
});

test('bounded direct wait resumes the same operation after timeout and rejects concurrent consumers',async()=>{
  const f=await fixture();try {
    await f.ok(['connect']);let link='',operationId='';
    const args=['auth-start','--scope','orders:read','--wait-timeout','1','--json'];
    const first=await main(args,{POPPYKIT_HOME:f.home},{backend:f.backend,transport:f.transport,openBrowser:async value=>{link=value;},progress:value=>{operationId=(value as {operationId:string}).operationId;}});
    assert.equal(first.code,0);assert.equal(reply(first.out).result.status,'pending');assert.ok(operationId);
    const callback=new URL(callbackUrl);callback.searchParams.set('state',new URL(link).searchParams.get('state')!);callback.searchParams.set('iss',issuer);callback.searchParams.set('code','PRIVATE_CODE');await f.provider.callback(callback.href);
    const completed=await main(['auth-wait',operationId,'--no-open','--json'],{POPPYKIT_HOME:f.home},{backend:f.backend,transport:f.transport});
    assert.equal(completed.code,0);assert.equal(reply(completed.out).result.status,'completed');
    const again=await f.ok(['auth-continue',operationId]);assert.equal(again.status,'completed');
    const state=new State(join(f.home,'cli.sqlite'));const release=state.claimApproval('test');assert.throws(()=>state.claimApproval('test'),{code:'approval_in_use'});release();state.put('approval-owner','test',{pid:2147483647,token:'dead'});state.claimApproval('test')();state.close();
  }finally{await f.close();}
});

test('approval polling honors retry guidance and aborts during backoff',async()=>{
  const controller=new AbortController();let attempts=0;
  const task=waitForApproval(async()=>{attempts++;throw {code:'rate_limited',retryAt:Date.now()+60_000};},{signal:controller.signal,pending:()=>true,timeoutMs:20});
  assert.equal(await task,undefined);assert.equal(attempts,1);
  const cancelled=waitForApproval(async()=>({status:'pending'}),{signal:controller.signal,pending:()=>true,timeoutMs:300_000});controller.abort();await assert.rejects(cancelled,{name:'AbortError'});
});

test('lost one-time direct retrieval reports uncertainty and never consumes again after restart',async()=>{
  const f=await fixture();let release:(()=>void)|undefined;
  try {
    await f.ok(['connect']);let takes=0,operationId='';
    const transport:HttpTransport={async fetch(request,options){const response=await f.transport.fetch(request,options);if(request.url.endsWith('/takeResult')){takes++;await new Promise<void>(resolve=>release=resolve);}return response;}};
    const result=await main(['auth-start','--scope','orders:read','--wait-timeout','1'],{POPPYKIT_HOME:f.home},{backend:f.backend,transport,progress:value=>operationId=(value as {operationId:string}).operationId,openBrowser:async link=>{
      const callback=new URL(callbackUrl);callback.searchParams.set('state',new URL(link).searchParams.get('state')!);callback.searchParams.set('iss',issuer);callback.searchParams.set('code','PRIVATE_CODE');await f.provider.callback(callback.href);
    }});
    assert.equal(result.code,6);assert.equal(reply(result.out).result.status,'uncertain');release?.();
    const resumed=await main(['auth-wait',operationId,'--no-open'],{POPPYKIT_HOME:f.home},{backend:f.backend,transport});
    assert.equal(resumed.code,6);assert.equal(takes,1);assert.equal(reply(resumed.out).error.code,'approval_result_uncertain');
    assert.equal((await f.run(['auth-cancel',operationId])).code,130);
  }finally{release?.();await f.close();}
});

test('received callback stays encrypted and resumes locally without another provider redemption',async()=>{
  const f=await fixture();try {
    await f.ok(['connect']);let operationId='',takes=0,failRead=true;
    const backend:SecureBackend={...f.backend,secrets:{...f.backend.secrets,async read(ref){const value=await f.backend.secrets.read(ref);if(failRead&&value?.startsWith(callbackUrl+'?')){failRead=false;throw new Error('PRIVATE_INTERRUPTION');}return value;}}};
    const transport:HttpTransport={async fetch(request,options){if(request.url.endsWith('/takeResult'))takes++;return f.transport.fetch(request,options);}};
    const first=await main(['auth-start','--scope','orders:read'],{POPPYKIT_HOME:f.home},{backend,transport,progress:value=>operationId=(value as {operationId:string}).operationId,openBrowser:async link=>{
      const callback=new URL(callbackUrl);callback.searchParams.set('state',new URL(link).searchParams.get('state')!);callback.searchParams.set('iss',issuer);callback.searchParams.set('code','PRIVATE_CODE');await f.provider.callback(callback.href);
    }});
    assert.equal(first.code,1);assert.ok(!JSON.stringify(first).includes('PRIVATE_'));
    const next=await main(['auth-wait',operationId,'--no-open'],{POPPYKIT_HOME:f.home},{backend,transport});assert.equal(next.code,0);assert.equal(reply(next.out).result.status,'completed');assert.equal(takes,1);
  }finally{await f.close();}
});

test('lost enrollment redemption reports uncertainty and requires explicit cleanup rather than polling again',async()=>{
  const home=await mkdtemp(join(tmpdir(),'lost enrollment wait ')),secrets=new Map<string,string>();let polls=0,release:(()=>void)|undefined;
  const backend:SecureBackend={async healthCheck(){},secrets:{async stage(value){const id=randomUUID();secrets.set(id,value);return id;},async read(id){return secrets.get(id)??null;},async remove(id){secrets.delete(id);}}};
  const transport:HttpTransport={async fetch(request){if(request.url.endsWith('/start'))return Response.json({requestId:'r'.repeat(43),browserUrl:'https://identity.example/approve',expiresAt:Date.now()+300000});if(request.url.endsWith('/cancel'))return Response.json({canceled:true});polls++;await new Promise<void>(resolve=>release=resolve);return Response.json({status:'ready',credential:'PRIVATE_CREDENTIAL',clientId,callbackUrl});}};
  const env={POPPYKIT_HOME:home};try {
    await main(['setup','--provider','https://identity.example/v1','--enrollment','https://identity.example/enrollment','--company','company.example'],env);
    const first=await main(['enroll','--no-open','--wait-timeout','1'],env,{backend,transport});assert.equal(first.code,6);assert.equal(reply(first.out).result.status,'uncertain');release?.();
    const resumed=await main(['enroll','--no-open'],env,{backend,transport});assert.equal(resumed.code,6);assert.equal(polls,1);
    assert.equal((await main(['enroll-cancel'],env,{backend,transport})).code,0);assert.equal(secrets.size,0);
  }finally{release?.();await rm(home,{recursive:true,force:true});}
});
test('Device and Mediated sign-in restart through SDK lifecycle and trusted input',async()=>{
  for(const method of ['device','mediated']){const f=await fixture();try{
    await f.ok(['connect']);const start=await f.ok(['auth-start','--method',method,'--scope','orders:read']);assert.equal(start.outcome.status,'pending');
    if(method==='device'){assert.equal(start.device.userCode,'USER-CODE');await new Promise(r=>setTimeout(r,1100));}
    const complete=await f.ok(['auth-continue',start.outcome.operationId]);assert.equal(complete.status,'completed');assert.equal(complete.connection.status,'signed_in');assert.ok(!JSON.stringify([start,complete]).includes('PRIVATE_'));
  }finally{await f.close();}}
});
test('retry preserves exact human author, message identity and refuses changed bindings',async()=>{
  const f=await fixture();try{
    await f.ok(['connect']);f.setLoseSend();const failed=await f.run(['start','--human','--text','generic message','--send-operation','saved']);assert.equal(failed.code,1);assert.equal(failed.out.toJSON().sendOperation,'saved');assert.match(JSON.stringify(failed.out),/Delivery is unconfirmed/);
    assert.deepEqual((f.sent[0] as {message:{author:unknown}}).message.author,{type:'human'});
    await f.ok(['retry','saved']);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[0],f.sent[1]);
    const state=new State(join(f.home,'cli.sqlite')),p=state.profile();state.update(p,{provider:'https://other.example/v1'});state.close();
    const changed=await f.run(['retry','saved']);assert.equal(changed.code,5);assert.equal(f.sent.length,2);
    const local=new State(join(f.home,'cli.sqlite'));const binding={profileId:p.id,provider:p.provider,installationId:p.installationId,enrollmentRef:p.credentialRef,connectionId:p.connectionId,issuer,endpoint:'https://company.example/conversations',resource:null};
    for(const change of [{profileId:'new'},{installationId:'new'},{enrollmentRef:'new'},{connectionId:'new'},{issuer:'https://evil.example'},{endpoint:'https://evil.example'}])assert.throws(()=>local.prepareRetry('saved',{...binding,...change}),{code:'retry_binding_conflict'});local.close();
  }finally{await f.close();}
});
test('company 503 retains the generated send handle and exact retry without exposing its response',async()=>{
  const f=await fixture();try{
    await f.ok(['connect']);f.setUnavailable(true);
    const failed=await f.run(['start','--text','generic message']),output=failed.out.toJSON();
    assert.equal(failed.code,1);assert.equal(failed.out.error.code,'company_unavailable');
    assert.equal(typeof output.sendOperation,'string');assert.ok(typeof output.sendOperation==='string');
    const metadata=await f.ok(['status',output.sendOperation]),state=new State(join(f.home,'cli.sqlite'));const enrollmentRef=state.profile().credentialRef;state.close();assert.ok(enrollmentRef);assert.ok(!JSON.stringify(metadata).includes(enrollmentRef),'status omits the private vault reference from its known binding envelope');
    assert.ok(output.error&&typeof output.error==='object'&&'httpStatus' in output.error);assert.equal(output.error.httpStatus,503);
    assert.match(JSON.stringify(output),/Delivery is unconfirmed/);assert.match(JSON.stringify(output),/enrollment does not need to be repeated/);assert.ok(!JSON.stringify(output).includes('PRIVATE_'));
    f.setUnavailable(false);await f.ok(['retry',output.sendOperation]);
    assert.equal(f.sent.length,2);assert.deepEqual(f.sent[0],f.sent[1]);
    const invalid=await f.run(['start','--text','generic message','--send-operation','invalid handle']);
    assert.equal(invalid.out.error.code,'invalid_send_operation');assert.equal(invalid.out.toJSON().sendOperation,undefined);assert.equal(f.sent.length,2);
  }finally{await f.close();}
});
test('cancel and backend errors do not expose secrets or raw adapter failures',async()=>{
  const f=await fixture();try{await f.ok(['connect']);const start=await f.ok(['auth-start','--method','direct','--scope','orders:read']);const result=await f.run(['auth-cancel',start.outcome.operationId]);assert.equal(result.code,130);assert.equal(result.out.result.status,'cancelled');
    f.backend.healthCheck=async()=>{throw new Error('PRIVATE_BACKEND_ERROR')};const failed=await f.run(['connections']);assert.equal(failed.code,1);assert.ok(!JSON.stringify(failed).includes('PRIVATE_BACKEND_ERROR'));
  }finally{await f.close();}
});
test('separate processes concurrently create profiles without lost writes',async()=>{
  const home=await mkdtemp(join(tmpdir(),'concurrent ü '));try{
    const cli=new URL('../dist/cli.js',import.meta.url);
    const run=(n:string)=>new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(cli),'setup','--profile',n,'--provider','https://identity.example/v1','--company','company.example','--json'],{env:{...process.env,POPPYKIT_HOME:home},windowsHide:true});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});
    const results=await Promise.all(['one','two','three'].map(run));for(const r of results)assert.equal(r.code,0,r.err+r.out);const state=new State(join(home,'cli.sqlite'));assert.equal(state.list('profile').length,3);state.close();
  }finally{await rm(home,{recursive:true,force:true});}
});
test('invocation cancellation fences a late Direct token response and retains uncertainty',async()=>{
  const f=await fixture();let release:(()=>void)|undefined;try{
    await f.ok(['connect']);const started=await f.ok(['auth-start','--method','direct','--scope','orders:read']);
    const u=new URL(callbackUrl);u.searchParams.set('state',expectValue(new URL(started.authorizationUrl).searchParams.get('state')));u.searchParams.set('iss',issuer);u.searchParams.set('code','PRIVATE_CODE');await f.provider.callback(u.href);
    const original=f.transport.fetch;let reached:()=>void=()=>{throw new Error('uninitialized ready');};const ready=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);
    f.transport.fetch=async req=>{if(new URL(req.url).pathname==='/token'&&(await req.clone().text()).includes('authorization_code')){reached();await gate;}return original(req);};
    const pending=f.run(['auth-continue',started.outcome.operationId]);await ready;process.emit('SIGTERM');const canceled=await pending;assert.equal(canceled.code,130);assert.equal(canceled.out.error.code,'canceled');expectValue(release)();await new Promise(r=>setTimeout(r,20));
    const status=await f.run(['auth-status',started.outcome.operationId]);assert.equal(status.code,6);assert.equal(status.out.result.status,'uncertain');assert.equal(status.out.result.connection.status,'signed_out');
  }finally{release?.();await f.close();}
});
test('watch preserves stream delegation, returns cursor, and signals cancel instead of success',async()=>{
  const f=await fixture();try{
    await f.ok(['connect']);await f.ok(['start','--text','generic']);let streams=0;
    f.transport.stream=async()=>{streams++;return Response.json({conversation_id:'conversation1',status:'closed',responder:'agent',events:[{id:'event1',type:'state',created_at:new Date().toISOString(),status:'closed',responder:'agent'}],cursor:'event1',has_more:false});};
    const watched=await f.ok(['watch','conversation1']);assert.equal(streams,1);assert.equal(watched.cursor,'event1');
    let reached:()=>void=()=>{throw new Error('uninitialized ready');};const ready=new Promise<void>(r=>reached=r);f.transport.stream=async()=>{reached();return new Promise(()=>{});};
    const watching=f.run(['watch','conversation1']);await ready;process.emit('SIGINT');const canceled=await watching;assert.equal(canceled.code,130);assert.equal(canceled.out.status,'error');
  }finally{await f.close();}
});



test('concurrent encrypted backend initialization retains one unlock record and no orphan secrets',async()=>{
 const home=await mkdtemp(join(tmpdir(),'vault race ü '));const passphrase='an independent concurrent passphrase';
 const first=await encryptedBackend(home,passphrase),second=await encryptedBackend(home,passphrase);
 try{
  await Promise.all([first.healthCheck(),second.healthCheck()]);
  const files=await readdir(home),ref=await readFile(join(home,'unlock-check'),'utf8');
  assert.equal(files.filter(name=>name==='unlock-check').length,1);
  assert.deepEqual(files.filter(name=>name.endsWith('.enc')),[ref+'.enc'],'losing initializer removes its staged ciphertext');
  const reopened=await encryptedBackend(home,passphrase);try{await reopened.healthCheck();const secret=await reopened.secrets.stage('PRIVATE_CONCURRENT_SECRET');assert.equal(await first.secrets.read(secret),'PRIVATE_CONCURRENT_SECRET');}finally{expectValue(reopened.close).call(reopened);}
 }finally{expectValue(first.close).call(first);expectValue(second.close).call(second);await rm(home,{recursive:true,force:true});}
});

test('tampered and truncated encrypted secrets fail locked without plaintext fallback',async()=>{
 const home=await mkdtemp(join(tmpdir(),'vault corruption ü ')),backend=await encryptedBackend(home,'an independent corruption passphrase');
 try{
  await backend.healthCheck();const ref=await backend.secrets.stage('PRIVATE_CORRUPTION_SECRET'),path=join(home,ref+'.enc'),original=await readFile(path);
  const changed=Buffer.from(original);changed[changed.length-1]^=1;
  for(const bytes of [changed,original.subarray(0,8),Buffer.from('PRIVATE_CORRUPTION_SECRET')]){
   await writeFile(path,bytes);await assert.rejects(backend.secrets.read(ref),error=>{assert.ok(error instanceof Error&&'code' in error);assert.equal(error.code,'secure_store_locked');assert.ok(!JSON.stringify(error).includes('PRIVATE_'));return true;});
  }
  await writeFile(path,original);assert.equal(await backend.secrets.read(ref),'PRIVATE_CORRUPTION_SECRET');
 }finally{expectValue(backend.close).call(backend);await rm(home,{recursive:true,force:true});}
});

test('vault publication stays invisible during a partial syscall and survives process death',{timeout:20000},async()=>{
  for(const interrupt of [false,true]){
    const directory=await mkdtemp(join(tmpdir(),'vault publication ü ')),passphrase='PRIVATE_VAULT_PASSPHRASE';
    const child=spawn(process.execPath,[fileURLToPath(new URL('../test-support/vault-publication-worker.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe','ipc'],windowsHide:true});
    assert.ok(child.stdin&&child.stdout&&child.stderr);
    let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
    const exit=once(child,'exit');
    try{
      const partial=once(child,'message');child.stdin.end(JSON.stringify({directory,passphrase}));assert.deepEqual(await partial,['partial',undefined]);
      await assert.rejects(readFile(join(directory,'unlock-check')),{code:'ENOENT'});
      const staged=(await readdir(directory)).find(name=>name.endsWith('.enc'));assert.ok(staged);
      if(interrupt){child.kill();await exit;assert.equal((await readdir(directory)).includes(staged),true,'unknown interrupted ciphertext is preserved');}
      const winner=await encryptedBackend(directory,passphrase);
      try{await winner.healthCheck();const ref=await readFile(join(directory,'unlock-check'),'utf8');assert.equal(ref.length,36);
        if(!interrupt){child.send('continue');assert.deepEqual(await exit,[0,null]);assert.ok(!(await readdir(directory)).includes(staged),'losing process removes only its own ciphertext');}
        const before=await readFile(join(directory,ref+'.enc')),wrong=await encryptedBackend(directory,'PRIVATE_WRONG_PASSPHRASE');
        try{await assert.rejects(wrong.healthCheck(),{code:'secure_store_locked'});}finally{await wrong.close?.();}
        assert.deepEqual(await readFile(join(directory,ref+'.enc')),before);await winner.healthCheck();
      }finally{await winner.close?.();}
      assert.ok(!out.includes(passphrase)&&!err.includes(passphrase));
    }finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await exit;}await rm(directory,{recursive:true,force:true});}
  }
  const directory=await mkdtemp(join(tmpdir(),'broken marker ü ')),backend=await encryptedBackend(directory,'PRIVATE_EXISTING_PASSPHRASE');
  try{const ref=await backend.secrets.stage('PRIVATE_EXISTING_CIPHERTEXT'),before=await readFile(join(directory,ref+'.enc'));await writeFile(join(directory,'unlock-check'),'broken');await assert.rejects(backend.healthCheck(),{code:'secure_store_locked'});assert.equal(await readFile(join(directory,'unlock-check'),'utf8'),'broken');assert.deepEqual(await readFile(join(directory,ref+'.enc')),before);}finally{await backend.close?.();await rm(directory,{recursive:true,force:true});}
});

test('definite enrollment rejection cleans custody; malformed and staging failures keep one-time uncertainty',async()=>{
  for(const mode of ['expired','unauthorized','canceled','denied','malformed','staging','finalizing']){
    const home=await mkdtemp(join(tmpdir(),'enrollment terminal ü ')),secrets=new Map<string,string>();let polls=0,cancels=0;
    let stagingFailed=false;
    const backend:SecureBackend={async healthCheck(){},secrets:{async stage(value){if(mode==='staging'&&value.includes('PRIVATE_CREDENTIAL')||mode==='finalizing'&&value==='PRIVATE_CREDENTIAL'&&!stagingFailed){stagingFailed=true;throw new Error('PRIVATE_STAGING_FAILURE');}const ref=randomUUID();secrets.set(ref,value);return ref;},async read(ref){return secrets.get(ref)??null;},async remove(ref){secrets.delete(ref);}}};
    const transport:HttpTransport={async fetch(request){if(request.url.endsWith('/start'))return Response.json({requestId:'r'.repeat(43),browserUrl:'https://identity.example/approve',expiresAt:Date.now()+300000});if(request.url.endsWith('/cancel')){cancels++;return Response.json({canceled:true});}polls++;if(mode==='malformed')return new Response('PRIVATE_MALFORMED');if(['staging','finalizing'].includes(mode))return Response.json({status:'ready',credential:'PRIVATE_CREDENTIAL',clientId,callbackUrl});if(mode==='denied')return Response.json({status:'denied'});return Response.json({error:mode,error_description:'PRIVATE_REMOTE_ERROR'},{status:400});}};
    const env={POPPYKIT_HOME:home},run=(args:string[])=>main([...args,'--json'],env,{backend,transport});
    try{await run(['setup','--provider','https://identity.example/v1','--enrollment','https://identity.example/enrollment','--company','company.example']);await run(['enroll','--no-wait']);
      if(mode==='finalizing'){
        const result=await run(['enroll-status']);assert.equal(result.code,6);assert.equal(reply(result.out).error.code,'enrollment_finalize_required');assert.equal(secrets.size,2);assert.equal(cancels,0);
        const resumed=await run(['enroll','--no-open']);assert.equal(resumed.code,0);assert.equal(reply(resumed.out).result.toJSON().enrolled,true);assert.equal(polls,1);assert.equal(cancels,0);assert.deepEqual([...secrets.values()],['PRIVATE_CREDENTIAL']);continue;
      }
      const result=await run(['enroll-status']),uncertain=['malformed','staging'].includes(mode);assert.equal(result.code,uncertain?6:3,mode);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(cancels,0);
      assert.equal(secrets.size,uncertain?1:0);
      const again=await run(['enroll-status']);assert.equal(again.code,uncertain?6:3);assert.equal(polls,1,'no repeated redemption after restart');
      if(uncertain)assert.equal((await run(['enroll-cancel'])).code,0);
    }finally{await rm(home,{recursive:true,force:true});}
  }
});

test('read and watch preserve exact opaque fields; typed failures expose only validated challenge detail',async()=>{
  const f=await fixture();try{
    await f.ok(['connect']);await f.ok(['start','--text','generic']);
    const data={authorization:{secret:'business authorization',credential:['a',{refresh_token:'business data'}]},cookie:'business cookie',nested:{secretRef:'business reference',dpopKeyRef:'business reference'}},event={id:'opaque1',type:'message',created_at:'2026-10-24T00:00:00Z',message:{id:'message1',author: { type: 'agent' },role:'company',data,credential:{secret:'extension data'}},authorization:{secret:'event extension'}};
    const page={conversation_id:'conversation1',status:'closed',responder:'agent',events:[event],cursor:event.id,has_more:false,credential:{secret:'page extension'},delivery:{secret:'opaque page extension'},outcome:{status:'uncertain'}};
    const original=f.transport.fetch;f.transport.fetch=async request=>request.url.includes('/conversations/')?Response.json(page):original(request);
    assert.deepEqual((await f.ok(['read','conversation1'])).toJSON(),page);
    const named=await f.run(['read','conversation1','--consumer','exact']);assert.equal(named.code,0);assert.deepEqual(named.out.result.toJSON(),page);assert.equal(typeof named.out.delivery,'string');await f.ok(['ack',named.out.delivery]);
    assert.deepEqual((await f.ok(['watch','conversation1'])).events,[event]);
    const sentState={conversation_id:'conversation1',status:'idle',responder:'agent',sendOperation:'company extension',delivery:{secret:'company delivery'},outcome:{status:'denied'}};
    f.transport.fetch=async request=>request.url.includes('/conversations/')?Response.json(sentState):original(request);
    const sent=await f.run(['send','conversation1','--text','keep extensions','--send-operation','bound-cli-handle']);assert.equal(sent.code,0);assert.equal(sent.out.toJSON().sendOperation,'bound-cli-handle');const {messageId,...sentData}=sent.out.result.toJSON();assert.equal(typeof messageId,'string');assert.deepEqual(sentData,sentState);
    f.transport.fetch=async request=>request.url.includes('/conversations/')?Response.json({error:'insufficient_scope',scope:'record:edit',extension:'company.example/approval',error_description:'PRIVATE_REMOTE_BODY',credential:'PRIVATE_CREDENTIAL'},{status:403,headers:{'www-authenticate':'DPoP error="insufficient_scope", scope="record:edit"','retry-after':'7'}}):original(request);
    const failed=await f.run(['send','conversation1','--text','exact retry','--send-operation','opaque-upgrade']),out=failed.out.toJSON();assert.equal(failed.code,3);assert.equal(out.sendOperation,'opaque-upgrade');assert.deepEqual(out.error,{code:'insufficient_scope',requiredScopes:['record:edit'],retryAfterMs:7000,extensions:['company.example/approval'],nextAction:'Delivery is unconfirmed. Keep this sendOperation and use retry with the same handle when ready; do not create a replacement message.'});assert.ok(!JSON.stringify(out).includes('PRIVATE_'));
    f.transport.fetch=async request=>request.url.includes('/conversations/')?Response.json({error:'direct_conversation_open',conversation_id:'existing1',error_description:'PRIVATE_REMOTE_BODY'},{status:409}):original(request);
    const conflict=await f.run(['send','conversation1','--text','other','--send-operation','direct-conflict']);assert.equal((conflict.out.toJSON().error as Record<string,unknown>).conversationId,'existing1');
  }finally{await f.close();}
});

test('terminal Direct recovery retires references after expiry or committed-result cleanup failure',async()=>{
  for(const mode of ['expired','completed','denied']){
    const f=await fixture();try{
      await f.ok(['connect']);const start=await f.ok(['auth-start','--scope','orders:read']),op=start.outcome.operationId;
      const state=new State(join(f.home,'cli.sqlite')),profile=state.profile(),direct=state.get<{secretRef:string;resultRef?:string}>('direct',op)!;state.close();
      let redemptions=0;const fetch=f.transport.fetch;f.transport.fetch=async request=>{if(request.url.endsWith('/takeResult'))redemptions++;return fetch(request);};
      if(mode==='expired'){
        const store=new SqliteAuthStore(join(f.home,`auth-${profile.id}.sqlite`));try{await store.transaction({operationId:op},draft=>{draft.operations[op].expiresAt=Date.now()-1;});}finally{store.close();}
      }else{
        const callback=new URL(callbackUrl);callback.searchParams.set('state',new URL(start.authorizationUrl).searchParams.get('state')!);callback.searchParams.set('iss',issuer);callback.searchParams.set(mode==='denied'?'error':'code',mode==='denied'?'access_denied':'PRIVATE_CODE');await f.provider.callback(callback.href);
        const remove=f.backend.secrets.remove;let fail=true;f.backend.secrets.remove=async ref=>{if(ref===direct.secretRef&&fail){fail=false;throw new Error('PRIVATE_CLEANUP_FAILURE');}await remove(ref);};
        const first=await f.run(['auth-continue',op]);assert.notEqual(first.code,0);assert.ok(!JSON.stringify(first).includes('PRIVATE_'));assert.ok(f.secrets.has(direct.secretRef));
      }
      const count=redemptions,result=await f.run(['auth-status',op]);assert.equal(result.out.result.status,mode);assert.equal(redemptions,count,'terminal restart never repeats one-time retrieval');
      const current=new State(join(f.home,'cli.sqlite'));try{assert.equal(current.get('direct',op),undefined);}finally{current.close();}assert.equal(f.secrets.has(direct.secretRef),false);
      await f.run(['auth-status',op]);assert.equal(redemptions,count);
    }finally{await f.close();}
  }
});

test('Windows opener uses the system helper and private input despite hostile cwd and PATH',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hostile opener ü '));
  try{
    await copyFile(process.execPath,join(directory,'powershell.exe'));
    const source=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';import {join} from 'node:path';
      const exec=cp.execFile;let calls=0;
      cp.execFile=(file,args,options,callback)=>{calls++;assert.equal(file,join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'));assert.equal(options.windowsHide,true);assert.equal(options.timeout,5000);assert.ok(!args.some(arg=>arg.includes('PRIVATE_QUERY')));assert.match(args.at(-1),/Start-Process -FilePath \\$u -WindowStyle Hidden/);
        return exec(file,['-NoProfile','-NonInteractive','-Command',"$u=[Console]::In.ReadToEnd(); if (!$u.Contains('PRIVATE_QUERY')) {exit 2}"],options,callback);};syncBuiltinESMExports();
      const {openApprovalBrowser}=await import(${JSON.stringify(new URL('../dist/approval.js',import.meta.url).href)});
      for(const value of ['http://example.com/','https://user:password@example.com/','https://example.com/\\nPRIVATE_QUERY'])await assert.rejects(openApprovalBrowser(value));
      assert.equal(calls,0);await openApprovalBrowser('https://example.com/approve?code=PRIVATE_QUERY');assert.equal(calls,1);`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:directory,env:{...process.env,PATH:directory},windowsHide:true});let out='',err='';child.stdout.on('data',bytes=>out+=bytes);child.stderr.on('data',bytes=>err+=bytes);
    const [code]=await once(child,'exit');assert.equal(code,0,err);assert.ok(!out.includes('PRIVATE_QUERY')&&!err.includes('PRIVATE_QUERY'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('typed auth retry deadlines preserve decimal precision and ignore raw failure details',async()=>{
  const f=await fixture();try{
    for(const deadline of ['1792860000000','99999999999999999999999999999999999999999999999999']){
      f.backend.healthCheck=async()=>{throw new AuthFailure('rate_limited',undefined,Infinity,deadline);};
      const failed=await f.run(['connections']),error=failed.out.toJSON().error as Record<string,unknown>;
      assert.equal(error.retryAt,deadline);assert.equal(error.retryAfterMs,undefined);
    }
    f.backend.healthCheck=async()=>{throw new AuthFailure('rate_limited',undefined,2000,'PRIVATE_UNVALIDATED_DATE');};
    const typed=(await f.run(['connections'])).out.toJSON().error as Record<string,unknown>;assert.equal(typed.retryAfterMs,2000);assert.equal(typed.retryAt,undefined);
    f.backend.healthCheck=async()=>{throw {code:'rate_limited',retryAt:'1792860000000',requiredScopes:['PRIVATE_RAW_SCOPES'],message:'PRIVATE_RAW_ERROR'};};
    const raw=await f.run(['connections']);assert.deepEqual(raw.out.toJSON().error,{code:'rate_limited'});assert.ok(!JSON.stringify(raw).includes('PRIVATE_'));
  }finally{await f.close();}
});

test('discovery and scopes show issuer-selected methods and company descriptions',async()=>{
  const f=await fixture();try{
    const found=(await f.ok(['discovery'])).toJSON();
    assert.deepEqual(found.authMethods,['direct','device','mediated']);
    assert.deepEqual(found.scopes,['orders:read']);assert.deepEqual(found.scopeDescriptions,{'orders:read':'Read orders'});
    await f.ok(['connect']);const scopes=await f.ok(['scopes']);
    assert.deepEqual(scopes.methods.map((item:{method:string})=>item.method),found.authMethods);
    assert.deepEqual(scopes.toJSON().scopeDescriptions,found.scopeDescriptions);
  }finally{await f.close();}
});
