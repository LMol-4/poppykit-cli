import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CliFailure } from './secrets.js';
import type { NativeKeyStore } from './native.js';

// Constant source and argv; all values, including the wrapping key, use private pipes.
const helper = String.raw`
ObjC.import('Foundation');
ObjC.import('Security');
function main() {
  function output(value) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value)).dataUsingEncoding($.NSUTF8StringEncoding)); }
  try {
    var bytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding)));
    $.SecKeychainSetUserInteractionAllowed(false);
    var keychain = Ref();
    var status = input.keychain ? $.SecKeychainOpen(input.keychain, keychain) : $.SecKeychainCopyDefault(keychain);
    function check(code) { if (code !== 0) throw code; }
    check(status);
    function query() {
      var q = $.NSMutableDictionary.alloc.init;
      q.setObjectForKey($.kSecClassGenericPassword, $.kSecClass);
      q.setObjectForKey($(input.service), $.kSecAttrService);
      q.setObjectForKey($('vault-key-v1'), $.kSecAttrAccount);
      return q;
    }
    if (input.action === 'adopt') {
      var add = query();
      add.setObjectForKey(keychain[0], $.kSecUseKeychain);
      add.setObjectForKey($('PoppyKit CLI local vault'), $.kSecAttrLabel);
      add.setObjectForKey($(input.value).dataUsingEncoding($.NSUTF8StringEncoding), $.kSecValueData);
      status = $.SecItemAdd(add, null);
      if (status !== -25299) check(status);
    } else if (input.action !== 'load') throw -50;
    var read = query(), result = Ref();
    read.setObjectForKey($.NSArray.arrayWithObject(keychain[0]), $.kSecMatchSearchList);
    read.setObjectForKey($.kCFBooleanTrue, $.kSecReturnData);
    read.setObjectForKey($.kSecMatchLimitOne, $.kSecMatchLimit);
    status = $.SecItemCopyMatching(read, result);
    if (status === -25300) return output({ ok: true, value: null });
    check(status);
    var value = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(result[0], $.NSUTF8StringEncoding));
    if (typeof value !== 'string') throw -50;
    output({ ok: true, value: value });
  } catch (error) { output({ ok: false, code: error === -25308 || error === -25293 ? 'secure_store_locked' : 'secure_store_unavailable' }); }
}
main();
`;

/** Login Keychain custody; other processes running as this macOS user are not isolated. */
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
        if (response?.ok === false && ['secure_store_locked', 'secure_store_unavailable'].includes(response.code)) return reject(new CliFailure(response.code, 4));
        if (response?.ok !== true || Object.keys(response).sort().join(',') !== 'ok,value' || !(response.value === null || typeof response.value === 'string' && response.value.length >= 12 && response.value.length <= 4096)) throw 0;
        resolve(response.value);
      } catch { reject(new CliFailure('secure_store_unavailable', 4)); }
    });
    child.stdin.end(JSON.stringify({ action, service, keychain, value }));
  });
  return { load: () => call('load'), async adopt(value) { const key = await call('adopt', value); if (!key) throw new CliFailure('secure_store_unavailable', 4); return key; } };
}
