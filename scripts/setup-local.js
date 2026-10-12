import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const text = `STORE_MODE=local\nPORT=3000\nAPP_ORIGIN=http://localhost:3000\nEVENT_ID=gdg-qualifier\nSESSION_SECRET=${randomBytes(32).toString('hex')}\nADMIN_KEY=${randomBytes(32).toString('hex')}\nDATA_DIR=./data\n`;
try { await writeFile('.env', text, { flag: 'wx', mode: 0o600 }); console.log('Created .env. Run npm run dev. Read ADMIN_KEY locally from .env for /admin.'); }
catch (e) { if (e.code !== 'EEXIST') throw e; console.log('.env already exists; kept existing session and organizer keys.'); }
