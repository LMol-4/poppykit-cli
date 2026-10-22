#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { exchange, MAX_FRAME, PIPE_RE } from './channel.js';
import { HELP } from './help.js';
import type { ErrorCategory, HostResponse, Json, Message, Operation, Profile } from './host-contract.js';

class Usage extends Error {}
class Local extends Error {
  constructor(readonly category: ErrorCategory, message: string, readonly sendOperation?: string) { super(message); }
}

const MAX_DEPTH = 64;
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/; // Poppy IDs (spec 7.2)
// Event types a Personal Agent recognizes (spec 7.5); anything else is reduced before it can reach a model.
const EVENT_TYPES = ['message', 'state', 'authorization', 'user_requested', 'direct_opened', 'direct_closed'];
const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const STATUSES = ['succeeded', 'accepted', 'pending', 'failed'];
const CATEGORIES: ErrorCategory[] = ['invalid_input', 'unsupported_capability', 'authorization_required', 'permission_denied', 'conflict', 'history_gap', 'transport_failure', 'uncertain_outcome', 'version_mismatch', 'oversized_result'];
const READ_ONLY: Operation[] = ['discovery', 'connection.list', 'login.status', 'operation.status', 'conversation.read'];

// shortcut: state is plain per-user files under LOCALAPPDATA (user-private by default ACL); it holds public config only.
const stateDir = (env: NodeJS.ProcessEnv) => env.POPPYKIT_HOME ?? join(env.LOCALAPPDATA ?? homedir(), 'poppykit-cli');

const deep = (v: unknown, d = 0): boolean => d > MAX_DEPTH || (typeof v === 'object' && v !== null && Object.values(v).some((x) => deep(x, d + 1)));
const sorted = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Local('transport_failure', 'local state is unreadable');
  }
}

async function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { flag: 'wx' });
  await rename(tmp, file);
}

// Exclusive, complete-or-absent create: two invocations racing on one handle cannot both write it.
async function createExclusive(file: string, data: unknown): Promise<boolean> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data), { flag: 'wx' });
  try { await link(tmp, file); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally { await unlink(tmp).catch(() => {}); }
}

type SendRecord = { operation: Operation; pipe: string; connection: string; conversation?: string; cursor?: string; message: Message };

const SEND_OPS: Record<string, Operation> = { start: 'conversation.start', send: 'conversation.send', direct: 'conversation.direct' };
const MSG_OPTS = { text: { type: 'string' }, data: { type: 'string' }, context: { type: 'string' }, human: { type: 'boolean' }, 'message-id': { type: 'string' }, 'send-operation': { type: 'string' }, wait: { type: 'string' } } as const;
const SIMPLE: Record<string, [Operation, string[]]> = {
  discovery: ['discovery', ['domain']], connect: ['connection.start', ['domain']], connections: ['connection.list', []],
  cancel: ['login.cancel', ['operation']], logout: ['logout', []], handoff: ['conversation.handoff', ['conversation']], close: ['conversation.close', ['conversation']],
};
const EXTRA: Record<string, object> = {
  login: { scope: { type: 'string', multiple: true }, domain: { type: 'string' }, replace: { type: 'string' } },
  status: { login: { type: 'boolean' } },
  send: { cursor: { type: 'string' } },
  read: { cursor: { type: 'string' }, wait: { type: 'string' }, consumer: { type: 'string' } },
  ack: { cursor: { type: 'string' }, consumer: { type: 'string' } },
};
const COMMANDS = [...Object.keys(SIMPLE), ...Object.keys(SEND_OPS), ...Object.keys(EXTRA)];

const wait = (v?: string) => {
  if (v === undefined) return {};
  if (!/^\d+$/.test(v) || Number(v) > 30) throw new Usage('--wait must be an integer from 0 to 30');
  return { waitSeconds: Number(v) };
};
const jsonObject = (name: string, v?: string) => {
  if (v === undefined) return {};
  let x: unknown;
  try { x = JSON.parse(v); } catch { throw new Usage(`--${name} is not valid JSON`); }
  if (typeof x !== 'object' || x === null || Array.isArray(x) || deep(x)) throw new Usage(`--${name} must be a JSON object nested at most ${MAX_DEPTH} deep`);
  return { [name]: x as { [k: string]: Json } };
};
const sendParams = (rec: SendRecord, sendOperation: string, w: object) => ({
  ...(rec.connection ? { connection: rec.connection } : {}), ...(rec.conversation ? { conversation: rec.conversation } : {}),
  sendOperation, message: rec.message, ...(rec.cursor ? { cursor: rec.cursor } : {}), ...w,
});

