import { RULES as DEFAULT_RULES, ACTION, ARMORY, ACTION_TO_KEY, initialState, step, replay, runScore } from '/engine.js';

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
  baseServer = e.serverNow + (performance.now() - started) / 2; basePerf = performance.now();
}

function message(text = '', error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function overlay(title, text) {
  $('overlay').hidden = false;
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text;
}

function connection(text, online = false) {
  $('connection').replaceChildren(Object.assign(document.createElement('i'), { ariaHidden: 'true' }), document.createTextNode(text));
  $('connection').classList.toggle('online', online);
}

async function api(path, data) {
  const started = performance.now();
  const url = new URL(path, location.origin);
  if (roomId) url.searchParams.set('room', roomId);
  const response = await fetch(url, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Dino-Request': '1' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(8000)
  });
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
  $('entry').hidden = true;
  $('player-label').textContent = `PLAYER ${roll}`;
  $('saved-score').textContent = score(result.state.best);
  storageWrite(storageKey('roll'), roll);
  $('ready-panel').hidden = event.status !== 'lobby';
  $('ready').disabled = !!result.ready;
  $('ready').textContent = result.ready ? 'Ready ✓' : 'I’m ready';
  $('ready-hint').textContent = result.ready ? 'You’re ready. Wait for the organizer to start.' : 'Mark yourself ready once you’re set.';
  renderWeaponsDock();
}

async function claimTab() {
  if (!navigator.locks) return true;
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
  const add = a => {
    if (!inputs.some(i => i[0] === view.frame && i[1] === a) &&
      inputs.filter(i => i[0] >= chunkStart && i[0] < chunkStart + RULES.chunkFrames).length < 76) {
      inputs.push([view.frame, a]);
    }
  };
  if (value === ACTION.JUMP && !view.running) add(ACTION.RESTART);
  add(value);
}

// Weapon Icons Emojis Map for mobile UI
const WEAPON_ICONS = {
  Q: '🗡️', W: '🔫', E: '🩴', R: '🔥', T: '🥷', Y: '😱', U: '🪚',
  I: '🚁', O: '⚔️', P: '🥋', A: '🚬', S: '🎯', D: '⚔️', F: '✌️',
  G: '💧', H: '🌀', J: '💣', K: '🐢', L: '⚡', Z: '☄️', X: '🔦',
  C: '☣️', V: '⚾', B: '🏹', N: '🛡️', M: '🔨'
};

// Render on-screen weapon dock for mobile phone touch controls
let lastInventoryKey = '';
function renderWeaponsDock() {
  const inv = view.inventory || {};
  const currentKey = Object.entries(inv).map(([k, v]) => `${k}:${v}`).join(',');
  if (currentKey === lastInventoryKey) return;
  lastInventoryKey = currentKey;

  const dock = $('weapon-dock');
  dock.replaceChildren();

  const keys = Object.keys(inv);
  if (!keys.length) {
    const empty = document.createElement('div');
    empty.className = 'weapon-dock-empty';
    empty.textContent = '📦 Collect letter mystery crates [A–Z] to unlock weapons!';
    dock.append(empty);
    $('active-weapon-name').textContent = 'NO WEAPONS EQUIPPED';
    return;
  }

  for (const key of keys) {
    const arm = ARMORY[key];
    if (!arm) continue;
    const uses = inv[key];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `weapon-btn ${view.activeWeapon === key ? 'active' : ''}`;
    btn.setAttribute('aria-label', `Use weapon ${key}: ${arm.name}`);

    const badge = document.createElement('span');
    badge.className = 'weapon-key-badge';
    badge.textContent = key;

    const icon = document.createElement('span');
    icon.className = 'weapon-icon';
    icon.textContent = WEAPON_ICONS[key] || '⚔️';

    const meta = document.createElement('div');
    meta.className = 'weapon-meta';

    const label = document.createElement('span');
    label.className = 'weapon-label';
    label.textContent = arm.name;

    const usesSpan = document.createElement('span');
    usesSpan.className = `weapon-uses ${uses === -1 ? 'unlimited' : ''}`;
    usesSpan.textContent = uses === -1 ? '∞' : `${uses} left`;

    meta.append(label, usesSpan);
    btn.append(badge, icon, meta);

    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      action(arm.action);
    });

    dock.append(btn);
  }

  const activeArm = ARMORY[view.activeWeapon];
  if (activeArm) {
    const uses = inv[view.activeWeapon];
    $('active-weapon-name').textContent = `ACTIVE: [${view.activeWeapon}] ${activeArm.name.toUpperCase()} (${uses === -1 ? '∞' : uses})`;
  }
}

