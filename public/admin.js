const $ = id => document.getElementById(id);
let room = new URLSearchParams(location.search).get('room'), event, authenticated = false, creatingId = null;
let baseServer = Date.now(), basePerf = performance.now(), qrObjectUrl, refreshing = false;
const now = () => baseServer + performance.now() - basePerf;
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('notice', error); }
async function call(path, data, scoped = true) {
  const url = new URL(path, location.origin);
  if (scoped && room) url.searchParams.set('room', room);
  const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Dino-Request': '1' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    if (response.status === 401) { authenticated = false; $('controls').hidden = true; $('login-panel').hidden = false; }
    throw new Error((await response.json()).message);
  }
  return response;
}
function action(id, fn) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try { await fn(); } catch (error) { status(error.message, true); } finally { $(id).disabled = false; renderClock(); }
  });
}
function setEvent(value) {
  event = value; baseServer = value.serverNow; basePerf = performance.now();
  $('room-name').textContent = value.name; $('qr-room-name').textContent = value.name;
  $('room-panel').hidden = false; $('create-panel').hidden = true;
  $('results-panel').hidden = false; $('recovery-panel').hidden = false;
  $('start-game').hidden = value.opensAt != null;
  $('new-room').hidden = value.closesAt == null || now() < value.closesAt;
  renderClock();
}
function renderClock() {
  if (!event) return;
  const live = event.opensAt != null && now() >= event.opensAt && now() < event.closesAt;
  const countdown = event.opensAt != null && now() < event.opensAt;
  const seconds = Math.max(0, Math.ceil((countdown ? event.opensAt - now() : event.closesAt != null ? event.closesAt - now() : event.rules.durationMs) / 1000));
  $('host-timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('host-timer-label').textContent = countdown ? 'STARTS IN' : live ? 'TIME LEFT' : event.closesAt != null ? 'ROUND ENDED' : 'GAME DURATION';
  $('room-state').textContent = countdown ? 'STARTING TOGETHER' : live ? 'GAME LIVE' : event.closesAt != null ? 'GAME ENDED' : 'WAITING ROOM';
  $('freeze').disabled = event.closesAt == null || now() <= event.closesAt + event.rules.lateMs + 30000;
  $('new-room').hidden = event.closesAt == null || now() < event.closesAt;
  $('room-hint').textContent = event.opensAt == null ? 'Start when everyone is ready. Players cannot play before you start.' : countdown ? 'Everyone starts together after this countdown.' : live ? 'The shared clock is running. Best run wins.' : 'Freeze and export the results once saves have settled.';
  $('qr-instruction').textContent = event.opensAt == null ? 'Enter your roll number and tap I’m ready. Wait for the organizer to start.' : countdown ? 'Get ready. The game starts in a moment.' : live ? 'The game is live. Scan to join for the remaining time.' : 'The competition has ended.';
}
async function refresh() {
  if (!authenticated || !room || refreshing) return;
  refreshing = true;
  try {
    const result = await (await call('/api/admin/lobby')).json(); setEvent(result.event);
    $('registered-count').textContent = result.registered; $('ready-count').textContent = result.ready;
    $('qr-registered').textContent = `${result.registered} registered`; $('qr-ready').textContent = `${result.ready} ready`;
    $('join-link').value = result.joinUrl; $('qr-player-link').textContent = result.joinUrl;
    $('qr-warning').textContent = ['localhost', '127.0.0.1', '::1'].includes(new URL(result.joinUrl).hostname) ?
      'This local preview link works on this computer. Use the deployed public URL for phones to scan.' : '';
  } catch (error) { status(error.message, true); } finally { refreshing = false; }
}
async function showQR() {
  if (!room) throw new Error('Create a competition first.');
  const blob = await (await call('/api/admin/qr')).blob();
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = URL.createObjectURL(blob); $('qr-image').src = qrObjectUrl;
  if (!$('qr-dialog').open) $('qr-dialog').showModal();
}
$('hide-qr').addEventListener('click', () => $('qr-dialog').close());
action('show-qr', showQR);
action('copy-link', async () => { await navigator.clipboard.writeText($('join-link').value); status('Player link copied.'); });
action('create', async () => {
  if (!creatingId) creatingId = 'gdg-' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
  room = creatingId;
  const result = await (await call('/api/admin/create', { name: $('name').value.trim(), minutes: Number($('minutes').value) })).json();
  creatingId = null; history.replaceState(null, '', `/admin?room=${encodeURIComponent(room)}`);
  setEvent(result); await refresh(); status('Waiting room created. Share the QR and start when everyone is ready.'); await showQR();
});
action('start-game', async () => {
  setEvent(await (await call('/api/admin/start', {})).json());
  status('Starting together in three seconds. The chosen game duration follows the countdown.');
});
action('new-room', async () => {
  room = null; event = null; creatingId = null; history.replaceState(null, '', '/admin');
  $('create-panel').hidden = false;
  for (const id of ['room-panel', 'results-panel', 'recovery-panel']) $(id).hidden = true;
  status('Create a new competition. Previous results remain saved under their room link.');
});
$('login-form').addEventListener('submit', async e => {
  e.preventDefault(); $('login').disabled = true;
  try {
    await call('/api/admin/login', { password: $('password').value }, false); $('password').value = '';
    authenticated = true; $('login-panel').hidden = true; $('controls').hidden = false; status('Organizer signed in.'); await refresh();
  } catch (error) { status(error.message, true); } finally { $('login').disabled = false; }
});
action('logout', async () => { await call('/api/admin/logout', {}, false); authenticated = false; $('controls').hidden = true; $('login-panel').hidden = false; $('qr-dialog').close(); status('Signed out.'); });
action('freeze', async () => { const result = await (await call('/api/admin/finalize', {})).json(); status(`Results frozen for ${result.participants} players. Download the final CSV and audit.`); });
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
action('export', async () => { download(await (await call('/api/admin/export')).blob(), `${room}-final.csv`); status('Final result CSV downloaded.'); });
action('live-export', async () => { download(await (await call('/api/admin/live-export')).blob(), `${room}-provisional.csv`); status('Current leaderboard downloaded. Use frozen results for prizes.'); });
action('recover', async () => {
  const result = await (await call('/api/admin/recovery', { roll: $('recovery-roll').value, verified: $('verified').checked })).json();
  $('recovery-link').value = `${location.origin}/?room=${encodeURIComponent(room)}#recover=${encodeURIComponent(result.ticket)}`;
  status('Recovery link created. Give it only to the verified participant.');
});
action('archive', async () => {
  const e = await (await call('/api/event')).json(), board = await (await call('/api/leaderboard')).json();
  const lines = [JSON.stringify({ kind: 'header', version: 1, event: e.id, beganAt: Date.now(), final: !!board.final }) + '\n'], counts = {};
  for (const table of ['DinoEvents', 'DinoEntries', 'DinoCheckpoints']) {
    let after = ''; counts[table] = 0;
    do {
      const page = await (await call(`/api/admin/archive?table=${table}&after=${encodeURIComponent(after)}`)).json();
      const bytes = new TextEncoder().encode(JSON.stringify(page.rows));
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== page.digest || page.table !== table || page.event.id !== e.id || (page.next && page.next <= after)) throw new Error('Archive integrity check failed. Download again.');
      lines.push(JSON.stringify({ kind: 'page', ...page }) + '\n'); counts[table] += page.rows.length; after = page.next;
      status(`Copying ${table}: ${counts[table]} records…`);
    } while (after);
  }
  lines.push(JSON.stringify({ kind: 'complete', counts, endedAt: Date.now(), finalAtStart: !!board.final }) + '\n');
  download(new Blob(lines, { type: 'application/x-ndjson' }), `${e.id}-audit-${Date.now()}.jsonl`);
  status(`Audit downloaded: ${counts.DinoEntries} entries, ${counts.DinoCheckpoints} checkpoints.`);
});
async function boot() {
  try {
    const session = await (await call('/api/admin/session', undefined, false)).json(); authenticated = session.authenticated;
    $('controls').hidden = !authenticated; $('login-panel').hidden = authenticated;
    status(authenticated ? session.local ? 'Organizer controls ready on this computer.' : 'Organizer signed in.' : 'Sign in to manage competitions.');
    if (authenticated) await refresh();
  } catch (error) { status(error.message, true); }
}
setInterval(refresh, 2000); setInterval(renderClock, 250); boot();
