import { randomBytes } from 'node:crypto';
import { RULES, rulesFor, initialState, replay, decodeRank } from '../shared/engine.js';
import { HttpError, requireThat, exactKeys } from './errors.js';
import { hash, equal, normalizeRoll, sign, verify, Limiter } from './security.js';
import { checkpointRow, insertOnce } from './store.js';

const eventRules = event => rulesFor((event?.durationMs ?? (event?.closesAt - event?.opensAt || RULES.durationMs)) / 60000);
const frameAt = (event, now) => event.opensAt == null ? 0 : Math.max(0, Math.min(eventRules(event).totalFrames,
  Math.floor((now - event.opensAt) * RULES.hz / 1000)));
const boundaryAt = (event, now) => Math.floor(frameAt(event, now) / RULES.chunkFrames) * RULES.chunkFrames;
export class GameService {
  constructor({ secret, eventKey, now = Date.now }) {
    this.secret = secret; this.eventKey = eventKey; this.now = now;
    this.eventCache = null; this.boardCache = null; this.boardPending = null; this.limiter = new Limiter();
    this.readyEntries = new Set();
  }
  async event(store) {
    if (this.eventCache?.opensAt != null) return this.eventCache;
    if (this.eventPending) return this.eventPending;
    if (this.eventCache && this.now() - this.eventCheckedAt < 500) return this.eventCache;
    this.eventPending = this.readEvent(store);
    try { return await this.eventPending; } finally { this.eventPending = null; }
  }
  async readEvent(store) {
    const row = this.eventCache ? null : await store.get('DinoEvents', this.eventKey);
    if (!row && !this.eventCache) return null;
    const event = row ? { Key: row.Key, ...JSON.parse(row.Payload) } : { ...this.eventCache };
    const duration = event.durationMs ?? event.closesAt - event.opensAt;
    requireThat(event.version === RULES.version && Number.isInteger(duration / 60000) && duration >= 60000 && duration <= 300000,
      503, 'RULE_MISMATCH', 'This round needs organizer attention.');
    event.durationMs = duration;
    if (event.opensAt == null) {
      const started = await store.get('DinoEvents', `${this.eventKey}:start`);
      if (started) Object.assign(event, JSON.parse(started.Payload));
    }
    requireThat(event.opensAt == null || Number.isSafeInteger(event.opensAt) && event.closesAt - event.opensAt === duration,
      503, 'RULE_MISMATCH', 'This round needs organizer attention.');
    this.eventCache = event; this.eventCheckedAt = this.now();
    return event;
  }
  async createRoom(store, body) {
    exactKeys(body, ['name', 'minutes']);
    requireThat(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 80,
      400, 'BAD_NAME', 'Give the competition a name of up to 80 characters.');
    requireThat(Number.isInteger(body.minutes) && body.minutes >= 1 && body.minutes <= 5,
      400, 'BAD_DURATION', 'Choose 1–5 whole minutes.');
    const payload = { version: RULES.version, name: body.name.trim(), durationMs: body.minutes * 60000,
      createdAt: this.now(), opensAt: null, closesAt: null, seed: randomBytes(4).readUInt32LE() };
    const result = await insertOnce(store, 'DinoEvents', { Key: this.eventKey, EventKey: this.eventKey, Payload: JSON.stringify(payload) });
    const existing = JSON.parse(result.row.Payload);
    requireThat(existing.name === payload.name && existing.durationMs === payload.durationMs,
      409, 'ROOM_EXISTS', 'This competition already exists. Create another competition for different settings.');
    this.eventCache = null;
    return this.publicEvent(await this.event(store));
  }
  async startRoom(store, body) {
    exactKeys(body, []);
    const event = await this.mustEvent(store);
    const original = JSON.parse((await store.get('DinoEvents', this.eventKey)).Payload);
    requireThat(original.opensAt == null, 409, 'ALREADY_SCHEDULED', 'This legacy round already has a fixed start.');
    // One immutable key chooses the same start across instances and retries.
    const opensAt = this.now() + 3000;
    const result = await insertOnce(store, 'DinoEvents', { Key: `${event.Key}:start`, EventKey: event.Key,
      Payload: JSON.stringify({ version: RULES.version, kind: 'start', clickedAt: this.now(), opensAt,
        closesAt: opensAt + event.durationMs }) });
    this.eventCache = { ...event, ...JSON.parse(result.row.Payload) };
    return this.publicEvent(this.eventCache);
  }
  async ready(store, entry, body) {
    exactKeys(body, []);
    const event = await this.mustEvent(store);
    requireThat(event.closesAt == null || this.now() < event.closesAt, 410, 'ROUND_OVER', 'The round has ended.');
    await insertOnce(store, 'DinoEvents', { Key: `${event.Key}:ready:${entry.Roll}`, EventKey: event.Key,
      Payload: JSON.stringify({ version: RULES.version, kind: 'ready', roll: entry.Roll, at: this.now() }) });
    this.readyEntries.add(entry.Key);
    this.lobbyCache = null;
    return { ready: true, event: this.publicEvent(event) };
  }
  async lobby(store) {
    const event = await this.mustEvent(store);
    if (this.lobbyCache && this.now() - this.lobbyCache.at < 2000) return { ...this.lobbyCache, event: this.publicEvent(event) };
    const entries = await store.entries(event.Key), ready = new Set();
    let after = '';
    do {
      const rows = await store.archivePage('DinoEvents', event.Key, after);
      for (const row of rows) if (row.Key.startsWith(`${event.Key}:ready:`)) ready.add(row.Key.slice(`${event.Key}:ready:`.length));
      after = rows.length === 300 ? rows.at(-1).Key : null;
    } while (after);
    this.lobbyCache = { at: this.now(), registered: entries.length, ready: entries.filter(e => ready.has(e.Roll)).length };
    return { ...this.lobbyCache, event: this.publicEvent(event) };
  }
  publicEvent(event) {
    const now = this.now();
    return { id: this.eventKey, name: event?.name || 'GDG Dino Run', opensAt: event?.opensAt ?? null,
      closesAt: event?.closesAt ?? null, serverNow: now, rules: eventRules(event),
      status: !event ? 'unscheduled' : event.opensAt == null ? 'lobby' : now < event.opensAt ? 'waiting' : now < event.closesAt ? 'live' :
        now <= event.closesAt + RULES.lateMs ? 'settling' : 'closed' };
  }
  async schedule(store, body) {
    exactKeys(body, ['opensAt', 'name']);
    const opensAt = Number(body.opensAt), now = this.now();
    requireThat(Number.isSafeInteger(opensAt) && opensAt >= now + 30000 && opensAt < now + 30 * 86400000,
      400, 'BAD_START', 'Schedule at least 30 seconds ahead and within 30 days.');
    requireThat(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 80,
      400, 'BAD_NAME', 'Give the round a name of up to 80 characters.');
    const payload = { version: RULES.version, name: body.name.trim(), opensAt,
      closesAt: opensAt + RULES.durationMs, seed: randomBytes(4).readUInt32LE() };
    const result = await insertOnce(store, 'DinoEvents', { Key: this.eventKey, EventKey: this.eventKey, Payload: JSON.stringify(payload) });
    requireThat(result.inserted || JSON.parse(result.row.Payload).opensAt === opensAt,
      409, 'ALREADY_SCHEDULED', 'This round already has a fixed start. Use a new EVENT_ID for another round.');
    this.eventCache = { Key: this.eventKey, ...JSON.parse(result.row.Payload) };
    return this.publicEvent(this.eventCache);
  }
  async mustEvent(store) {
    const event = await this.event(store);
    requireThat(event, 409, 'NOT_SCHEDULED', 'The organizer has not created this competition yet.');
    return event;
  }
  sessionToken(entry, event) {
    return sign({ type: 'player', entryKey: entry.Key, eventKey: event.Key,
      exp: (event.closesAt ?? this.now() + 30 * 86400000) + 86400000 }, this.secret);
  }
  async authenticate(store, token) {
    const session = verify(token, this.secret, this.now(), 'player');
    requireThat(session.eventKey === this.eventKey, 401, 'SESSION_LOST', 'Please join this round.');
    const entry = await store.get('DinoEntries', session.entryKey);
    requireThat(entry, 401, 'SESSION_LOST', 'Please join this round.');
    return entry;
  }
  async join(store, body, token) {
    exactKeys(body, ['roll', 'claim']);
    const roll = normalizeRoll(body.roll);
    requireThat(typeof body.claim === 'string' && /^[a-f0-9]{64}$/.test(body.claim),
      400, 'BAD_CLAIM', 'Browser session could not be created. Please reload.');
    const event = await this.mustEvent(store), now = this.now();
    const key = `${event.Key}:${roll}`;
    let entry = await store.get('DinoEntries', key);
    if (!entry) {
      requireThat(event.closesAt == null || now < event.closesAt, 410, 'ROUND_OVER', 'The round has ended.');
      const result = await insertOnce(store, 'DinoEntries', { Key: key, EventKey: event.Key,
        Roll: roll, ClaimHash: hash(body.claim), Payload: JSON.stringify({ joinedAt: now,
          initialFrame: Math.min(eventRules(event).totalFrames, Math.ceil(frameAt(event, now) / RULES.chunkFrames) * RULES.chunkFrames) }) });
      entry = result.row;
    }
    let hasCookie = false;
    try { hasCookie = (await this.authenticate(store, token)).Key === key; } catch (e) { if (!(e instanceof HttpError)) throw e; }
    requireThat(hasCookie || equal(entry.ClaimHash, hash(body.claim)), 409, 'ROLL_CLAIMED',
      'This roll number is already registered in another browser. Ask the organizer to restore access.');
    return { token: this.sessionToken(entry, event), ...(await this.state(store, entry, event)) };
  }
  async state(store, entry, event = null) {
    event ||= await this.mustEvent(store);
    const row = await store.latest(entry.Key);
    const state = row ? JSON.parse(row.Payload).state : initialState(JSON.parse(entry.Payload).initialFrame);
    if (!this.readyEntries.has(entry.Key) && await store.get('DinoEvents', `${event.Key}:ready:${entry.Roll}`)) this.readyEntries.add(entry.Key);
    return { event: this.publicEvent(event), roll: entry.Roll, seed: event.seed, ready: this.readyEntries.has(entry.Key),
      seq: row ? Number(row.Seq) : -1, state };
  }
  validateInputs(inputs, start, end) {
    requireThat(Array.isArray(inputs) && inputs.length <= 80, 400, 'BAD_INPUT', 'Invalid gameplay input count.');
    let last = start, same = new Set();
    for (const pair of inputs) {
      requireThat(Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) &&
        pair[0] >= last && pair[0] < end && Number.isInteger(pair[1]) && pair[1] >= 1 && pair[1] <= 4,
      400, 'BAD_INPUT', 'Gameplay inputs are invalid or out of order.');
      if (pair[0] !== last) same.clear();
      requireThat(!same.has(pair[1]), 400, 'BAD_INPUT', 'Duplicate action in the same frame.');
      same.add(pair[1]); last = pair[0];
    }
  }
  async checkpoint(store, entry, body) {
    exactKeys(body, ['seq', 'endFrame', 'inputs']);
    this.limiter.use(`play:${entry.Key}`, 12, 2000, this.now());
    const { seq, endFrame, inputs } = body;
    const event = await this.mustEvent(store), now = this.now();
    requireThat(event.opensAt != null, 409, 'WAITING_FOR_START', 'Waiting for the organizer to start.');
    requireThat(Number.isSafeInteger(seq) && seq >= 0 && seq <= 15000 &&
      Number.isSafeInteger(endFrame) && endFrame > 0 && endFrame <= eventRules(event).totalFrames,
      400, 'BAD_CHECKPOINT', 'Invalid checkpoint.');
    // Validate structure before hashing or checking an old idempotency key.
    this.validateInputs(inputs, Math.max(0, endFrame - RULES.chunkFrames), endFrame);
    const digest = hash(JSON.stringify({ seq, endFrame, inputs }));
    const key = `${entry.Key}:${seq}`;
    const existing = await store.get('DinoCheckpoints', key);
    if (existing) {
      requireThat(equal(existing.Digest, digest), 409, 'STATE_CHANGED', 'Another request saved this checkpoint. Resume the saved game.');
      return this.state(store, entry);
    }
    const current = await this.state(store, entry, event);
    requireThat(seq === current.seq + 1, 409, 'STATE_CHANGED', 'Resume the saved game before continuing.');
    requireThat(endFrame === current.state.frame + RULES.chunkFrames, 400, 'BAD_CHECKPOINT', 'Checkpoint must cover exactly two seconds.');
    const endAt = event.opensAt + endFrame * 1000 / RULES.hz;
    requireThat(now >= endAt, 425, 'TOO_EARLY', 'Wait for this gameplay interval to finish.', { retryAt: endAt });
    requireThat(now <= endAt + RULES.lateMs, 409, 'STALE_CHECKPOINT', 'Connection was interrupted. Resume the saved game.');
    this.validateInputs(inputs, current.state.frame, endFrame);
    const state = replay(current.state, endFrame, inputs, event.seed);
    const result = await insertOnce(store, 'DinoCheckpoints', checkpointRow(event, entry, seq, digest,
      'play', inputs, state, now));
    requireThat(equal(result.row.Digest, digest), 409, 'STATE_CHANGED', 'Another request saved this checkpoint. Resume the saved game.');
    // Read the winner/latest after persistence, never acknowledge a predicted score.
    return this.state(store, entry, event);
  }
  async sync(store, entry, body) {
    exactKeys(body, []);
    this.limiter.use(`sync:${entry.Key}`, 6, 2000, this.now());
    const event = await this.mustEvent(store), now = this.now();
    const current = await this.state(store, entry, event);
    if (event.opensAt == null) return current;
    const end = boundaryAt(event, now);
    if ((!current.state.running && end <= current.state.frame) || now >= event.closesAt + RULES.lateMs) return current;
    // A refresh/disconnection forfeits unsaved gameplay. Reset the current run;
    // retain the acknowledged best. Downtime must not earn survival points.
    const target = Math.max(end, current.state.frame);
    const state = { ...initialState(target), best: current.state.best,
      bestAt: current.state.bestAt, run: current.state.run, crashAt: target - 30 };
    const seq = current.seq + 1;
    const digest = hash(JSON.stringify({ kind: 'sync', seq, end }));
    await insertOnce(store, 'DinoCheckpoints', checkpointRow(event, entry, seq, digest, 'sync', [], state, now));
    return this.state(store, entry, event);
  }
  async recover(store, body) {
    exactKeys(body, ['ticket']);
    const ticket = verify(body.ticket, this.secret, this.now(), 'recovery');
    requireThat(ticket.eventKey === this.eventKey, 401, 'WRONG_ROUND', 'Recovery code belongs to another round.');
    const entry = await store.get('DinoEntries', ticket.entryKey);
    requireThat(entry, 404, 'NO_ENTRY', 'Entry was not found.');
    const event = await this.mustEvent(store);
    await insertOnce(store, 'DinoEvents', { Key: `${event.Key}:used:${hash(body.ticket)}`, EventKey: event.Key,
      Payload: JSON.stringify({ version: 1, kind: 'recovery-used', roll: entry.Roll, at: this.now() }) });
    return { token: this.sessionToken(entry, event), ...(await this.state(store, entry, event)) };
  }
  async recoveryTicket(store, body) {
    exactKeys(body, ['roll', 'verified']);
    requireThat(body.verified === true, 400, 'VERIFY_FIRST', 'Verify the participant in person first.');
    const event = await this.mustEvent(store);
    const entry = await store.get('DinoEntries', `${event.Key}:${normalizeRoll(body.roll)}`);
    requireThat(entry, 404, 'NO_ENTRY', 'This roll number has not registered.');
    const exp = Math.min(this.now() + 300000, (event.closesAt ?? this.now()) + 86400000);
    const ticket = sign({ type: 'recovery', entryKey: entry.Key, eventKey: event.Key,
      nonce: randomBytes(8).toString('hex'), exp }, this.secret);
    await store.insert('DinoEvents', { Key: `${event.Key}:issued:${hash(ticket)}`, EventKey: event.Key,
      Payload: JSON.stringify({ version: 1, kind: 'recovery-issued', roll: entry.Roll, at: this.now(), exp, verified: true }) });
    return { ticket };
  }
  async leaderboard(store, fresh = false) {
    const event = await this.event(store), now = this.now();
    if (!event) return { event: this.publicEvent(null), updatedAt: now, rows: [], participants: 0 };
    const final = await this.finalResults(store);
    if (final) return { ...final, event: this.publicEvent(event), final: true };
    if (!fresh && this.boardCache && now - this.boardCache.updatedAt < 8000) return {
      ...this.boardCache, event: this.publicEvent(event) };
    if (this.boardPending) {
      const pending = await this.boardPending;
      if (!fresh) return pending;
    }
    this.boardPending = (async () => {
      const [entries, ranks] = await Promise.all([store.entries(event.Key), store.ranks(event.Key)]);
      const rows = entries.map(entry => ({ roll: entry.Roll, value: ranks.get(entry.Key) || 0 }))
        .sort((a, b) => b.value - a.value || a.roll.localeCompare(b.roll, 'en'))
        .map((r, index) => ({ rank: index + 1, roll: r.roll, ...decodeRank(r.value) }));
      this.boardCache = { event: this.publicEvent(event), updatedAt: this.now(), participants: rows.length, rows };
      return this.boardCache;
    })();
    try { return await this.boardPending; } finally { this.boardPending = null; }
  }
  async finalResults(store) {
    if (this.finalCache) return this.finalCache;
    const manifest = await store.get('DinoEvents', `${this.eventKey}:final`);
    if (!manifest) return null;
    const meta = JSON.parse(manifest.Payload), rows = [];
    for (let i = 0; i < meta.pages; i++) {
      const page = await store.get('DinoEvents', `${this.eventKey}:result:${meta.snapshot}:${i}`);
      requireThat(page, 503, 'RESULTS_UNAVAILABLE', 'Final results are temporarily unavailable.');
      rows.push(...JSON.parse(page.Payload));
    }
    requireThat(hash(JSON.stringify(rows)) === meta.digest, 503, 'RESULTS_UNAVAILABLE', 'Final results need organizer attention.');
    this.finalCache = { rows, participants: rows.length, updatedAt: meta.finalizedAt, final: true };
    return this.finalCache;
  }
  async finalize(store) {
    const existing = await this.finalResults(store);
    if (existing) return existing;
    const event = await this.mustEvent(store);
    requireThat(event.closesAt != null, 409, 'WAITING_FOR_START', 'Start the competition before freezing results.');
    // Drain the AppSail 30-second request bound after the last admissible inputs.
    requireThat(this.now() > event.closesAt + RULES.lateMs + 30000, 409, 'STILL_SETTLING',
      'Wait 36 seconds after the round ends before freezing prize results.');
    const board = await this.leaderboard(store, true);
    const snapshot = randomBytes(8).toString('hex');
    const pages = Math.max(1, Math.ceil(board.rows.length / 100));
    for (let i = 0; i < pages; i++) await store.insert('DinoEvents', {
      Key: `${event.Key}:result:${snapshot}:${i}`, EventKey: event.Key, Payload: JSON.stringify(board.rows.slice(i * 100, (i + 1) * 100)) });
    // Publish only after all pages are durable. A process kill leaves harmless
    // unreferenced pages; concurrent finalizers cannot mix snapshots.
    await insertOnce(store, 'DinoEvents', { Key: `${event.Key}:final`, EventKey: event.Key, Payload: JSON.stringify({ snapshot,
      pages, digest: hash(JSON.stringify(board.rows)), finalizedAt: this.now() }) });
    return this.finalResults(store);
  }
}