// Canvas Drawing Engine for DinoSwords
function draw() {
  ctx.clearRect(0, 0, 900, 240);
  ctx.fillStyle = '#101114';
  ctx.fillRect(0, 0, 900, 240);

  const ground = 193;

  // Ground line
  ctx.fillStyle = '#272a30';
  ctx.fillRect(0, ground + 1, 900, 2);

  // Ground details
  for (let i = 0; i < 16; i++) {
    const x = (i * 71 + 900 - Math.floor(view.distance / 170) % 71) % 900;
    ctx.fillStyle = '#3a3f4a';
    ctx.fillRect(x, ground + 7 + i % 3 * 4, i % 2 ? 4 : 10, 1);
  }

  // Clouds
  ctx.strokeStyle = '#23262d';
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const x = 260 + i * 220 - Math.floor(view.distance / 2000) % 200;
    ctx.beginPath();
    ctx.moveTo(x, 48 + i % 2 * 20);
    ctx.lineTo(x + 40, 48 + i % 2 * 20);
    ctx.lineTo(x + 35, 40 + i % 2 * 20);
    ctx.lineTo(x + 20, 40 + i % 2 * 20);
    ctx.lineTo(x + 15, 33 + i % 2 * 20);
    ctx.lineTo(x + 8, 33 + i % 2 * 20);
    ctx.lineTo(x + 3, 48 + i % 2 * 20);
    ctx.stroke();
  }

  // --- DRAW CRATES [A-Z] ---
  if (view.crates) {
    for (const c of view.crates) {
      const cx = c.x / 100, cy = ground - c.y - c.h;
      // Crate box
      ctx.fillStyle = '#f39c12';
      ctx.fillRect(cx, cy, c.w, c.h);
      ctx.fillStyle = '#d35400';
      ctx.strokeRect(cx + 1, cy + 1, c.w - 2, c.h - 2);
      // Letter inside crate
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.letter, cx + c.w / 2, cy + c.h / 2 + 1);
    }
  }

  // --- DRAW OBSTACLES (CACTUS, PTERODACTYL, GOLDEN MIDAS) ---
  for (const o of view.obstacles) {
    const ox = o.x / 100, oy = ground - o.y;

    if (o.bird) {
      // Golden Midas or Classic Bird
      const isGolden = !!o.golden;
      ctx.fillStyle = isGolden ? '#f1c40f' : '#8892b0';

      // Flapping wings
      const flapDown = (view.frame % 20 < 10);
      ctx.fillRect(ox + 8, oy - 14, 28, 8);
      ctx.fillRect(ox, oy - 18, 14, 7);
      ctx.fillRect(ox + 21, oy - 24 + (flapDown ? 0 : 13), 5, 15);

      // Beak / Eye
      ctx.fillStyle = isGolden ? '#ffffff' : '#ccd6f6';
      ctx.fillRect(ox + 2, oy - 16, 3, 3);

      // Golden sparkle effects
      if (isGolden) {
        ctx.fillStyle = '#fffa65';
        ctx.fillRect(ox + 35, oy - 20, 2, 2);
        ctx.fillRect(ox + 5, oy - 26, 2, 2);
      }
    } else {
      // Cactus
      ctx.fillStyle = '#2ecc71';
      ctx.fillRect(ox + o.w / 2 - 3, oy - o.h, 7, o.h);
      ctx.fillRect(ox + 1, oy - o.h + 10, 5, 16);
      ctx.fillRect(ox + 3, oy - o.h + 21, o.w / 2, 5);
      ctx.fillRect(ox + o.w - 5, oy - o.h + 6, 5, 17);
      ctx.fillRect(ox + o.w / 2, oy - o.h + 18, o.w / 2, 5);
    }
  }

  // --- DRAW PROJECTILES ---
  if (view.projectiles) {
    for (const p of view.projectiles) {
      const px = p.x / 100, py = ground - (p.y / 100);
      switch (p.type) {
        case 'bullet':
        case 'rifle_bullet':
          ctx.fillStyle = '#fffa65';
          ctx.fillRect(px, py, p.w, p.h);
          break;
        case 'shuriken':
          ctx.fillStyle = '#bdc3c7';
          ctx.beginPath();
          ctx.arc(px + p.w / 2, py + p.h / 2, 6, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'flipflop':
          ctx.fillStyle = '#e67e22';
          ctx.fillRect(px, py, p.w, p.h);
          ctx.fillStyle = '#2980b9';
          ctx.fillRect(px + 4, py - 2, 6, 2);
          break;
        case 'arrow':
          ctx.fillStyle = '#f5cd79';
          ctx.fillRect(px, py, p.w, 3);
          ctx.fillStyle = '#c44569';
          ctx.fillRect(px + p.w - 4, py - 2, 4, 7);
          break;
        case 'grenade':
          ctx.fillStyle = '#27ae60';
          ctx.beginPath();
          ctx.arc(px + 6, py + 6, 6, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'holy_water':
          ctx.fillStyle = '#3498db';
          ctx.fillRect(px, py, 8, 12);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(px + 3, py + 3, 2, 6);
          ctx.fillRect(px + 1, py + 5, 6, 2);
          break;
        case 'portal_shot':
          ctx.fillStyle = '#0984e3';
          ctx.beginPath();
          ctx.arc(px + 8, py + 6, 8, 0, Math.PI * 2);
          ctx.fill();
          break;
      }
    }
  }

  // --- DRAW EFFECTS (LASER, EXPLOSIONS, SCREAM, METEOR, ETC) ---
  if (view.effects) {
    for (const ef of view.effects) {
      const efx = (ef.x || 0) / 100, efy = ground - ((ef.y || 0) / 100);
      switch (ef.type) {
        case 'slice':
        case 'bat_swing':
          ctx.strokeStyle = '#e74c3c';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(efx, efy, 25, -Math.PI / 3, Math.PI / 3);
          ctx.stroke();
          break;
        case 'flame':
          ctx.fillStyle = ef.ttl % 2 === 0 ? '#ff4757' : '#ffa502';
          ctx.beginPath();
          ctx.moveTo(efx, efy);
          ctx.lineTo(efx + 90, efy - 25);
          ctx.lineTo(efx + 90, efy + 25);
          ctx.fill();
          break;
        case 'scream':
          ctx.fillStyle = '#ff6b81';
          ctx.font = 'bold 20px monospace';
          ctx.textAlign = 'left';
          ctx.fillText('AAAHHHH!!!', efx, efy);
          break;
        case 'respect':
          ctx.fillStyle = '#2ed573';
          ctx.font = 'bold 22px sans-serif';
          ctx.fillText('✌️', efx, efy);
          break;
        case 'laser_beam':
          ctx.fillStyle = '#00d2d3';
          ctx.fillRect(0, ground - (ef.y / 100), 900, 8);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, ground - (ef.y / 100) + 2, 900, 4);
          break;
        case 'meteor':
          ctx.fillStyle = '#e55039';
          ctx.beginPath();
          ctx.arc(450, 100, 45, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#f6b93b';
          ctx.beginPath();
          ctx.arc(450, 100, 30, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'chemical_plane':
          ctx.fillStyle = '#2ecc71';
          ctx.globalAlpha = 0.35;
          ctx.fillRect(0, 0, 900, 240);
          ctx.globalAlpha = 1.0;
          ctx.fillStyle = '#a4b0be';
          ctx.fillRect(200 + (45 - ef.ttl) * 15, 30, 45, 14);
          break;
        case 'hit':
        case 'golden_explosion':
          ctx.fillStyle = ef.type === 'golden_explosion' ? '#f1c40f' : '#ff4757';
          ctx.beginPath();
          ctx.arc(efx, efy, 16, 0, Math.PI * 2);
          ctx.fill();
          break;
      }
    }
  }

  // --- DRAW DINOSAUR (PIXEL ART WITH GEAR & VEHICLES) ---
  const duck = view.duck && view.y === 0;
  const pixels = duck ? [
    '        XXXXXXXX',
    '        XX XXXXX',
    '   XXXXXXXXXXXXX',
    'XXXXXXXXXXX     ',
    ' XXXXXXXXX      ',
    '  XX    XX      ',
    '  X      X      '
  ] : [
    '    XXXXXXXX',
    '    XX XXXXX',
    '    XXXXXXXX',
    '    XXXXX   ',
    'X   XXXXX   ',
    'XX XXXXXXX  ',
    'XXXXXXXX X  ',
    ' XXXXXXX    ',
    '  XXXXX     ',
    '   XX XX    ',
    '   X   X    '
  ];

  const unit = 4, x = 80;
  const y = ground - view.y / 100 - pixels.length * unit;

  // Dino color: normal #dfe4ea, purple if Cigarettes smoked
  let dinoColor = '#dfe4ea';
  if (view.smokeCount > 0) {
    const purpleLevels = ['#d2b4de', '#bb8fce', '#a569bd', '#8e44ad', '#7d3c98', '#6c3483', '#5b2c6f', '#512e5f', '#4a235a', '#3b1c47', '#2e1538'];
    dinoColor = purpleLevels[Math.min(view.smokeCount - 1, 10)];
  }

  ctx.fillStyle = dinoColor;
  pixels.forEach((row, iy) => [...row].forEach((p, ix) => {
    if (p === 'X') ctx.fillRect(x + ix * unit, y + iy * unit, unit, unit);
  }));

  // Bat Cap
  if (view.batEquipped) {
    ctx.fillStyle = '#3498db';
    ctx.fillRect(x + 16, y - 6, 26, 6);
    ctx.fillRect(x + 28, y - 2, 22, 4);
  }

  // Running foot animation
  if (view.running && view.y === 0 && !duck && !view.vehicle) {
    ctx.fillStyle = '#101114';
    ctx.fillRect(x + (view.frame % 16 < 8 ? 12 : 24), ground - 4, 4, 4);
  }

  // Vehicle: MSCHF Helicopter
  if (view.vehicle === 'heli') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 15, y - 10, 68, 22);
    // Rotor
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(x - 25 + (view.frame % 4) * 5, y - 16, 85, 3);
    // Text: MSCHF
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MSCHF', x + 18, y + 4);
  }

  // Vehicle: 100 Thieves Tank
  if (view.vehicle === 'tank') {
    ctx.fillStyle = '#2c3e50';
    ctx.fillRect(x - 14, ground - 18, 65, 18);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(x + 36, ground - 14, 24, 6); // Cannon barrel
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 8px monospace';
    ctx.fillText('100T', x + 14, ground - 6);
  }
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
    $('jump').disabled = !live;
    $('duck').disabled = !live;
    $('round-status').textContent = !event.opensAt ? (event.status === 'lobby' ? 'WAITING ROOM' : 'COMING SOON') : waiting ? 'STARTING SOON' : live ? 'ROUND LIVE' : 'ROUND ENDED';
    $('round-status').classList.toggle('live', live);

    if (saved && event.opensAt != null && !suspended && ownsTab && !document.hidden) {
      const clockFrame = Math.max(0, Math.floor((now - event.opensAt) * RULES.hz / 1000));
      const target = Math.min(RULES.totalFrames, saved.state.frame + RULES.chunkFrames * 2, clockFrame);

      if (clockFrame - view.frame > RULES.chunkFrames * 2 && now < event.closesAt && !busy) {
        suspended = true; busy = true; resume().catch(() => {}).finally(() => { busy = false; });
      } else {
        while (view.frame < target) {
          const actions = inputs.filter(i => i[0] === view.frame).map(i => i[1]);
          step(view, actions, seed);
        }
      }
      saveCheckpoint();
      renderWeaponsDock();
    }

    if (!ownsTab) overlay('Already running in another tab.', 'Close the other game tab, then reload this one.');
    else if (suspended) overlay('Reconnecting…', 'Your saved best is kept. The round clock keeps running.');
    else if (!saved) overlay('See you on the starting line.', 'Enter your roll number to join.');
    else if (!event.opensAt) overlay('You’re in the waiting room.', 'Mark yourself ready. The organizer will start everyone together.');
    else if (waiting) overlay('You’re on the starting line.', 'Everyone starts together. Keep this tab open.');
    else if (!live) overlay('That’s time.', 'Saving the last checkpoint. Rankings are provisional until frozen.');
    else if (view.frame >= saved.state.frame + RULES.chunkFrames * 2) overlay('Waiting for connection…', 'Your saved best is kept.');
    else if (!view.running) overlay(view.crashAt >= 0 ? 'One more run?' : 'Let’s run.', 'Tap Jump / Retry or press Space to battle!');
    else $('overlay').hidden = true;
  }

  $('run-score').textContent = score(runScore(view));
  draw();
  requestAnimationFrame(tick);
}

