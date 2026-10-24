import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
assert.equal(process.platform,'darwin','build native helper on macOS');
function run(file,args){const result=spawnSync(file,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
const output='native/darwin-keychain';
run('/usr/bin/xcrun',['clang','-fobjc-arc','-O2','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-arch','arm64','-arch','x86_64','-mmacosx-version-min=11.0','-framework','Foundation','-framework','Security','native/keychain.m','-o',output]);
run('/usr/bin/codesign',['--force','--sign','-','--identifier','org.poppykit.cli.vault',output]);
run('/usr/bin/codesign',['--verify','--strict','--all-architectures',output]);
await chmod(output,0o755);
const architectures=run('/usr/bin/lipo',['-archs',output]).split(/\s+/).sort();assert.deepEqual(architectures,['arm64','x86_64']);
for(const architecture of architectures)assert.match(run('/usr/bin/xcrun',['otool','-arch',architecture,'-l',output]),/\bminos 11\.0\b/,'deployment target mismatch');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest={schema:1,sourceSha256:hash(await readFile('native/keychain.m')),binarySha256:hash(await readFile(output)),architectures,deploymentTarget:'11.0',signing:'ad-hoc',compiler:run('/usr/bin/xcrun',['clang','--version']).split('\n')[0]};
await writeFile(output+'.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:'PASS',...manifest}));
