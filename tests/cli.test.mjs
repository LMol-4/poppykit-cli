// Subprocess tests: the built CLI against an independent fixture host written here from docs/host-contract.md.
// The fixture is a plain Node pipe listener; it has no code from the demo host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/host-contract.json', import.meta.url), 'utf8'));
const win = process.platform === 'win32';

let home;
let n = 0;
before(async () => { home = await mkdtemp(join(tmpdir(), 'poppykit-cli-test-')); });
after(() => rm(home, { recursive: true, force: true }));

function run(args, env = {}, stateDir = home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, POPPYKIT_HOME: stateDir, ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const json = (r) => {
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, 'exactly one stdout line');
  assert.ok(r.stdout.endsWith('\n'));
  return JSON.parse(r.stdout);
};

// Fixture host. `reply(request, socket)` returns a string frame to send (LF appended) or handles the socket itself.
async function host(reply) {
  const pipe = `\\\\.\\pipe\\poppykit-cli-test-${process.pid}-${++n}-${randomUUID().slice(0, 8)}`;
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buf = '';
    socket.on('data', async (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      const request = JSON.parse(buf.slice(0, buf.indexOf('\n')));
      buf = '';
      requests.push(request);
      const out = await reply(request, socket);
      if (typeof out === 'string') socket.end(out + '\n');
    });
  });
  await new Promise((r) => server.listen(pipe, r));
  return { pipe, requests, close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); } };
}
const ok = (request, extra = {}) => ({ version: 1, requestId: request.requestId, operation: request.operation, status: 'succeeded', result: { echoed: true }, ...extra });
const answer = (fn) => (request) => JSON.stringify(fn(request));

async function withHost(reply, body, profile = {}) {
  const h = await host(reply);
  const dir = await mkdtemp(join(home, 'case-'));
  try {
    const add = await run(['profile', 'add', 'p', '--pipe', h.pipe, ...(profile.connection ? ['--connection', profile.connection] : [])], {}, dir);
    assert.equal(add.code, 0);
    await body(h, (args, env) => run(args, env, dir), dir);
  } finally { await h.close(); }
}