type Built = { op: Operation; params: Record<string, unknown>; profile: Profile; sendOperation?: string };

async function build(cmd: string, argv: string[], home: string): Promise<Built> {
  const sendOp = SEND_OPS[cmd];
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: { profile: { type: 'string' }, connection: { type: 'string' }, ...(sendOp ? MSG_OPTS : {}), ...EXTRA[cmd] } as never,
    });
  } catch (e) { throw new Usage(`invalid arguments (${(e as { code?: string }).code ?? 'parse'})`); }
  const o = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const pos = parsed.positionals;
  const str = (k: string) => o[k] as string | undefined;
  for (const v of [...pos, ...['profile', 'connection', 'consumer', 'cursor', 'replace', 'domain'].map(str)]) {
    if (v !== undefined && (v === '' || v.includes('\0'))) throw new Usage('arguments must be nonempty strings');
  }
  const need = (n: number) => { if (pos.length !== n) throw new Usage(`${cmd} takes ${n} positional argument(s)`); };

  const profiles = (await readJson<Profile[]>(join(home, 'profiles.json'))) ?? [];
  const name = str('profile');
  const profile = name ? profiles.find((p) => p.name === name) : profiles.length === 1 ? profiles[0] : undefined;
  if (!profile) throw new Usage(name ? 'unknown profile' : profiles.length ? 'several profiles configured; pass --profile' : 'no profile configured; run: profile add');
  if (!PIPE_RE.test(profile.pipe)) throw new Usage('profile pipe must be a local \\\\.\\pipe\\ name');
  const connection = str('connection') ?? profile.connection;
  const sel = connection ? { connection } : {};

  if (cmd === 'login') {
    const scopes = (o.scope as string[] | undefined) ?? [];
    if (!scopes.length || scopes.some((s) => !s || /\s/.test(s))) throw new Usage('login needs at least one --scope');
    need(0);
    if (str('domain')) {
      if (str('connection')) throw new Usage('--domain and --connection are mutually exclusive');
      return { op: 'login.start', profile, params: { scopes, domain: str('domain'), ...(str('replace') ? { replaceConnection: str('replace') } : {}) } };
    }
    if (str('replace')) throw new Usage('--replace needs --domain');
    if (!connection) throw new Usage('login needs --connection (or a profile connection) or --domain');
    return { op: 'login.start', profile, params: { scopes, connection } };
  }
  if (cmd === 'status') {
    need(1);
    return { op: o.login ? 'login.status' : 'operation.status', profile, params: { operation: pos[0] } };
  }
  if (cmd === 'read') {
    need(1);
    return { op: 'conversation.read', profile, params: { ...sel, conversation: pos[0], ...(str('cursor') ? { cursor: str('cursor') } : {}), ...wait(str('wait')), ...(str('consumer') ? { consumer: str('consumer') } : {}) } };
  }
  if (cmd === 'ack') {
    need(1);
    if (!str('consumer') || !str('cursor')) throw new Usage('ack needs --consumer and --cursor');
    return { op: 'conversation.ack', profile, params: { ...sel, conversation: pos[0], consumer: str('consumer'), cursor: str('cursor') } };
  }
  if (!sendOp) {
    const [op, names] = SIMPLE[cmd];
    need(names.length);
    const named = Object.fromEntries(names.map((n, i) => [n, pos[i]]));
    return { op, profile, params: ['logout', 'conversation.handoff', 'conversation.close'].includes(op) ? { ...sel, ...named } : named };
  }

  // Message commands: persist the send handle and message before contacting the host.
  const handle = str('send-operation');
  if (handle !== undefined && !NAME_RE.test(handle)) throw new Usage('--send-operation must match [A-Za-z0-9._-]{1,128}');
  if (str('message-id') !== undefined && !ID_RE.test(str('message-id')!)) throw new Usage('--message-id must match [A-Za-z0-9_-]{1,256}');
  const w = wait(str('wait'));
  const file = (h: string) => join(home, 'sends', `${h}.json`);
  const retryOnly = handle !== undefined && pos.length === 0 && ['text', 'data', 'context', 'message-id', 'cursor', 'connection', 'human'].every((k) => o[k] === undefined);
  if (!retryOnly) need(cmd === 'start' ? 0 : 1);
  if (retryOnly) {
    const saved = await readJson<SendRecord>(file(handle));
    if (!saved) throw new Usage('unknown send operation');
    if (saved.operation !== sendOp) throw new Local('conflict', 'send operation belongs to a different command', handle);
    if (saved.pipe !== profile.pipe || !saved.connection || (connection !== undefined && saved.connection !== connection)) {
      throw new Local('conflict', 'send operation destination differs or is unbound', handle);
    }
    return { op: sendOp, profile, sendOperation: handle, params: sendParams(saved, handle, w) };
  }
  if (o.text === undefined && o.data === undefined && o.context === undefined) throw new Usage('a message needs --text, --data or --context');
  const message: Message = {
    id: str('message-id') ?? `msg-${randomUUID()}`, sender: o.human ? 'human' : 'agent',
    ...(str('text') !== undefined ? { text: str('text') } : {}), ...jsonObject('data', str('data')), ...jsonObject('context', str('context')),
  };
  if (!connection) throw new Usage('message commands need --connection or a profile connection');
  let rec: SendRecord = { operation: sendOp, pipe: profile.pipe, connection, ...(pos[0] ? { conversation: pos[0] } : {}), ...(str('cursor') ? { cursor: str('cursor') } : {}), message };
  const id = handle ?? `send-${randomUUID()}`;
  await mkdir(join(home, 'sends'), { recursive: true });
  if (!(await createExclusive(file(id), rec))) {
    const saved = await readJson<SendRecord>(file(id));
    // Retrying without --message-id reuses the saved message ID; everything else must match exactly.
    if (saved && str('message-id') === undefined) rec = { ...rec, message: { ...message, id: saved.message.id } };
    if (sorted(saved) !== sorted(rec)) throw new Local('conflict', 'send operation already exists with different content or target', id);
  }
  return { op: sendOp, profile, sendOperation: id, params: sendParams(rec, id, w) };
}

