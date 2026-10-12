# GitHub source and manual AppSail deployment

Keep the source in GitHub. Deploy the app manually by uploading a runtime ZIP to the same Catalyst AppSail service after changes. This process requires no pipeline, Catalyst deployment token, global CLI installation or Docker setup.

## Stop the previous automation

Disable the Git push trigger on the Catalyst Pipeline you already created, or remove that pipeline connection. Keep the Catalyst project and its tables. The newly prepared GitHub Actions workflow has been removed locally. If you already uploaded that workflow to GitHub, commit its deletion or disable it in GitHub Actions as well.

The root `catalyst-pipelines.yaml` is retained only as a legacy alternative; it is unused by this manual process.

## GitHub integration limitations

To link your account, open Catalyst **Settings → General Settings → Integrations → GitHub → Add Account**, if available, and authorize GitHub. The legacy deployment integration is documented for Functions and Web Client Hosting, requires a standard Catalyst project directory with `catalyst.json`, and is restricted to accounts active before July 2024 or accounts that already integrated repositories.

This repository is a Node.js AppSail service. Connecting GitHub alone does not establish a verified deployment path for it, and legacy Deploy/Sync should not be treated as an AppSail update. Keep the existing architecture and use the build upload below. Do not add a dummy `catalyst.json` to make the repository appear compatible.

## After each code change

Push the source to GitHub normally. From the current project checkout, build and create the upload ZIP:

```sh
npm ci
npm run build
rm -f gdg-dino-appsail.zip
(cd build && zip -qr ../gdg-dino-appsail.zip .)
```

The ZIP must have `package.json`, `server/`, `shared/`, `public/` and `node_modules/` at its root, without an outer `build/` directory. The build allowlist excludes local `.env`, score journals, exports and reports. Do not upload a GitHub source-download ZIP, the schema ZIP, or the old project IaC ZIP as the app build.

1. Open the existing imported Catalyst project in **Development**.
2. Go to **Serverless → AppSail → your existing service → Deployments → Create Deployment**. If no service exists yet, choose **AppSail → Deploy from Console** and create it once, e.g. `gdg-dino`.
3. Choose **Catalyst-Managed Runtime**, upload `gdg-dino-appsail.zip`, select **Node.js 22**, and set startup command to **`node server/main.js`**. Start with 512 MB memory.
4. Retain the runtime variables listed below and click **Deploy**. Open `/api/health` on the resulting app URL; it should return `ok: true` and `mode: catalyst`.
5. To release the public event site, go to **Settings → Project Settings → Environments → Deployments** and promote the AppSail code to Production. Review the deployment selection so a routine release does not copy practice database rows over Production data. Initial Production activation is a separate setup step.
6. Check the Production health URL and manually test a separate practice room.

Keep these variables configured in AppSail, separately for Development and Production:

| Variable | Value |
| --- | --- |
| STORE_MODE | catalyst |
| EVENT_ID | gdg-qualifier |
| APP_ORIGIN | That environment's exact HTTPS app origin, no trailing slash |
| SESSION_SECRET | Stable random secret, at least 32 characters |
| ADMIN_KEY | Different stable random secret, at least 32 characters |
| ORGANIZER_PASSWORD | Private organizer password, at least 12 characters |

Use the same project and service. Retain the session secret across releases. Never rerun the schema import to update code. Uploading the app build does not include database records or schema operations.

Do not release during a live prize round. Persisted inputs are replayed using `shared/engine.js`; keep its rules/version compatible with retained records. Export Final CSV and Full audit JSONL after each room freezes.

The agent has prepared the local build workflow; it has not connected an account or deployed this app to Catalyst.

## Record limits and persistence checks

`server/store.js` validates every production insert without truncating fields. Keys are at most 150 characters, event IDs 40, rolls 8, claim hashes/digests 64 and Text payloads 10,000. Int values are nonnegative signed-32-bit values; BigInt ranking values must also be safe JavaScript integers. Startup checks reject incorrect types, missing mandatory flags, insufficient string capacity, missing unique Key constraints, and unintended unique constraints on other custom columns.

The local suite verifies maximum event IDs, 80 gameplay inputs, five-minute rounds, 500-player final pages, restart recovery, concurrent Start, durable acknowledgement, CSV/audit exports and replay corruption detection. These are local checks, not verification of the imported live schema. Production `/api/health` runs the provider schema checks, and a real saved-score/redeploy/export practice test is still required. A complete 500-player deployed load test is also outstanding.

No release step recreates schema, deletes scores, rotates keys, or copies local `data/` onto Catalyst. Keep the same project, keep original records, and download Final CSV plus Full audit JSONL after each room freezes. For CLI backups use `EXPORT_ROOM` with the `room` value in that room's URL.

Sources:

- [GitHub integration scope and availability](https://docs.catalyst.zoho.com/en/devops/help/github-integration/introduction/)
- [GitHub account linking and legacy Deploy/Sync](https://docs.catalyst.zoho.com/en/devops/help/github-integration/implementation/)
- [AppSail console upload](https://docs.catalyst.zoho.com/en/serverless/help/appsail/catalyst-managed-runtimes/deploy-from-console/)
- [New deployment on an existing AppSail service](https://docs.catalyst.zoho.com/en/serverless/help/appsail/console/deployments/)
