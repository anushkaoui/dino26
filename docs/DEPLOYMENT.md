# Catalyst deployment

This app targets one AppSail Node.js 22 service serving both static files and the API, backed by Catalyst Data Store. Use production for the actual event. No deployment or provider spending has been performed by this agent.

Keep the source on GitHub and follow [manual deployment](GITHUB-DEPLOYMENT.md) to upload a runtime ZIP through AppSail's console after changes. No pipeline, deployment token or Docker setup is required. Use the existing imported project/service and configure runtime variables in Catalyst.

## 1. Create the Data Store schema

Create these three tables with the exact names and custom columns below. All custom columns are **mandatory**. Every **Key** column must have **IsUnique enabled when created**. Do not make Roll, EventKey, EntryKey, Seq or RankValue individually unique. Catalyst's default ROWID, CREATORID, CREATEDTIME and MODIFIEDTIME columns remain.

| Table | Column | Type / minimum size | Unique |
| --- | --- | --- | --- |
| DinoEvents | Key | Var Char 150 | Yes |
| DinoEvents | EventKey | Var Char 40 | No |
| DinoEvents | Payload | Text | No |
| DinoEntries | Key | Var Char 150 | Yes |
| DinoEntries | EventKey | Var Char 40 | No |
| DinoEntries | Roll | Var Char 8 | No |
| DinoEntries | ClaimHash | Var Char 64 | No |
| DinoEntries | Payload | Text | No |
| DinoCheckpoints | Key | Var Char 150 | Yes |
| DinoCheckpoints | EventKey | Var Char 40 | No |
| DinoCheckpoints | EntryKey | Var Char 150 | No |
| DinoCheckpoints | Seq | Int | No |
| DinoCheckpoints | RankValue | BigInt | No |
| DinoCheckpoints | Digest | Var Char 64 | No |
| DinoCheckpoints | Payload | Text | No |

`Payload` uses Catalyst Text's 10,000-character capacity. The server checks column types, mandatory flags, sizes and unique keys before serving production API requests. Bad/missing schema fails closed. Keep these tables accessible only through the privileged backend; do not grant anonymous browser clients direct Data Store writes. The game exposes its own roll-number registration and signed cookie, so public gameplay must not require a separate Catalyst user login.

Schema checks are memoized per instance after a successful check. Do not change schema or uniqueness during a round; restart/redeploy after a correction. The exact SDK query response for `MAX(RankValue)` must be verified in your deployed project. Unsupported result shapes fail with 503 rather than substituting zero scores.

Sources: [column types and constraints](https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns/), [metadata API](https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/data-store/get-all-columns-metadata/), [ZCQL grouping](https://docs.catalyst.zoho.com/en/cloud-scale/help/zcql/groupby-orderby/).

## 2. Build and configure AppSail

```sh
npm ci
npm run build
```

`build/` contains only runtime code, public assets, pinned dependencies and package metadata. It excludes `.env`, journals, exports and test reports. Upload/deploy that directory, select Node.js 22, and set the startup command to `node server/main.js`. Dependencies are bundled. Start with 512 MB and measure the actual deployed workload.

Set these environment variables in AppSail's configuration:

| Variable | Value |
| --- | --- |
| STORE_MODE | catalyst |
| EVENT_ID | A new immutable round ID, e.g. gdg-practice-01 |
| APP_ORIGIN | Exact public HTTPS origin, without a trailing slash |
| SESSION_SECRET | Random secret of at least 32 characters, identical across instances/redeploys |
| ADMIN_KEY | A different random secret of at least 32 characters; organizers only |
| ORGANIZER_PASSWORD | Private organizer password of at least 12 characters |

Generate each secret independently using `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` on your computer and enter it into the console. Keep a private backup of the session secret. Changing it invalidates sessions and recovery tickets, but does not delete scores. Do not upload local `.env`. AppSail supplies `X_ZOHO_CATALYST_LISTEN_PORT`; the server binds to that port on `0.0.0.0`.

Initialize/link your Catalyst project using its CLI or deploy through the console. For regular CLI setup, `catalyst init` or `catalyst appsail:add` registers AppSail, then `catalyst deploy appsail` deploys it. Decline sample code, point the build path to the absolute path of this project's `build/`, and retain the startup command above. `app-config.json` is a template; account/project identifiers and secrets have not been configured. Confirm the generated CLI configuration before deploying. Production activation, billing and schema migration must be completed in your console; do not assume a development deployment is production.

Sources: [supported runtimes](https://docs.catalyst.zoho.com/en/serverless/help/appsail/catalyst-managed-runtimes/key-concepts/), [CLI deployment](https://docs.catalyst.zoho.com/en/serverless/help/appsail/catalyst-managed-runtimes/deploy-from-cli/), [production activation](https://docs.catalyst.zoho.com/en/deployment-and-billing/environments/initial-deployment/).

## 3. Verify in a separate practice project/round

Open `/api/health` and confirm `ok: true` and `mode: catalyst`. From `/admin`, sign in with ORGANIZER_PASSWORD, create a 1–5 minute practice competition, scan its QR, register and mark ready, then click Start game. Keep the room-specific URL. Register players and ensure their saved score, live leaderboard, recovery and export persist after restarting/redeploying AppSail. Freeze after settling, export and run the offline verifier. Confirm a CSV contains every participant, including zero-score entries.

Development Data Store has documented limits of 5,000 rows per table and 25,000 per project. Five hundred players can produce roughly **45,000 gameplay checkpoints** in three minutes, plus resets. Development is insufficient for this retention model. Production has no documented upper record-count limit, but query, rate and compute limits still apply. See [insert limits](https://docs.catalyst.zoho.com/en/sdk/javascript/v1/cloudscale/datastore/insert-rows/).

The current load script supports the legacy scheduled-future-round fixture and needs updating before a load test of the new manual-start lobby. For a legacy scheduled **separate future practice round**, deliberately run:

```sh
LOAD_URL=https://YOUR-PRACTICE-ORIGIN LOAD_PLAYERS=500 npm run load
```

This consumes that deployment's quota/credits and creates synthetic entries. It does not schedule a round. Never point it at the prize round. Use a fresh practice event ID if a previous test claimed the synthetic roll numbers. The report always leaves `deploymentQualified: false`; the operator must assess failures, latency, provider limits, persistent records and offline replay before using it for prizes. Shorten an early smoke test with `LOAD_SECONDS=12`.

AppSail currently documents five default instances, 100 concurrent in-flight requests per instance, autoscaling at 80%, cold starts and a 30-second request timeout. These are request limits, not guaranteed player capacity. At two-second saves the game averages about 250 checkpoint requests/second for 500 players, plus polling. Each checkpoint performs authentication/read/write queries, so Data Store capacity and latency matter. Leaderboards are cached per instance for eight seconds and saves use client jitter. Request support increases if your test needs them. Warm the app through legitimate practice/read traffic before the event.

Source: [AppSail limits](https://docs.catalyst.zoho.com/en/serverless/help/appsail/appsail-basics/).

No browser automation testing is planned; perform your manual keyboard/touch and network tests using the operations guide.
