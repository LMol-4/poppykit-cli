import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MAX_FRAME = 8 * 1024 * 1024; // bytes including the LF
const HELPER = fileURLToPath(new URL('../helpers/pipe-client.ps1', import.meta.url));
export const PIPE_RE = /^\\\\\.\\pipe\\([A-Za-z0-9._-]{1,128})$/i;

// not_sent: the request never reached the host. uncertain: it may have. oversized: response over the frame limit.
export type Exchange = { kind: 'ok'; frame: string } | { kind: 'not_sent' | 'uncertain' | 'oversized' };

export function exchange(pipe: string, request: string, env: NodeJS.ProcessEnv = process.env): Promise<Exchange> {
  const name = PIPE_RE.exec(pipe)?.[1];
  const bytes = Buffer.from(request + '\n', 'utf8');
  if (!name || process.platform !== 'win32' || bytes.length > MAX_FRAME) return Promise.resolve({ kind: 'not_sent' });
  // Timeout overrides exist for tests; the contract values are 5 s connect, 35 s request.
  const connectMs = Number(env.POPPYKIT_CONNECT_TIMEOUT_MS) || 5_000;
  const requestMs = Number(env.POPPYKIT_REQUEST_TIMEOUT_MS) || 35_000;
  return new Promise((resolve) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, name, String(connectMs), String(requestMs)],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = () => child.kill(); // by handle, never by image name
    const hard = setTimeout(stop, connectMs + requestMs + 10_000); // helper hung (e.g. slow pwsh start)
    process.once('SIGINT', stop); // interrupt cancels waiting only; the result is then uncertain
    process.once('SIGTERM', stop);
    const done = (r: Exchange) => {
      clearTimeout(hard);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(r);
    };
    child.on('error', () => done({ kind: 'not_sent' })); // pwsh missing
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_FRAME) stop();
      else chunks.push(d);
    });
    child.on('close', (code) => {
      if (code === 10 || code === 11) return done({ kind: 'not_sent' });
      if (code === 13 || size > MAX_FRAME) return done({ kind: 'oversized' });
      const buf = Buffer.concat(chunks);
      // Complete means exactly one trailing LF; anything else is a truncated or malformed transport.
      if (code !== 0 || buf.at(-1) !== 10 || buf.indexOf(10) !== buf.length - 1) return done({ kind: 'uncertain' });
      try {
        done({ kind: 'ok', frame: new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, -1)) });
      } catch {
        done({ kind: 'uncertain' });
      }
    });
    child.stdin.end(bytes);
  });
}
