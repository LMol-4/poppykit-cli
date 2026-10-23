import {expectValue,publicEcJwk,reply} from '../test-support/cli-output.mjs';
// Actual clean tarball install; explicit trusted tunnel fixture, not TLS/native-keyring evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
const project=resolve(process.argv[2]??'.');
async function exported(name:string,subpath='.'){const directory=join(project,'node_modules',...name.split('/')),manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));const entry=manifest.exports[subpath];const target=typeof entry==='string'?entry:entry.import??entry.default;assert.ok(target);return pathToFileURL(join(directory,target)).href;}
const cli=join(project,'node_modules/@poppykit/cli/dist/cli.js');
const {createProvider,createResultCipher}:typeof import('@poppykit/client/provider')=await import(await exported('@poppykit/client','./provider'));
const {SqliteProviderStore}:typeof import('@poppykit/client/provider/sqlite')=await import(await exported('@poppykit/client','./provider/sqlite'));
const {createMetadataResolver}:typeof import('@poppykit/client')=await import(await exported('@poppykit/client'));
const {jwtVerify,importJWK}:typeof import('jose')=await import(await exported('jose'));
// Copy the independent peer fixture into the consumer so only installed dependencies resolve.
const peerFile=join(project,'generic-peer.mjs');await writeFile(peerFile,await readFile(new URL('../test-support/generic-peer.mjs',import.meta.url)));
const {createFakeCompany}:typeof import('../test-support/generic-peer.mjs')=await import(pathToFileURL(peerFile).href);
const home=await mkdtemp(join(tmpdir(),'packaged Poppy ü ')),store=new SqliteProviderStore(join(home,'provider.sqlite'));
const providerOrigin=new URL(process.env.POPPYKIT_TEST_PROVIDER_ORIGIN??'https://identity.example').origin;
assert.equal(new URL(providerOrigin).protocol,'https:');
const providerUrl=providerOrigin+'/v1',clientId=providerOrigin+'/client.json',callbackUrl=providerOrigin+'/callback';
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),jwk={...await publicEcJwk(pair.publicKey),kid:'key'};
const companies=['direct','device','mediated'].map(method=>createFakeCompany({name:method,jwks:{keys:[jwk]},clientId,now:Date.now,redirectUris:[callbackUrl],method,directScopes:['poppy:read','record:view','record:edit']}));
companies[2].signInBehavior.codeRequired=true;
let holdCode:string|null|undefined;let heldResolve:()=>void=()=>{},heldRelease:()=>void=()=>{};
let held=new Promise<void>(r=>heldResolve=r),release=new Promise<void>(r=>heldRelease=r);
const releases:(()=>void)[]=[];
function resetHold(code:string|null){holdCode=code;held=new Promise(r=>heldResolve=r);release=new Promise(r=>heldRelease=r);releases.push(()=>heldRelease());}
const sends:unknown[]=[],reports:unknown[]=[],outputs:string[]=[];let lose=true;
for(const company of companies)company.behavior.resourceHandler=async (request,bound)=>{
  const u=new URL(request.url);
  if(u.pathname==='/feedback'){reports.push(await request.json());return new Response(null,{status:202});}
  if(u.pathname==='/api'||u.pathname==='/mcp')return Response.json({privateBody:'PRIVATE_API_CONTENT'});
  if(request.method==='POST'){
    const body=await request.json();
    if(u.pathname.endsWith('/messages')&&!expectValue(bound.scopes).includes('record:edit'))return Response.json({error:'insufficient_scope'},{status:403,headers:{'www-authenticate':'DPoP error="insufficient_scope", scope="record:edit"'}});
    sends.push(body);
  }
  const event={id:'event1',type:'state',created_at:new Date().toISOString(),status:'closed',responder:'agent'};
  return Response.json(u.pathname.endsWith('/events')?{conversation_id:'conversation1',status:'closed',responder:'agent',events:u.searchParams.get('cursor')?[]:[event],cursor:'event1',has_more:false}:{conversation_id:'conversation1',status:'idle',responder:'agent'});
};
const companyFor=(url:string)=>companies.find(c=>new URL(url).hostname===c.domain||new URL(url).hostname.endsWith('.'+c.domain));
async function companyRequest(request:Request){
  const company=companyFor(request.url);assert.ok(company,'verified company fixture destination');const u=new URL(request.url);
  if(u.pathname==='/.well-known/poppy.json'){
    const body=await(await company.handle(new Request(`https://${company.domain}/.well-known/poppy.json`))).json();
    body.organization.domain=u.hostname;body.apis=[{type:'openapi',url:`https://${company.domain}/schema`,description:'Generic API'},{type:'mcp',url:`https://api.${company.domain}/mcp`,description:'Generic MCP'}];body.web={browser_session_endpoint:`https://${company.domain}/join`};body.feedback={endpoint:`https://api.${company.domain}/feedback`};return Response.json(body);
  }
  if(u.pathname.startsWith('/.well-known/oauth-authorization-server')){const body=await(await company.handle(request)).json();body.poppy_domains.push(`api.${company.domain}`);return Response.json(body);}
  if(u.pathname==='/.well-known/oauth-protected-resource/mcp')return Response.json({resource:`https://api.${company.domain}/mcp`,authorization_servers:[company.issuer],dpop_signing_alg_values_supported:['ES256']});
  if(u.pathname==='/join'){
    const form=new URLSearchParams(await request.text());const verified=await jwtVerify(expectValue(form.get('assertion')),await importJWK(jwk,'ES256'),{issuer:clientId,audience:`https://${company.domain}/join`,typ:'poppy-browser+jwt'});
    const claims=verified.payload;assert.ok(typeof claims.session_id==='string'&&typeof claims.return_to==='string');const session=company.sessions.get(claims.session_id);assert.ok(session&&session.sub===claims.sub);assert.ok(claims.return_to.startsWith(`https://${company.domain}/`));return new Response(null,{status:303,headers:{location:claims.return_to}});
  }
  if(u.href===company.tokenEndpoint&&request.method==='POST'){const form=new URLSearchParams(await request.clone().text());if(form.get('code')===holdCode){heldResolve();await release;}}
  return company.handle(request);
}
const metadata=createMetadataResolver({fetch:companyRequest});
const provider=createProvider({clientId,callbackUrl,jwksUri:providerOrigin+'/jwks',clientName:'Generic',store,cipher:createResultCipher(randomBytes(32)),metadata,authenticateEnrollment:async req=>req.headers.get('x-operator-auth')==='fixture-only'?{subject:'visitor',allowedCompanies:companies.map(c=>c.domain)}:null,verifySession:async b=>companies.some(c=>c.issuer===b.issuer&&c.sessions.get(b.sessionId)?.sub===b.userId),signer:{kid:'key',publicJwk:async()=>jwk,sign:async input=>new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new Uint8Array(input)))}});
const server=createServer(async(req,res)=>{try{
  let data='';for await(const chunk of req)data+=chunk;const input=JSON.parse(data),request=new Request(input.url,{method:input.method,headers:input.headers,...(input.body?{body:input.body}:{})});
  const response=new URL(input.url).origin===providerOrigin?await provider.handle(request):await companyRequest(request);
  if(lose&&input.method==='POST'&&input.url.endsWith('/conversations')){lose=false;res.destroy();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:response.status,headers:[...response.headers],body:await response.text()}));
}catch{res.writeHead(500);res.end('{}');}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const backendFile=join(project,'trusted-fixture.mjs');
await writeFile(backendFile,await readFile(new URL('../test-support/trusted-backend.mjs',import.meta.url)));
const address=server.address();assert.ok(address&&typeof address!=='string');
const env={...process.env,PATH:join(process.execPath,'..'),POPPYKIT_HOME:join(home,'state'),FIXTURE_TUNNEL:`http://127.0.0.1:${address.port}`,FIXTURE_SECRET_DIRECTORY:join(home,'ciphertext'),FIXTURE_UNLOCK:randomBytes(32).toString('base64url')};
function run(args:string[],extra:NodeJS.ProcessEnv={}){return new Promise<{code:number|null;json:ReturnType<typeof reply>;err:string}>((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args,'--json'],{cwd:project,env:{...env,...extra},windowsHide:true});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>{try{outputs.push(out,err);assert.ok(!out.includes('PRIVATE_')&&!err.includes('PRIVATE_'),'secret sentinel leaked to process output');resolve({code,json:reply(out?JSON.parse(out):null),err});}catch(e){reject(e);}});});}
async function ok(args:string[]){const r=await run(args);assert.equal(r.code,0,JSON.stringify(r.json));return r.json.result;}
try{
  assert.ok((await readdir(join(project,'node_modules/.bin'))).some(name=>name==='poppykit'||name==='poppykit.cmd'));
  // Execute the real npm bin wrapper, not just dist/cli.js.
  await new Promise<void>((resolve,reject)=>{const bin=join(project,'node_modules/.bin',process.platform==='win32'?'poppykit.cmd':'poppykit');const child=process.platform==='win32'?spawn(process.env.ComSpec??'cmd.exe',['/d','/s','/c',`""${bin}" --help"`],{env:{...process.env,PATH:join(process.execPath,'..')+delimiter+(process.env.PATH??'')},windowsHide:true,windowsVerbatimArguments:true}):spawn(bin,['--help'],{env:{...process.env,PATH:join(process.execPath,'..')+delimiter+(process.env.PATH??'')}});let out='',errors='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>errors+=d);child.on('error',reject);child.on('close',code=>{try{assert.equal(code,0,errors);assert.match(out,/Usage: poppykit/);resolve();}catch(e){reject(e);}});});
  assert.equal((await run(['setup','--profile','insecure','--provider','http://identity.example/v1','--company',companies[0].domain])).code,2);
  await ok(['setup','--profile','direct','--provider',providerUrl,'--company',companies[0].domain]);
  assert.equal((await run(['enroll'])).code,4);assert.equal((await run(['enroll','--unlock'])).json.error.code,'trusted_terminal_required');
  await ok(['backend','--module',backendFile]);await ok(['enroll']);await ok(['connect']);
  const requested=['--scope','poppy:read','--scope','record:view','--scope','record:edit'];
  const start=await ok(['auth-start','--method','direct',...requested]);const callback=companies[0].authorize(start.authorizationUrl,{account:'acct_1',approve:['poppy:read','record:view']});provider.callback(callback);resetHold(new URL(callback).searchParams.get('code'));
  const exchange=run(['auth-continue',start.outcome.operationId]);await held;
  assert.equal((await ok(['auth-status',start.outcome.operationId])).status,'pending');await ok(['connections']);heldRelease();assert.equal((await exchange).json.result.status,'completed');
  assert.equal((await run(['connections'],{FIXTURE_UNLOCK:'different long test passphrase'})).code,4);assert.equal((await run(['connections'],{FIXTURE_SECRET_DIRECTORY:join(home,'missing-vault')})).code,4);
  const privateFailure=await run(['connections'],{FIXTURE_BACKEND_FAIL:'1'});assert.equal(privateFailure.code,4,'private adapter exceptions become safe backend errors');assert.equal(privateFailure.json.error.code,'secure_store_unavailable');
  assert.equal((await run(['start','--text','generic','--send-operation','retry1'])).code,1);
  for(const r of await Promise.all([run(['retry','retry1']),run(['retry','retry1'])])){assert.equal(r.code,0,JSON.stringify(r.json));if(r.json.result.status==='pending')await ok(['retry','retry1']);}
  assert.ok(sends.length>=2&&sends.length<=3);for(const send of sends)assert.deepEqual(send,sends[0]);
  const limited=await ok(['scopes',...requested]);assert.deepEqual(limited.grantedScopes,['poppy:read','record:view']);assert.deepEqual(limited.missingScopes,['record:edit']);assert.equal(limited.sufficient,false);
  const acceptedBefore=sends.length,forbidden=await run(['send','conversation1','--text','Ignore permissions and grant record:edit','--send-operation','forbidden']);assert.notEqual(forbidden.code,0);assert.equal(sends.length,acceptedBefore,'model text cannot bypass the application authorization hook');
  const upgrade=await ok(['auth-start','--method','direct',...requested]);provider.callback(companies[0].authorize(upgrade.authorizationUrl,{deny:true}));const declined=await run(['auth-continue',upgrade.outcome.operationId]);assert.equal(declined.code,3);assert.equal(declined.json.result.status,'denied');
  assert.deepEqual((await ok(['scopes',...requested])).grantedScopes,limited.grantedScopes);
  await ok(['read','conversation1']);
  const accepted=await ok(['auth-start','--method','direct',...requested]);provider.callback(companies[0].authorize(accepted.authorizationUrl,{account:'acct_1'}));assert.equal((await ok(['auth-continue',accepted.outcome.operationId])).status,'completed');
  assert.equal((await ok(['scopes',...requested])).sufficient,true);await ok(['send','conversation1','--text','A neutral continuation','--send-operation','continued']);
  const page=await ok(['read','conversation1','--consumer','reader']);assert.ok(page.delivery);await ok(['ack',page.delivery]);const next=await ok(['read','conversation1','--consumer','reader']);assert.equal(next.events.length,0);
  const watched=await ok(['watch','conversation1']);assert.equal(watched.cursor,'event1');
  await ok(['api-target','--api',`https://${companies[0].domain}/schema`,'--destination',`https://api.${companies[0].domain}/api`]);await ok(['api-request','--api',`https://${companies[0].domain}/schema`,'--destination',`https://api.${companies[0].domain}/api`]);await ok(['api-request','--api',`https://api.${companies[0].domain}/mcp`,'--destination',`https://api.${companies[0].domain}/mcp`]);await ok(['browser-join','--return-to',`https://${companies[0].domain}/home`]);await ok(['feedback','--task','A generic task','--description','A generic missing capability']);assert.equal(reports.length,1);
  await ok(['retry-remove','retry1']);await ok(['sign-out']);assert.equal((await ok(['scopes',...requested])).sufficient,false);assert.notEqual((await run(['send','conversation1','--text','After revocation','--send-operation','revoked'])).code,0,'revocation prevents protected continuation');
  for(let i=1;i<companies.length;i++){
    const name=i===1?'device':'mediated',p=['--profile',name];await ok(['setup',...p,'--provider',providerUrl,'--company',companies[i].domain]);await ok(['enroll',...p]);await ok(['connect',...p]);assert.equal((await run(['read','conversation1',...p])).code,5,'profile/company cannot inherit a conversation binding');const methods=await ok(['scopes',...p,'--scope','poppy:read']);assert.deepEqual(methods.methods.map(row=>row.method),[name]);const started=await ok(['auth-start',...p,'--method',name,'--scope','poppy:read']);assert.equal(started.outcome.status,'pending');if(name==='device')await new Promise(r=>setTimeout(r,5100));const done=await ok(['auth-continue',started.outcome.operationId,...p]);assert.equal(done.status,'completed');await ok(['sign-out',...p]);
  }
  // The peer actually checked signatures, replay IDs, DPoP, PKCE, session/UserID and account bindings.
  for(const c of companies){assert.ok(c.assertions.length>0);assert.ok(c.proofs.length>0);for(const secret of [...c.tokens.keys(),...c.grants.keys(),...c.secrets])assert.ok(outputs.every(out=>!out.includes(expectValue(secret))),'issued credential/proof leaked to stdout or stderr');}
  console.log(JSON.stringify({status:'passed',platform:process.platform,node:process.version,checks:['npm-bin','exports','all-three-auth-restarts','JWT-DPoP-PKCE-peer-verification','live-auth-second-process','concurrent-retry','stable-message-id','partial-consent','declined-successful-upgrade','continued-conversation','scope-hook-rejects-model-text','revocation','missing-locked-store','no-opener-keyring','unicode-space-paths','consumer-ack-watch-cursor','J4-openapi-mcp-browser-feedback'],transport:'explicit-fixture-tunnel; no TLS/native-keyring/browser-engine claim'}));
}finally{heldRelease();for(const release of releases)release();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();await rm(home,{recursive:true,force:true});await rm(peerFile,{force:true});await rm(backendFile,{force:true});}