// Live Leaderboard Poller (with backoff & edge caching support)
async function board() {
  try {
    const result = await api('/api/leaderboard');
    $('board-info').textContent = `${result.participants} players · ${result.final ? 'FINAL RESULTS' : 'live ranking'}`;
    const tbody = $('scores'); tbody.replaceChildren();

    if (!result.rows.length) {
      const tr = document.createElement('tr'), td = document.createElement('td');
      td.colSpan = 3; td.className = 'empty'; td.textContent = 'The starting line is yours.';
      tr.append(td); tbody.append(tr);
    }

    for (const row of result.rows.slice(0, 20)) {
      const tr = document.createElement('tr');
      if (row.roll === roll) tr.className = 'me';
      for (const value of [String(row.rank).padStart(2, '0'), row.roll, score(row.score)]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      tbody.append(tr);
    }
    const me = result.rows.find(r => r.roll === roll);
    $('my-rank').textContent = me ? `Your place: #${me.rank} of ${result.participants} · Best: ${me.score}` : '';
  } catch {
    $('board-info').textContent = 'Leaderboard sync paused · reconnecting';
  }
  boardTimer = setTimeout(board, 4000 + Math.random() * 1500);
}

async function start(result) {
  adopt(result, true);
  if (!(await claimTab())) return;
  pending = storageRead(storageKey('pending'));
  await resume(); message('You’re in the arena! Tap weapons as you collect them.');
}

// Form registration
$('join-form').addEventListener('submit', async e => {
  e.preventDefault(); $('join').disabled = true;
  try {
    let claim = storageRead(storageKey('claim'));
    if (!claim) {
      claim = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (!storageWrite(storageKey('claim'), claim)) throw new Error('Enable browser storage before entering the competition.');
    }
    const result = await api('/api/join', { roll: $('roll').value.trim().toUpperCase(), claim });
    if (!saved) await start(result); else { adopt(result, true); await resume(); }
  } catch (e) { message(e.message, true); } finally { $('join').disabled = false; }
});

// Keyboard controls (Desktop / Tablet)
document.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;

  // Jump / Duck
  if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
    e.preventDefault();
    if (!e.repeat) action(e.code === 'ArrowDown' ? ACTION.DUCK : ACTION.JUMP);
    return;
  }

  // Letters A-Z (DinoSwords Weapons)
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.code.startsWith('Key')) {
    const letter = e.code.slice(3).toUpperCase();
    const arm = ARMORY[letter];
    if (arm) {
      e.preventDefault();
      action(arm.action);
    }
  }
});

