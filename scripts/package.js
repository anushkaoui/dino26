import { mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const destination = resolve('build');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
// Allowlist excludes .env, browser session data, journals, tests and reports.
for (const path of ['server', 'shared', 'public', 'node_modules', 'package-lock.json']) await cp(path, `${destination}/${path}`, { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.scripts = { start: 'node server/main.js' };
await writeFile(`${destination}/package.json`, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Catalyst build prepared at ${destination}. Configure production environment variables before deployment.`);
