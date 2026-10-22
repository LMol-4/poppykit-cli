import { randomBytes, scryptSync, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SecretStore, TrustedInput, IdentitySigner, HttpTransport, AgentBrowserController } from '@poppykit/client';

export class CliFailure extends Error {
  constructor(readonly code: string, readonly exitCode = 1) { super(code); }
}
/** User-controlled trusted module. Never load a module supplied by company/provider metadata. */
export interface SecureBackend {
  secrets: SecretStore;
  healthCheck(): Promise<void>;
  enrollmentAuth?(request: { url: string; installationId: string }): Promise<HeadersInit>;
  trustedInput?: TrustedInput;
  /** Optional local signer whose public key the operator publishes in this clientId's JWKS. */
  identity?: IdentitySigner;
  /** Trusted operator transport; must preserve SDK HTTPS/address/redirect/credential policy. */
  transport?: HttpTransport;
  browserController?: AgentBrowserController;
  close?(): Promise<void> | void;
}
export async function hiddenInput(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !process.stdin.setRawMode) throw new CliFailure('trusted_terminal_required', 4);
  process.stderr.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = '', settled = false;
    const wasRaw = process.stdin.isRaw;
    function finish(error?: Error) { if(settled)return;settled=true;process.off('SIGINT', interrupted);process.off('SIGTERM',interrupted);process.stdin.off('data', data); process.stdin.off('end', ended); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write('\n'); if (error) reject(error); else resolve(value); value = ''; }
    function interrupted(){finish(new CliFailure('canceled',130));}
    function ended() { finish(new CliFailure('trusted_input_closed', 4)); }
    function data(chunk: Buffer) {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { finish(new CliFailure('canceled', 130)); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 4096) value += char;
      }
    }
    process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', data); process.stdin.once('end', ended);
  });
}
export const terminalTrustedInput: TrustedInput = {
  async collect(request) {
    process.stderr.write(`Sign in to ${JSON.stringify(request.organization.name).slice(0,256)} (${request.organization.domain})${request.challenge ? ' (challenge)' : ''}\n`);
    const input: Record<string, string> = {};
    for (const field of request.fields) input[field.name] = await hiddenInput(`Field ${JSON.stringify(field.label).slice(0,256)}`);
    return input;
  },
};
/** Attended only: independently salted/authenticated immutable ciphertext files, no persisted unlock key. */
export async function encryptedBackend(directory: string, passphrase: string): Promise<SecureBackend> {
  if (passphrase.length < 12) throw new CliFailure('unlock_passphrase_too_short', 4);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const password = Buffer.from(passphrase, 'utf8');
  const known = (ref: string) => /^[a-f0-9-]{36}$/.test(ref);
  const file = (ref: string) => join(directory, `${ref}.enc`);
  const secrets: SecretStore = {
    async stage(value) {
      const salt = randomBytes(16), iv = randomBytes(12), key = scryptSync(password, salt, 32), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([salt, iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); key.fill(0);
      const ref = randomUUID(); await writeFile(file(ref), bytes, { flag: 'wx', mode: 0o600 }); return ref;
    },
    async read(ref) {
      if(!known(ref))return null; // SDK memory-only token references legitimately disappear at process exit.
      let bytes: Buffer; try { bytes = await readFile(file(ref)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new CliFailure('secure_store_unavailable', 4); }
      const key = scryptSync(password, bytes.subarray(0, 16), 32);
      try { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(16, 28)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(28, -16)), cipher.final()]).toString('utf8'); }
      catch { throw new CliFailure('secure_store_locked', 4); } finally { key.fill(0); }
    },
    async remove(ref) { if(!known(ref))return;await unlink(file(ref)).catch(error => { if (error.code !== 'ENOENT') throw new CliFailure('secure_store_unavailable', 4); }); },
  };
  return { secrets, async healthCheck() {
    const pointer=join(directory,'unlock-check');let ref:string;
    try{ref=await readFile(pointer,'utf8');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new CliFailure('secure_store_unavailable',4);const staged=await secrets.stage('poppykit-vault-unlock-v1');
      try{await writeFile(pointer,staged,{flag:'wx',mode:0o600});ref=staged;}
      catch(error){await secrets.remove(staged);if((error as NodeJS.ErrnoException).code!=='EEXIST')throw new CliFailure('secure_store_unavailable',4);ref=await readFile(pointer,'utf8');}
    }
    if(await secrets.read(ref)!=='poppykit-vault-unlock-v1')throw new CliFailure('secure_store_locked',4);
  }, trustedInput: terminalTrustedInput, close() { password.fill(0); } };
}
export async function openBackend(input: { module?: string; unlock?: boolean; directory: string }): Promise<SecureBackend> {
  let backend: SecureBackend;
  try {
    if (input.unlock) backend = await encryptedBackend(input.directory, await hiddenInput('Unlock encrypted PoppyKit storage (12+ characters)'));
    else {
      if (!input.module) throw new CliFailure('secure_backend_required', 4);
      if (!isAbsolute(input.module)) throw new CliFailure('secure_backend_path_must_be_absolute', 4);
      const adapter = await import(pathToFileURL(input.module).href);
      backend = await adapter.open({ purpose: 'poppykit-cli', unattended: true });
      if (!backend?.healthCheck || !backend.secrets?.stage || !backend.secrets.read || !backend.secrets.remove) throw new CliFailure('invalid_secure_backend', 4);
    }
    await backend.healthCheck(); return backend;
  } catch (error) { if (error instanceof CliFailure) throw error; throw new CliFailure('secure_store_unavailable', 4); }
}
