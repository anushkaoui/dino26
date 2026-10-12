# Automatic Catalyst schema setup

The schema-only IaC ZIP creates a NEW development project. It does not modify an existing project, import game records, or deploy AppSail.

Regenerate locally:

```sh
node scripts/schema-template.js
python3 - <<'PY'
from zipfile import ZipFile, ZIP_DEFLATED
with ZipFile('deploy/gdg-dino-schema.zip', 'w', ZIP_DEFLATED) as archive:
    archive.write('deploy/schema/project-template-1.0.0.json', 'project-template-1.0.0.json')
PY
```

In the India Catalyst console: General Settings → Infrastructure as Code → IaC Imports → Import New Project. Name the new project `GDG Dino`, upload `deploy/gdg-dino-schema.zip`, and click Import. Open Access Project after success. If you already created an empty project, use a distinct project name; do not delete existing data.

Check all three tables and 15 custom columns, mandatory flags, and unique Key constraints after import. App User has no direct table permissions; App Administrator has backend access. Deploy the game's AppSail ZIP into this imported project, then promote it to Production using the deployment instructions.

This template follows Zoho's documented IaC structure, but has not been imported into a live Catalyst account. If import fails, use View Error Log and preserve its exact error before changing the template. A successful import plus `/api/health` is required to confirm provider compatibility.

Source: https://docs.catalyst.zoho.com/en/getting-started/set-up-a-catalyst-project/iac-settings/