describe('commands', { skip: !win }, () => {
  const cases = [
    [['discovery', 'shop.poppy.test'], 'discovery', { domain: 'shop.poppy.test' }],
    [['connect', 'shop.poppy.test'], 'connection.start', { domain: 'shop.poppy.test' }],
    [['connections'], 'connection.list', {}],
    [['login', '--scope', 'poppy:read', '--scope', 'poppy:write'], 'login.start', { scopes: ['poppy:read', 'poppy:write'], connection: 'c1' }],
    [['login', '--scope', 'poppy:read', '--domain', 'shop.poppy.test', '--replace', 'c0'], 'login.start', { scopes: ['poppy:read'], domain: 'shop.poppy.test', replaceConnection: 'c0' }],
    [['status', 'op-1'], 'operation.status', { operation: 'op-1' }],
    [['status', 'op-1', '--login'], 'login.status', { operation: 'op-1' }],
    [['cancel', 'login-1'], 'login.cancel', { operation: 'login-1' }],
    [['logout'], 'logout', { connection: 'c1' }],
    [['read', 'conv-1', '--cursor', 'cur', '--wait', '10', '--consumer', 'agent'], 'conversation.read', { connection: 'c1', conversation: 'conv-1', cursor: 'cur', waitSeconds: 10, consumer: 'agent' }],
    [['ack', 'conv-1', '--consumer', 'agent', '--cursor', 'cur'], 'conversation.ack', { connection: 'c1', conversation: 'conv-1', consumer: 'agent', cursor: 'cur' }],
    [['handoff', 'conv-1'], 'conversation.handoff', { connection: 'c1', conversation: 'conv-1' }],
    [['close', 'conv-1'], 'conversation.close', { connection: 'c1', conversation: 'conv-1' }],
  ];
  for (const [args, op, params] of cases) {
    test(`${args[0]} -> ${op}`, async () => {
      await withHost(answer(ok), async (h, cli) => {
        const r = await cli(args);
        assert.equal(r.code, 0, r.stderr);
        const out = json(r);
        assert.equal(out.operation, op);
        assert.equal(out.status, 'succeeded');
        assert.equal(h.requests.length, 1);
        assert.deepEqual(h.requests[0].params, params);
        assert.equal(h.requests[0].version, 1);
        assert.equal(r.stderr, '');
      }, { connection: 'c1' });
    });
  }

  test('start, send and direct build messages and persist handles', async () => {
    await withHost(answer(ok), async (h, cli, dir) => {
      const start = json(await cli(['start', '--text', 'hi', '--human', '--wait', '5']));
      assert.equal(start.status, 'succeeded');
      await cli(['send', 'conv-1', '--text', 'a', '--data', '{"k":[1,{"z":null}]}', '--context', '{"c":1}', '--cursor', 'cur']);
      await cli(['direct', 'conv-1', '--data', '{"x":1}']);
      const [s, d, c] = h.requests;
      assert.equal(s.operation, 'conversation.start');
      assert.deepEqual([s.params.message.sender, s.params.message.text, s.params.waitSeconds], ['human', 'hi', 5]);
      assert.equal(d.operation, 'conversation.send');
      assert.deepEqual(d.params.message, { id: d.params.message.id, sender: 'agent', text: 'a', data: { k: [1, { z: null }] }, context: { c: 1 } });
      assert.equal(d.params.cursor, 'cur');
      assert.equal(c.operation, 'conversation.direct');
      assert.equal(c.params.conversation, 'conv-1');
      const files = readdirSync(join(dir, 'sends'));
      assert.deepEqual(files.sort(), [s, d, c].map((x) => `${x.params.sendOperation}.json`).sort());
      assert.notEqual(s.requestId, d.requestId);
    });
  });

  test('host fixtures pass through unchanged with exit codes from status', async () => {
    const byOp = (op) => fixtures.find((f) => f.response.operation === op);
    const trials = [
      [['logout', '--connection', 'connection-1'], 'logout', 0],
      [['read', 'conversation-1', '--connection', 'connection-1'], 'conversation.read', byOp('conversation.read').response.status === 'failed' ? 1 : 0],
    ];
    for (const [args, op, code] of trials) {
      await withHost((req) => JSON.stringify({ ...byOp(op).response, requestId: req.requestId }), async (h, cli) => {
        const r = await cli(args);
        assert.equal(r.code, code);
        const out = json(r);
        assert.deepEqual({ ...out, requestId: 0 }, { ...byOp(op).response, requestId: 0 });
      });
    }
  });

  test('page results keep unknown fields; the page is not altered', async () => {
    const page = { events: [{ type: 'x', unknown_field: { a: 1 } }], cursor: 'c2', future: true };
    await withHost(answer((q) => ok(q, { result: { page } })), async (_h, cli) => {
      assert.deepEqual(json(await cli(['read', 'conv-1'])).result.page, page);
    });
  });

  test('host failure keeps category, protocol failure and next action; exit 1', async () => {
    const failure = { error: { category: 'authorization_required', message: 'Sign-in is required.', protocol: { status: 401, code: 'sign_in_required', retryAfter: '3' } }, nextAction: { type: 'sign_in' } };
    await withHost(answer((q) => ({ version: 1, requestId: q.requestId, operation: q.operation, status: 'failed', ...failure })), async (_h, cli) => {
      const r = await cli(['read', 'conv-1']);
      assert.equal(r.code, 1);
      const out = json(r);
      assert.deepEqual([out.error, out.nextAction], [failure.error, failure.nextAction]);
      assert.equal(r.stderr, 'poppykit: conversation.read authorization_required\n');
    });
  });

  test('accepted and pending exit 0', async () => {
    for (const status of ['accepted', 'pending']) {
      await withHost(answer((q) => ok(q, { status })), async (_h, cli) => {
        const r = await cli(['status', 'op-1']);
        assert.equal(r.code, 0);
        assert.equal(json(r).status, status);
      });
    }
  });

  test('profile connection is forwarded; --connection overrides it', async () => {
    await withHost(answer(ok), async (h, cli) => {
      await cli(['logout']);
      await cli(['logout', '--connection', 'other']);
      assert.deepEqual(h.requests.map((q) => q.params.connection), ['c1', 'other']);
    }, { connection: 'c1' });
  });
});

