import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const cli=join(resolve(process.argv[2]),'node_modules/@poppykit/cli/dist/cli.js');
const result=spawnSync(process.execPath,[cli,'--help','--json'],{encoding:'utf8',windowsHide:true});
assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).error.code,'node_24_12_or_newer_required');assert.ok(!result.stderr.includes('ERR_UNKNOWN_BUILTIN_MODULE'));console.log('unsupported runtime fails clearly');