document.addEventListener('keyup', e => {
  if (e.code === 'ArrowDown') action(ACTION.RELEASE);
});

window.addEventListener('blur', () => action(ACTION.RELEASE));

// Touch & Mouse Controls for Phones
canvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  action(ACTION.JUMP);
});

$('jump').addEventListener('pointerdown', e => {
  e.preventDefault();
  action(ACTION.JUMP);
});
$('jump').addEventListener('click', e => {
  if (e.detail === 0) action(ACTION.JUMP);
});

$('duck').addEventListener('pointerdown', e => {
  e.preventDefault();
  $('duck').setPointerCapture(e.pointerId);
  action(ACTION.DUCK);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('duck').addEventListener(name, () => action(ACTION.RELEASE));
}

// Armory Handbook Modal Population
function setupHandbook() {
  const modal = $('armory-modal');
  const grid = $('armory-grid');
  grid.replaceChildren();

  for (const [key, arm] of Object.entries(ARMORY)) {
    const card = document.createElement('div');
    card.className = 'armory-card';

    const kBadge = document.createElement('span');
    kBadge.className = 'armory-card-key';
    kBadge.textContent = key;

    const body = document.createElement('div');
    body.className = 'armory-card-body';

    const title = document.createElement('h4');
    title.textContent = `${WEAPON_ICONS[key] || ''} ${arm.name}`;

    const uses = document.createElement('span');
    uses.className = 'armory-card-uses';
    uses.textContent = arm.uses === -1 ? 'Uses: Infinite (∞)' : `Uses: ${arm.uses}`;

    const desc = document.createElement('p');
    desc.className = 'armory-card-desc';
    desc.textContent = arm.desc;

    body.append(title, uses, desc);
    card.append(kBadge, body);
    grid.append(card);
  }

  $('btn-handbook').addEventListener('click', () => modal.showModal());
  $('close-modal').addEventListener('click', () => modal.close());
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.close();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspended = true;
  else if (saved && ownsTab && !busy) resume().catch(() => { suspended = true; });
});

