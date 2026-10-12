import { RULES as DEFAULT_RULES, ACTION, initialState, step, replay, runScore } from '/engine.js';
const $ = id => document.getElementById(id);
let RULES = DEFAULT_RULES;
const roomId = new URLSearchParams(location.search).get('room');
const canvas = $('game'), ctx = canvas.getContext('2d');
let event, saved, view = initialState(), seed = 1, inputs = [], pending = null;
let roll = null, busy = false, suspended = false, ownsTab = true, baseServer = Date.now(), basePerf = performance.now();
let lastCheckpoint = 0, retryAt = 0, failures = 0, boardTimer;
const score = n => String(n).padStart(5, '0');
const serverNow = () => baseServer + performance.now() - basePerf;
const storageKey = name => `gdg-dino:${event?.id || 'pending'}:${name}`;
function storageRead(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function storageWrite(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
function clockUpdate(e, started) {
  if (event?.opensAt != null && e.opensAt == null && event.id === e.id) return;
  event = e; RULES = e.rules || DEFAULT_RULES;
  $('duration-title').textContent = `${RULES.durationMs / 60000} ${RULES.durationMs === 60000 ? 'minute' : 'minutes'}.`;
  $('competition-name').textContent = e.name;
  // Event responses always contain fresh server time, even cached leaderboards.
  baseServer = e.serverNow + (performance.now() - started) / 2; basePerf = performance.now();
}
function message(text = '', error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function overlay(title, text) { $('overlay').hidden = false; $('overlay-title').textContent = title; $('overlay-text').textContent = text; }
function connection(text, online = false) {
  $('connection').replaceChildren(Object.assign(document.createElement('i'), { ariaHidden: 'true' }), document.createTextNode(text));
  $('connection').classList.toggle('online', online);
}
async function api(path, data) {
  const started = performance.now();
  const url = new URL(path, location.origin);
  if (roomId) url.searchParams.set('room', roomId);
  const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Dino-Request': '1' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(8000) });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.message || 'Request failed.'), { code: body.error, status: response.status, retryAt: body.retryAt });
  const info = body.event || (body.serverNow ? body : null);
  if (info) clockUpdate(info, started);
  return body;
}
function adopt(result, reset = false) {
  saved = result; roll = result.roll; seed = result.seed;
  inputs = inputs.filter(i => i[0] >= result.state.frame);
  const oldFrame = reset ? result.state.frame : Math.max(result.state.frame, view.frame);
  view = replay(result.state, Math.min(oldFrame, result.state.frame + RULES.chunkFrames * 2), inputs, seed);
  $('entry').hidden = true; $('player-label').textContent = `PLAYER ${roll}`;
  $('saved-score').textContent = score(result.state.best);
  storageWrite(storageKey('roll'), roll);
  $('ready-panel').hidden = event.status !== 'lobby';
  $('ready').disabled = !!result.ready;
  $('ready').textContent = result.ready ? 'Ready ✓' : 'I’m ready';
  $('ready-hint').textContent = result.ready ? 'You’re ready. Wait for the organizer to start.' : 'Mark yourself ready once you’re set.';
}
async function claimTab() {
  if (!navigator.locks) return true; // API still serializes conflicting requests.
  return new Promise(resolve => {
    navigator.locks.request(`gdg-dino:${event.id}:${roll}`, { ifAvailable: true }, async lock => {
      ownsTab = !!lock; resolve(ownsTab);
      if (!lock) return;
      await new Promise(release => addEventListener('pagehide', release, { once: true }));
    }).catch(() => { ownsTab = false; resolve(false); });
  });
}
async function resume() {
  if (!saved || !ownsTab) return;
  suspended = true;
  // Resolve a persisted completed batch before a reset can claim its sequence.
  // A lost response may already have committed, even after its deadline.
  if (pending) {
    try { adopt(await api('/api/checkpoint', pending), true); }
    catch (error) {
      if (![400, 409].includes(error.status)) {
        if (error.status === 401) {
          $('entry').hidden = false;
          message('Session lost. Re-enter your roll number in this browser to restore it.', true);
        }
        throw error;
      }
    }
    pending = null; storageWrite(storageKey('pending'), null);
  }
  const restored = await api('/api/sync', {});
  inputs = []; adopt(restored, true); suspended = false; pending = null;
  storageWrite(storageKey('pending'), null);
  connection('Saved · online', true);
}
async function saveCheckpoint() {
  if (!event?.opensAt || !saved || busy || suspended || !ownsTab || performance.now() < retryAt) return;
  const endFrame = saved.state.frame + RULES.chunkFrames;
  if (!pending && (view.frame < endFrame || endFrame > RULES.totalFrames || serverNow() < event.opensAt + endFrame / RULES.hz * 1000 + lastCheckpoint)) return;
  busy = true;
  if (!pending) {
    pending = { seq: saved.seq + 1, endFrame, inputs: inputs.filter(i => i[0] >= saved.state.frame && i[0] < endFrame) };
    storageWrite(storageKey('pending'), pending);
  }
  try {
    const result = await api('/api/checkpoint', pending);
    pending = null; failures = 0; retryAt = 0;
    storageWrite(storageKey('pending'), null); adopt(result);
    connection('Saved · online', true);
  } catch (error) {
    if (error.status === 425) retryAt = performance.now() + 150;
    else if (error.status === 409 || error.status === 400) {
      pending = null; storageWrite(storageKey('pending'), null);
      try { await resume(); message('Connection restored. Your saved best is kept; press Jump for a new run.'); }
      catch { suspended = true; retryAt = performance.now() + 1000; }
    } else if (error.status === 401) {
      suspended = true; $('entry').hidden = false; message('Session lost. Re-enter your roll number in this browser to restore it.', true);
    } else {
      failures++; retryAt = performance.now() + Math.min(3000, 300 * 2 ** Math.min(failures, 3)) + Math.random() * 250;
      connection('Reconnecting · saved best kept');
    }
  } finally { busy = false; }
}
function action(value) {
  if (!event?.opensAt || !saved || suspended || !ownsTab || document.hidden || serverNow() < event.opensAt || serverNow() >= event.closesAt ||
    view.frame >= saved.state.frame + RULES.chunkFrames * 2) return;
  const chunkStart = Math.floor(view.frame / RULES.chunkFrames) * RULES.chunkFrames;
  const add = a => { if (!inputs.some(i => i[0] === view.frame && i[1] === a) &&
    inputs.filter(i => i[0] >= chunkStart && i[0] < chunkStart + RULES.chunkFrames).length < 76) inputs.push([view.frame, a]); };
  if (value === ACTION.JUMP && !view.running) add(ACTION.RESTART);
  add(value);
}
function draw() {
  ctx.clearRect(0, 0, 900, 240); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 240);
  const ground = 193;
  ctx.fillStyle = '#dfe2da'; ctx.fillRect(0, ground + 1, 900, 1);
  for (let i = 0; i < 16; i++) { const x = (i * 71 + 900 - Math.floor(view.distance / 170) % 71) % 900; ctx.fillRect(x, ground + 7 + i % 3 * 4, i % 2 ? 4 : 10, 1); }
  ctx.strokeStyle = '#e1e4dc'; ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) { const x = 260 + i * 220 - Math.floor(view.distance / 2000) % 200;
    ctx.beginPath(); ctx.moveTo(x, 48 + i % 2 * 20); ctx.lineTo(x + 40, 48 + i % 2 * 20); ctx.lineTo(x + 35, 40 + i % 2 * 20); ctx.lineTo(x + 20, 40 + i % 2 * 20); ctx.lineTo(x + 15, 33 + i % 2 * 20); ctx.lineTo(x + 8, 33 + i % 2 * 20); ctx.lineTo(x + 3, 48 + i % 2 * 20); ctx.stroke(); }
  ctx.fillStyle = '#454b43';
  for (const o of view.obstacles) {
    const x = o.x / 100, y = ground - o.y;
    if (o.bird) { ctx.fillRect(x + 8, y - 14, 28, 8); ctx.fillRect(x, y - 18, 14, 7); ctx.fillRect(x + 21, y - 24 + (view.frame % 20 < 10 ? 0 : 13), 5, 15); }
    else { ctx.fillRect(x + o.w / 2 - 3, y - o.h, 7, o.h); ctx.fillRect(x + 1, y - o.h + 10, 5, 16); ctx.fillRect(x + 3, y - o.h + 21, o.w / 2, 5); ctx.fillRect(x + o.w - 5, y - o.h + 6, 5, 17); ctx.fillRect(x + o.w / 2, y - o.h + 18, o.w / 2, 5); }
  }
  // Original pixel dinosaur artwork; no external assets or Chrome internals.
  const duck = view.duck && view.y === 0;
  const pixels = duck ? ['        XXXXXXXX','        XX XXXXX','   XXXXXXXXXXXXX','XXXXXXXXXXX     ',' XXXXXXXXX      ','  XX    XX      ','  X      X      '] :
    ['    XXXXXXXX','    XX XXXXX','    XXXXXXXX','    XXXXX   ','X   XXXXX   ','XX XXXXXXX  ','XXXXXXXX X  ',' XXXXXXX    ','  XXXXX     ','   XX XX    ','   X   X    '];
  const unit = 4, x = 80, y = ground - view.y / 100 - pixels.length * unit;
  pixels.forEach((row, iy) => [...row].forEach((p, ix) => { if (p === 'X') ctx.fillRect(x + ix * unit, y + iy * unit, unit, unit); }));
  if (view.running && view.y === 0 && !duck) { ctx.fillStyle = '#fff'; ctx.fillRect(x + (view.frame % 16 < 8 ? 12 : 24), ground - 4, 4, 4); }
}
function tick() {
  const now = serverNow();
  if (event) {
    const waiting = event.opensAt && now < event.opensAt;
    const remaining = waiting ? event.opensAt - now : event.closesAt ? event.closesAt - now : RULES.durationMs;
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('timer-label').textContent = waiting ? 'STARTS IN' : event.opensAt ? 'TIME LEFT' : 'ROUND LENGTH';
    const live = event.opensAt != null && now >= event.opensAt && now < event.closesAt;
    $('ready-panel').hidden = !saved || event.status !== 'lobby';
    $('jump').disabled = !live; $('duck').disabled = !live;
    $('round-status').textContent = !event.opensAt ? event.status === 'lobby' ? 'WAITING ROOM' : 'COMING SOON' : waiting ? 'STARTING SOON' : live ? 'ROUND LIVE' : 'ROUND ENDED';
    $('round-status').classList.toggle('live', live);
    if (saved && event.opensAt != null && !suspended && ownsTab && !document.hidden) {
      const clockFrame = Math.max(0, Math.floor((now - event.opensAt) * RULES.hz / 1000));
      const target = Math.min(RULES.totalFrames, saved.state.frame + RULES.chunkFrames * 2, clockFrame);
      // A backgrounded/slow device cannot invent inputs for the missed time.
      if (clockFrame - view.frame > RULES.chunkFrames * 2 && now < event.closesAt && !busy) {
        suspended = true; busy = true; resume().catch(() => {}).finally(() => { busy = false; });
      }
      else while (view.frame < target) {
        const actions = inputs.filter(i => i[0] === view.frame).map(i => i[1]);
        step(view, actions, seed);
      }
      saveCheckpoint();
    }
    if (!ownsTab) overlay('Already running in another tab.', 'Close the other game tab, then reload this one.');
    else if (suspended) overlay('Reconnecting…', 'Your saved best is kept. The round clock keeps running.');
    else if (!saved) overlay('See you on the starting line.', 'Enter your roll number to join.');
    else if (!event.opensAt) overlay('You’re in the waiting room.', 'Mark yourself ready. The organizer will start everyone together.');
    else if (waiting) overlay('You’re on the starting line.', 'Everyone starts together. Keep this tab open.');
    else if (!live) overlay('That’s time.', 'Saving the last checkpoint. Rankings are provisional until frozen.');
    else if (view.frame >= saved.state.frame + RULES.chunkFrames * 2) overlay('Waiting for connection…', 'Your saved best is kept.');
    else if (!view.running) overlay(view.crashAt >= 0 ? 'One more run?' : 'Let’s run.', 'Press Space, tap the game, or use Jump.');
    else $('overlay').hidden = true;
  }
  $('run-score').textContent = score(runScore(view)); draw(); requestAnimationFrame(tick);
}
async function board() {
  try {
    const result = await api('/api/leaderboard');
    $('board-info').textContent = `${result.participants} players · ${result.final ? 'FINAL RESULTS' : 'updates every 8s'}`;
    const tbody = $('scores'); tbody.replaceChildren();
    if (!result.rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 3; td.className = 'empty'; td.textContent = 'The starting line is yours.'; tr.append(td); tbody.append(tr); }
    for (const row of result.rows.slice(0, 20)) {
      const tr = document.createElement('tr'); if (row.roll === roll) tr.className = 'me';
      for (const value of [String(row.rank).padStart(2, '0'), row.roll, score(row.score)]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
      tbody.append(tr);
    }
    const me = result.rows.find(r => r.roll === roll);
    $('my-rank').textContent = me ? `Your place: ${me.rank} of ${result.participants} · ${result.final ? 'Final' : 'Provisional'} · Best saved: ${me.score}` : '';
  } catch { $('board-info').textContent = 'Leaderboard reconnecting · showing last update'; }
  boardTimer = setTimeout(board, 8000 + Math.random() * 2000);
}
async function start(result) {
  adopt(result, true);
  if (!(await claimTab())) return;
  pending = storageRead(storageKey('pending'));
  await resume(); message('You’re in. Keep this browser open for the round.');
}
$('join-form').addEventListener('submit', async e => {
  e.preventDefault(); $('join').disabled = true;
  try {
    let claim = storageRead(storageKey('claim'));
    if (!claim) { claim = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (!storageWrite(storageKey('claim'), claim)) throw new Error('Enable browser storage before entering the competition.'); }
    const result = await api('/api/join', { roll: $('roll').value.trim().toUpperCase(), claim });
    if (!saved) await start(result); else { adopt(result, true); await resume(); }
  } catch (e) { message(e.message, true); } finally { $('join').disabled = false; }
});
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
  if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) { e.preventDefault(); if (!e.repeat) action(e.code === 'ArrowDown' ? ACTION.DUCK : ACTION.JUMP); }
});
document.addEventListener('keyup', e => { if (e.code === 'ArrowDown') action(ACTION.RELEASE); });
window.addEventListener('blur', () => action(ACTION.RELEASE));
canvas.addEventListener('pointerdown', e => { e.preventDefault(); action(ACTION.JUMP); });
$('jump').addEventListener('pointerdown', e => { e.preventDefault(); action(ACTION.JUMP); });
$('jump').addEventListener('click', e => { if (e.detail === 0) action(ACTION.JUMP); });
$('duck').addEventListener('pointerdown', e => { e.preventDefault(); $('duck').setPointerCapture(e.pointerId); action(ACTION.DUCK); });
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('duck').addEventListener(name, () => action(ACTION.RELEASE));
$('duck').addEventListener('keydown', e => { if (['Space', 'Enter'].includes(e.code)) { e.preventDefault(); action(ACTION.DUCK); } });
$('duck').addEventListener('keyup', () => action(ACTION.RELEASE));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspended = true;
  else if (saved && ownsTab && !busy) resume().catch(() => { suspended = true; });
});
addEventListener('online', () => { if (saved && ownsTab && !busy) { retryAt = 0; if (pending) saveCheckpoint(); else resume().catch(() => {}); } });
setInterval(() => { if (suspended && saved && ownsTab && !document.hidden && !busy && performance.now() >= retryAt) {
  busy = true; resume().catch(() => { retryAt = performance.now() + 2000; }).finally(() => { busy = false; });
} }, 1500);
async function boot() {
  try {
    event = await api('/api/event'); lastCheckpoint = 30 + Math.random() * 300;
    const recovery = new URLSearchParams(location.hash.slice(1)).get('recover');
    if (recovery) { history.replaceState(null, '', location.pathname + location.search); await start(await api('/api/recover', { ticket: recovery })); }
    else {
      try { await start(await api('/api/state')); }
      catch (e) {
        if (e.status !== 401) throw e;
        const previous = storageRead(storageKey('roll')), claim = storageRead(storageKey('claim'));
        if (previous && claim) await start(await api('/api/join', { roll: previous, claim }));
      }
    }
  } catch (e) { message(e.message, true); }
  board();
}
$('ready').addEventListener('click', async () => {
  $('ready').disabled = true;
  try { const result = await api('/api/ready', {}); saved.ready = result.ready;
    $('ready').textContent = 'Ready ✓'; $('ready-hint').textContent = 'You’re ready. Wait for the organizer to start.';
  } catch (error) { $('ready').disabled = false; message(error.message, true); }
});
async function watchStart() {
  if (event?.status === 'lobby' || event?.status === 'unscheduled') {
    try { await api('/api/event'); } catch { /* Keep polling the persistent start record. */ }
  }
  setTimeout(watchStart, 800 + Math.random() * 200);
}
requestAnimationFrame(tick); boot(); watchStart();
