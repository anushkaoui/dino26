# Slate GitHub deployment

Slate with framework Other publishes the selected output directory. The existing `npm run build` creates an AppSail runtime package whose homepage is nested at `build/public/index.html`. Publishing `build` gives no homepage at `/` and can expose runtime files as static downloads. Use the frontend-only build below.

After committing and pushing `scripts/build-slate.js` and the updated `package.json`, set these values in Slate's Git deployment:

| Setting | Value |
| --- | --- |
| Branch | main |
| Framework | Other |
| Node runtime | 22 |
| Root path | / |
| Install command | npm ci |
| Build command | npm run build:slate |
| Output path | dist |

Click Sync Now or create a new Git deployment with those settings. The logs must run `scripts/build-slate.js` rather than `scripts/package.js`. The new output has `index.html`, all referenced assets including `engine.js`, and `/admin/index.html` at their correct public paths. It contains no backend code, runtime dependencies or secrets.

This fixes the artifact layout for the homepage and organizer page only. Their API requests currently use `/api` on the page's own origin. Slate does not deploy this repository's Node HTTP scoring server through the Other/static output. A backend and a verified connection to it are still required for registration, competition start, persistent scores and exports. Do not use this frontend-only deployment for the student competition yet.

Keep backend secrets out of Slate's frontend build. Connecting a separate backend needs an explicit API routing and session plan; simply replacing fetch URLs is insufficient for the existing same-origin cookies.

The existing AppSail build remains `npm run build`, with output `build`. The frontend build does not alter Data Store records or change the game rules.

Source: [Slate Git deployment settings](https://docs.catalyst.zoho.com/en/slate/help/git-integration/deploy-from-private-repository/).
