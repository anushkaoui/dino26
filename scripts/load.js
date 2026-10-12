// Run without a URL for an isolated local test using synthetic participants.
// Passing LOAD_URL explicitly targets that deployment and consumes its quota.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { LocalStore } from '../server/store.js';
import { GameService } from '../server/service.js';
import { createApp } from '../server/http.js';
import { RULES } from '../shared/engine.js';
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const participants = Number(process.env.LOAD_PLAYERS || 500);
const seconds = Number(process.env.LOAD_SECONDS || 180);
if (!Number.isInteger(participants) || participants < 1 || participants > 2000 ||
    !Number.isInteger(seconds) || seconds < 2 || seconds > 180 || seconds % 2) throw new Error('Use 1–2000 players and an even duration of 2–180 seconds');
let base = process.env.LOAD_URL, server, store, dir;
const room = process.env.LOAD_ROOM;
if (!base) {
  dir = await mkdtemp(join(tmpdir(), 'gdg-load-'));
  store = await new LocalStore(dir).init();
  const eventKey = 'synthetic-load';
  // Disposable fixture, not the user's preview/event. No organizer key is used.
  const opensAt = Date.now() + 10000;
  await store.insert('DinoEvents', { Key: eventKey, EventKey: eventKey, Payload: JSON.stringify({ version: 1,
    name: 'Synthetic local load test', opensAt, closesAt: opensAt + RULES.durationMs, seed: 42 }) });
  const service = new GameService({ secret: randomBytes(32).toString('hex'), eventKey });
  server = createApp({ service, storeForRequest: async () => store, adminKey: randomBytes(32).toString('hex'),
    origin: 'http://localhost', logger: { error: () => {} } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const latencies = [], errors = [], statusCounts = {};
let count = 0;
async function request(path, body, cookie) {
  const start = performance.now();
  try {
    const url = new URL(base + path); if (room) url.searchParams.set('room', room);
    const res = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dino-Request': '1', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const json = await res.json();
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    if (!res.ok) throw new Error(`${path} ${res.status} ${json.error}`);
    return { json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  } catch (e) { errors.push(e.message); throw e; }
  finally { count++; latencies.push(performance.now() - start); }
}
try {
  const { json: event } = await request('/api/event');
  if (!event.opensAt || event.status !== 'waiting') throw new Error('Schedule a separate load-test round in the future before testing a deployment. Never use the prize round.');
  const clients = await Promise.all(Array.from({ length: participants }, async (_, i) => {
    const roll = 'T' + String(i).padStart(7, '0');
    const { json, cookie } = await request('/api/join', { roll, claim: randomBytes(32).toString('hex') });
    return { roll, cookie, seq: json.seq, frame: json.state.frame };
  }));
  console.log(`Testing ${participants} synthetic players for ${seconds}s (${process.env.LOAD_URL ? 'DEPLOYED backend' : 'LOCAL durable journal only'}).`);
  for (let chunk = 1; chunk <= seconds / 2; chunk++) {
    await sleep(event.opensAt + chunk * 2000 + 70 - Date.now());
    const results = await Promise.allSettled(clients.map(async (client, i) => {
      await sleep((i % 31) * 10);
      const endFrame = client.frame + RULES.chunkFrames;
      const body = { seq: client.seq + 1, endFrame, inputs: [[client.frame, 4]] };
      const { json } = await request('/api/checkpoint', body, client.cookie);
      client.seq = json.seq; client.frame = json.state.frame;
      // Simulate an acknowledged response being lost and retried unchanged.
      if (chunk % 9 === 0 && i % 20 === 0) await request('/api/checkpoint', body, client.cookie);
      // Refresh/connection recovery for a subset, using saved authoritative state.
      if (chunk % 15 === 0 && i % 25 === 0) {
        const { json: restored } = await request('/api/sync', {}, client.cookie);
        client.seq = restored.seq; client.frame = restored.state.frame;
      }
      if (chunk % 4 === 0) await request('/api/leaderboard');
    }));
    if (results.some(r => r.status === 'rejected')) throw new Error(`Load iteration ${chunk} failed: ${errors[errors.length - 1]}`);
    if (chunk % 15 === 0) console.log(`${chunk * 2}s: ${count} requests, ${errors.length} failures`);
  }
  const { json: board } = await request('/api/leaderboard');
  if (board.participants !== participants || board.rows.length !== participants || new Set(board.rows.map(r => r.roll)).size !== participants)
    throw new Error('Leaderboard count/uniqueness mismatch.');
} catch (e) { if (!errors.includes(e.message)) errors.push(e.message); process.exitCode = 1; }
finally {
  if (server) await new Promise(r => server.close(r));
  if (store) await store.close();
  const ordered = latencies.sort((a, b) => a - b);
  const percentile = n => Math.round(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * n))] || 0);
  const report = { backend: process.env.LOAD_URL ? 'deployed' : 'local-journal', participants, seconds,
    requests: count, failures: errors.length, statusCounts, latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: Math.round(ordered.at(-1) || 0) },
    errors: errors.slice(0, 20), deploymentQualified: false,
    note: 'Local results do not qualify Catalyst capacity, provider latency, campus Wi-Fi, or browser fairness.' };
  await mkdir('reports', { recursive: true });
  const path = `reports/load-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); console.log(`Report: ${path}`);
  if (dir) await rm(dir, { recursive: true, force: true });
}
