import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateContents} from '../scripts/packaged-contracts.mjs';
test('package contents reject unlisted fixtures, local state and private material',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'packaged-content-')),manifest={files:['dist','README.md']};
  try{
    await mkdir(join(directory,'dist'));await writeFile(join(directory,'dist/index.js'),'export {};');await writeFile(join(directory,'README.md'),'Generic package');
    await validateContents(directory,manifest);
    for(const [path,body] of [['fixture.mjs','test'],['dist/state.sqlite','state'],['dist/data.json','{}'],['dist/secret.js','-----BEGIN PRIVATE KEY-----']]){
      await writeFile(join(directory,path),body);await assert.rejects(validateContents(directory,manifest));await rm(join(directory,path));
    }
    await validateContents(directory,manifest);
  }finally{await rm(directory,{recursive:true,force:true});}
});
