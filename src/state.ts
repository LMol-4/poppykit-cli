import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CliFailure } from './secrets.js';
export interface Profile { id: string; name: string; provider: string; domain: string; installationId: string; clientId?: string; callbackUrl?: string; credentialRef?: string; connectionId?: string }
export class State {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path); this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS cli_records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));');
  }
  close() { this.db.close(); }
  get<T>(kind: string, id: string): T | undefined { const row = this.db.prepare('SELECT body FROM cli_records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.body as string) : undefined; }
  put(kind: string, id: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO cli_records VALUES (?,?,?)').run(kind, id, JSON.stringify(value)); }
  remove(kind: string, id: string) { this.db.prepare('DELETE FROM cli_records WHERE kind=? AND id=?').run(kind, id); }
  list<T>(kind: string): { id: string; value: T }[] { return this.db.prepare('SELECT id,body FROM cli_records WHERE kind=? ORDER BY id LIMIT 1000').all(kind).map(row => ({ id: row.id as string, value: JSON.parse(row.body as string) })); }
  atomic<T>(action: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = action(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  profile(name?: string): Profile {
    const rows = this.list<Profile>('profile'); const found = name ? rows.find(row => row.id === name)?.value : rows.length === 1 ? rows[0]?.value : undefined;
    if (!found) throw new CliFailure('select_profile_with_--profile', 2); return found;
  }
  createProfile(name: string, provider: string, domain: string) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new CliFailure('invalid_profile_name', 2);
    return this.atomic(() => { if (this.get('profile', name)) throw new CliFailure('profile_exists', 5); const row = { id: randomUUID(), name, provider, domain, installationId: randomUUID() }; this.put('profile', name, row); return row; });
  }
  update(profile: Profile, change: Partial<Profile>) {
    return this.atomic(() => { const current = this.get<Profile>('profile', profile.name); if (current?.id !== profile.id) throw new CliFailure('profile_changed', 5); const result = { ...current, ...change }; this.put('profile', profile.name, result); return result; });
  }
  prepareRetry(id: string, binding: unknown, payload?: unknown): any {
    return this.atomic(() => {
      const current = this.get<any>('retry', id);
      if (current) { if (JSON.stringify(current.binding) !== JSON.stringify(binding) || (payload !== undefined && JSON.stringify(current.payload) !== JSON.stringify(payload))) throw new CliFailure('retry_binding_conflict', 5); return current; }
      if (payload === undefined) throw new CliFailure('unknown_retry', 2);
      if (this.list('retry').length >= 1000) throw new CliFailure('retry_retention_limit_remove_old_records', 5);
      const row = { binding, payload, messageId: `msg_${randomUUID().replaceAll('-', '')}`, createdAt: Date.now() }; this.put('retry', id, row); return row;
    });
  }
}
