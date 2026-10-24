import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { linuxKeyStore, linuxStorageDiagnostics } from '../dist/linux.js';
import { CliFailure } from '../dist/secrets.js';

const linux = { skip: process.platform !== 'linux' };
const key = 'PRIVATE wrapping key ü 🔐';
test('Linux adoption publishes one verified custody key under concurrent initialization', linux, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'Linux vault ü ')), items = new Map<string, string>();
  const calls: string[] = [];
  const store = linuxKeyStore(directory, async (action, attributes, value) => {
    assert.equal(attributes[0], 'application'); assert.ok(!attributes.includes(key));
    const ref = attributes.at(-1)!; calls.push(action);
    if (action === 'store') { assert.ok(value); items.set(ref, value); return ''; }
    if (action === 'clear') { items.delete(ref); return ''; }
    const item = items.get(ref); if (!item) throw new CliFailure('linux_secret_service_unavailable', 4); return item;
  });
  try {
    assert.equal(await store.load(), null); assert.deepEqual(calls, []);
    const keys = await Promise.all([store.adopt(key), store.adopt('another PRIVATE wrapping key')]);
    assert.equal(keys[0], keys[1]); assert.equal(items.size, 1);
    assert.equal(await store.load(), keys[0]);
    assert.ok(!String(await readFile(join(directory, 'native-unlock'))).includes('PRIVATE'));
    const before = [...items]; assert.equal(await store.adopt('unused PRIVATE wrapping key'), keys[0]); assert.deepEqual([...items], before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Linux missing or locked referenced items fail closed without generating replacement keys', linux, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'Linux missing key ')), pointer = join(directory, 'native-unlock'), ref = randomUUID();
  await writeFile(pointer, ref, { mode: 0o600 });
  const store = linuxKeyStore(directory, async action => { assert.equal(action, 'lookup'); throw new CliFailure('linux_secret_service_unavailable', 4); });
  try {
    await assert.rejects(store.load(), { code: 'linux_secret_service_unavailable' });
    await assert.rejects(store.adopt(key), { code: 'linux_secret_service_unavailable' });
    assert.equal(await readFile(pointer, 'utf8'), ref);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Linux malformed custody and failed verification never publish a pointer', linux, async () => {
  for (const result of ['not JSON', 'null', JSON.stringify('short'), JSON.stringify('a different wrapping key')]) {
    const directory = await mkdtemp(join(tmpdir(), 'Linux invalid key ')); const calls: string[] = [];
    const store = linuxKeyStore(directory, async action => { calls.push(action); return action === 'lookup' ? result : ''; });
    try {
      await assert.rejects(store.adopt(key), { code: 'linux_secret_service_unavailable' });
      await assert.rejects(readFile(join(directory, 'native-unlock')), { code: 'ENOENT' });
      assert.deepEqual(calls, ['store', 'lookup', 'clear']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('Linux pointer rejects symlinks, unsafe permissions and malformed references before helper execution', linux, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'Linux unsafe pointer ')), pointer = join(directory, 'native-unlock');
  const store = linuxKeyStore(directory, async () => { assert.fail('unsafe pointer reached helper'); });
  try {
    await writeFile(pointer, randomUUID(), { mode: 0o644 });
    await assert.rejects(store.load(), { code: 'linux_secret_service_unavailable' });
    await chmod(pointer, 0o600); await writeFile(pointer, 'x'.repeat(36));
    await assert.rejects(store.load(), { code: 'linux_secret_service_unavailable' });
    await rm(pointer); const target = join(directory, 'target'); await writeFile(target, randomUUID(), { mode: 0o600 }); await symlink(target, pointer);
    await assert.rejects(store.load(), { code: 'linux_secret_service_unavailable' });
    await rm(target);
    await assert.rejects(store.adopt(key), { code: 'linux_secret_service_unavailable' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Linux helper inputs preserve Unicode/control characters and bound the libsecret stdin size', linux, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'Linux encoded key ')), value = key + '\n\t"'; let saved = '';
  const store = linuxKeyStore(directory, async (action, _attributes, input) => { if (action === 'store') saved = input!; return action === 'lookup' ? saved : ''; });
  try {
    assert.equal(await store.adopt(value), value); assert.equal(JSON.parse(saved), value);
    await rm(join(directory, 'native-unlock')); saved = '';
    await assert.rejects(store.adopt('🔐'.repeat(2048)), { code: 'linux_secret_service_unavailable' }); assert.equal(saved, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Linux diagnostics return only fixed offline prerequisites', async () => {
  const result = await linuxStorageDiagnostics();
  assert.ok(['available', 'missing'].includes(result.secretTool)); assert.ok(['configured', 'not-configured'].includes(result.sessionBus));
  assert.equal(result.availability, 'not-probed'); assert.deepEqual(Object.keys(result).sort(), ['availability', 'secretTool', 'sessionBus']);
});