describe('transport failures never succeed and are never replayed', { skip: !win }, () => {
  const bad = {
    'no LF (truncated)': (q, s) => { s.end(JSON.stringify(ok(q))); },
    'empty close': (_q, s) => { s.end(); },
    'malformed JSON': () => '{not json',
    'JSON but not an object': () => '[1]',
    'two frames': (q) => `${JSON.stringify(ok(q))}\n${JSON.stringify(ok(q))}`,
    'wrong requestId': (q) => JSON.stringify({ ...ok(q), requestId: 'other' }),
    'wrong operation': (q) => JSON.stringify({ ...ok(q), operation: 'connection.list' }),
    'unknown version': (q) => JSON.stringify({ ...ok(q), version: 2 }),
    'unknown status': (q) => JSON.stringify({ ...ok(q), status: 'done' }),
    'succeeded with error': (q) => JSON.stringify({ ...ok(q), error: { category: 'conflict', message: 'x' } }),
    'failed without error': (q) => JSON.stringify({ ...ok(q), status: 'failed', result: undefined }),
    'invalid UTF-8': (_q, s) => { s.end(Buffer.from([0x7b, 0xff, 0x7d, 0x0a])); },
    'too deep': (q) => JSON.stringify({ ...ok(q), result: { a: JSON.parse('['.repeat(70) + ']'.repeat(70)) } }),
  };
  for (const [name, reply] of Object.entries(bad)) {
    test(name, async () => {
      await withHost(reply, async (h, cli, dir) => {
        const send = await cli(['send', 'conv-1', '--text', 'hello']);
        assert.equal(send.code, 1);
        const out = json(send);
        assert.equal(out.status, 'failed');
        assert.equal(out.error.category, 'uncertain_outcome');
        const handle = out.nextAction.operation;
        assert.deepEqual(out.result, { sendOperation: handle });
        assert.equal(h.requests.length, 1, 'no automatic replay');
        assert.equal(h.requests[0].params.sendOperation, handle);
        const read = await cli(['read', 'conv-1']);
        assert.equal(read.code, 1);
        assert.equal(json(read).error.category, 'transport_failure');
        assert.equal(h.requests.length, 2);
      });
    });
  }

  test('response over 8 MiB is oversized_result', async () => {
    const huge = JSON.stringify(ok({ requestId: 'x', operation: 'x' }, { result: { blob: 'a'.repeat(8 * 1024 * 1024) } }));
    await withHost((q, s) => { s.end(`${huge}\n`); }, async (h, cli) => {
      const r = await cli(['send', 'conv-1', '--text', 'hi']);
      assert.equal(r.code, 1);
      assert.equal(json(r).error.category, 'oversized_result');
      assert.equal(h.requests.length, 1);
    });
  });

  test('a response of exactly 8 MiB with LF is accepted', async () => {
    const LIMIT = 8 * 1024 * 1024;
    await withHost((q, s) => {
      const base = JSON.stringify(ok(q, { result: { blob: '' } }));
      s.end(base.replace('"blob":""', `"blob":"${'a'.repeat(LIMIT - 1 - base.length)}"`) + '\n');
    }, async (_h, cli) => {
      const r = await cli(['read', 'conv-1']);
      assert.equal(r.code, 0);
      assert.equal(Buffer.byteLength(r.stdout), LIMIT);
    });
  });

  test('silent host: request timeout is uncertain, not success', async () => {
    await withHost(() => new Promise(() => {}), async (h, cli) => {
      const r = await cli(['send', 'conv-1', '--text', 'hi'], { POPPYKIT_REQUEST_TIMEOUT_MS: '1500' });
      assert.equal(r.code, 1);
      assert.equal(json(r).error.category, 'uncertain_outcome');
      assert.equal(h.requests.length, 1);
    });
  });

  test('no host listening: request not sent, transport_failure with the send handle', async () => {
    const dir = await mkdtemp(join(home, 'case-'));
    await run(['profile', 'add', 'p', '--pipe', `\\\\.\\pipe\\poppykit-cli-absent-${randomUUID()}`], {}, dir);
    const r = await run(['send', 'conv-1', '--text', 'hi'], { POPPYKIT_CONNECT_TIMEOUT_MS: '500' }, dir);
    assert.equal(r.code, 1);
    const out = json(r);
    assert.equal(out.error.category, 'transport_failure');
    assert.match(out.result.sendOperation, /^send-/);
  });

  test('pipe is opened at Identification level and its owner is checked', async () => {
    const name = `poppykit-cli-level-${randomUUID()}`;
    const script = `
      $s = [IO.Pipes.NamedPipeServerStream]::new('${name}', 'InOut', 1, 'Byte', 'Asynchronous')
      $s.WaitForConnection()
      $r = [IO.StreamReader]::new($s); $line = $r.ReadLine()
      $req = $line | ConvertFrom-Json
      $level = ''
      $s.RunAsClient({ $script:level = [string][Security.Principal.WindowsIdentity]::GetCurrent($true).ImpersonationLevel })
      $out = @{ version = 1; requestId = $req.requestId; operation = $req.operation; status = 'succeeded'; result = @{ level = $level } } | ConvertTo-Json -Compress -Depth 5
      $w = [IO.StreamWriter]::new($s); $w.Write($out + "\`n"); $w.Flush()
      Start-Sleep -Milliseconds 500`;
    const server = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 2500)); // let pwsh create the pipe
      const dir = await mkdtemp(join(home, 'case-'));
      await run(['profile', 'add', 'p', '--pipe', `\\\\.\\pipe\\${name}`], {}, dir);
      const r = await run(['connections'], {}, dir);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(json(r).result.level, 'Identification');
    } finally { server.kill(); }
  });
});

