import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let text='';for await(const chunk of process.stdin)text+=chunk;
const project=resolve(process.argv[2]),input=JSON.parse(text);
const {nativeBackend,migrateNativeStorage}:typeof import('../dist/native.js')=await import(pathToFileURL(join(project,'dist/native.js')).href);
const {encryptedBackend}:typeof import('../dist/secrets.js')=await import(pathToFileURL(join(project,'dist/secrets.js')).href);
const {State}:typeof import('../dist/state.js')=await import(pathToFileURL(join(project,'dist/state.js')).href);
try{
  await mkdir(input.home,{recursive:true,mode:0o700});const directory=join(input.home,'encrypted-secrets');
  if(input.action==='migrate'){await migrateNativeStorage(directory,async()=>input.passphrase);console.log(JSON.stringify({ok:true}));}
  else{
    const backend=input.action==='seed-attended'?await encryptedBackend(directory,input.passphrase):await nativeBackend(directory);
    try{
      await backend.healthCheck();
      if(input.action==='read'){const value=await backend.secrets.read(input.ref);console.log(JSON.stringify({hash:value===null?null:createHash('sha256').update(value).digest('hex'),tty:!!process.stdin.isTTY}));}
      else{
        const ref=await backend.secrets.stage(input.value),state=new State(join(input.home,'cli.sqlite'));
        try{const p=state.createProfile('native','https://provider.example/v1','company.example'),record={provider:p.provider,domain:p.domain,installationId:p.installationId,clientId:'https://provider.example/client.json',callbackUrl:'https://provider.example/callback',credentialRef:ref};state.update(p,{...record,enrollmentUrl:'https://provider.example/enrollment'});state.put('enrollment',p.id,record);}finally{state.close();}
        console.log(JSON.stringify({ref,tty:!!process.stdin.isTTY}));
      }
    }finally{await backend.close?.();}
  }
}catch(error){console.log(JSON.stringify({error:error&&typeof error==='object'&&'code'in error?error.code:'failed',...(error&&typeof error==='object'&&'nativeDiagnostic'in error?{nativeDiagnostic:error.nativeDiagnostic}:{})}));process.exitCode=1;}
