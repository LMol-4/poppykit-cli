import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const pin=JSON.parse(await readFile('.github/client-candidate.json','utf8'));
assert.match(pin.version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const file=resolve(`.candidate/artifacts/poppykit-client-${pin.version}.tgz`);
const result=spawnSync('npm',['install','--ignore-scripts','--no-save','--no-package-lock','--no-audit','--no-fund',file,'typescript@5.9.3','@types/node@24.10.0','undici-types@7.16.0'],{stdio:'inherit',windowsHide:true});
assert.equal(result.status,0,'explicit source/tooling dependency install failed');
