import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, open, link, unlink, access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { encryptedBackend, hiddenInput, CliFailure, type SecureBackend } from './secrets.js';
import { windowsBackend } from './windows.js';
import { macosKeyStore } from './macos.js';

export interface NativeKeyStore { load(): Promise<string | null>; adopt(value: string): Promise<string> }
export async function publishNativeReference(directory: string, ref: string): Promise<boolean> {
  const temporary = join(directory, 'native-unlock-' + randomUUID() + '.tmp');
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(ref, 'utf8'); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, join(directory, 'native-unlock')); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
}
async function exists(path: string) { try { await access(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function directoryPath(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new CliFailure('secure_backend_path_must_be_absolute', 4);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new CliFailure('secure_store_unavailable', 4);
  return realpath(directory);
}
function windowsKeyStore(directory: string): NativeKeyStore {
  const pointer = join(directory, 'native-unlock');
  async function backend() { const current = await windowsBackend(directory); await current.healthCheck(); return current; }
  async function reference() {
    try { const info = await lstat(pointer); if (!info.isFile() || info.isSymbolicLink() || info.size !== 36) throw new CliFailure('secure_store_unavailable', 4); return await readFile(pointer, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async function load() { const ref = await reference(); if (!ref) return null; const value = await (await backend()).secrets.read(ref); if (!value) throw new CliFailure('secure_store_unavailable', 4); return value; }
  return { load, async adopt(value) {
    const existing = await load(); if (existing) return existing;
    const current = await backend(), ref = await current.secrets.stage(value);
    try { if (!await publishNativeReference(directory, ref)) await current.secrets.remove(ref); }
    catch (error) { await current.secrets.remove(ref); throw error; }
    const winner = await load(); if (!winner) throw new CliFailure('secure_store_unavailable', 4); return winner;
  } };
}
async function stores(directory: string, testKeys?: NativeKeyStore, interactive = false) {
  // DPAPI creates and verifies its restrictive Windows ACL before Node writes public metadata.
  const windows = process.platform === 'win32' && !testKeys ? await windowsBackend(directory) : undefined;
  if (windows && !await exists(join(directory, 'unlock-check'))) await windows.healthCheck();
  const path = await directoryPath(directory);
  if (!testKeys && !windows && process.platform !== 'darwin') throw new CliFailure('secure_backend_required', 4);
  return { path, windows, keys: testKeys ?? (windows ? windowsKeyStore(join(path, 'native-keys')) : macosKeyStore(path, interactive)) };
}
async function opened(path: string, key: string, windows?: SecureBackend): Promise<SecureBackend> {
  const encrypted = await encryptedBackend(path, key);
  try { await encrypted.healthCheck(); } catch (error) { encrypted.close?.(); throw error; }
  if (!windows) return encrypted;
  // Existing direct-DPAPI and attended records can coexist without rewriting references.
  return { ...encrypted, secrets: { stage: value => encrypted.secrets.stage(value), read: async ref => await encrypted.secrets.read(ref) ?? (/^[a-f0-9-]{36}$/.test(ref) && await exists(join(path, ref + '.dpapi')) ? windows.secrets.read(ref) : null), remove: async ref => { await encrypted.secrets.remove(ref); if (/^[a-f0-9-]{36}$/.test(ref) && await exists(join(path, ref + '.dpapi'))) await windows.secrets.remove(ref); } } };
}
export async function nativeBackend(directory: string, testKeys?: NativeKeyStore): Promise<SecureBackend> {
  const { path, windows, keys } = await stores(directory, testKeys);
  const saved = await keys.load();
  if (saved) return opened(path, saved, windows);
  if (await exists(join(path, 'unlock-check'))) throw new CliFailure('storage_migration_required', 4);
  if (windows) return windows;
  return opened(path, await keys.adopt(randomBytes(32).toString('base64url')));
}
/** Explicit adoption keeps ciphertext/references intact; interrupted adoption is safe to repeat. */
export async function migrateNativeStorage(directory: string, collect = () => hiddenInput('Unlock existing encrypted PoppyKit storage (12+ characters)'), testKeys?: NativeKeyStore): Promise<void> {
  const { path, windows, keys } = await stores(directory, testKeys, !!process.stdin.isTTY && !!process.stderr.isTTY);
  const saved = await keys.load();
  if (saved) { const current = await opened(path, saved, windows); await current.close?.(); return; }
  if (!await exists(join(path, 'unlock-check'))) throw new CliFailure('no_attended_storage_to_migrate', 5);
  const passphrase = await collect(), source = await encryptedBackend(path, passphrase);
  try {
    await source.healthCheck();
    if (await keys.adopt(passphrase) !== passphrase) throw new CliFailure('storage_migration_conflict', 5);
    const current = await opened(path, passphrase, windows); await current.close?.();
  } finally { await source.close?.(); }
}
