import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalystStore } from '../server/store.js';
test('Catalyst adapter paginates past 300 and validates aggregate shape', async () => {
  const queries = [];
  const db = { async executeZCQLQuery(query) {
    queries.push(query);
    const offset = Number(query.match(/LIMIT (\d+),300/)[1]);
    const table = query.includes('DinoEntries') ? 'DinoEntries' : 'DinoCheckpoints';
    const n = offset === 1 ? 300 : 200;
    return Array.from({ length: n }, (_, i) => ({ [table]: table === 'DinoEntries' ?
      { Key: `test:P${String(offset + i).padStart(7, '0')}`, Roll: `P${String(offset + i).padStart(7, '0')}` } :
      { EntryKey: `test:P${String(offset + i).padStart(7, '0')}`, 'MAX(RankValue)': String(i * 20000) } }));
  } };
  const store = new CatalystStore(db);
  assert.equal((await store.entries('test')).length, 500);
  assert.equal((await store.ranks('test')).size, 500);
  assert.equal(queries.filter(q => q.includes('LIMIT 301,300')).length, 2);
  await assert.rejects(store.get('DinoEntries', "test:' OR 1=1"), /Invalid datastore key/);
  db.executeZCQLQuery = async () => [{ DinoCheckpoints: { EntryKey: 'test:X1234567' } }];
  await assert.rejects(store.ranks('test'), /Unexpected Catalyst aggregate response/);
});
test('pinned official Catalyst SDK initializes an AppSail request with isolated admin credentials', async () => {
  const { zcAuth } = await import('@zcatalyst/auth');
  const { Datastore } = await import('@zcatalyst/datastore');
  const headers = { 'x-zc-projectid': '123456', 'x-zc-projectkey': 'test',
    'x-zc-projectdomain': 'example.catalystserverless.in', 'x-zc-admin-cred-type': 'token',
    'x-zc-admin-cred-token': 'test-admin-token', 'x-zc-user-type': 'admin' };
  const app = await zcAuth.init({ headers }, { scope: 'admin' });
  assert.equal(app.config.projectId, '123456');
  assert.equal((await app.credential.getToken()).access_token, 'test-admin-token');
  const store = new Datastore(app);
  assert.equal(typeof store.executeZCQLQuery, 'function');
  assert.equal(typeof store.table('DinoEntries').insertRow, 'function');
});

test('Catalyst startup refuses a schema without required unique keys or adequate column sizes', async () => {
  const { SCHEMA } = await import('../server/store.js');
  const metadata = Object.fromEntries(Object.entries(SCHEMA).map(([table, cols]) => [table,
    Object.entries(cols).map(([name, [type, size]]) => ({ column_name: name, data_type: type,
      max_length: String(size || 0), is_mandatory: true, is_unique: name === 'Key' }))]));
  const db = { table: name => ({ getAllColumns: async () => metadata[name] }) };
  const store = new CatalystStore(db); await store.validateSchema();
  metadata.DinoCheckpoints[0].is_unique = false;
  await assert.rejects(store.validateSchema(), /DinoCheckpoints.Key/);
  metadata.DinoCheckpoints[0].is_unique = true;
  metadata.DinoEntries.find(c => c.column_name === 'Roll').max_length = '7';
  await assert.rejects(store.validateSchema(), /DinoEntries.Roll/);
});
