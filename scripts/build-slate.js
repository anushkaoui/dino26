import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Slate publishes these files. Runtime code, dependencies and secrets stay out.
const destination = resolve('dist');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of ['index.html', 'admin.html', 'style.css', 'app.js', 'admin.js'])
  await cp(`public/${file}`, `${destination}/${file}`);
await cp('shared/engine.js', `${destination}/engine.js`);
await mkdir(`${destination}/admin`, { recursive: true });
await cp('public/admin.html', `${destination}/admin/index.html`);
console.log(`Slate frontend prepared at ${destination}. The /api routes still require a connected backend; this build does not deploy one.`);
