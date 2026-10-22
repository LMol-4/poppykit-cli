import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('candidate checks reject changed bytes and wrong CLI/client commits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'candidate ü ')),file=join(directory,'candidate.tgz'),manifest=join(directory,'manifest.json');
  const script=fileURLToPath(new URL('../scripts/candidate-manifest.mjs',import.meta.url));
  const run=(mode,extra={})=>spawnSync(process.execPath,[script,mode,manifest,file],{env:{...process.env,GITHUB_SHA:'cli-tip',POPPYKIT_CLIENT_COMMIT:'client-tip',...extra},windowsHide:true});
  try{await writeFile(file,'candidate bytes');assert.equal(run('write').status,0);assert.equal(run('check').status,0);assert.equal(run('check',{GITHUB_SHA:'other'}).status,1);assert.equal(run('check',{POPPYKIT_CLIENT_COMMIT:'other'}).status,1);await writeFile(file,'tampered bytes');assert.equal(run('check').status,1);}finally{await rm(directory,{recursive:true,force:true});}
});
