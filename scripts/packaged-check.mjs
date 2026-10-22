// Run against an actual clean install: node scripts/packaged-check.mjs <consumer-project>.
// The generic HTTP tunnel is an explicit trusted test transport; this is not TLS/OS-keyring evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const project=resolve(process.argv[2]??'.');
async function exported(name,subpath='.'){const directory=join(project,'node_modules',...name.split('/')),manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));assert.ok(manifest.exports[subpath]?.import);return pathToFileURL(join(directory,manifest.exports[subpath].import)).href;}
const cli=join(project,'node_modules','@poppykit','cli','dist','cli.js');
const {createProvider,createResultCipher}=await import(await exported('@poppykit/client','./provider'));
const {SqliteProviderStore}=await import(await exported('@poppykit/client','./provider/sqlite'));
const home=await mkdtemp(join(tmpdir(),'packaged Poppy ü '));
const store=new SqliteProviderStore(join(home,'provider.sqlite'));
const issuer='https://company.example/issuer',clientId='https://identity.example/client.json',callbackUrl='https://identity.example/callback';
const doc={protocol_version:'0.2',organization:{name:'Generic company',domain:'company.example'},auth:{issuer,direct:{scopes:['poppy:read']},device:{scopes:['poppy:read']}},agent:{protocols:[{type:'poppy',endpoint:'https://company.example/conversations'}]}};
const authorization={issuer,poppy_domains:['company.example'],token_endpoint:'https://company.example/token',revocation_endpoint:'https://company.example/revoke',authorization_endpoint:'https://company.example/authorize',device_authorization_endpoint:'https://company.example/device'};
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const provider=createProvider({clientId,callbackUrl,jwksUri:'https://identity.example/jwks',clientName:'Generic',store,cipher:createResultCipher(randomBytes(32)),metadata:{resolveCompany:async()=>({document:doc,authorization})},authenticateEnrollment:async req=>req.headers.get('x-operator-auth')==='fixture-only'?{subject:'visitor',allowedCompanies:['company.example']}:null,signer:{kid:'key',publicJwk:()=>crypto.subtle.exportKey('jwk',pair.publicKey),sign:async input=>new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,input))}});
const sends=[];let lose=true,heldResolve,heldRelease;
const held=new Promise(r=>heldResolve=r),release=new Promise(r=>heldRelease=r);
const server=createServer(async(req,res)=>{try{let data='';for await(const chunk of req)data+=chunk;const input=JSON.parse(data),request=new Request(input.url,{method:input.method,headers:input.headers,...(input.body?{body:input.body}:{})}),url=new URL(input.url);let response;
  if(url.hostname==='identity.example')response=await provider.handle(request);
  else if(url.pathname==='/.well-known/poppy.json')response=Response.json(doc);
  else if(url.pathname==='/.well-known/oauth-authorization-server/issuer')response=Response.json(authorization);
  else if(url.pathname==='/token'){const form=new URLSearchParams(input.body);if(form.get('grant_type')==='authorization_code'&&form.get('code')==='HELD_CODE'){heldResolve();await release;}const signedIn=form.get('grant_type')!=='urn:ietf:params:oauth:grant-type:jwt-bearer';response=Response.json({access_token:'PRIVATE_ACCESS',token_type:'DPoP',expires_in:300,session_id:form.get('session_id')??'session1',signed_in:signedIn,scope:signedIn?'poppy:read':'',...(signedIn?{refresh_token:'PRIVATE_ACCOUNT'}:{})});}
  else if(url.pathname==='/revoke')response=new Response(null,{status:200});
  else if(url.pathname.startsWith('/conversations')){if(request.method==='POST'){sends.push(JSON.parse(input.body));if(lose){lose=false;res.destroy();return;}}response=Response.json({conversation_id:'conversation1',status:'idle',responder:'agent'});}
  else throw new Error('unexpected request');
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:response.status,headers:[...response.headers],body:await response.text()}));
}catch{res.writeHead(500);res.end('{}');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const tunnel=`http://127.0.0.1:${server.address().port}`;
const backendFile=join(home,'trusted-fixture.mjs');
await writeFile(backendFile,`import {encryptedBackend} from ${JSON.stringify(await exported('@poppykit/cli'))};
export async function open(){const backend=await encryptedBackend(process.env.FIXTURE_SECRET_DIRECTORY,process.env.FIXTURE_UNLOCK);backend.enrollmentAuth=async()=>({'x-operator-auth':'fixture-only'});backend.transport={async fetch(request){const response=await fetch(process.env.FIXTURE_TUNNEL,{method:'POST',body:JSON.stringify({url:request.url,method:request.method,headers:[...request.headers],body:request.method==='GET'||request.method==='HEAD'?null:await request.text()})});if(!response.ok)throw new Error('fixture tunnel failed');const result=await response.json();return new Response(result.body||null,{status:result.status,headers:result.headers});}};return backend;}`);
const env={...process.env,POPPYKIT_HOME:join(home,'state'),FIXTURE_TUNNEL:tunnel,FIXTURE_SECRET_DIRECTORY:join(home,'ciphertext'),FIXTURE_UNLOCK:randomBytes(32).toString('base64url')};
function run(args,extra={}){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args,'--json'],{cwd:project,env:{...env,...extra},windowsHide:true});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>{try{assert.ok(!out.includes('PRIVATE_'),out);resolve({code,json:JSON.parse(out),err});}catch(e){reject(e);}});});}
async function ok(args){const result=await run(args);assert.equal(result.code,0,JSON.stringify(result.json));return result.json.result;}
try{
  const manifest=JSON.parse(await readFile(join(project,'node_modules/@poppykit/cli/package.json'),'utf8'));assert.equal(manifest.dependencies['@poppykit/client'],'0.0.0');
  assert.ok((await readdir(join(project,'node_modules/.bin'))).some(name=>name==='poppykit'||name==='poppykit.cmd'));
  await ok(['setup','--provider','https://identity.example/v1','--company','company.example']);
  const missing=await run(['enroll']);assert.equal(missing.code,4);
  const unlock=await run(['enroll','--unlock']);assert.equal(unlock.code,4);assert.equal(unlock.json.error.code,'trusted_terminal_required');
  await ok(['backend','--module',backendFile]);await ok(['enroll']);await ok(['connect']);
  const started=await ok(['auth-start','--method','direct','--scope','poppy:read']);
  const callback=new URL(callbackUrl);callback.searchParams.set('state',new URL(started.authorizationUrl).searchParams.get('state'));callback.searchParams.set('iss',issuer);callback.searchParams.set('code','HELD_CODE');provider.callback(callback.href);
  const exchanging=run(['auth-continue',started.outcome.operationId]);await held;
  const concurrent=await ok(['connections']);assert.equal(concurrent.connections[0].status,'signed_out');
  const pending=await ok(['auth-status',started.outcome.operationId]);assert.equal(pending.status,'pending');
  heldRelease();const completed=await exchanging;assert.equal(completed.code,0,JSON.stringify(completed.json));assert.equal(completed.json.result.status,'completed');
  assert.equal((await ok(['auth-status',started.outcome.operationId])).status,'completed');
  const wrong=await run(['connections'],{FIXTURE_UNLOCK:'different long test passphrase'});assert.equal(wrong.code,4);
  const absent=await run(['connections'],{FIXTURE_SECRET_DIRECTORY:join(home,'missing-vault')});assert.equal(absent.code,4);
  const failed=await run(['start','--text','generic','--send-operation','retry1']);assert.equal(failed.code,1);
  const retries=await Promise.all([run(['retry','retry1']),run(['retry','retry1'])]);for(const result of retries){assert.equal(result.code,0,JSON.stringify(result.json));if(result.json.result.status==='pending')await ok(['retry','retry1']);}assert.ok(sends.length>=2&&sends.length<=3);for(const send of sends)assert.deepEqual(send,sends[0]);
  await ok(['retry-remove','retry1']);
  await ok(['sign-out']);
  console.log(JSON.stringify({status:'passed',platform:process.platform,node:process.version,checks:['installed-bin','exports','provider-enrollment','encrypted-durable-secret-backend','Direct-restart','live-auth-second-process','concurrent-retry','stable-message-id','missing-locked-store','no-opener-keyring','unicode-space-paths','sign-out'],transport:'explicit-fixture-tunnel; no TLS claim'}));
}finally{heldRelease();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();await rm(home,{recursive:true,force:true});}
