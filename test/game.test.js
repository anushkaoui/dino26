import test from 'node:test';
import assert from 'node:assert/strict';
import { GameService } from '../server/service.js';
import { RULES, initialState, replay, runScore, decodeRank, rankValue } from '../shared/engine.js';
import { insertOnce } from '../server/store.js';
import { MemoryStore } from './helpers.js';
const secret = 'server-secret-at-least-32-characters-long';
async function fixture() {
  const store = new MemoryStore(); let time = 100000;
  const service = new GameService({ secret, eventKey: 'test', now: () => time });
  await service.schedule(store, { name: 'Test', opensAt: 130000 });
  const join = await service.join(store, { roll: 'ab12cd34', claim: 'a'.repeat(64) });
  const entry = await service.authenticate(store, join.token);
  return { store, service, entry, join, time: t => { time = t; } };
}
test('roll syntax and normalization are enforced on the server', async () => {
  const f = await fixture(); assert.equal(f.join.roll, 'AB12CD34');
  for (const roll of ['123', '１２３４５６７８', 'ABCDEF!1', "ABC'EF12", 12345678, null])
    await assert.rejects(f.service.join(f.store, { roll, claim: 'b'.repeat(64) }), e => e.code === 'BAD_ROLL');
});
test('joining twice and response-loss retry create only one entry; another claim is locked out', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 25 }, () => f.service.join(f.store, { roll: 'ab12cd34', claim: 'a'.repeat(64) })));
  assert.equal((await f.store.entries('test')).length, 1);
  await assert.rejects(f.service.join(f.store, { roll: 'AB12CD34', claim: 'b'.repeat(64) }), e => e.code === 'ROLL_CLAIMED');
});
test('entry race chooses a single browser across independent service instances', async () => {
  const f = await fixture();
  const other = new GameService({ secret, eventKey: 'test', now: () => 100000 });
  const results = await Promise.allSettled([f.service.join(f.store, { roll: 'NEW12345', claim: 'b'.repeat(64) }),
    other.join(f.store, { roll: 'NEW12345', claim: 'c'.repeat(64) })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('scores come from replay; score fields, accelerated, stale and malformed submissions fail', async () => {
  const f = await fixture();
  const request = { seq: 0, endFrame: 120, inputs: [[0, 4], [0, 1]] };
  f.time(131999);
  await assert.rejects(f.service.checkpoint(f.store, f.entry, request), e => e.code === 'TOO_EARLY');
  f.time(132100);
  await assert.rejects(f.service.checkpoint(f.store, f.entry, { ...request, score: 999999 }), e => e.code === 'BAD_BODY');
  for (const inputs of [[[0, 9]], [[12, 1], [1, 1]], [[-1, 1]], [[120, 1]], [[0, 1], [0, 1]]])
    await assert.rejects(f.service.checkpoint(f.store, f.entry, { ...request, inputs }), e => e.code === 'BAD_INPUT');
  const result = await f.service.checkpoint(f.store, f.entry, request);
  assert.deepEqual(result.state, replay(initialState(), 120, request.inputs, result.seed));
  assert.ok(result.state.best > 0 && result.state.best < 1000);
  f.time(150000);
  await assert.rejects(f.service.checkpoint(f.store, f.entry, { seq: 1, endFrame: 240, inputs: [] }), e => e.code === 'STALE_CHECKPOINT');
});
test('checkpoint response loss is retryable even after deadline; changed body cannot replace it', async () => {
  const f = await fixture(); f.time(132100);
  const request = { seq: 0, endFrame: 120, inputs: [[0, 4]] };
  const before = await f.service.checkpoint(f.store, f.entry, request);
  f.time(330000);
  const after = await f.service.checkpoint(f.store, f.entry, request);
  assert.deepEqual(after.state, before.state);
  assert.equal(f.store.tables.get('DinoCheckpoints').size, 1);
  await assert.rejects(f.service.checkpoint(f.store, f.entry, { ...request, inputs: [] }), e => e.code === 'STATE_CHANGED');
});
test('conflicting tabs cannot fork the checkpoint chain across two servers', async () => {
  const f = await fixture(); f.time(132100);
  const other = new GameService({ secret, eventKey: 'test', now: () => 132100 });
  const results = await Promise.allSettled([f.service.checkpoint(f.store, f.entry, { seq: 0, endFrame: 120, inputs: [[0, 4]] }),
    other.checkpoint(f.store, f.entry, { seq: 0, endFrame: 120, inputs: [] })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.store.tables.get('DinoCheckpoints').size, 1);
});
test('refresh and disconnected time retain best but forfeit current run and cannot earn idle points', async () => {
  const f = await fixture(); f.time(132100);
  const before = await f.service.checkpoint(f.store, f.entry, { seq: 0, endFrame: 120, inputs: [[0, 4]] });
  const sameInterval = await f.service.sync(f.store, f.entry, {});
  assert.equal(sameInterval.state.running, false); assert.equal(sameInterval.state.best, before.state.best);
  f.time(150000);
  const resumed = await f.service.sync(f.store, f.entry, {});
  assert.equal(resumed.state.frame, 1200); assert.equal(resumed.state.distance, 0);
  assert.equal(resumed.state.best, before.state.best);
  await assert.rejects(f.service.checkpoint(f.store, f.entry, { seq: resumed.seq + 1, endFrame: 240, inputs: [] }), e => e.code === 'BAD_CHECKPOINT');
});
test('lost browser storage needs organizer recovery; it retains entry and does not reset deadline', async () => {
  const f = await fixture();
  await assert.rejects(f.service.authenticate(f.store, f.join.token + 'bad'), e => e.status === 401);
  await assert.rejects(f.service.recoveryTicket(f.store, { roll: 'AB12CD34', verified: false }), e => e.code === 'VERIFY_FIRST');
  const { ticket } = await f.service.recoveryTicket(f.store, { roll: 'AB12CD34', verified: true });
  const recovery = await f.service.recover(f.store, { ticket });
  assert.equal(recovery.roll, 'AB12CD34'); assert.equal(recovery.event.closesAt, 310000);
  assert.equal((await f.store.entries('test')).length, 1);
  f.time(401000); await assert.rejects(f.service.recover(f.store, { ticket }), e => e.status === 401);
});
test('collision is enforced even when client hides it; a retry retains best', () => {
  const state = replay(initialState(), 400, [[0, 4]], 123);
  assert.equal(state.running, false); assert.ok(state.crashAt > 0);
  const best = state.best;
  const retry = replay(state, 450, [[400, 4], [400, 1]], 123);
  assert.equal(retry.running, true); assert.ok(retry.best >= best); assert.equal(retry.run, 2);
});
test('deterministic replay and integer tie-break rank round-trip', () => {
  const inputs = [[0, 4], [170, 1], [300, 4], [300, 1]];
  const whole = replay(initialState(), 360, inputs, 42);
  const first = replay(initialState(), 240, inputs.filter(i => i[0] < 240), 42);
  const resumed = replay(first, 360, inputs.filter(i => i[0] >= 240), 42);
  assert.deepEqual(whole, resumed);
  assert.deepEqual(decodeRank(rankValue(whole)), { score: whole.best, achievedFrame: whole.bestAt });
});
test('late joiners get only remaining global time; new registrations stop at end', async () => {
  const f = await fixture(); f.time(200100);
  const joined = await f.service.join(f.store, { roll: 'LATE1234', claim: 'b'.repeat(64) });
  assert.equal(joined.state.frame, 4320); assert.equal(joined.event.closesAt, 310000);
  f.time(310000);
  await assert.rejects(f.service.join(f.store, { roll: 'LAST1234', claim: 'c'.repeat(64) }), e => e.code === 'ROUND_OVER');
});
test('500 entries are ranked once each; final snapshot survives interrupted/concurrent finalizers', async () => {
  const f = await fixture();
  for (let i = 0; i < 499; i++) await f.service.join(f.store, { roll: 'P' + String(i).padStart(7, '0'), claim: 'a'.repeat(64) });
  f.time(132100);
  await f.service.checkpoint(f.store, f.entry, { seq: 0, endFrame: 120, inputs: [[0, 4]] });
  assert.equal((await f.service.leaderboard(f.store, true)).rows.length, 500);
  await assert.rejects(f.service.finalize(f.store), e => e.code === 'STILL_SETTLING');
  f.time(346001);
  const insert = f.store.insert.bind(f.store); let failed = false;
  f.store.insert = async (table, row) => {
    if (row.Key.endsWith(':2') && row.Key.includes(':result:') && !failed) { failed = true; throw new Error('process interruption'); }
    return insert(table, row);
  };
  await assert.rejects(f.service.finalize(f.store));
  assert.equal(await f.service.finalResults(f.store), null);
  f.store.insert = insert;
  const other = new GameService({ secret, eventKey: 'test', now: () => 346001 });
  const finals = await Promise.all([f.service.finalize(f.store), other.finalize(f.store)]);
  assert.deepEqual(finals[0], finals[1]); assert.equal(finals[0].rows.length, 500);
  assert.equal(finals[0].rows[0].roll, 'AB12CD34');
});
test('uncertain datastore writes require authoritative readback, never fabricated success', async () => {
  const store = new MemoryStore(), insert = store.insert.bind(store);
  store.insert = async (table, row) => { await insert(table, row); throw new Error('response lost'); };
  const result = await insertOnce(store, 'DinoEvents', { Key: 'one', Payload: '{}' });
  assert.equal(result.row.Key, 'one');
  store.insert = async () => { throw new Error('database down'); };
  await assert.rejects(insertOnce(store, 'DinoEvents', { Key: 'two', Payload: '{}' }), /database down/);
});
