import assert from 'node:assert/strict';
import { readFile, lstat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const file='native/darwin-keychain',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<=1048576);
const binary=await readFile(file),manifest=JSON.parse(await readFile(file+'.json','utf8'));
assert.equal(manifest.schema,1);assert.equal(manifest.sourceSha256,hash(await readFile('native/keychain.m')),'native helper source changed');assert.equal(manifest.binarySha256,hash(binary),'native helper binary changed');
assert.deepEqual(manifest.architectures,['arm64','x86_64']);assert.equal(manifest.deploymentTarget,'11.0');assert.equal(manifest.signing,'ad-hoc');
assert.equal(binary.readUInt32BE(0),0xcafebabe,'expected universal Mach-O');assert.equal(binary.readUInt32BE(4),2);
const architectures=[];for(let index=0;index<2;index++){const entry=8+index*20;architectures.push(binary.readUInt32BE(entry));const offset=binary.readUInt32BE(entry+8),size=binary.readUInt32BE(entry+12);assert.ok(offset>=48&&size>0&&offset+size<=binary.length);}
assert.deepEqual(architectures.sort((a,b)=>a-b),[0x01000007,0x0100000c]);
await chmod(file,0o755);
console.log(JSON.stringify({status:'PASS',sourceSha256:manifest.sourceSha256,binarySha256:manifest.binarySha256,architectures:manifest.architectures}));
