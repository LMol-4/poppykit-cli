import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { main, runtimeSupported } from '../dist/cli.js';
import { encryptedBackend, openBackend } from '../dist/secrets.js';
import { State } from '../dist/state.js';
import { createProvider, createResultCipher } from '@poppykit/client/provider';
import { SqliteProviderStore } from '@poppykit/client/provider/sqlite';

const clientId='https://identity.example/client.json',callbackUrl='https://identity.example/callback',issuer='https://company.example/issuer';
async function fixture(){
  const home=await mkdtemp(join(tmpdir(),'poppy ü spaces ')),secrets=new Map(),store=new SqliteProviderStore(join(home,'provider.sqlite'));
  const backend={secrets:{async stage(v){const id=randomUUID();secrets.set(id,v);return id;},async read(id){return secrets.get(id)??null;},async remove(id){secrets.delete(id);}},async healthCheck(){},async enrollmentAuth(){return {'x-human':'yes'};},trustedInput:{async collect(req){return req.challenge?{code:'PRIVATE_OTP'}:{password:'PRIVATE_PASSWORD'};}}};
  const doc={protocol_version:'0.2',organization:{name:'Generic',domain:'company.example'},auth:{issuer,direct:{scopes:['poppy:read']},device:{scopes:['poppy:read']},mediated:{endpoint:'https://company.example/mediated',fields:[{name:'password',label:'Password',secret:true}],scopes:['poppy:read']}},agent:{protocols:[{type:'poppy',endpoint:'https://company.example/conversations'}]}};
  const authorization={issuer,token_endpoint:'https://company.example/token',revocation_endpoint:'https://company.example/revoke',poppy_domains:['company.example'],authorization_endpoint:'https://company.example/authorize',device_authorization_endpoint:'https://company.example/device'};
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const metadata={resolveCompany:async()=>({document:doc,authorization})};
  const provider=createProvider({clientId,callbackUrl,jwksUri:'https://identity.example/jwks',clientName:'Generic',store,cipher:createResultCipher(randomBytes(32)),metadata,signer:{kid:'key',publicJwk:()=>crypto.subtle.exportKey('jwk',key.publicKey),sign:async bytes=>new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,bytes))},authenticateEnrollment:async request=>request.headers.get('x-human')==='yes'?{subject:'human',allowedCompanies:['company.example']}:null});
  const sent=[];let loseSend=false,mediated=0;
  const token=(signedIn,session='session1')=>({access_token:signedIn?'PRIVATE_ACCESS':'PRIVATE_SESSION',token_type:'DPoP',expires_in:300,session_id:session,signed_in:signedIn,scope:signedIn?'poppy:read':'',...(signedIn?{refresh_token:'PRIVATE_ACCOUNT'}:{})});
  const transport={async fetch(request){const u=new URL(request.url);if(u.hostname==='identity.example')return provider.handle(request);if(u.pathname==='/.well-known/poppy.json')return Response.json(doc);if(u.pathname==='/.well-known/oauth-authorization-server/issuer')return Response.json(authorization);if(u.pathname==='/token'){const form=new URLSearchParams(await request.text());return Response.json(token(form.get('grant_type')!=='urn:ietf:params:oauth:grant-type:jwt-bearer',form.get('session_id')??'session1'));}if(u.pathname==='/device')return Response.json({device_code:'PRIVATE_DEVICE',user_code:'USER-CODE',verification_uri:'https://company.example/verify',expires_in:600,interval:1});if(u.pathname.startsWith('/mediated')){mediated++;const body=await request.json();if(mediated===1){assert.equal(body.credentials.password,'PRIVATE_PASSWORD');return Response.json({status:'code_required',sign_in_id:'challenge1',code:{sent_to:'email'},expires_at:new Date(Date.now()+600000).toISOString()});}assert.equal(body.code,'PRIVATE_OTP');return Response.json({status:'complete',...token(true)});}if(u.pathname==='/revoke')return new Response(null,{status:200});if(u.pathname.startsWith('/conversations')){if(request.method==='POST'){sent.push(await request.json());if(loseSend){loseSend=false;throw new Error('PRIVATE_FAILURE');}return Response.json({conversation_id:'conversation1',status:'idle',responder:'agent'});}return Response.json({conversation_id:'conversation1',status:'idle',responder:'agent',events:[],cursor:null,has_more:false});}throw new Error('unexpected fixture destination '+request.url);}};
  const run=async args=>main([...args,'--json'],{POPPYKIT_HOME:home},{backend,transport});
  const ok=async args=>{const result=await run(args);assert.equal(result.code,0,JSON.stringify(result.out));assert.equal(typeof result.out,'object');return result.out.result;};
  await ok(['setup','--provider','https://identity.example/v1','--company','company.example']);await ok(['enroll']);
  return {home,backend,provider,transport,run,ok,sent,secrets,setLoseSend:()=>loseSend=true,close:async()=>{store.close();await rm(home,{recursive:true,force:true});}};
}
test('offline startup, runtime floor, stable JSON and no secure backend fallback',async()=>{
  assert.equal(runtimeSupported('24.11.9'),false);assert.equal(runtimeSupported('24.12.0'),true);assert.equal(runtimeSupported('25.0.0'),true);
  const home=await mkdtemp(join(tmpdir(),'startup ü '));try{
    const help=await main(['--help'],{POPPYKIT_HOME:join(home,'absent')});assert.equal(help.code,0);assert.match(help.out,/no daemon or PowerShell/);assert.deepEqual(await readdir(home),[]);
    const invalid=await main(['send','--password','SECRET'],{POPPYKIT_HOME:home});assert.equal(invalid.code,2);assert.ok(!JSON.stringify(invalid).includes('SECRET'));
    await main(['setup','--provider','https://identity.example/v1','--company','company.example'],{POPPYKIT_HOME:home});
    const missing=await main(['enroll','--json'],{POPPYKIT_HOME:home});assert.equal(missing.code,4);assert.equal(missing.out.error.code,'secure_backend_required');
    const unattended=await main(['enroll','--unlock','--json'],{POPPYKIT_HOME:home});assert.equal(unattended.code,4);assert.equal(unattended.out.error.code,'trusted_terminal_required');
  }finally{await rm(home,{recursive:true,force:true});}
});
test('encrypted attended backend persists only ciphertext, rejects wrong unlock and unavailable modules',async()=>{
  const home=await mkdtemp(join(tmpdir(),'encrypted ü '));try{
    const first=await encryptedBackend(home,'a long independent passphrase');await first.healthCheck();const ref=await first.secrets.stage('PRIVATE_SECRET');first.close();
    const files=await readdir(home);assert.equal(files.length,3);assert.ok(files.includes('unlock-check'));assert.equal((await readFile(join(home,ref+'.enc'))).includes(Buffer.from('PRIVATE_SECRET')),false);
    const second=await encryptedBackend(home,'a long independent passphrase');assert.equal(await second.secrets.read(ref),'PRIVATE_SECRET');second.close();
    const wrong=await encryptedBackend(home,'a totally different passphrase');await assert.rejects(wrong.secrets.read(ref),{code:'secure_store_locked'});wrong.close();
    await assert.rejects(openBackend({module:join(home,'missing.mjs'),directory:home}),{code:'secure_store_unavailable'});
    const module=join(home,'locked.mjs');await writeFile(module,"export async function open(){throw new Error('PRIVATE_DETAILS')}");await assert.rejects(openBackend({module,directory:home}),{code:'secure_store_unavailable'});
  }finally{await rm(home,{recursive:true,force:true});}
});
test('Direct enrollment, callback, restart completion and sign-out redact all credentials',async()=>{
  const f=await fixture();try{
    const connection=await f.ok(['connect']);assert.equal(connection.connection.status,'signed_out');
    const start=await f.ok(['auth-start','--method','direct','--scope','poppy:read']);const op=start.outcome.operationId;
    const authorization=new URL(start.authorizationUrl);assert.equal(authorization.hostname,'company.example');
    const callback=new URL(callbackUrl);callback.searchParams.set('state',authorization.searchParams.get('state'));callback.searchParams.set('iss',issuer);callback.searchParams.set('code','PRIVATE_CODE');f.provider.callback(callback.href);
    const result=await f.ok(['auth-continue',op]);assert.equal(result.status,'completed');assert.equal(result.connection.status,'signed_in');
    assert.ok(!JSON.stringify([connection,start,result]).includes('PRIVATE_'));
    const scopes=await f.ok(['scopes','--scope','poppy:read']);assert.equal(scopes.sufficient,true);
    const signedOut=await f.ok(['sign-out']);assert.equal(signedOut.connection.status,'disconnected');
  }finally{await f.close();}
});
test('Device and Mediated sign-in restart through SDK lifecycle and trusted input',async()=>{
  for(const method of ['device','mediated']){const f=await fixture();try{
    await f.ok(['connect']);const start=await f.ok(['auth-start','--method',method,'--scope','poppy:read']);assert.equal(start.outcome.status,'pending');
    if(method==='device'){assert.equal(start.device.userCode,'USER-CODE');await new Promise(r=>setTimeout(r,1100));}
    const complete=await f.ok(['auth-continue',start.outcome.operationId]);assert.equal(complete.status,'completed');assert.equal(complete.connection.status,'signed_in');assert.ok(!JSON.stringify([start,complete]).includes('PRIVATE_'));
  }finally{await f.close();}}
});
test('retry preserves exact message identity and refuses profile, enrollment, issuer and endpoint changes',async()=>{
  const f=await fixture();try{
    await f.ok(['connect']);f.setLoseSend();const failed=await f.run(['start','--text','generic message','--send-operation','saved']);assert.equal(failed.code,1);
    await f.ok(['retry','saved']);assert.equal(f.sent.length,2);assert.deepEqual(f.sent[0],f.sent[1]);
    const state=new State(join(f.home,'cli.sqlite')),p=state.profile();state.update(p,{provider:'https://other.example/v1'});state.close();
    const changed=await f.run(['retry','saved']);assert.equal(changed.code,5);assert.equal(f.sent.length,2);
    const local=new State(join(f.home,'cli.sqlite'));const binding={profileId:p.id,provider:p.provider,installationId:p.installationId,enrollmentRef:p.credentialRef,connectionId:p.connectionId,issuer,endpoint:'https://company.example/conversations',resource:null};
    for(const change of [{profileId:'new'},{installationId:'new'},{enrollmentRef:'new'},{connectionId:'new'},{issuer:'https://evil.example'},{endpoint:'https://evil.example'}])assert.throws(()=>local.prepareRetry('saved',{...binding,...change}),{code:'retry_binding_conflict'});local.close();
  }finally{await f.close();}
});
test('cancel and backend errors do not expose secrets or raw adapter failures',async()=>{
  const f=await fixture();try{await f.ok(['connect']);const start=await f.ok(['auth-start','--method','direct','--scope','poppy:read']);const result=await f.run(['auth-cancel',start.outcome.operationId]);assert.equal(result.code,130);assert.equal(result.out.result.status,'cancelled');
    f.backend.healthCheck=async()=>{throw new Error('PRIVATE_BACKEND_ERROR')};const failed=await f.run(['connections']);assert.equal(failed.code,1);assert.ok(!JSON.stringify(failed).includes('PRIVATE_BACKEND_ERROR'));
  }finally{await f.close();}
});
test('separate processes concurrently create profiles without lost writes',async()=>{
  const home=await mkdtemp(join(tmpdir(),'concurrent ü '));try{
    const cli=new URL('../dist/cli.js',import.meta.url);
    const run=n=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli.pathname.replace(/^\/(\w:)/,'$1'),'setup','--profile',n,'--provider','https://identity.example/v1','--company','company.example','--json'],{env:{...process.env,POPPYKIT_HOME:home},windowsHide:true});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});
    const results=await Promise.all(['one','two','three'].map(run));for(const r of results)assert.equal(r.code,0,r.err+r.out);const state=new State(join(home,'cli.sqlite'));assert.equal(state.list('profile').length,3);state.close();
  }finally{await rm(home,{recursive:true,force:true});}
});
test('invocation cancellation fences a late Direct token response and retains uncertainty',async()=>{
  const f=await fixture();let release;try{
    await f.ok(['connect']);const started=await f.ok(['auth-start','--method','direct','--scope','poppy:read']);
    const u=new URL(callbackUrl);u.searchParams.set('state',new URL(started.authorizationUrl).searchParams.get('state'));u.searchParams.set('iss',issuer);u.searchParams.set('code','PRIVATE_CODE');f.provider.callback(u.href);
    const original=f.transport.fetch;let reached;const ready=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
    f.transport.fetch=async req=>{if(new URL(req.url).pathname==='/token'&&(await req.clone().text()).includes('authorization_code')){reached();await gate;}return original(req);};
    const pending=f.run(['auth-continue',started.outcome.operationId]);await ready;process.emit('SIGTERM');const canceled=await pending;assert.equal(canceled.code,130);assert.equal(canceled.out.error.code,'canceled');release();await new Promise(r=>setTimeout(r,20));
    const status=await f.run(['auth-status',started.outcome.operationId]);assert.equal(status.code,6);assert.equal(status.out.result.status,'uncertain');assert.equal(status.out.result.connection.status,'signed_out');
  }finally{release?.();await f.close();}
});
test('watch preserves stream delegation, returns cursor, and signals cancel instead of success',async()=>{
  const f=await fixture();try{
    await f.ok(['connect']);await f.ok(['start','--text','generic']);let streams=0;
    f.transport.stream=async()=>{streams++;return Response.json({conversation_id:'conversation1',status:'closed',responder:'agent',events:[{id:'event1',type:'state',created_at:new Date().toISOString(),status:'closed',responder:'agent'}],cursor:'event1',has_more:false});};
    const watched=await f.ok(['watch','conversation1']);assert.equal(streams,1);assert.equal(watched.cursor,'event1');
    let reached;const ready=new Promise(r=>reached=r);f.transport.stream=async()=>{reached();return new Promise(()=>{});};
    const watching=f.run(['watch','conversation1']);await ready;process.emit('SIGINT');const canceled=await watching;assert.equal(canceled.code,130);assert.equal(canceled.out.status,'error');
  }finally{await f.close();}
});