const obj = (x: unknown): x is { [k: string]: any } => typeof x === 'object' && x !== null && !Array.isArray(x);
const field = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);
// Unrecognized events keep only validated id, type and created_at; failing fields become null.
const reduceEvent = (e: unknown) => obj(e) && typeof e.type === 'string' && EVENT_TYPES.includes(e.type) ? e : {
  id: field(obj(e) && e.id, ID_RE), type: field(obj(e) && e.type, /^[a-z0-9_.-]{1,64}$/),
  created_at: field(obj(e) && e.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/i),
};

// 'deep': excessive result nesting, which the host contract maps to oversized_result.
function validResponse(text: string, requestId: string, op: Operation): HostResponse | 'deep' | undefined {
  let r: HostResponse;
  try { r = JSON.parse(text); } catch { return undefined; }
  if (deep(r)) return 'deep';
  if (!obj(r) || r.version !== 1 || r.requestId !== requestId || r.operation !== op || !STATUSES.includes(r.status)) return undefined;
  const ok = r.status === 'failed'
    ? obj(r.error) && CATEGORIES.includes(r.error!.category) && typeof r.error!.message === 'string'
    : obj(r.result) && r.error === undefined;
  const page: { [k: string]: any } | undefined = obj(r.result) && obj(r.result.page) ? r.result.page : undefined;
  if (ok && Array.isArray(page?.events)) page!.events = page!.events.map(reduceEvent);
  return ok ? r : undefined;
}

function failed(operation: Operation, requestId: string, category: ErrorCategory, message: string, sendOperation?: string): HostResponse {
  return {
    version: 1, requestId, operation, status: 'failed', error: { category, message },
    ...(sendOperation ? { result: { sendOperation }, nextAction: { type: 'inspect_operation' as const, operation: sendOperation } } : {}),
  };
}

