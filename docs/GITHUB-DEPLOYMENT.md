# GitHub → Catalyst Pipelines → AppSail

This repository includes `catalyst-pipelines.yaml`. Pushes or merges to `main` trigger install, all backend tests, packaging and an AppSail DEVELOPMENT deployment in that order. A failed test prevents deployment. Catalyst's CLI deploys resources to Development; publishing to Production requires promotion in the console. This is not fully automatic Production deployment.

No Git repository exists in this directory yet. No GitHub repository was created, pushed, connected or deployed by the agent. Create an empty private GitHub repository with no initial README, license or `.gitignore`.

## Push the source

From the project directory, run these commands, replacing the GitHub URL:

```sh
git init -b main
git add .
git status --short
git commit -m "Add GDG Dino game and Catalyst pipeline"
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

Before committing, confirm `.env`, `node_modules`, `data`, `build`, `exports` and `reports` are absent from the staged files. They are ignored. Keep the source, package lock, tests, deployment scripts and root pipeline YAML in Git. Use GitHub's normal authentication; do not put access tokens in the remote URL. If pushing is rejected because the remote already contains files, stop and reconcile the histories; do not force-push.

## One-time Catalyst setup

1. Open the project created by the successful schema IaC import. Verify the three tables exist. Do not rerun an IaC import on each release: it creates another project.
2. Create the AppSail service once using the console upload instructions. Name it `gdg-dino` (or record the actual existing service name), choose Node.js 22, startup `node server/main.js`, and initial memory 512 MB. The pipeline deploys to this same service name in this same project. Configure `STORE_MODE=catalyst`, `EVENT_ID=gdg-qualifier`, the exact `APP_ORIGIN`, `SESSION_SECRET`, `ADMIN_KEY`, and `ORGANIZER_PASSWORD` in AppSail. Keep secrets private and stable. AppSail runtime variables are separate from pipeline variables.
3. Install the pinned CLI locally and generate a token for the India account:

```sh
npm install -g zcatalyst-cli@1.28.0
catalyst login --dc in
catalyst token:generate --dc in
```

Complete Zoho's verification in your browser. Save the resulting token as a secret, not in source control. Revoke and replace it if exposed or expired.

4. In the Catalyst console, open **Pipelines → Create Pipeline**. Name it `gdg-dino-main`, choose **GitHub**, add your account, select the owner and repository, then Continue. Use the existing `catalyst-pipelines.yaml` on `main`; do not replace it with an unrelated template.
5. Under **Global Variables**, add:

| Variable | Value |
| --- | --- |
| CATALYST_TOKEN | Secret token generated above |
| CATALYST_PROJECT_ID | Numeric ID of the IMPORTED project |
| CATALYST_ORG_ID | Numeric Catalyst organization ID |
| CATALYST_APP_NAME | Exact existing AppSail name, e.g. gdg-dino |
| DOCKER_USERNAME | Docker Hub username for runner image pulls |
| DOCKER_TOKEN | Secret Docker Hub access token with read access |

Use the console's secret/protected setting where available. The Docker credentials authenticate pulling the Node.js runner image; they are not installed into the game. Find the project ID in Project Settings/General or the project's console URL, and the organization ID in your Catalyst organization details. Do not substitute the app's ZAID or subscription ID. All targets are explicit; no old project IDs from screenshots are hardcoded.

6. Save/commit the pipeline configuration through Catalyst. If Catalyst commits a change, run `git pull --ff-only` before your next push. Its Git integration triggers runs on push/merge; the YAML restricts execution to `refs/heads/main`.
7. Check **Execution History**: install, tests, build and deploy must all succeed. Open the DEVELOPMENT `/api/health`; expect `ok: true` and `mode: catalyst`. Verify the development AppSail origin matches its `APP_ORIGIN`.

## Release to Production

After a successful pipeline run, go to **Settings → Project Settings → Environments → Deployments** and promote Development to Production. First activation requires payment setup and migrates all configured components/data. On subsequent releases, select the AppSail code change and review the deployment diff. Do not overwrite Production database rows with development practice records or introduce schema changes as part of a routine code release.

Set the Production AppSail variables separately, especially its HTTPS `APP_ORIGIN`. Check the Production health URL and manually test a separate practice room before the prize event. The pipeline updates Development automatically; the Production URL changes only after successful promotion.

Do not release during a live prize round. Persisted inputs are replayed using `shared/engine.js`; keep its rules/version compatible with retained records. Rule changes require an intentional version/migration strategy, not replacing the engine mid-round. Redeploying code in the existing project/service does not import, truncate or delete Data Store rows. Keep `SESSION_SECRET` and the public origin stable to preserve sessions.

## Record limits and persistence checks

`server/store.js` validates every production insert without truncating fields. Keys are at most 150 characters, event IDs 40, rolls 8, claim hashes/digests 64 and Text payloads 10,000. Int values are nonnegative signed-32-bit values; BigInt ranking values must also be safe JavaScript integers. Startup checks reject incorrect types, missing mandatory flags, insufficient string capacity, missing unique Key constraints, and unintended unique constraints on other custom columns.

The local suite verifies maximum event IDs, 80 gameplay inputs, five-minute rounds, 500-player final pages, restart recovery, concurrent Start, durable acknowledgement, CSV/audit exports and replay corruption detection. These are local checks, not verification of the imported live schema. Production `/api/health` runs the provider schema checks, and a real saved-score/redeploy/export practice test is still required. A complete 500-player deployed load test is also outstanding.

No release step recreates schema, deletes scores, rotates keys, or copies local `data/` onto Catalyst. Keep the same project, keep original records, and download Final CSV plus Full audit JSONL after each room freezes. For CLI backups use `EXPORT_ROOM` with the `room` value in that room's URL.

Sources:

- https://docs.catalyst.zoho.com/en/pipelines/help/pipelines/create-a-pipeline/
- https://docs.catalyst.zoho.com/en/pipelines/help/triggers/introduction/
- https://docs.catalyst.zoho.com/en/pipelines/help/deployments/deploy-to-appsail/
- https://docs.catalyst.zoho.com/en/cli/v1/deploy-resources/introduction/
- https://docs.catalyst.zoho.com/en/pipelines/help/catalyst-pipelines.yaml/build-the-pipeline/variables/
