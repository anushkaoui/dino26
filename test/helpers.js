export class MemoryStore {
  constructor() { this.tables = new Map(['DinoEvents', 'DinoEntries', 'DinoCheckpoints'].map(t => [t, new Map()])); }
  async insert(table, row) {
    await Promise.resolve();
    if (this.tables.get(table).has(row.Key)) throw new Error('duplicate');
    this.tables.get(table).set(row.Key, structuredClone(row)); return row;
  }
  async get(table, key) { return structuredClone(this.tables.get(table).get(key) || null); }
  async latest(key) {
    return [...this.tables.get('DinoCheckpoints').values()].filter(r => r.EntryKey === key)
      .sort((a, b) => b.Seq - a.Seq).map(r => structuredClone(r))[0] || null;
  }
  async entries(eventKey) { return [...this.tables.get('DinoEntries').values()].filter(r => r.EventKey === eventKey); }
  async ranks(eventKey) {
    const ranks = new Map();
    for (const row of this.tables.get('DinoCheckpoints').values()) if (row.EventKey === eventKey)
      ranks.set(row.EntryKey, Math.max(ranks.get(row.EntryKey) || 0, row.RankValue));
    return ranks;
  }
  async audit(key, after = -1) { return [...this.tables.get('DinoCheckpoints').values()].filter(r => r.EntryKey === key && r.Seq > after).slice(0, 300); }
  async archivePage(table, eventKey, after = '') {
    return [...this.tables.get(table).values()].filter(r => r.EventKey === eventKey && r.Key > after)
      .sort((a, b) => a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0).slice(0, 300).map(r => structuredClone(r));
  }
}
