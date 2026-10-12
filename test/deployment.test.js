import test from 'node:test';
import assert from 'node:assert/strict';
import { deployArgs } from '../scripts/deploy-catalyst.js';
import { SCHEMA, CatalystStore, validateRecord, checkpointRow } from '../server/store.js';
import { GameService } from '../server/service.js';
import { MemoryStore } from './helpers.js';
import { initialState, replay, rankValue, rulesFor } from '../shared/engine.js';
import { readFile } from 'node:fs/promises';

test('deployment requires explicit existing targets and never passes credentials in arguments', () => {
  const env = { CATALYST_PROJECT_ID: '123', CATALYST_ORG_ID: '456', CATALYST_APP_NAME: 'gdg-dino', CATALYST_TOKEN: 'private-token' };
  const args = deployArgs(env);
  assert.equal(args.includes(env.CATALYST_TOKEN), false);
  assert.deepEqual(args.slice(0, 2), ['deploy', 'appsail']);
  assert.equal(args.at(-1), 'in');
  assert.equal(args.includes('iac:import'), false);
  for (const key of ['CATALYST_PROJECT_ID', 'CATALYST_ORG_ID', 'CATALYST_APP_NAME', 'CATALYST_TOKEN'])
    assert.throws(() => deployArgs({ ...env, [key]: '' }));
});

test('IaC columns match runtime schema exactly, with no direct player permissions', async () => {
  const template = JSON.parse(await readFile('deploy/schema/project-template-1.0.0.json'));
  for (const [table, columns] of Object.entries(SCHEMA)) {
    for (const [name, [type, size]] of Object.entries(columns)) {
      const column = template.components.Datastore.find(c => c.type === 'column' && c.name === `${table}-${name}`);
      assert.equal(column.properties.data_type, type);
      assert.equal(column.properties.is_mandatory, true);
      assert.equal(column.properties.is_unique, name === 'Key');
      if (size) assert.equal(column.properties.max_length, size);
    }
    const permission = template.components.Datastore.find(c => c.type === 'tablePermission' && c.name === `${table}-App User`);
    assert.deepEqual(permission.properties.table_permissions, []);
  }
});

test('provider rejects oversize records before writing; schema rejects unintended uniqueness', async () => {
  let writes = 0;
  const metadata = table => Object.entries(SCHEMA[table]).map(([name, [type, size]]) => ({ column_name: name,
    data_type: type, max_length: size || 0, is_mandatory: true, is_unique: name === 'Key' }));
  const cols = Object.fromEntries(Object.keys(SCHEMA).map(table => [table, metadata(table)]));
  const db = { table: table => ({ getAllColumns: async () => cols[table], insertRow: async row => { writes++; return row; } }) };
  const store = new CatalystStore(db); await store.validateSchema();
  const row = { Key: 'r:AB12CD34', EventKey: 'r', Roll: 'AB12CD34', ClaimHash: 'a'.repeat(64), Payload: '{}' };
  await store.insert('DinoEntries', row);
  for (const [name, value] of [['Key', 'x'.repeat(151)], ['EventKey', 'x'.repeat(41)], ['Roll', 'ABCDEFGHI'],
    ['ClaimHash', 'a'.repeat(65)], ['Payload', 'x'.repeat(10001)]])
    await assert.rejects(store.insert('DinoEntries', { ...row, [name]: value }), /Invalid record/);
  assert.equal(writes, 1);
  cols.DinoEntries.find(c => c.column_name === 'Roll').is_unique = true;
  await assert.rejects(store.validateSchema(), /DinoEntries.Roll/);
  cols.DinoEntries.find(c => c.column_name === 'Roll').is_unique = false;
  cols.DinoEvents.find(c => c.column_name === 'Payload').max_length = 9999;
  await assert.rejects(store.validateSchema(), /DinoEvents.Payload/);
});

