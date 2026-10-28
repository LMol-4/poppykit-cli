import assert from 'node:assert/strict';
import {encryptedBackend} from '@poppykit/cli';
import type {SecureBackend} from '@poppykit/cli';
function environment(name:string){const value=process.env[name];assert.ok(value,'missing fixture environment '+name);return value;}
// Copied as compiled JavaScript into the clean consumer. Imports resolve only the
// installed npm candidate; fixture transport is an explicit local HTTP tunnel.
export async function open():Promise<SecureBackend>{
  if(process.env.FIXTURE_BACKEND_FAIL)throw new Error('PRIVATE_BACKEND_FAILURE');
  const backend=await encryptedBackend(environment('FIXTURE_SECRET_DIRECTORY'),environment('FIXTURE_UNLOCK'));
  const stage=backend.secrets.stage;
  let readyReceived=false;
  backend.secrets.stage=async value=>{
    if(value.startsWith('{"status":"ready"')){readyReceived=true;if(process.env.FIXTURE_RESULT_CRASH)process.exit(91);}
    else if(readyReceived&&process.env.FIXTURE_FINAL_STAGE_FAIL)throw new Error('PRIVATE_FINAL_STAGE_FAILURE');
    return stage(value);
  };
  backend.enrollmentAuth=async()=>({'x-operator-auth':'fixture-only'});
  backend.trustedInput={async collect(request):Promise<Record<string,string>>{return request.challenge?{code:'123456'}:{password:'PRIVATE_PASSWORD'};}};
  const transport:NonNullable<SecureBackend['transport']>={async fetch(request){
    const response=await fetch(environment('FIXTURE_TUNNEL'),{method:'POST',signal:request.signal,body:JSON.stringify({url:request.url,method:request.method,headers:[...request.headers],body:['GET','HEAD'].includes(request.method)?null:await request.text()})});
    if(!response.ok)throw new Error('fixture tunnel failed');
    const envelope:unknown=await response.json();assert.ok(envelope&&typeof envelope==='object'&&'status' in envelope&&typeof envelope.status==='number'&&'body' in envelope&&typeof envelope.body==='string'&&'headers' in envelope&&Array.isArray(envelope.headers));
    const headers=new Headers();for(const entry of envelope.headers){assert.ok(Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&typeof entry[1]==='string');headers.append(entry[0],entry[1]);}
    return new Response(envelope.body||null,{status:envelope.status,headers});
  }};
  backend.transport=transport;
  let joinCookie='';
  backend.browserController={kind:'agent-controlled',
    async loadJoinForm(url){const page=await transport.fetch(new Request(url));assert.equal(page.status,200);joinCookie=(page.headers.get('set-cookie')??'').split(';')[0];const code=/name="code" value="([^"]+)"/.exec(await page.text())?.[1];assert.ok(code);return {code};},
    async postForm(input){const response=await transport.fetch(new Request(input.url,{method:'POST',headers:{cookie:joinCookie},body:new URLSearchParams(input.fields)}));const location=response.headers.get('location');assert.ok(location);input.validateRedirect(response.status,location);},
    async navigate(url){assert.equal(new URL(url).protocol,'https:');},
  };
  return backend;
}
