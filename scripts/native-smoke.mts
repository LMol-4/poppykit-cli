import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, cp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

assert.ok(['win32','darwin','linux'].includes(process.platform),'native smoke requires Windows, macOS or Linux');
if(process.platform==='linux')assert.equal(process.env.POPPYKIT_LINUX_TEST_SESSION,'disposable','run linux-native-session.mjs to isolate the test keyring');
const project=resolve(process.argv[2]??'.'),root=await mkdtemp(join(tmpdir(),'Poppy native ü '));
let previousKeychain:string|undefined;
const testKeychain=join(root,'disposable.keychain-db');
let upgradeProject:string|undefined;
function security(args:string[]){const result=spawnSync('/usr/bin/security',args,{encoding:'utf8'});assert.equal(result.status,0,'disposable Keychain setup/cleanup failed');return result.stdout.trim();}
const value='PRIVATE_NATIVE_SENTINEL_ü_🔐',passphrase='PRIVATE_legacy wrapping phrase ü 🔐';
function worker(input:Record<string,unknown>){const result=spawnSync(process.execPath,[fileURLToPath(new URL('../test-support/native-worker.mjs',import.meta.url)),project],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true});assert.ok(!result.stdout.includes(value)&&!result.stderr.includes(value)&&!result.stdout.includes(passphrase)&&!result.stderr.includes(passphrase),'secret appeared in worker output');return {status:result.status,json:JSON.parse(result.stdout)};}
function cli(home:string,source=project,args=['enroll-status','--profile','native'],extra:NodeJS.ProcessEnv={}){const result=spawnSync(process.execPath,[join(source,'dist/cli.js'),...args,'--json'],{env:{...process.env,POPPYKIT_HOME:home,...extra},encoding:'utf8',windowsHide:true,timeout:25000});assert.ok(!result.stdout.includes(value)&&!result.stderr.includes(value)&&!result.stdout.includes(passphrase)&&!result.stderr.includes(passphrase),'secret appeared in CLI output');return {status:result.status,json:JSON.parse(result.stdout)};}
try{
  if(process.platform==='darwin'){
    previousKeychain=security(['default-keychain','-d','user']).replace(/^"|"$/g,'');
    security(['create-keychain','-p','',testKeychain]);
    security(['set-keychain-settings','-lut','3600',testKeychain]);
    security(['unlock-keychain','-p','',testKeychain]);
    security(['default-keychain','-d','user','-s',testKeychain]);
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
  if(process.platform==='linux'){
    assert.equal(cli(legacyHome,project,['storage','migrate']).status,0,'Linux CLI migration dispatch is idempotent');
    const diagnostics=cli(home,project,['diagnostics']);assert.equal(diagnostics.status,0);assert.equal(diagnostics.json.result.defaultSecureBackend,'linux-secret-service');assert.equal(diagnostics.json.result.linuxPrerequisites.secretTool,'available');assert.equal(diagnostics.json.result.secureBackendAvailability,'not-probed');
    const concurrentHome=join(root,'concurrent');
    const concurrent=()=>new Promise<{ref:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('../test-support/native-worker.mjs',import.meta.url)),project],{stdio:['pipe','pipe','pipe']});let out='',err='';
      child.stdout.on('data',bytes=>out+=bytes);child.stderr.on('data',bytes=>err+=bytes);child.on('error',reject);child.on('close',code=>{try{assert.equal(code,0,'concurrent native process failed');assert.ok(!out.includes(value)&&!err.includes(value));resolve(JSON.parse(out));}catch(error){reject(error);}});
      child.stdin.end(JSON.stringify({action:'stage-native',home:concurrentHome,value}));
    });
    for(const result of await Promise.all([concurrent(),concurrent()]))assert.equal(worker({action:'read',home:concurrentHome,ref:result.ref}).json.hash,createHash('sha256').update(value).digest('hex'));
    const pointer=join(home,'encrypted-secrets','native-unlock'),before=await readFile(pointer);
    const unavailable=cli(home,project,undefined,{DBUS_SESSION_BUS_ADDRESS:'unix:path=/nonexistent-poppykit-test-bus'});assert.equal(unavailable.status,4);assert.equal(unavailable.json.error.code,'linux_secret_service_unavailable');assert.deepEqual(await readFile(pointer),before);
    await chmod(join(home,'encrypted-secrets'),0o755);assert.equal(cli(home).status,4);await chmod(join(home,'encrypted-secrets'),0o700);assert.equal(cli(home).status,0);
    const busArgs=['call','--session','--dest','org.freedesktop.secrets'];
    const alias=spawnSync('/usr/bin/gdbus',[...busArgs,'--object-path','/org/freedesktop/secrets','--method','org.freedesktop.Secret.Service.ReadAlias','default'],{encoding:'utf8'});
    assert.equal(alias.status,0,'test collection alias unavailable');
    const collection=/^\(objectpath '(\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_/]+)',\)\s*$/.exec(alias.stdout)?.[1];assert.ok(collection,'invalid test collection path');
    // Older secret-tool lock treats "default" as a name rather than resolving the alias.
    const locked=spawnSync('/usr/bin/gdbus',[...busArgs,'--object-path','/org/freedesktop/secrets','--method','org.freedesktop.Secret.Service.Lock',`['${collection}']`],{encoding:'utf8'});assert.equal(locked.status,0,'test collection lock failed');
    const lockState=spawnSync('/usr/bin/gdbus',[...busArgs,'--object-path',collection,'--method','org.freedesktop.DBus.Properties.Get','org.freedesktop.Secret.Collection','Locked'],{encoding:'utf8'});assert.equal(lockState.status,0);assert.match(lockState.stdout,/<true>/,'test collection was not actually locked');
    const refused=cli(home);assert.equal(refused.status,4);assert.equal(refused.json.error.code,'linux_secret_service_unavailable');assert.deepEqual(await readFile(pointer),before);
  }
  if(process.platform==='darwin'){
    security(['lock-keychain',testKeychain]);const locked=cli(home);assert.equal(locked.status,4);assert.equal(locked.json.error.code,'secure_store_locked');
    security(['unlock-keychain','-p','',testKeychain]);assert.equal(cli(home).status,0);
    upgradeProject=await mkdtemp(join(project,'native-upgrade-smoke-'));
    await cp(join(project,'dist'),join(upgradeProject,'dist'),{recursive:true});await cp(join(project,'native'),join(upgradeProject,'native'),{recursive:true});await cp(join(project,'package.json'),join(upgradeProject,'package.json'));
    const helper=join(upgradeProject,'native/darwin-keychain'),resigned=spawnSync('/usr/bin/codesign',['--force','--sign','-','--identifier','org.poppykit.cli.vault','--options','runtime',helper],{encoding:'utf8'});assert.equal(resigned.status,0);
    const manifest=JSON.parse(await readFile(helper+'.json','utf8')),changed=createHash('sha256').update(await readFile(helper)).digest('hex');assert.notEqual(changed,manifest.binarySha256);manifest.binarySha256=changed;await writeFile(helper+'.json',JSON.stringify(manifest));
    const rejected=cli(home,upgradeProject);assert.equal(rejected.status,4);assert.equal(rejected.json.error.code,'secure_store_locked');assert.match(rejected.json.error.nextAction,/storage migrate/);
    const unattended=cli(home,upgradeProject,['storage','migrate']);assert.equal(unattended.status,4);assert.equal(unattended.json.error.code,'secure_store_locked','unattended migration must not silently reauthorize a changed helper');
    assert.equal(cli(home).status,0,'original approved helper still opens unchanged vault');
  }
  console.log(JSON.stringify({status:'PASS',platform:process.platform,architecture:process.arch,checks:['native-custody','process-restart','non-TTY','repeated-enrollment-status','Unicode-secret-and-path','wrong-migration-passphrase','migration-preserves-ciphertext','migration-retry','no-secret-output',...(process.platform==='darwin'?['disposable-keychain-locked-negative','changed-helper-refused','upgrade-recovery-hint','no-unattended-reauthorization']:[]),...(process.platform==='linux'?['concurrent-native-processes','missing-session-bus','unsafe-directory-refused','locked-keyring-refused']:[])],humanKeychainApproval:'NOT_RUN'}));
}finally{
  if(process.platform==='darwin'){
    if(previousKeychain)security(['default-keychain','-d','user','-s',previousKeychain]);
    security(['delete-keychain',testKeychain]);
  }
  await rm(root,{recursive:true,force:true});
  if(upgradeProject)await rm(upgradeProject,{recursive:true,force:true});
}