test('maximum gameplay payload, longest generated keys and 500-player final pages fit schema', async () => {
  let now = 100000;
  const store = new MemoryStore(), eventKey = 'x'.repeat(40), secret = 'a'.repeat(64);
  const game = new GameService({ secret, eventKey, now: () => now });
  await game.createRoom(store, { name: '\u0001'.repeat(80), minutes: 5 });
  const players = await Promise.all(Array.from({ length: 500 }, async (_, i) => {
    const joined = await game.join(store, { roll: 'P' + String(i).padStart(7, '0'), claim: 'b'.repeat(64) });
    return game.authenticate(store, joined.token);
  }));
  await Promise.all(players.map(entry => game.ready(store, entry, {})));
  const started = await game.startRoom(store, {});
  const rules = rulesFor(5);
  const inputs = Array.from({ length: 80 }, (_, i) => [i, 1 + i % 4]);
  const state = replay(initialState(), 120, inputs, 42);
  const checkpoint = checkpointRow({ Key: eventKey }, players[0], 15000, 'c'.repeat(64), 'play', inputs, state, now);
  validateRecord('DinoCheckpoints', checkpoint);
  const theoreticalMaxScore = Math.floor(rules.totalFrames * 1200 / 1000);
  assert.ok(Number.isSafeInteger(rankValue({ best: theoreticalMaxScore, bestAt: rules.totalFrames })));
  for (const entry of players) await store.insert('DinoCheckpoints', checkpointRow({ Key: eventKey }, entry, 0, 'd'.repeat(64), 'play', [],
    { ...initialState(), best: theoreticalMaxScore, bestAt: rules.totalFrames }, now));
  const issued = await game.recoveryTicket(store, { roll: players[0].Roll, verified: true });
  await game.recover(store, issued);
  now = started.closesAt + 36001;
  const final = await game.finalize(store);
  assert.equal(final.participants, 500);
  for (const [table, rows] of store.tables) for (const row of rows.values()) validateRecord(table, row);
  const restarted = new GameService({ secret, eventKey, now: () => now });
  assert.deepEqual((await restarted.finalResults(store)).rows, final.rows);
});

test('waiting rooms survive service restart, concurrent Start is immutable, and 1–5 minute rounds accept all intervals', async () => {
  for (const minutes of [1, 2, 3, 4, 5]) {
    let now = 100000;
    const store = new MemoryStore(), secret = 'lobby'.repeat(12), eventKey = `minutes-${minutes}`;
    const make = () => new GameService({ secret, eventKey, now: () => now });
    let game = make();
    await game.createRoom(store, { name: 'Practice', minutes });
    const joined = await game.join(store, { roll: 'AB12CD34', claim: 'a'.repeat(64) });
    const entry = await game.authenticate(store, joined.token);
    await game.ready(store, entry, {});
    await assert.rejects(game.checkpoint(store, entry, { seq: 0, endFrame: 120, inputs: [] }), e => e.code === 'WAITING_FOR_START');
    game = make();
    assert.equal((await game.state(store, entry)).ready, true);
    const starts = await Promise.all([game.startRoom(store, {}), make().startRoom(store, {}), make().startRoom(store, {})]);
    assert.ok(starts.every(e => e.opensAt === starts[0].opensAt));
    assert.equal(starts[0].closesAt - starts[0].opensAt, minutes * 60000);
    const chunks = minutes * 30;
    for (let i = 0; i < chunks; i++) {
      now = starts[0].opensAt + (i + 1) * 2000 + 1;
      await game.checkpoint(store, entry, { seq: i, endFrame: (i + 1) * 120, inputs: [[i * 120, 4]] });
    }
    await assert.rejects(game.checkpoint(store, entry, { seq: chunks, endFrame: (chunks + 1) * 120, inputs: [] }), e => e.code === 'BAD_CHECKPOINT');
    const state = await game.state(store, entry);
    game = make();
    assert.deepEqual((await game.state(store, entry)).state, state.state);
    assert.equal((await game.startRoom(store, {})).opensAt, starts[0].opensAt);
  }
});