// Local-only convenience, not a host operation: manages profiles.json.
async function profileCommand(argv: string[], home: string): Promise<{ [k: string]: Json }> {
  const [sub, ...rest] = argv;
  let p;
  try { p = parseArgs({ args: rest, allowPositionals: true, options: { pipe: { type: 'string' }, connection: { type: 'string' } } }); } catch { throw new Usage('invalid arguments'); }
  const file = join(home, 'profiles.json');
  const profiles = (await readJson<Profile[]>(file)) ?? [];
  if (sub === 'list' && !p.positionals.length) return { profiles: profiles as unknown as Json };
  const name = p.positionals[0];
  if (!['add', 'remove'].includes(sub) || p.positionals.length !== 1 || !NAME_RE.test(name)) throw new Usage('usage: profile add|remove <name> [--pipe P] [--connection C] | profile list');
  await mkdir(home, { recursive: true });
  if (sub === 'remove') {
    await writeAtomic(file, profiles.filter((x) => x.name !== name));
    return { removed: name };
  }
  if (!p.values.pipe || !PIPE_RE.test(p.values.pipe)) throw new Usage('--pipe must be a local \\\\.\\pipe\\ name');
  const next: Profile = { name, pipe: p.values.pipe, ...(p.values.connection ? { connection: p.values.connection } : {}) };
  await writeAtomic(file, [...profiles.filter((x) => x.name !== name), next]);
  return { profile: next as unknown as Json };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<{ out: HostResponse | string; code: number }> {
  if (argv.length === 1 && (argv[0] === 'help' || argv[0] === '--help')) return { out: HELP, code: 0 };
  const home = stateDir(env);
  const requestId = `req-${randomUUID()}`;
  const [cmd, ...rest] = argv;
  let op: Operation = 'connection.list'; // the contract's stand-in when parsing never identified an operation
  let sendOperation: string | undefined;
  try {
    if (cmd === 'profile') return { out: { version: 1, requestId, operation: op, status: 'succeeded', result: await profileCommand(rest, home) }, code: 0 };
    if (!COMMANDS.includes(cmd)) throw new Usage('unknown command');
    const b = await build(cmd, rest, home);
    op = b.op;
    sendOperation = b.sendOperation;
    const frame = JSON.stringify({ version: 1, requestId, operation: op, params: b.params });
    if (Buffer.byteLength(frame) + 1 > MAX_FRAME) throw new Usage('request exceeds the 8 MiB frame limit');
    const ex = await exchange(b.profile.pipe, frame, env);
    const unknown = READ_ONLY.includes(op) ? 'transport_failure' : 'uncertain_outcome';
    if (ex.kind === 'not_sent') return { out: failed(op, requestId, 'transport_failure', 'host unreachable or not trusted; request not sent', sendOperation), code: 1 };
    if (ex.kind === 'oversized') return { out: failed(op, requestId, 'oversized_result', 'host response exceeded the frame limit', sendOperation), code: 1 };
    if (ex.kind !== 'ok') return { out: failed(op, requestId, unknown, 'no complete response from host; outcome unknown, do not assume success', sendOperation), code: 1 };
    const r = validResponse(ex.frame, requestId, op);
    if (r === 'deep') return { out: failed(op, requestId, 'oversized_result', 'host response nesting exceeded the limit', sendOperation), code: 1 };
    if (!r) return { out: failed(op, requestId, unknown, 'host response was invalid; outcome unknown', sendOperation), code: 1 };
    return { out: r, code: r.status === 'failed' ? 1 : 0 };
  } catch (e) {
    if (e instanceof Usage) return { out: failed(op, requestId, 'invalid_input', e.message), code: 2 };
    const local = e instanceof Local;
    return { out: failed(op, requestId, local ? e.category : 'transport_failure', local ? e.message : 'local failure', (local && e.sendOperation) || sendOperation), code: 1 };
  }
}

// realpath: an installed bin is a symlink, and Node's argv[1] keeps the link path while import.meta.url is the real one.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { out, code } = await main(process.argv.slice(2), process.env);
  // Diagnostics carry only fixed text and the category, never peer strings or values.
  if (typeof out !== 'string' && out.error) process.stderr.write(`poppykit: ${out.operation} ${out.error.category}${code === 2 ? `: ${out.error.message}` : ''}\n`);
  process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out) + '\n', () => process.exit(code));
}
