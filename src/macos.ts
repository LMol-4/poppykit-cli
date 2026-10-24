import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CliFailure } from './secrets.js';
import type { NativeKeyStore } from './native.js';

// Constant source and argv; all values, including the wrapping key, use private pipes.
const helper = String.raw`
ObjC.import('Foundation');
ObjC.import('Security');
function main() {
  var phase = 'input';
  function output(value) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value)).dataUsingEncoding($.NSUTF8StringEncoding)); }
  try {
    var bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));
    phase = 'keychain';
    $.SecKeychainSetUserInteractionAllowed(false);
    var keychain = Ref();
    var status = input.keychain ? $.SecKeychainOpen(input.keychain, keychain) : $.SecKeychainCopyDefault(keychain);
    function check(code) { if (code !== 0) throw code; }
    check(status);
    var service = input.service, account = 'vault-key-v1';
    if (input.action === 'adopt') {
      var valueData = $(input.value).dataUsingEncoding($.NSUTF8StringEncoding);
      phase = 'add';
      status = $.SecKeychainAddGenericPassword(keychain[0], service.length, service, account.length, account, valueData.length, valueData.bytes, null);
      if (status !== -25299) check(status);
    } else if (input.action !== 'load') throw -50;
    var length = Ref(), result = Ref();
    phase = 'read';
    status = $.SecKeychainFindGenericPassword(keychain[0], service.length, service, account.length, account, length, result, null);
    if (status === -25300) return output({ ok: true, value: null });
    check(status);
    phase = 'decode';
    try {
      if (length[0] > 16384) throw -50;
      var data = $.NSData.dataWithBytesLength(result[0], length[0]);
      var value = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
      if (typeof value !== 'string') throw -50;
      output({ ok: true, value: value });
    } finally { $.SecKeychainItemFreeContent(null, result[0]); }
  } catch (error) { output({ ok: false, code: error === -25308 || error === -25293 ? 'secure_store_locked' : 'secure_store_unavailable', phase: phase, status: typeof error === 'number' ? error : null }); }
}
main();
`;

/** Login Keychain custody; other processes running as this macOS user are not isolated. */
// shortcut: deprecated generic-password APIs avoid JXA's CF query incompatibility; replace when a tested modern bridge or native helper is available.
export function macosKeyStore(directory: string, keychain?: string): NativeKeyStore {
  if (process.platform !== 'darwin') throw new CliFailure('secure_backend_unavailable', 4);
  const service = 'org.poppykit.cli.vault.' + createHash('sha256').update(directory).digest('hex');
  const call = (action: 'load' | 'adopt', value?: string): Promise<string | null> => new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', helper], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, failed = false;
    const stop = () => { failed = true; child.kill(); };
    const timer = setTimeout(stop, 15000);
    child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 32768) stop(); else chunks.push(bytes); });
    child.stderr.on('data', stop);
    child.stdin.on('error', stop);
    child.on('error', () => { clearTimeout(timer); reject(new CliFailure('secure_store_unavailable', 4)); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        if (code || failed) throw 0;
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response?.ok === false && ['secure_store_locked', 'secure_store_unavailable'].includes(response.code) && ['input','keychain','query','add','read','decode'].includes(response.phase) && (response.status === null || Number.isInteger(response.status))) return reject(Object.assign(new CliFailure(response.code, 4), { nativeDiagnostic: { phase: response.phase, status: response.status } }));
        if (response?.ok !== true || Object.keys(response).sort().join(',') !== 'ok,value' || !(response.value === null || typeof response.value === 'string' && response.value.length >= 12 && response.value.length <= 4096)) throw 0;
        resolve(response.value);
      } catch { reject(new CliFailure('secure_store_unavailable', 4)); }
    });
    child.stdin.end(JSON.stringify({ action, service, keychain, value }));
  });
  return { load: () => call('load'), async adopt(value) { const key = await call('adopt', value); if (!key) throw new CliFailure('secure_store_unavailable', 4); return key; } };
}
