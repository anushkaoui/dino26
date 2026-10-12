import { mkdir, readFile, open, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { rankValue } from '../shared/engine.js';
export const SCHEMA = {
  DinoEvents: { Key: ['varchar', 150], EventKey: ['varchar', 40], Payload: ['text', 10000] },
  DinoEntries: { Key: ['varchar', 150], EventKey: ['varchar', 40], Roll: ['varchar', 8], ClaimHash: ['varchar', 64], Payload: ['text', 10000] },
  DinoCheckpoints: { Key: ['varchar', 150], EventKey: ['varchar', 40], EntryKey: ['varchar', 150], Seq: ['int'], RankValue: ['bigint'], Digest: ['varchar', 64], Payload: ['text', 10000] }
};
// Reject invalid records before sending them to the provider. Never truncate
// audit payloads: a truncated replay record would invalidate prize evidence.
export function validateRecord(table, row) {
  const columns = SCHEMA[table];
  if (!columns) throw new Error('Unknown table');
  for (const [name, [type, size]] of Object.entries(columns)) {
    const value = row[name];
    if (type === 'varchar' || type === 'text') {
      if (typeof value !== 'string' || !value.length || value.length > size)
        throw new Error(`Invalid record: ${table}.${name}`);
    } else if (!Number.isSafeInteger(value) || value < 0 ||
      (type === 'int' && value > 2147483647)) throw new Error(`Invalid record: ${table}.${name}`);
  }
  return row;
}
const tables = ['DinoEvents', 'DinoEntries', 'DinoCheckpoints'];
function identifier(value) {
  if (!/^[A-Za-z0-9_:-]{1,150}$/.test(value)) throw new Error('Invalid datastore key');
  return value;
}
// Only for local development: a single process, fsynced write-ahead journal.
// Production AppSail never uses local disk for durable game state.
export class LocalStore {
  constructor(dir) {
    this.dir = resolve(dir); this.maps = new Map(tables.map(t => [t, new Map()]));
    this.latestIndex = new Map(); this.rankIndex = new Map(); this.queue = []; this.flushing = null;
  }
  index(table, row) {
    this.maps.get(table).set(row.Key, row);
    if (table === 'DinoCheckpoints') {
      const previous = this.latestIndex.get(row.EntryKey);
      if (!previous || row.Seq > previous.Seq) this.latestIndex.set(row.EntryKey, row);
      this.rankIndex.set(row.EntryKey, Math.max(this.rankIndex.get(row.EntryKey) || 0, row.RankValue));
    }
  }
  async init() {
    await mkdir(this.dir, { recursive: true });
    const journal = join(this.dir, 'journal.jsonl');
    let text = '';
    try { text = await readFile(journal, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (text && !text.endsWith('\n')) {
      // A killed process can leave a partial, unacknowledged final append.
      // Preserve those bytes for inspection, then recover the committed prefix.
      const end = text.lastIndexOf('\n') + 1;
      await writeFile(join(this.dir, `uncommitted-tail-${Date.now()}.txt`), text.slice(end), { flag: 'wx', mode: 0o600 });
      const repair = await open(journal, 'r+');
      try { await repair.truncate(Buffer.byteLength(text.slice(0, end))); await repair.sync(); }
      finally { await repair.close(); }
      text = text.slice(0, end);
    }
    // Fail closed on corruption; do not silently lose already acknowledged scores.
    for (const line of text.split('\n').filter(Boolean)) {
      const { table, row } = JSON.parse(line);
      this.index(table, row);
    }
    this.handle = await open(journal, 'a', 0o600);
    return this;
  }
  async insert(table, row) {
    if (this.fault) throw this.fault;
    if (this.closed || !this.maps.has(table)) throw new Error('Store is closed or table is invalid');
    const result = new Promise((resolve, reject) => this.queue.push({ table, row: structuredClone(row), resolve, reject }));
    if (!this.flushing) this.flushing = this.flush();
    return result;
  }
  async flush() {
    // Group concurrent appends into one fsync. Every success still waits for
    // its complete batch to be durable; reads never expose uncommitted rows.
    while (this.queue.length) {
      await new Promise(r => setTimeout(r, 5));
      const batch = this.queue.splice(0), accepted = [], seen = new Set();
      for (const item of batch) {
        const key = `${item.table}:${item.row.Key}`;
        if (seen.has(key) || this.maps.get(item.table).has(item.row.Key)) item.reject(new Error('Duplicate key'));
        else { seen.add(key); accepted.push(item); }
      }
      try {
        if (accepted.length) {
          await this.handle.writeFile(accepted.map(({ table, row }) => JSON.stringify({ table, row }) + '\n').join(''));
          await this.handle.sync();
          for (const item of accepted) { this.index(item.table, item.row); item.resolve(structuredClone(item.row)); }
        }
      } catch (error) {
        this.fault = error;
        for (const item of [...accepted, ...this.queue.splice(0)]) item.reject(error);
      }
    }
    this.flushing = null;
  }
  async idle() { while (this.flushing) await this.flushing; if (this.fault) throw this.fault; }
  async get(table, key) { await this.idle(); return structuredClone(this.maps.get(table).get(key) || null); }
  async latest(entryKey) {
    await this.idle();
    return structuredClone(this.latestIndex.get(entryKey) || null);
  }
  async entries(eventKey) {
    await this.idle();
    return [...this.maps.get('DinoEntries').values()].filter(r => r.EventKey === eventKey).map(r => structuredClone(r));
  }
  async ranks(eventKey) {
    await this.idle();
    const result = new Map();
    for (const [key, value] of this.rankIndex) if (key.startsWith(eventKey + ':')) result.set(key, value);
    return result;
  }
  async audit(entryKey, afterSeq = -1) {
    await this.idle();
    return [...this.maps.get('DinoCheckpoints').values()].filter(r => r.EntryKey === entryKey && r.Seq > afterSeq)
      .sort((a, b) => a.Seq - b.Seq).slice(0, 300).map(r => structuredClone(r));
  }
  async archivePage(table, eventKey, after = '') {
    await this.idle();
    return [...this.maps.get(table).values()].filter(r => r.EventKey === eventKey && r.Key > after)
      .sort((a, b) => a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0).slice(0, 300).map(r => structuredClone(r));
  }
  async close() { this.closed = true; await this.idle(); await this.handle.close(); }
}
export class CatalystStore {
  constructor(datastore) { this.db = datastore; }
  async validateSchema() {
    for (const [table, columns] of Object.entries(SCHEMA)) {
      const metadata = await this.db.table(table).getAllColumns();
      for (const [name, [type, size]] of Object.entries(columns)) {
        const col = metadata.find(c => c.column_name === name);
        if (!col || col.data_type.toLowerCase().replace(/[ _-]/g, '') !== type || !col.is_mandatory ||
          (type === 'varchar' && size && Number(col.max_length) < size) ||
          (type === 'text' && col.max_length != null && Number(col.max_length) > 0 && Number(col.max_length) < size) ||
          !!col.is_unique !== (name === 'Key'))
          throw new Error(`Invalid schema: ${table}.${name}`);
      }
    }
  }
  async query(table, query) {
    const response = await this.db.executeZCQLQuery(query);
    const rows = Array.isArray(response) ? response : response.content;
    if (!Array.isArray(rows)) throw new Error('Unexpected Catalyst query response');
    return rows.map(r => {
      const row = r[table];
      if (!row) throw new Error('Unexpected Catalyst table response');
      return row;
    });
  }
  async insert(table, row) { validateRecord(table, row); return this.db.table(table).insertRow(row); }
  async get(table, key) {
    if (!tables.includes(table)) throw new Error('Unknown table');
    return (await this.query(table, `SELECT * FROM ${table} WHERE Key='${identifier(key)}' LIMIT 1`))[0] || null;
  }
  async latest(entryKey) {
    return (await this.query('DinoCheckpoints', `SELECT * FROM DinoCheckpoints WHERE EntryKey='${identifier(entryKey)}' ORDER BY Seq DESC LIMIT 1`))[0] || null;
  }
  async entries(eventKey) {
    const results = [];
    for (let offset = 1; ; offset += 300) {
      const rows = await this.query('DinoEntries', `SELECT * FROM DinoEntries WHERE EventKey='${identifier(eventKey)}' ORDER BY Key ASC LIMIT ${offset},300`);
      results.push(...rows);
      if (rows.length < 300) return results;
      if (results.length >= 10000) throw new Error('Entry safety limit exceeded');
    }
  }
  async ranks(eventKey) {
    const result = new Map();
    for (let offset = 1; ; offset += 300) {
      const rows = await this.query('DinoCheckpoints', `SELECT EntryKey, MAX(RankValue) FROM DinoCheckpoints WHERE EventKey='${identifier(eventKey)}' GROUP BY EntryKey ORDER BY EntryKey ASC LIMIT ${offset},300`);
      for (const row of rows) {
        const raw = row['MAX(RankValue)'] ?? row.RankValue;
        const value = Number(raw);
        if (raw == null || !Number.isSafeInteger(value) || value < 0) throw new Error('Unexpected Catalyst aggregate response');
        result.set(row.EntryKey, value);
      }
      if (rows.length < 300) return result;
      if (result.size >= 10000) throw new Error('Rank safety limit exceeded');
    }
  }
  async audit(entryKey, afterSeq = -1) {
    return this.query('DinoCheckpoints', `SELECT * FROM DinoCheckpoints WHERE EntryKey='${identifier(entryKey)}' AND Seq>${Number(afterSeq)} ORDER BY Seq ASC LIMIT 300`);
  }
  async archivePage(table, eventKey, after = '') {
    if (!tables.includes(table)) throw new Error('Unknown table');
    const cursor = after ? ` AND Key>'${identifier(after)}'` : '';
    return this.query(table, `SELECT * FROM ${table} WHERE EventKey='${identifier(eventKey)}'${cursor} ORDER BY Key ASC LIMIT 300`);
  }
}
// On any uncertain insert error, read the unique key. Only that read can establish
// that a write happened. Database outage stays an error and is safe to retry.
export async function insertOnce(store, table, row) {
  try { await store.insert(table, row); return { row, inserted: true }; }
  catch (error) {
    const existing = await store.get(table, row.Key);
    if (!existing) throw error;
    return { row: existing, inserted: false };
  }
}
export function checkpointRow(event, entry, seq, digest, kind, inputs, state, acceptedAt) {
  return { Key: `${entry.Key}:${seq}`, EventKey: event.Key, EntryKey: entry.Key, Seq: seq,
    RankValue: rankValue(state), Digest: digest,
    Payload: JSON.stringify({ version: 1, kind, inputs, state, acceptedAt }) };
}
