import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CliFailure } from './secrets.js';
import type { NativeKeyStore } from './native.js';

/** Native Keychain custody; other processes running as this macOS user are not isolated. */
export function macosKeyStore(directory: string, interactive = false): NativeKeyStore {
  if (process.platform !== 'darwin') throw new CliFailure('secure_backend_unavailable', 4);
  const executable = fileURLToPath(new URL('../native/darwin-keychain', import.meta.url));
  const service = 'org.poppykit.cli.vault.' + createHash('sha256').update(directory).digest('hex');
  const call = async (action: 'load' | 'adopt', value?: string): Promise<string | null> => {
    try {
      const info = await lstat(executable), metadataInfo = await lstat(executable + '.json');
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576 || !metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 8192) throw 0;
      const manifest = JSON.parse(await readFile(executable + '.json', 'utf8'));
      if (manifest.schema !== 1 || manifest.binarySha256 !== createHash('sha256').update(await readFile(executable)).digest('hex')) throw 0;
    } catch { throw new CliFailure('native_helper_unavailable', 4); }
    return new Promise((resolve, reject) => {
      // Fixed executable/argv; wrapping keys use only bounded private pipes.
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let size = 0, failed = false;
      const stop = () => { failed = true; child.kill(); };
      const timer = setTimeout(stop, interactive ? 60000 : 15000);
      child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 32768) stop(); else chunks.push(bytes); });
      child.stderr.on('data', stop);
      child.stdin.on('error', stop);
      child.on('error', () => { clearTimeout(timer); reject(new CliFailure('secure_store_unavailable', 4)); });
      child.on('close', code => {
        clearTimeout(timer);
        try {
          if (code || failed) throw 0;
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response?.ok === false && ['secure_store_locked', 'secure_store_unavailable'].includes(response.code) && ['input','keychain','add','read','decode'].includes(response.phase) && Number.isInteger(response.status)) return reject(Object.assign(new CliFailure(response.code, 4), { nativeDiagnostic: { phase: response.phase, status: response.status } }));
          if (response?.ok !== true || Object.keys(response).sort().join(',') !== 'ok,value' || !(response.value === null || typeof response.value === 'string' && response.value.length >= 12 && response.value.length <= 4096)) throw 0;
          resolve(response.value);
        } catch { reject(new CliFailure('secure_store_unavailable', 4)); }
      });
      child.stdin.end(JSON.stringify({ action, service, interactive, ...(value === undefined ? {} : { value }) }));
    });
  };
  return { load: () => call('load'), async adopt(value) { const key = await call('adopt', value); if (!key) throw new CliFailure('secure_store_unavailable', 4); return key; } };
}
