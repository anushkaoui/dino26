import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HttpError, requireThat } from './errors.js';
import { equal, hash, sign, verify, Limiter } from './security.js';
import { SCHEMA } from './store.js';
import QRCode from 'qrcode';
const staticFiles = new Map([
  ['/', ['../public/index.html', 'text/html']], ['/style.css', ['../public/style.css', 'text/css']],
  ['/app.js', ['../public/app.js', 'text/javascript']], ['/engine.js', ['../shared/engine.js', 'text/javascript']],
  ['/admin', ['../public/admin.html', 'text/html']], ['/admin.js', ['../public/admin.js', 'text/javascript']]
]);
const cookieName = 'gdg_dino';
function getCookie(req, name = cookieName) {
  return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
}
async function body(req) {
  requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'JSON_REQUIRED', 'Use JSON requests.');
  requireThat(req.headers['x-dino-request'] === '1', 403, 'BAD_REQUEST_ORIGIN', 'Request header is missing.');
  const parts = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= 8192, 413, 'BODY_TOO_LARGE', 'Request is too large.');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new HttpError(400, 'BAD_JSON', 'Invalid JSON.'); }
}
function csv(board) {
  return 'rank,roll_number,best_score,achieved_frame\n' + board.rows.map(r =>
    [r.rank, r.roll, r.score, r.achievedFrame ?? ''].join(',')).join('\n') + '\n';
}
export function createApp({ service: defaultService, storeForRequest, adminKey, organizerPassword = adminKey, origin,
  production = false, localOrganizerAccess = false, logger = console }) {
  const services = new Map([[defaultService.eventKey, defaultService]]), authLimiter = new Limiter();
  function organizer(req) {
    if (equal(req.headers.authorization, `Bearer ${adminKey}`)) return true;
    try {
      const session = verify(getCookie(req, 'gdg_organizer'), defaultService.secret, defaultService.now(), 'organizer');
      return equal(session.fingerprint, hash(organizerPassword));
    } catch (error) { if (error instanceof HttpError) return false; throw error; }
  }
  const share = service => `${origin}/?room=${encodeURIComponent(service.eventKey)}`;
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    function json(status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
    function setSession(token) {
      res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${production ? '; Secure' : ''}`);
    }
    function setOrganizer() {
      const token = sign({ type: 'organizer', exp: defaultService.now() + 12 * 3600000,
        fingerprint: hash(organizerPassword) }, defaultService.secret);
      res.setHeader('Set-Cookie', `gdg_organizer=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${production ? '; Secure' : ''}`);
    }
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && staticFiles.has(path)) {
        const [file, type] = staticFiles.get(path);
        const data = await readFile(fileURLToPath(new URL(file, import.meta.url)));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(data); return;
      }
      requireThat(path.startsWith('/api/'), 404, 'NOT_FOUND', 'Page was not found.');
      if (req.headers.origin) requireThat(req.headers.origin === origin, 403, 'BAD_REQUEST_ORIGIN', 'Use the game website to make requests.');
      if (req.method === 'GET' && path === '/api/admin/session') {
        const local = localOrganizerAccess && !production && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (local) setOrganizer();
        return json(200, { authenticated: local || organizer(req), local });
      }
      if (req.method === 'POST' && path === '/api/admin/login') {
        authLimiter.use(`login:${req.socket.remoteAddress}`, 8, 60000, defaultService.now());
        const login = await body(req);
        requireThat(login && Object.keys(login).length === 1 && equal(login.password, organizerPassword),
          401, 'ADMIN_REQUIRED', 'Organizer password is incorrect.');
        setOrganizer(); return json(200, { authenticated: true });
      }
      const isAdmin = path.startsWith('/api/admin/');
      if (isAdmin) requireThat(organizer(req), 401, 'ADMIN_REQUIRED', 'Sign in as the organizer.');
      if (req.method === 'POST' && path === '/api/admin/logout') {
        await body(req);
        res.setHeader('Set-Cookie', `gdg_organizer=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? '; Secure' : ''}`);
        return json(200, { authenticated: false });
      }
      const room = new URL(req.url, 'http://localhost').searchParams.get('room') || defaultService.eventKey;
      requireThat(/^[a-z0-9_-]{1,40}$/.test(room), 400, 'BAD_ROOM', 'Invalid competition link.');
      if (!services.has(room)) {
        if (services.size >= 256) services.delete(services.keys().next().value);
        services.set(room, new defaultService.constructor({ secret: defaultService.secret, eventKey: room, now: defaultService.now }));
      }
      const service = services.get(room);
      const data = req.method === 'POST' ? await body(req) : null;
      const store = await storeForRequest(req);
      if (req.method === 'GET' && path === '/api/event') return json(200, service.publicEvent(await service.event(store)));
      if (req.method === 'GET' && path === '/api/leaderboard') return json(200, await service.leaderboard(store));
      if (req.method === 'GET' && path === '/api/health') {
        await store.get('DinoEvents', service.eventKey);
        return json(200, { ok: true, mode: production ? 'catalyst' : 'local', engineVersion: 1 });
      }
      if (req.method === 'POST' && path === '/api/join') {
        // LAN audiences share an IP: do not set a small per-IP registration cap.
        service.limiter.use(`join:${req.socket.remoteAddress}`, 1500, 60000, service.now());
        const result = await service.join(store, data, getCookie(req));
        setSession(result.token); delete result.token; return json(200, result);
      }
      if (req.method === 'POST' && path === '/api/recover') {
        service.limiter.use(`recover:${req.socket.remoteAddress}`, 1500, 60000, service.now());
        const result = await service.recover(store, data);
        setSession(result.token); delete result.token; return json(200, result);
      }
      if (req.method === 'POST' && path === '/api/admin/schedule') return json(200, await service.schedule(store, data));
      if (req.method === 'POST' && path === '/api/admin/create') return json(200, { ...(await service.createRoom(store, data)), joinUrl: share(service) });
      if (req.method === 'POST' && path === '/api/admin/start') return json(200, await service.startRoom(store, data));
      if (req.method === 'GET' && path === '/api/admin/lobby') return json(200, { ...(await service.lobby(store)), joinUrl: share(service) });
      if (req.method === 'GET' && path === '/api/admin/qr') {
        await service.mustEvent(store);
        const svg = await QRCode.toString(share(service), { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 640 });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' }); return res.end(svg);
      }
      if (req.method === 'POST' && path === '/api/admin/recovery') return json(200, await service.recoveryTicket(store, data));
      if (req.method === 'POST' && path === '/api/admin/finalize') return json(200, await service.finalize(store));
      if (req.method === 'GET' && path === '/api/admin/archive') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const table = query.get('table'), after = query.get('after') || '';
        requireThat(Object.hasOwn(SCHEMA, table) && (!after ||
          /^[A-Za-z0-9_:-]{1,150}$/.test(after) && (after === service.eventKey || after.startsWith(service.eventKey + ':'))),
          400, 'BAD_ARCHIVE_CURSOR', 'Use a valid table and event cursor.');
        const rows = await store.archivePage(table, service.eventKey, after);
        return json(200, { version: 1, event: service.publicEvent(await service.event(store)), table,
          asOf: service.now(), final: !!(await service.finalResults(store)), rows,
          digest: hash(JSON.stringify(rows)), next: rows.length === 300 ? rows.at(-1).Key : null });
      }
      if (req.method === 'GET' && path === '/api/admin/live-export') {
        const board = await service.leaderboard(store, true);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="gdg-dino-provisional.csv"' }); return res.end(csv(board));
      }
      if (req.method === 'GET' && path === '/api/admin/export') {
        const board = await service.finalResults(store);
        requireThat(board, 409, 'FINALIZE_FIRST', 'Finalize the results before exporting prizes.');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="gdg-dino-results.csv"' }); return res.end(csv(board));
      }
      if (req.method === 'GET' && path === '/api/admin/audit') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const roll = query.get('roll'), after = Number(query.get('after') ?? -1);
        requireThat(/^[A-Z0-9]{8}$/.test(roll) && Number.isSafeInteger(after) && after >= -1,
          400, 'BAD_AUDIT', 'Provide an uppercase roll number and valid cursor.');
        return json(200, { rows: await store.audit(`${service.eventKey}:${roll}`, after) });
      }
      if (['/api/state', '/api/checkpoint', '/api/sync', '/api/ready'].includes(path)) {
        const entry = await service.authenticate(store, getCookie(req));
        if (req.method === 'GET' && path === '/api/state') return json(200, await service.state(store, entry));
        if (req.method === 'POST' && path === '/api/checkpoint') return json(200, await service.checkpoint(store, entry, data));
        if (req.method === 'POST' && path === '/api/sync') return json(200, await service.sync(store, entry, data));
        if (req.method === 'POST' && path === '/api/ready') return json(200, await service.ready(store, entry, data));
      }
      throw new HttpError(404, 'NOT_FOUND', 'API route was not found.');
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof HttpError) {
        if (error.status === 429) res.setHeader('Retry-After', '2');
        return json(error.status, { error: error.code, message: error.message, ...error.details });
      }
      // Do not log request bodies, cookies, entry credentials, or provider errors.
      logger.error('Request failed', { type: error.name || 'Error' });
      json(503, { error: 'TEMPORARILY_UNAVAILABLE', message: 'Connection interrupted. Your saved score is safe. Reconnecting…' });
    }
  });
}
