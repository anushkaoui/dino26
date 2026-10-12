import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { MemoryStore } from './helpers.js';
import { GameService } from '../server/service.js';
import { createApp } from '../server/http.js';
const execute = promisify(execFile);
test('full HTTP audit exports 500 registrations and 450 checkpoints; offline replay verifies final results and detects corruption', async t => {
  const store = new MemoryStore(); let now = 100000;
  const game = new GameService({ secret: 'archive-secret-'.repeat(4), eventKey: 'archive', now: () => now });
  await game.schedule(store, { opensAt: 130000, name: 'Disposable archive fixture' });
  const players = await Promise.all(Array.from({ length: 500 }, async (_, i) => {
    const roll = 'E' + String(i).padStart(7, '0');
    const joined = await game.join(store, { roll, claim: 'a'.repeat(64) });
    return game.authenticate(store, joined.token);
  }));
  for (let chunk = 0; chunk < 90; chunk++) {
    now = 130000 + (chunk + 1) * 2000 + 10;
    for (const entry of players.slice(0, 5)) await game.checkpoint(store, entry, {
      seq: chunk, endFrame: (chunk + 1) * 120, inputs: [[chunk * 120, 4]]
    });
  }
  const ticket = await game.recoveryTicket(store, { roll: players[0].Roll, verified: true });
  await game.recover(store, ticket); await game.recover(store, ticket); // idempotent redemption log
  now = 346001; await game.finalize(store);
  const adminKey = 'archive-admin-'.repeat(4);
  const server = createApp({ service: game, adminKey, origin: 'http://localhost', storeForRequest: async () => store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${adminKey}` };
  assert.equal((await fetch(base + '/api/admin/archive?table=DinoEntries')).status, 401);
  assert.equal((await fetch(base + '/api/admin/archive?table=DinoEntries&after=other:123', { headers })).status, 400);
  const dir = await mkdtemp(join(tmpdir(), 'gdg-archive-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const backup = await execute(process.execPath, ['scripts/export.js'], { env: {
    ...process.env, EXPORT_URL: base, ADMIN_KEY: adminKey, EXPORT_DIR: dir
  } });
  assert.match(backup.stdout, /500 rows copied/);
  const backupPath = join(dir, (await readdir(dir)).find(name => name.endsWith('.jsonl')));
  assert.match((await execute(process.execPath, ['scripts/verify-export.js', backupPath])).stdout, /frozen leaderboard matches replay/);
  assert.match(await readFile(join(dir, (await readdir(dir)).find(name => name.endsWith('.final.csv'))), 'utf8'), /E0000000/);
  const lines = [JSON.stringify({ kind: 'header', version: 1, event: 'archive', final: true })], counts = {};
  for (const table of ['DinoEvents', 'DinoEntries', 'DinoCheckpoints']) {
    counts[table] = 0; let after = '';
    do {
      const response = await fetch(`${base}/api/admin/archive?table=${table}&after=${encodeURIComponent(after)}`, { headers });
      assert.equal(response.status, 200); const page = await response.json();
      assert.equal(page.final, true); counts[table] += page.rows.length;
      lines.push(JSON.stringify({ kind: 'page', ...page })); after = page.next;
    } while (after);
  }
  assert.equal(counts.DinoEntries, 500); assert.equal(counts.DinoCheckpoints, 450);
  assert.equal(counts.DinoEvents, 9); // event, 2 recovery logs, 5 final pages, manifest
  lines.push(JSON.stringify({ kind: 'complete', counts }));
  const path = join(dir, 'audit.jsonl'); await writeFile(path, lines.join('\n') + '\n');
  const checked = await execute(process.execPath, ['scripts/verify-export.js', path]);
  assert.match(checked.stdout, /frozen leaderboard matches replay/);
  const page = JSON.parse(lines.find(text => text.includes('DinoCheckpoints')));
  page.rows[0].RankValue = 999999;
  const tampered = lines.map(text => text.includes('"table":"DinoCheckpoints"') ? JSON.stringify(page) : text);
  await writeFile(path, tampered.join('\n') + '\n');
  await assert.rejects(execute(process.execPath, ['scripts/verify-export.js', path]), /Page checksum mismatch/);
});
