import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../server/store.js';
import { GameService } from '../server/service.js';

const secret = 'crash-test-only-'.repeat(4);
test('SIGKILL after acknowledgement preserves scores, raw inputs, entry claim and final snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gdg-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const code = `import { LocalStore } from './server/store.js';
import { GameService } from './server/service.js';
const store = await new LocalStore(process.argv[1]).init(); let now = 100000;
const game = new GameService({ secret: ${JSON.stringify(secret)}, eventKey: 'crash', now: () => now });
await game.schedule(store, { opensAt: 130000, name: 'Disposable crash fixture' });
const joined = await game.join(store, { roll: 'KILL1234', claim: 'a'.repeat(64) });
const entry = await game.authenticate(store, joined.token); now = 132100;
const saved = await game.checkpoint(store, entry, { seq: 0, endFrame: 120, inputs: [[0,4]] });
now = 346001; const final = await game.finalize(store);
process.stdout.write(JSON.stringify({ saved, final }) + '\\n');
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const result = await Promise.race([
    new Promise((resolve, reject) => { let output = ''; child.stdout.on('data', b => {
      output += b; if (output.includes('\n')) { try { resolve(JSON.parse(output.split('\n')[0])); } catch (e) { reject(e); } }
    }); child.once('exit', () => reject(new Error('Fixture exited before acknowledgement: ' + stderr))); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Crash fixture timeout')), 15000); timer.unref(); })
  ]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  // Simulate an incomplete final write from an interrupted, unacknowledged request.
  await appendFile(join(dir, 'journal.jsonl'), '{"table":"DinoCheckpoints","row":');
  const store = await new LocalStore(dir).init(); t.after(() => store.close());
  const restarted = new GameService({ secret, eventKey: 'crash', now: () => 346002 });
  const joined = await restarted.join(store, { roll: 'KILL1234', claim: 'a'.repeat(64) });
  assert.deepEqual(joined.state, result.saved.state);
  assert.deepEqual((await restarted.finalResults(store)).rows, result.final.rows);
  assert.deepEqual(JSON.parse((await store.audit('crash:KILL1234'))[0].Payload).inputs, [[0, 4]]);
  assert.ok((await readdir(dir)).some(name => name.startsWith('uncommitted-tail-')));
});

test('500 concurrent journal writes acknowledge only durable batches and reject duplicate keys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gdg-batch-'));
  const store = await new LocalStore(dir).init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await Promise.all(Array.from({ length: 500 }, (_, i) => store.insert('DinoEntries', {
    Key: `batch:P${String(i).padStart(7, '0')}`, EventKey: 'batch', Roll: `P${String(i).padStart(7, '0')}`, Payload: '{}'
  })));
  const copies = await Promise.allSettled(Array.from({ length: 20 }, () => store.insert('DinoEvents', { Key: 'batch', EventKey: 'batch', Payload: '{}' })));
  assert.equal(copies.filter(r => r.status === 'fulfilled').length, 1);
  const reopened = await new LocalStore(dir).init();
  assert.equal((await reopened.entries('batch')).length, 500); await reopened.close();
});
