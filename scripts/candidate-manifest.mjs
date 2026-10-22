import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
const [mode,manifest,...paths]=process.argv.slice(2);
if(mode==='write'){
  const files=[];for(const path of paths){const bytes=await readFile(path);files.push({name:basename(path),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
  await writeFile(manifest,JSON.stringify({version:1,cliCommit:process.env.GITHUB_SHA??'local',clientCommit:process.env.POPPYKIT_CLIENT_COMMIT??'local',files},null,2)+'\n');
}else if(mode==='check'){
  const record=JSON.parse(await readFile(manifest,'utf8'));
  if(record.version!==1||record.files.length!==paths.length)throw new Error('candidate manifest mismatch');
  if(process.env.GITHUB_SHA&&record.cliCommit!==process.env.GITHUB_SHA)throw new Error('CLI commit mismatch');
  if(process.env.POPPYKIT_CLIENT_COMMIT&&record.clientCommit!==process.env.POPPYKIT_CLIENT_COMMIT)throw new Error('client commit mismatch');
  for(const path of paths){const bytes=await readFile(path),file=record.files.find(file=>file.name===basename(path));if(!file||file.bytes!==bytes.length||file.sha256!==createHash('sha256').update(bytes).digest('hex'))throw new Error('candidate digest mismatch');}
}else throw new Error('usage: candidate-manifest write|check manifest files...');