addEventListener('online', () => {
  if (saved && ownsTab && !busy) {
    retryAt = 0;
    if (pending) saveCheckpoint(); else resume().catch(() => {});
  }
});

setInterval(() => {
  if (suspended && saved && ownsTab && !document.hidden && !busy && performance.now() >= retryAt) {
    busy = true; resume().catch(() => { retryAt = performance.now() + 2000; }).finally(() => { busy = false; });
  }
}, 1500);

async function boot() {
  setupHandbook();
  try {
    event = await api('/api/event');
    lastCheckpoint = 30 + Math.random() * 300;
    const recovery = new URLSearchParams(location.hash.slice(1)).get('recover');
    if (recovery) {
      history.replaceState(null, '', location.pathname + location.search);
      await start(await api('/api/recover', { ticket: recovery }));
    } else {
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
  try {
    const result = await api('/api/ready', {});
    saved.ready = result.ready;
    $('ready').textContent = 'Ready ✓';
    $('ready-hint').textContent = 'You’re ready. Wait for the organizer to start.';
  } catch (error) {
    $('ready').disabled = false;
    message(error.message, true);
  }
});

async function watchStart() {
  if (event?.status === 'lobby' || event?.status === 'unscheduled') {
    try { await api('/api/event'); } catch {}
  }
  setTimeout(watchStart, 800 + Math.random() * 200);
}

requestAnimationFrame(tick);
boot();
watchStart();
