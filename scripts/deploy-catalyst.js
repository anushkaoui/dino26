// CI deploys code only. No schema import, record deletion or secret generation.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export function deployArgs(env) {
  const project = env.CATALYST_PROJECT_ID, org = env.CATALYST_ORG_ID;
  const name = env.CATALYST_APP_NAME;
  if (!/^[0-9]+$/.test(project || '') || !/^[0-9]+$/.test(org || ''))
    throw new Error('Set numeric CATALYST_PROJECT_ID and CATALYST_ORG_ID for the imported project.');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(name || ''))
    throw new Error('Set CATALYST_APP_NAME to the EXISTING AppSail service name.');
  if (!env.CATALYST_TOKEN) throw new Error('Set CATALYST_TOKEN as a secret pipeline variable.');
  if (env.CATALYST_DC && env.CATALYST_DC !== 'in') throw new Error('This deployment targets the India data center.');
  return ['deploy', 'appsail', '--name', name, '--build-path', resolve('build'), '--stack', 'node22',
    '--command', 'node server/main.js', '--project', project, '--org', org, '--dc', 'in'];
}
async function main() {
  const args = deployArgs(process.env);
  await access('build/server/main.js');
  const config = JSON.parse(await readFile('app-config.json', 'utf8'));
  if (Object.keys(config.env_variables || {}).length) throw new Error('Keep runtime variables in Catalyst, not the deployment file.');
  console.log('Deploying code to the existing DEVELOPMENT AppSail service. Database rows and schema are not part of this deployment.');
  const child = spawn('catalyst', args, { stdio: 'inherit', shell: false, env: { ...process.env, CI: 'true' } });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
