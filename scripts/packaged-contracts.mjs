import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export async function validateContents(directory,manifest){
  async function visit(relative=''){
    for(const entry of await readdir(join(directory,relative),{withFileTypes:true})){
      const path=(relative?relative+'/':'')+entry.name;
      assert.ok(!entry.isSymbolicLink(),'package contains a symlink');
      const allowed=path==='package.json'||/^LICENSE(?:\.[\w-]+)?$/i.test(path)||manifest.files.some(prefix=>path===prefix||path.startsWith(prefix+'/'));
      assert.ok(allowed,'unexpected package path: '+path);
      assert.ok(!/(?:^|\/)(?:tests?|test-support|fixtures?)(?:\/|$)/i.test(path),'test fixture in package: '+path);
      assert.ok(!/(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:pem|key|sqlite|db|log|tgz))$/i.test(path),'private/state file in package: '+path);
      if(entry.isDirectory())await visit(path);
      else{
        if(path.startsWith('dist/'))assert.ok(/\.(?:js|d\.ts)(?:\.map)?$/.test(path),'non-code artifact in dist: '+path);
        const bytes=await readFile(join(directory,path));
        assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|PRIVATE_PASSWORD|PRIVATE_BACKEND_FAILURE/.test(bytes.toString('utf8')),'private material in package: '+path);
      }
    }
  }
  await visit();
}
export async function main(){
const [consumer,compiler,typeRoots]=process.argv.slice(2);
assert.ok(consumer&&compiler&&typeRoots,'usage: packaged-contracts consumer typescript.js typeRoots');
const project=resolve(consumer),packages=['client','server','cli'];let types='',i=0;
const manifests=[];
for(const name of packages){
  const directory=join(project,'node_modules/@poppykit',name),manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
  assert.equal(manifest.name,'@poppykit/'+name);assert.equal(manifest.version,'0.0.0');
  await validateContents(directory,manifest);
  for(const [subpath,entry] of Object.entries(manifest.exports)){
    const specifier=manifest.name+(subpath==='.'?'':subpath.slice(1));
    assert.ok(entry.types&&entry.import);await readFile(join(directory,entry.types));await import(pathToFileURL(join(directory,entry.import)));
    types+=`import * as p${i} from ${JSON.stringify(specifier)};\nexport const e${i}=p${i};\n`;i++;
  }
  for(const path of manifest.files)await readFile(join(directory,path==='dist'?'dist/index.js':path));
  assert.ok(!JSON.stringify(manifest).includes('file:')&&!JSON.stringify(manifest).includes('workspace:'));
  manifests.push({name:manifest.name,version:manifest.version,dependencies:manifest.dependencies,exports:Object.keys(manifest.exports)});
}
assert.deepEqual(manifests[2].dependencies,{'@poppykit/client':'0.0.0'});
assert.deepEqual(manifests[0].dependencies,{jose:'6.2.12'});assert.deepEqual(manifests[1].dependencies,{jose:'6.2.12'});
const jose=JSON.parse(await readFile(join(project,'node_modules/jose/package.json'),'utf8'));assert.equal(jose.version,'6.2.12');
const fixture=join(project,'contracts.mts');await writeFile(fixture,types);
const result=spawnSync(process.execPath,[resolve(compiler),'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2023','--typeRoots',resolve(typeRoots),fixture],{cwd:project,encoding:'utf8',windowsHide:true});
assert.equal(result.status,0,result.stdout+result.stderr);
console.log(JSON.stringify({status:'passed',node:process.version,platform:process.platform,manifests,typescript:JSON.parse(await readFile(join(dirname(compiler),'../package.json'),'utf8')).version,scope:'actual installed package exports, declaration graphs, docs and production dependencies; external compiler/types are test tooling'}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
