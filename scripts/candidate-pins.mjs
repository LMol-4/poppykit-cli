import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const name of ['client','server']){const pin=JSON.parse(await readFile('.github/'+name+'-candidate.json','utf8'));assert.equal(pin.repository,'LMol-4/poppykit-'+name);assert.match(pin.ref,/^[a-f0-9]{40}$/);assert.match(pin.version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
 if(process.argv[2]==='check'){const result=spawnSync('git',['rev-parse','HEAD'],{cwd:'.candidate/'+name,encoding:'utf8',windowsHide:true});assert.equal(result.status,0);assert.equal(result.stdout.trim(),pin.ref);assert.equal(JSON.parse(await readFile('.candidate/'+name+'/package.json','utf8')).version,pin.version);}
 else await writeFile(process.env.GITHUB_OUTPUT,name+'-repository='+pin.repository+'\n'+name+'-ref='+pin.ref+'\n',{flag:'a'});
}
