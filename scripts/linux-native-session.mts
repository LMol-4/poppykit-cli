import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'linux', 'requires native Linux, dbus, gnome-keyring, libsecret-tools and libglib2.0-bin');
const project = resolve(process.argv.at(-1) ?? '.');
if (process.argv[2] !== '--session') {
  const home = await mkdtemp(join(tmpdir(), 'poppy-secret-service-'));
  try {
    await mkdir(join(home, 'runtime'), { mode: 0o700 });
    const result = spawnSync('/usr/bin/dbus-run-session', [process.execPath, fileURLToPath(import.meta.url), '--session', project], {
      stdio: 'inherit', timeout: 180000,
      env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_RUNTIME_DIR: join(home, 'runtime'), GNOME_KEYRING_CONTROL: '', DISPLAY: '', WAYLAND_DISPLAY: '' },
    });
    assert.equal(result.status, 0, 'isolated Linux native session failed');
  } finally { await rm(home, { recursive: true, force: true }); }
} else {
  // Test-only unlock secret lives in a private pipe, never in argv, env or a file.
  const daemon = spawn('/usr/bin/gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = new Promise<void>(resolve => daemon.once('close', () => resolve()));
  daemon.on('error', () => {});
  daemon.stdin.on('error', () => {}); daemon.stdin.end(randomBytes(32).toString('base64url'));
  try {
    await new Promise<void>((resolve, reject) => {
      const ready = spawn('/usr/bin/gdbus', ['wait', '--session', '--timeout', '15', 'org.freedesktop.secrets'], { stdio: 'ignore', timeout: 20000 });
      ready.once('error', reject); ready.once('close', code => code === 0 ? resolve() : reject(new Error('disposable Secret Service did not start')));
    });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./native-smoke.mjs', import.meta.url)), project], { stdio: 'inherit', timeout: 120000, env: { ...process.env, POPPYKIT_LINUX_TEST_SESSION: 'disposable' } });
    assert.equal(result.status, 0, 'Linux native smoke failed');
  } finally { daemon.kill('SIGKILL'); await closed; }
}