describe('send handles', { skip: !win }, () => {
  test('saved before the host is contacted', async () => {
    let dirRef;
    const seen = [];
    await withHost((q) => {
      seen.push(existsSync(join(dirRef, 'sends', `${q.params.sendOperation}.json`)));
      return JSON.stringify(ok(q));
    }, async (_h, cli, dir) => {
      dirRef = dir;
      assert.equal((await cli(['send', 'conv-1', '--text', 'hello'])).code, 0);
      assert.deepEqual(seen, [true]);
    });
  });

  test('retry after an uncertain send resends the same sendOperation and message ID', async () => {
    let first = true;
    await withHost((q, s) => {
      if (first) { first = false; s.end(); return; }
      return JSON.stringify(ok(q));
    }, async (h, cli) => {
      const a = json(await cli(['send', 'conv-1', '--text', 'hello', '--connection', 'c9']));
      const handle = a.result.sendOperation;
      const retry = await cli(['send', '--send-operation', handle]);
      assert.equal(retry.code, 0);
      const [x, y] = h.requests;
      assert.equal(y.params.sendOperation, handle);
      assert.deepEqual(y.params, x.params);
      assert.notEqual(x.requestId, y.requestId, 'requestId identifies one attempt');
      // Same content given again also reuses the saved message ID.
      const again = await cli(['send', 'conv-1', '--text', 'hello', '--connection', 'c9', '--send-operation', handle]);
      assert.equal(again.code, 0);
      assert.equal(h.requests[2].params.message.id, x.params.message.id);
    });
  });

  test('reusing a handle with changed content, target or command is a conflict and sends nothing', async () => {
    await withHost(answer(ok), async (h, cli) => {
      assert.equal((await cli(['send', 'conv-1', '--text', 'hello', '--send-operation', 'h1'])).code, 0);
      for (const args of [
        ['send', 'conv-1', '--text', 'changed', '--send-operation', 'h1'],
        ['send', 'conv-2', '--text', 'hello', '--send-operation', 'h1'],
        ['send', 'conv-1', '--text', 'hello', '--message-id', 'different', '--send-operation', 'h1'],
        ['send', 'conv-1', '--text', 'hello', '--human', '--send-operation', 'h1'],
        ['direct', '--send-operation', 'h1'],
      ]) {
        const r = await cli(args);
        assert.equal(r.code, 1, args.join(' '));
        assert.equal(json(r).error.category, 'conflict');
      }
      assert.equal(h.requests.length, 1);
    });
  });

  test('unknown handle without content is invalid input', async () => {
    await withHost(answer(ok), async (h, cli) => {
      const r = await cli(['send', '--send-operation', 'nope']);
      assert.equal(r.code, 2);
      assert.equal(h.requests.length, 0);
    });
  });

  test('explicit handle and message ID are used as given; unsafe handles are rejected', async () => {
    await withHost(answer(ok), async (h, cli) => {
      await cli(['start', '--text', 'x', '--send-operation', 'my.handle-1', '--message-id', 'm-1']);
      assert.deepEqual([h.requests[0].params.sendOperation, h.requests[0].params.message.id], ['my.handle-1', 'm-1']);
      for (const bad of ['..\\x', '../x', 'a b', '']) assert.equal((await cli(['start', '--text', 'x', '--send-operation', bad])).code, 2);
    });
  });
});

