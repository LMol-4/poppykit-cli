import { randomUUID } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Publish complete immutable metadata without replacing another process's winner. */
export async function publishReference(directory: string, name: string, ref: string): Promise<boolean> {
  const temporary = join(directory, name + '-' + randomUUID() + '.tmp');
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(ref, 'utf8'); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, join(directory, name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
}
