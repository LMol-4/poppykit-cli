import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

assert.ok(['win32','darwin'].includes(process.platform),'native smoke requires Windows or macOS');
const project=resolve(process.argv[2]??'.'),root=await mkdtemp(join(tmpdir(),'Poppy native ü '));
let previousKeychain:string|undefined;
const testKeychain=join(root,'disposable.keychain-db');
function security(args:string[]){const result=spawnSync('/usr/bin/security',args,{encoding:'utf8'});assert.equal(result.status,0,'disposable Keychain setup/cleanup failed');return result.stdout.trim();}
const value='PRIVATE_NATIVE_SENTINEL_ü_🔐',passphrase='PRIVATE_legacy wrapping phrase ü 🔐';
function worker(input:Record<string,unknown>){const result=spawnSync(process.execPath,[join(project,'test-support/native-worker.mjs'),project],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true});assert.ok(!result.stdout.includes(value)&&!result.stderr.includes(value)&&!result.stdout.includes(passphrase)&&!result.stderr.includes(passphrase),'secret appeared in worker output');return {status:result.status,json:JSON.parse(result.stdout)};}
function cli(home:string){const result=spawnSync(process.execPath,[join(project,'dist/cli.js'),'enroll-status','--profile','native','--json'],{env:{...process.env,POPPYKIT_HOME:home},encoding:'utf8',windowsHide:true});assert.ok(!result.stdout.includes(value)&&!result.stderr.includes(value)&&!result.stdout.includes(passphrase)&&!result.stderr.includes(passphrase),'secret appeared in CLI output');return {status:result.status,json:JSON.parse(result.stdout)};}
try{
  if(process.platform==='darwin'){
    previousKeychain=security(['default-keychain','-d','user']).replace(/^"|"$/g,'');
    security(['create-keychain','-p','',testKeychain]);
    security(['set-keychain-settings','-lut','3600',testKeychain]);
    security(['unlock-keychain','-p','',testKeychain]);
    security(['default-keychain','-d','user','-s',testKeychain]);
    const probe=spawnSync('/usr/bin/osascript',['-l','JavaScript','-e',String.raw`
ObjC.import('Foundation');ObjC.import('Security');
var keychain=Ref();var open=$.SecKeychainCopyDefault(keychain);
var results=[];
for(var variant=0;variant<4;variant++){
  var q=$.NSMutableDictionary.alloc.init;
  q.setObjectForKey($.kSecClassGenericPassword,$.kSecClass);
  q.setObjectForKey($('org.poppykit.test.nonexistent'),$.kSecAttrService);
  if(variant>=1)q.setObjectForKey($(true),$.kSecReturnData);
  if(variant>=2)q.setObjectForKey($.kSecMatchLimitOne,$.kSecMatchLimit);
  if(variant>=3)q.setObjectForKey($.NSArray.arrayWithObject(keychain[0]),$.kSecMatchSearchList);
  var ref=Ref();results.push({variant:variant,status:$.SecItemCopyMatching(q,ref)});
}
JSON.stringify({open:open,queries:results});
`],{encoding:'utf8'});assert.equal(probe.status,0);console.log('Native API parameter probe: '+probe.stdout.trim());
  }
  const home=join(root,'new'),seed=worker({action:'seed-native',home,value});assert.equal(seed.status,0,JSON.stringify(seed.json));assert.equal(seed.json.tty,false);
  const read=worker({action:'read',home,ref:seed.json.ref});assert.equal(read.status,0,JSON.stringify(read.json));assert.equal(read.json.hash,createHash('sha256').update(value).digest('hex'));assert.equal(read.json.tty,false);
  for(let count=0;count<2;count++){const result=cli(home);assert.equal(result.status,0,JSON.stringify(result.json));assert.equal(result.json.result.enrolled,true);}
  const legacyHome=join(root,'legacy'),legacy=worker({action:'seed-attended',home:legacyHome,value,passphrase});assert.equal(legacy.status,0);
  const directory=join(legacyHome,'encrypted-secrets'),files=await readdir(directory),before=await Promise.all(files.map(file=>readFile(join(directory,file))));
  assert.equal(cli(legacyHome).json.error.code,'storage_migration_required');
  assert.equal(worker({action:'migrate',home:legacyHome,passphrase:'different wrong passphrase'}).json.error,'secure_store_locked');
  assert.equal(worker({action:'migrate',home:legacyHome,passphrase}).status,0);
  assert.equal(worker({action:'migrate',home:legacyHome,passphrase:'unused after success'}).status,0);
  assert.deepEqual(await Promise.all(files.map(file=>readFile(join(directory,file)))),before,'migration rewrote existing ciphertext');
  assert.equal(cli(legacyHome).status,0);
  const migrated=worker({action:'read',home:legacyHome,ref:legacy.json.ref});assert.equal(migrated.json.hash,createHash('sha256').update(value).digest('hex'));
  if(process.platform==='darwin'){
    security(['lock-keychain',testKeychain]);const locked=cli(home);assert.equal(locked.status,4);assert.equal(locked.json.error.code,'secure_store_locked');
    security(['unlock-keychain','-p','',testKeychain]);assert.equal(cli(home).status,0);
  }
  console.log(JSON.stringify({status:'PASS',platform:process.platform,checks:['native-custody','process-restart','non-TTY','repeated-enrollment-status','Unicode-secret-and-path','wrong-migration-passphrase','migration-preserves-ciphertext','migration-retry','no-secret-output',...(process.platform==='darwin'?['disposable-keychain-locked-negative']:[])]}));
}finally{
  if(process.platform==='darwin'){
    if(previousKeychain)security(['default-keychain','-d','user','-s',previousKeychain]);
    security(['delete-keychain',testKeychain]);
  }
  await rm(root,{recursive:true,force:true});
}