describe('invocation errors exit 2 with one JSON result and nothing sent', () => {
  const bad = [
    [[], 'connection.list'], [['frobnicate'], 'connection.list'], [['status'], 'connection.list'],
    [['login'], 'connection.list'], [['login', '--scope', 'a b'], 'connection.list'],
    [['login', '--scope', 'a', '--domain', 'd', '--connection', 'c'], 'connection.list'],
    [['login', '--scope', 'a', '--replace', 'c', '--connection', 'c'], 'connection.list'],
    [['send', 'c1'], 'connection.list'], [['send', 'c1', '--text', 'x', '--data', '[1]'], 'connection.list'],
    [['send', 'c1', '--text', 'x', '--data', '{bad'], 'connection.list'], [['start', '--text', 'x', '--wait', '31'], 'connection.list'],
    [['read'], 'connection.list'], [['ack', 'c1', '--consumer', 'x'], 'connection.list'], [['read', 'c1', '--nope'], 'connection.list'],
    [['start', '--text', 'x', '--data', `${'['.repeat(70)}${']'.repeat(70)}`], 'connection.list'],
  ];
  for (const [args, op] of bad) {
    test(`exit 2: ${args.join(' ') || '(no args)'}`, async () => {
      const dir = await mkdtemp(join(home, 'case-'));
      await run(['profile', 'add', 'p', '--pipe', '\\\\.\\pipe\\poppykit-cli-unused', '--connection', 'c0'], {}, dir);
      const r = await run(args, {}, dir);
      assert.equal(r.code, 2, r.stdout);
      const out = json(r);
      assert.equal(out.error.category, 'invalid_input');
      assert.equal(out.status, 'failed');
      assert.equal(out.operation, op);
      assert.match(out.requestId, /^req-/);
      assert.equal(existsSync(join(dir, 'sends')), false);
    });
  }

  test('profile problems', async () => {
    const empty = await mkdtemp(join(home, 'case-'));
    assert.equal((await run(['connections'], {}, empty)).code, 2);
    await run(['profile', 'add', 'a', '--pipe', '\\\\.\\pipe\\x'], {}, empty);
    await run(['profile', 'add', 'b', '--pipe', '\\\\.\\pipe\\y'], {}, empty);
    assert.equal((await run(['connections'], {}, empty)).code, 2, 'ambiguous profile');
    assert.equal((await run(['connections', '--profile', 'zzz'], {}, empty)).code, 2);
    for (const pipe of ['127.0.0.1:80', '\\\\server\\pipe\\x', '\\\\.\\pipe\\a\\b', '/tmp/sock', '\\\\.\\pipe\\']) {
      assert.equal((await run(['profile', 'add', 'c', '--pipe', pipe], {}, empty)).code, 2, pipe);
    }
  });

  test('profile add, list and remove', async () => {
    const dir = await mkdtemp(join(home, 'case-'));
    await run(['profile', 'add', 'a', '--pipe', '\\\\.\\pipe\\x', '--connection', 'c1'], {}, dir);
    await run(['profile', 'add', 'a', '--pipe', '\\\\.\\pipe\\x2'], {}, dir);
    await run(['profile', 'add', 'b', '--pipe', '\\\\.\\pipe\\y'], {}, dir);
    const list = json(await run(['profile', 'list'], {}, dir));
    assert.deepEqual(list.result.profiles.map((p) => [p.name, p.pipe]).sort(), [['a', '\\\\.\\pipe\\x2'], ['b', '\\\\.\\pipe\\y']]);
    await run(['profile', 'remove', 'a'], {}, dir);
    assert.equal(json(await run(['profile', 'list'], {}, dir)).result.profiles.length, 1);
  });
});

describe('no secrets in output', { skip: !win }, () => {
  const SECRET = 'tok_SECRET_9f3a';
  const clean = (r) => { assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'secret leaked'); };

  test('invalid arguments and hostile host bodies are not echoed', async () => {
    await withHost((q, s) => { s.end(`{"access_token":"${SECRET}"\n`); }, async (_h, cli) => {
      clean(await cli(['read', 'c1', `--${SECRET}=1`]));
      clean(await cli(['frobnicate', SECRET]));
      clean(await cli(['send', 'c1', '--text', 'x', '--data', `{${SECRET}`]));
      const r = await cli(['send', 'c1', '--text', 'x']);
      assert.equal(r.code, 1);
      clean(r);
    });
  });

  test('stderr is fixed text only', async () => {
    await withHost(answer((q) => ({ version: 1, requestId: q.requestId, operation: q.operation, status: 'failed', error: { category: 'permission_denied', message: `denied ${SECRET}` } })), async (_h, cli) => {
      const r = await cli(['read', 'c1']);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, 'poppykit: conversation.read permission_denied\n');
    });
  });

  test('error category outside the contract list is an invalid response', async () => {
    await withHost(answer((q) => ({ version: 1, requestId: q.requestId, operation: q.operation, status: 'failed', error: { category: 'bogus', message: 'x' } })), async (_h, cli) => {
      const r = await cli(['read', 'c1']);
      assert.equal(r.code, 1);
      assert.ok(!r.stdout.includes('bogus') && !r.stderr.includes('bogus'), 'unknown category reached output');
      assert.equal(json(r).error.category, 'transport_failure');
      assert.equal(r.stderr, 'poppykit: conversation.read transport_failure\n');
    });
  });
});
