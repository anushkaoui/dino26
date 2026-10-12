// Read-only backup. ADMIN_KEY comes from the environment, never a command argument.
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { SCHEMA } from '../server/store.js';
const base = process.env.EXPORT_URL?.replace(/\/$/, '');
const key = process.env.ADMIN_KEY;
const room = process.env.EXPORT_ROOM;
if (!base || !key) throw new Error('Set EXPORT_URL and ADMIN_KEY. For local use: EXPORT_URL=http://localhost:3000 node --env-file=.env scripts/export.js');
const dir = resolve(process.env.EXPORT_DIR || 'exports');
await mkdir(dir, { recursive: true });
async function get(path) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const url = new URL(base + path);
      if (room) url.searchParams.set('room', room);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(25000) });
      if (!response.ok) {
        const body = await response.json();
        const error = new Error(body.message || `Export failed (${response.status})`);
        if (response.status < 500 && response.status !== 429) { error.fatal = true; throw error; }
        throw error;
      }
      return response;
    } catch (error) { if (error.fatal) throw error; last = error; await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}
const event = await (await get('/api/event')).json();
const board = await (await get('/api/leaderboard')).json();
const prefix = join(dir, `${event.id}-${Date.now()}`), partial = prefix + '.jsonl.partial';
const handle = await open(partial, 'wx', 0o600);
const digest = createHash('sha256'), counts = {}, beganAt = Date.now();
async function line(value) {
  const text = JSON.stringify(value) + '\n';
  await handle.writeFile(text); await handle.sync(); digest.update(text);
}
try {
  await line({ kind: 'header', version: 1, event: event.id, beganAt, final: !!board.final });
  for (const table of Object.keys(SCHEMA)) {
    let after = ''; counts[table] = 0;
    do {
      const page = await (await get(`/api/admin/archive?table=${table}&after=${encodeURIComponent(after)}`)).json();
      if (createHash('sha256').update(JSON.stringify(page.rows)).digest('hex') !== page.digest) throw new Error('Archive page checksum mismatch');
      if (page.event.id !== event.id || page.table !== table || page.rows.length > 300) throw new Error('Archive identity mismatch');
      await line({ kind: 'page', ...page }); counts[table] += page.rows.length;
      if (page.next && page.next <= after) throw new Error('Archive cursor did not advance');
      after = page.next;
    } while (after);
    console.log(`${table}: ${counts[table]} rows copied`);
  }
  await line({ kind: 'complete', counts, endedAt: Date.now(), finalAtStart: !!board.final });
  await handle.close();
  await rename(partial, prefix + '.jsonl');
  await writeFile(prefix + '.sha256', `${digest.digest('hex')}  ${prefix.split('/').at(-1)}.jsonl\n`, { flag: 'wx', mode: 0o600 });
  const csv = await (await get(board.final ? '/api/admin/export' : '/api/admin/live-export')).text();
  await writeFile(prefix + (board.final ? '.final.csv' : '.provisional.csv'), csv, { flag: 'wx', mode: 0o600 });
  console.log(`Backup saved: ${prefix}.jsonl. Run node scripts/verify-export.js on it.`);
  if (!board.final) console.log('This was a live/provisional export. Repeat after freezing results for the prize archive.');
} catch (error) {
  await handle.close().catch(() => {});
  throw new Error(`${error.message}. Partial backup remains at ${partial}; rerun to create a fresh complete backup. Source records were not modified.`);
}
