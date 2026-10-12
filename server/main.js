import { LocalStore, CatalystStore } from './store.js';
import { GameService } from './service.js';
import { createApp } from './http.js';
const production = process.env.STORE_MODE === 'catalyst';
if (!['local', 'catalyst'].includes(process.env.STORE_MODE || 'local')) throw new Error('Invalid STORE_MODE');
if (process.env.X_ZOHO_CATALYST_LISTEN_PORT && !production) throw new Error('AppSail requires STORE_MODE=catalyst. Local storage is not durable there.');
const secret = process.env.SESSION_SECRET, adminKey = process.env.ADMIN_KEY;
const organizerPassword = process.env.ORGANIZER_PASSWORD || adminKey;
if (process.env.ORGANIZER_PASSWORD && process.env.ORGANIZER_PASSWORD.length < 12) throw new Error('ORGANIZER_PASSWORD must be at least 12 characters');
if (!secret || secret.length < 32 || !adminKey || adminKey.length < 32 || secret === adminKey)
  throw new Error('Set distinct SESSION_SECRET and ADMIN_KEY values of at least 32 characters. Run node scripts/setup-local.js for development.');
const eventKey = process.env.EVENT_ID || 'gdg-qualifier';
if (!/^[a-z0-9_-]{1,40}$/.test(eventKey)) throw new Error('EVENT_ID must be 1–40 lowercase letters, digits, underscores or hyphens');
const port = Number(process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || 3000);
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
if (production && !origin.startsWith('https://')) throw new Error('APP_ORIGIN must be the exact HTTPS AppSail URL');
const service = new GameService({ secret, eventKey });
let local, storeForRequest;
if (production) {
  const { zcAuth } = await import('@zcatalyst/auth');
  const { Datastore } = await import('@zcatalyst/datastore');
  let schemaReady = null;
  storeForRequest = async req => {
    const store = new CatalystStore(new Datastore(await zcAuth.init(req, { scope: 'admin' })));
    if (!schemaReady) schemaReady = store.validateSchema().catch(error => { schemaReady = null; throw error; });
    await schemaReady;
    return store;
  };
} else {
  local = await new LocalStore(process.env.DATA_DIR || './data').init();
  storeForRequest = async () => local;
}
const server = createApp({ service, storeForRequest, adminKey, organizerPassword, origin, production, localOrganizerAccess: !production });
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, production ? '0.0.0.0' : '127.0.0.1', () => console.log(`GDG Dino Run (${production ? 'Catalyst' : 'local'}) at ${origin}`));
let closing = false;
async function stop() {
  if (closing) return; closing = true;
  server.close(async () => { if (local) await local.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
