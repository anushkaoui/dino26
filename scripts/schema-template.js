// Generate a schema-only Catalyst IaC template from the runtime schema.
// This creates local files only; it does not connect to Catalyst.
import { mkdir, writeFile } from 'node:fs/promises';
import { SCHEMA } from '../server/store.js';

const definitions = [];
for (const [table, columns] of Object.entries(SCHEMA)) {
  const dependsOn = [`Datastore.table.${table}`];
  definitions.push({ type: 'table', name: table, properties: { table_name: table }, dependsOn: [] });
  for (const [column, [type, size]] of Object.entries(columns)) {
    definitions.push({ type: 'column', name: `${table}-${column}`, properties: {
      column_name: column, data_type: type, is_unique: column === 'Key', is_mandatory: true,
      search_index_enabled: false, table_id: table, table_name: table,
      ...(size ? { max_length: size } : {})
    }, dependsOn });
  }
  for (const role of ['App Administrator', 'App User']) {
    definitions.push({ type: 'tableScope', name: `${table}-${role}`, properties: {
      role_name: role, table_scope: 'GLOBAL', type: role, table_name: table
    }, dependsOn });
    definitions.push({ type: 'tablePermission', name: `${table}-${role}`, properties: {
      role_name: role, type: role, table_name: table,
      table_permissions: role === 'App Administrator' ? ['SELECT', 'UPDATE', 'INSERT', 'DELETE'] : []
    }, dependsOn });
  }
}
await mkdir('deploy/schema', { recursive: true });
await writeFile('deploy/schema/project-template-1.0.0.json', JSON.stringify({
  name: 'project-template', version: '1.0.0', parameters: {}, components: { Datastore: definitions }
}, null, 2) + '\n');
console.log('Created deploy/schema/project-template-1.0.0.json (3 tables, 15 custom columns).');
