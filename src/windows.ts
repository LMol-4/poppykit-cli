import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { CliFailure, type SecureBackend } from './secrets.js';

// The helper receives all material over private pipes; its command line is constant.
const helper = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$phase = 'setup'
try {
  Add-Type -AssemblyName System.Security
  $r = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $dir = [IO.Path]::GetFullPath($r.directory)
  if (![IO.Directory]::Exists($dir)) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    [IO.Directory]::CreateDirectory($dir,$acl) | Out-Null
  }
  function Check($path) {
    if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
    $a = if ([IO.Directory]::Exists($path)) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
    if ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
    foreach ($rule in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) { throw 'unsafe' }
    }
  }
  $phase = 'directory_permissions'
  Check $dir
  if ($r.ref -notmatch '^[a-f0-9-]{36}$') { throw 'unsafe' }
  $file = [IO.Path]::Combine($dir,$r.ref + '.dpapi')
  $entropy = [Text.Encoding]::UTF8.GetBytes('poppykit-cli-v1:' + $dir + ':' + $r.ref)
  if ($r.action -eq 'stage') {
    $phase = 'encrypt'
    $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($r.value),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $phase = 'write'
    $stream = New-Object IO.FileStream($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $phase = 'file_permissions'
    Check $file
    [Console]::Out.Write('true')
  } elseif ($r.action -eq 'read') {
    $phase = 'read'
    if (![IO.File]::Exists($file)) { [Console]::Out.Write('null'); exit 0 }
    Check $file
    if ((New-Object IO.FileInfo($file)).Length -gt 131072) { throw 'unsafe' }
    $phase = 'decrypt'
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([Text.Encoding]::UTF8.GetString($bytes))))
  } elseif ($r.action -eq 'remove') {
    if ([IO.File]::Exists($file)) { Check $file; [IO.File]::Delete($file) }
    [Console]::Out.Write('true')
  } else { throw 'unsafe' }
} catch { [Console]::Error.Write('secure_store_unavailable:' + $phase); exit 4 }
`;

/** Current-user DPAPI; does not isolate other processes running as the same Windows user. */
export async function windowsBackend(directory: string): Promise<SecureBackend> {
  if (process.platform !== 'win32' || !isAbsolute(directory) || !process.env.SystemRoot) throw new CliFailure('secure_backend_unavailable', 4);
  const executable = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const call = (action: string, ref: string, value?: string): Promise<any> => new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(helper,'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let output = '', failed = false, diagnostic = '';
    const stop = () => { failed = true; child.kill(); };
    const timer = setTimeout(stop, 15000);
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 262144) stop(); });
    child.stderr.on('data', bytes => { failed = true; if (diagnostic.length < 256) diagnostic += bytes.toString(); });
    child.on('error', () => { clearTimeout(timer); reject(new CliFailure('secure_store_unavailable',4)); });
    child.on('close', code => { clearTimeout(timer); if (code || failed) return reject(Object.assign(new CliFailure('secure_store_unavailable',4), { nativeDiagnostic: { phase: /^secure_store_unavailable:(setup|directory_permissions|encrypt|write|file_permissions|read|decrypt)$/.exec(diagnostic)?.[1] ?? 'helper' } })); try { resolve(JSON.parse(output.replace(/^\uFEFF/,''))); } catch { reject(new CliFailure('secure_store_unavailable',4)); } });
    child.stdin.on('error', () => { failed = true; });
    child.stdin.end(JSON.stringify({ action, directory, ref, value }));
  });
  const valid = (ref: string) => /^[a-f0-9-]{36}$/.test(ref);
  const secrets: SecureBackend['secrets'] = {
    async stage(value) { if (Buffer.byteLength(value) > 65536) throw new CliFailure('secure_store_unavailable',4); const ref = randomUUID(); await call('stage',ref,value); return ref; },
    async read(ref) { return valid(ref) ? call('read',ref) : null; },
    async remove(ref) { if (valid(ref)) await call('remove',ref); },
  };
  return { secrets, async healthCheck() { const value = randomUUID(), ref = await secrets.stage(value); try { if (await secrets.read(ref) !== value) throw new CliFailure('secure_store_unavailable',4); } finally { await secrets.remove(ref); } } };
}
