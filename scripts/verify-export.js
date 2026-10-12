import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { hash } from '../server/security.js';
import { RULES as DEFAULT_RULES, rulesFor, initialState, replay, rankValue, decodeRank } from '../shared/engine.js';
const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/verify-export.js exports/round.jsonl');
const tables = new Map(['DinoEvents', 'DinoEntries', 'DinoCheckpoints'].map(t => [t, new Map()]));
let header, complete, counts = Object.fromEntries([...tables.keys()].map(t => [t, 0]));
for await (const text of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
  const item = JSON.parse(text);
  assert.ok(!complete, 'Data follows completion marker');
  if (item.kind === 'header') { assert.ok(!header); assert.equal(item.version, 1); header = item; }
  else if (item.kind === 'page') {
    assert.ok(header && tables.has(item.table)); assert.equal(item.event.id, header.event);
    assert.equal(hash(JSON.stringify(item.rows)), item.digest, 'Page checksum mismatch');
    for (const row of item.rows) {
      assert.equal(row.EventKey, header.event); assert.ok(!tables.get(item.table).has(row.Key), 'Duplicate row');
      tables.get(item.table).set(row.Key, row); counts[item.table]++;
    }
  } else if (item.kind === 'complete') complete = item;
  else throw new Error('Unknown archive record');
}
assert.ok(header && complete, 'Incomplete archive'); assert.deepEqual(counts, complete.counts);
const eventRow = tables.get('DinoEvents').get(header.event);
if (!eventRow) { assert.equal(counts.DinoEntries + counts.DinoCheckpoints, 0); console.log('Verified empty, unscheduled archive.'); process.exit(0); }
const event = JSON.parse(eventRow.Payload), ranks = new Map(), chains = new Map();
const RULES = rulesFor((event.durationMs ?? event.closesAt - event.opensAt) / 60000);
const start = tables.get('DinoEvents').get(`${header.event}:start`);
if (start) Object.assign(event, JSON.parse(start.Payload));
assert.equal(event.version, RULES.version);
if (event.opensAt != null) assert.equal(event.closesAt - event.opensAt, RULES.durationMs);
for (const row of tables.get('DinoCheckpoints').values()) {
  if (!chains.has(row.EntryKey)) chains.set(row.EntryKey, []);
  chains.get(row.EntryKey).push(row);
}
for (const entry of tables.get('DinoEntries').values()) {
  let state = initialState(JSON.parse(entry.Payload).initialFrame), seq = -1;
  for (const row of (chains.get(entry.Key) || []).sort((a, b) => Number(a.Seq) - Number(b.Seq))) {
    assert.equal(Number(row.Seq), ++seq, 'Checkpoint sequence gap');
    const payload = JSON.parse(row.Payload); assert.equal(payload.version, RULES.version);
    if (payload.kind === 'play') {
      assert.equal(payload.state.frame, state.frame + RULES.chunkFrames);
      assert.equal(row.Digest, hash(JSON.stringify({ seq, endFrame: payload.state.frame, inputs: payload.inputs })));
      assert.deepEqual(replay(state, payload.state.frame, payload.inputs, event.seed), payload.state, 'Authoritative replay mismatch');
    } else {
      assert.equal(payload.kind, 'sync'); assert.ok(payload.state.frame >= state.frame);
      const end = Math.floor(Math.max(0, Math.min(RULES.totalFrames, Math.floor((payload.acceptedAt - event.opensAt) * RULES.hz / 1000))) / RULES.chunkFrames) * RULES.chunkFrames;
      assert.equal(row.Digest, hash(JSON.stringify({ kind: 'sync', seq, end })));
      assert.deepEqual(payload.state, { ...initialState(Math.max(end, state.frame)), best: state.best,
        bestAt: state.bestAt, run: state.run, crashAt: Math.max(end, state.frame) - 30 });
    }
    state = payload.state;
    assert.equal(Number(row.RankValue), rankValue(state), 'Stored rank mismatch');
    ranks.set(entry.Key, Math.max(ranks.get(entry.Key) || 0, Number(row.RankValue)));
  }
  chains.delete(entry.Key);
}
assert.equal(chains.size, 0, 'Checkpoint without registration');
const rows = [...tables.get('DinoEntries').values()].map(entry => ({ roll: entry.Roll, value: ranks.get(entry.Key) || 0 }))
  .sort((a, b) => b.value - a.value || a.roll.localeCompare(b.roll, 'en'))
  .map((r, i) => ({ rank: i + 1, roll: r.roll, ...decodeRank(r.value) }));
const manifestRow = tables.get('DinoEvents').get(`${header.event}:final`);
if (manifestRow) {
  const manifest = JSON.parse(manifestRow.Payload), finalRows = [];
  for (let i = 0; i < manifest.pages; i++) {
    const page = tables.get('DinoEvents').get(`${header.event}:result:${manifest.snapshot}:${i}`);
    assert.ok(page, 'Missing final result page'); finalRows.push(...JSON.parse(page.Payload));
  }
  assert.equal(hash(JSON.stringify(finalRows)), manifest.digest, 'Final snapshot checksum mismatch');
  assert.deepEqual(rows, finalRows, 'Reconstructed leaderboard differs from final snapshot');
}
console.log(`Verified ${counts.DinoEntries} entries and ${counts.DinoCheckpoints} checkpoints; ${manifestRow ? 'frozen leaderboard matches replay' : 'provisional archive'}.`);
