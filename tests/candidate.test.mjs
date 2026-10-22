import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('candidate checks reject changed bytes and wrong CLI/client commits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'candidate ü ')),file=join(directory,'poppykit-client-0.0.0.tgz'),server=join(directory,'poppykit-server-0.0.0.tgz'),cli=join(directory,'poppykit-cli-0.0.0.tgz'),manifest=join(directory,'manifest.json');
  const script=fileURLToPath(new URL('../scripts/candidate-manifest.mjs',import.meta.url));
  const run=(mode,extra={},files=[file,server,cli])=>spawnSync(process.execPath,[script,mode,manifest,...files],{env:{...process.env,GITHUB_SHA:'cli-tip',POPPYKIT_CLIENT_COMMIT:'client-tip',POPPYKIT_SERVER_COMMIT:'server-tip',...extra},windowsHide:true});
  try{
    for(const path of [file,server,cli])await writeFile(path,'candidate bytes');
    assert.equal(run('write').status,0);assert.equal(run('check').status,0);
    for(const name of ['GITHUB_SHA','POPPYKIT_CLIENT_COMMIT','POPPYKIT_SERVER_COMMIT'])assert.equal(run('check',{[name]:'other'}).status,1);
    assert.equal(run('check',{},[file,cli]).status,1);assert.equal(run('write',{},[file,cli]).status,1);assert.equal(run('check',{},[file,server,server]).status,1);assert.equal(run('write',{},[file,server,server]).status,1);
    const saved=await readFile(manifest,'utf8'),truncated=JSON.parse(saved);truncated.files=truncated.files.filter(row=>!row.name.startsWith('poppykit-server'));
    await writeFile(manifest,JSON.stringify(truncated));assert.equal(run('check',{},[file,cli]).status,1);await writeFile(manifest,saved);
    await writeFile(server,'tampered server bytes');assert.equal(run('check').status,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
