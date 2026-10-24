import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

let input='';for await(const chunk of process.stdin)input+=chunk;
const {directory,passphrase}=JSON.parse(input) as {directory:string;passphrase:string};
const open=fs.open,writeFile=fs.writeFile;
async function pause(){process.send?.('partial');await new Promise<void>(resolve=>process.once('message',()=>resolve()));}
fs.open=async (...args)=>{
  const file=await open(...args);
  if(String(args[0]).includes('unlock-check')){
    const write=file.writeFile.bind(file);
    file.writeFile=async(data,options)=>{
      if(typeof data!=='string')throw new Error('unexpected reference');
      await write(data.slice(0,7),options);await pause();await write(data.slice(7),options);
    };
  }
  return file;
};
// Also stop the former direct write at its exposed publication boundary.
fs.writeFile=async(...args)=>{
  if(String(args[0])===join(directory,'unlock-check')){
    if(typeof args[1]!=='string')throw new Error('unexpected reference');
    await writeFile(args[0],args[1].slice(0,7),args[2]);await pause();
    await writeFile(args[0],args[1],{flag:'w'});return;
  }
  return writeFile(...args);
};
syncBuiltinESMExports();
const {encryptedBackend}=await import('../dist/secrets.js');
const backend=await encryptedBackend(directory,passphrase);
try{await backend.healthCheck();process.send?.('complete');}finally{await backend.close?.();process.disconnect?.();}
