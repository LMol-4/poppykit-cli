import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { join } from 'node:path';
import { CliFailure } from './secrets.js';
import { publishNativeReference, type NativeKeyStore } from './native.js';

const executable = '/usr/bin/secret-tool';
type SecretTool = (action: 'store' | 'lookup' | 'clear', attributes: string[], value?: string) => Promise<string>;
const unavailable = () => new CliFailure('linux_secret_service_unavailable', 4);

/** No shell, PATH lookup, secret argv/env, or forwarded helper diagnostics. */
const secretTool: SecretTool = (action, attributes, value) => new Promise((resolve, reject) => {
  const child = spawn(executable, [action, ...(action === 'store' ? ['--label=PoppyKit CLI vault', '--collection=default'] : []), ...attributes], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let size = 0, failed = false;
  const stop = () => { failed = true; child.kill('SIGKILL'); };
  const timer = setTimeout(stop, 15000);
  child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 8192) stop(); else chunks.push(bytes); });
  child.stderr.on('data', stop);
  child.stdin.on('error', stop);
  child.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(error.code === 'ENOENT' ? new CliFailure('linux_secret_tool_missing', 4) : unavailable()); });
  child.on('close', code => { clearTimeout(timer); if (code !== 0 || failed) reject(unavailable()); else resolve(Buffer.concat(chunks).toString('utf8')); });
  child.stdin.end(value);
});

/** Called only after native.ts validates the canonical, private, user-owned directory. */
export function linuxKeyStore(directory: string, call: SecretTool = secretTool): NativeKeyStore {
  const service = 'org.poppykit.cli.vault.' + createHash('sha256').update(directory).digest('hex');
  const attributes = (ref: string) => ['application', 'org.poppykit.cli', 'vault', service, 'reference', ref];
  async function reference(): Promise<string | null> {
    try {
      const file = await open(join(directory, 'native-unlock'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size !== 36) throw unavailable();
        const ref = await file.readFile('utf8');
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(ref)) throw unavailable();
        return ref;
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw unavailable(); }
  }
  function decode(text: string): string {
    try { const value: unknown = JSON.parse(text); if (typeof value === 'string' && value.length >= 12 && value.length <= 4096) return value; } catch { /* Only the fixed failure code leaves this boundary. */ }
    throw unavailable();
  }
  async function load() {
    const ref = await reference();
    // secret-tool uses the same exit code for absent and inaccessible items. Never replace a referenced key.
    return ref === null ? null : decode(await call('lookup', attributes(ref)));
  }
  return { load, async adopt(value) {
    const existing = await load(); if (existing !== null) return existing;
    const encoded = JSON.stringify(value);
    if (value.length < 12 || value.length > 4096 || Buffer.byteLength(encoded) > 8191) throw unavailable();
    const ref = randomUUID(), attrs = attributes(ref);
    await call('store', attrs, encoded);
    let published = false;
    try {
      if (decode(await call('lookup', attrs)) !== value) throw unavailable();
      published = await publishNativeReference(directory, ref);
    } finally { if (!published) await call('clear', attrs); }
    const winner = await load(); if (winner === null) throw unavailable(); return winner;
  } };
}

/** Offline prerequisites only: never opens a bus, prompts, or initializes a keyring. */
export async function linuxStorageDiagnostics() {
  const installed = await access(executable, constants.X_OK).then(() => true, () => false);
  return { secretTool: installed ? 'available' : 'missing', sessionBus: process.env.DBUS_SESSION_BUS_ADDRESS ? 'configured' : 'not-configured', availability: 'not-probed' };
}
