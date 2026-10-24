import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, join } from 'node:path';

/** Open only a public HTTPS approval link; never run it through a shell. */
export async function openApprovalBrowser(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || /[\x00-\x20]/.test(value)) throw new Error('invalid_browser_url');
  if (process.platform === 'win32' && (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot))) throw new Error('browser_unavailable');
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === 'win32'
      ? execFile(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile','-NonInteractive','-Command', "$ErrorActionPreference='Stop'; [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); $u=[Console]::In.ReadToEnd(); Start-Process -FilePath $u -WindowStyle Hidden"], { windowsHide: true, timeout: 5000 }, error => error ? reject(new Error('browser_unavailable')) : resolve())
      : execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url.href], { timeout: 5000 }, error => error ? reject(error) : resolve());
    if (process.platform === 'win32') { child.stdin?.on('error', () => {}); child.stdin?.end(url.href); }
  });
}

/** A local wait only. Each poll is a separate bounded request. */
export async function waitForApproval<T>(poll: () => Promise<T>, options: {
  signal: AbortSignal; pending(value:T):boolean; timeoutMs:number;
}): Promise<T | undefined> {
  const deadline = performance.now() + options.timeoutMs;
  let retryAfterMs = 0;
  while (performance.now() < deadline) {
    options.signal.throwIfAborted();
    const remaining = deadline - performance.now();
    if (retryAfterMs >= remaining) { await delay(remaining, undefined, {signal:options.signal}); return; }
    if (retryAfterMs) await delay(retryAfterMs, undefined, {signal:options.signal});
    try {
      const value = await poll();
      if (!options.pending(value)) return value;
      const hint = (value as {retryAfterMs?:number}).retryAfterMs;
      retryAfterMs = Math.max(2000, Number.isFinite(hint) ? hint ?? 0 : 0);
    } catch (error) {
      const safe = error as {code?:string;retryAfterMs?:number;retryAt?:number};
      if (!['rate_limited','provider_rate_limited'].includes(safe.code ?? '')) throw error;
      retryAfterMs = Math.max(2000, Number.isFinite(safe.retryAfterMs) ? safe.retryAfterMs ?? 0 : 0, typeof safe.retryAt==='number'&&Number.isFinite(safe.retryAt)?safe.retryAt-Date.now():0);
    }
  }
}
