# GDG Dino Run

A minimal browser game for one shared three-minute round. Players enter an eight-character alphanumeric roll number, retry after collisions, and compete on their best run. The server replays gameplay inputs to calculate scores. Prize results are frozen separately from the live leaderboard.

## Run locally

Node.js 22 or newer:

```sh
npm ci
node scripts/setup-local.js
npm run dev
```

Open http://localhost:3000/ for players and http://localhost:3000/admin for organizers. `setup-local.js` creates `.env` with separate random session and organizer secrets, without printing them. Read `ADMIN_KEY` from that local file and enter it in the organizer page. Never share the key or commit `.env`.

The preview starts unscheduled. Schedule a practice round yourself from the organizer page. Use a new `EVENT_ID` in `.env` and restart the server for each new round. Scheduling the same event is immutable. All instances of one production round must use the same event ID and session secret.

## What is persisted

| Record | Durable contents |
| --- | --- |
| Event | Fixed start/end, rules version, course seed |
| Registration | Normalized roll number, hashed browser claim, join time, initial frame |
| Every accepted two-second checkpoint | Sequence, exact inputs, server-replayed state, best score, tie-break value, digest, acceptance time |
| Refresh/reconnect reset | New checkpoint retaining the saved best; missed time earns no points |
| Organizer recovery | Verified recovery issuance and first redemption, without storing the usable recovery ticket |
| Frozen results | Complete ranked list, checksummed pages and one immutable publication manifest |

Production uses **Catalyst Data Store**, shared across AppSail instances. AppSail filesystem storage is never used for game records. A successful checkpoint response follows the database write and readback. Unique keys arbitrate duplicate registrations and competing checkpoint requests. An uncertain database write is resolved by reading its unique key; an outage produces a retryable error rather than an invented success.

Local development uses a single-process, append-only journal in `data/journal.jsonl`, with group commit and `fsync` before success. A restart reconstructs records and rankings. An interrupted final append is quarantined to an `uncommitted-tail-*.txt` file; corruption in a completed record stops startup. Never run two local processes against the same data directory. Keep the entire directory and `.env` when restarting locally.

**Retention boundary:** acknowledged scores are durable application records. The current browser prediction is saved only at two-second boundaries. A refresh, hidden tab, browser crash, or a connection interruption beyond the six-second submission grace can forfeit unsent gameplay and end the current run. It keeps the saved best and never extends the shared clock. No web app can promise delivery from an offline or destroyed browser. Hardware/provider loss, deleting the database, and credit/billing suspension require backups and operational recovery; they are not solved by a browser cookie.

## Exports and replay

The organizer page offers:

- **Final CSV:** all participants and frozen ranks for awarding prizes. Available after freezing.
- **Current CSV:** provisional leaderboard at the time of the request.
- **Full audit JSONL:** all event records, registrations and accepted gameplay checkpoints, paginated past 300 rows. Download again after freezing.

For a durable download directly to your computer, while the app is running:

```sh
EXPORT_URL=http://localhost:3000 node --env-file=.env scripts/export.js
node scripts/verify-export.js exports/YOUR-EXPORTED-FILE.jsonl
```

For production, set `EXPORT_URL` to the exact HTTPS URL and provide `ADMIN_KEY` through an environment variable or a private local environment file. Never put the key in a URL or command argument. The script saves an audit JSONL, SHA-256 sidecar and leaderboard CSV under `exports/`. It syncs every downloaded page to disk, retries temporary read failures and keeps an explicitly incomplete `.partial` file on failure. Rerun to create a fresh complete export. It never changes the source database. Keep two independent copies of the final archive and CSV.

The verifier checks every page checksum, sequence continuity, recorded input replay, persisted scores and the frozen leaderboard. Checksums detect accidental corruption; they are not a digital signature proving who created an edited export. Only finalized exports have a stable prize snapshot. A download while gameplay/recovery is changing is a collected view, not a database-wide transaction; repeat after the event settles.

## Rules and fairness

- Exactly 180 seconds from the server's scheduled start; late joins get only remaining time.
- Input batches cover exactly 120 frames at 60Hz. Too-early, malformed and stale batches are rejected.
- Best run wins. Ties use the earliest global frame at which that score was reached, then ascending roll number.
- Refresh resets the current run and preserves the saved best. Same-browser re-entry restores the registration. Lost storage requires an organizer recovery link after in-person identity verification.
- Web Locks prevents accidental concurrent play in supported browsers; the database unique checkpoint key arbitrates conflicts in every browser.
- Changing a displayed score or client collision logic cannot change the authoritative replay. Automated inputs, bots, shared recovery links and false roll numbers remain possible. Roll-only entry does not authenticate a person. Use the agreed supervised final to award prizes.
- This is a hosted Dino-style game with original pixel artwork. `chrome://dino` is a browser-internal page and does not provide this site's score/session/backend integration.

## Checks and deployment status

```sh
npm test
npm run load
npm run build
```

`npm run load` starts a disposable local server and synthetic round; it does not schedule the visible preview or use Catalyst credits. It runs 500 simulated clients for 180 seconds by default, including duplicate submissions, refreshes and leaderboard reads. Reports are saved in `reports/`.

Local backend checks pass, including real HTTP, 500-entry exports and forced process termination. The successful full load report is `reports/load-1791655081313.json`: 56,872 requests, zero failures, p95 1,005ms, maximum 1,600ms. An earlier per-write-fsync implementation failed; concurrent journal writes now share a durable batch. These numbers qualify only the local test workload, not Catalyst, real phones or campus Wi-Fi.

The Catalyst adapter and deployment build are implemented, but no real Catalyst account has been connected, deployed or load-tested. Browser testing is left to you as requested. See [Deployment guide](docs/DEPLOYMENT.md), [Event operations](docs/OPERATIONS.md), and [Credit research](docs/CREDITS.md).
# GitHub deployment

Keep the source on GitHub and use [manual Catalyst deployment](docs/GITHUB-DEPLOYMENT.md) to upload a fresh AppSail build ZIP after changes. No pipeline, deployment token or Docker setup is required. Catalyst's legacy Git Deploy/Sync is documented for Functions and Web Client Hosting; this app uses AppSail. Deploy updates to the existing service and retain its Data Store records and runtime secrets.
# dino_game
