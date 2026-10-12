# Run the club event

## Before announcing the link

1. Confirm Catalyst **production** is active and has the required schema, billing and credit expiry. Use a separate practice round for deployment tests and synthetic load. Freeze, export and verify that practice round, including a redeploy/restart.
2. Manually try desktop keyboard, phone touch, refresh mid-run, hidden-tab return, brief/long offline periods, cookie clearing, storage clearing and two tabs. Changing the visible score must not change the persisted leaderboard. Verify recovery with a separate organizer device.
3. Create a fresh competition from `/admin` for the actual event and keep its room-specific URL. Keep SESSION_SECRET stable on every instance. Keep the organizer password and ADMIN_KEY off the projector and participant devices.
4. In production, sign in with ORGANIZER_PASSWORD; local organizer access opens directly. Create the competition, choose 1–5 minutes (default three), and project its QR. Players register and mark ready. Hide/re-show the QR as needed, check the counts, then click Start game for a shared three-second countdown. Check campus connectivity.
5. Announce the rules: one shared chosen time window, unlimited retries, best run counts, server-confirmed score is authoritative, and prize winners play a supervised final. Equal scores use earliest achievement frame, then roll number. Roll-only registration cannot prove identity.

## During the round

Do not change the event ID, session secret, schema, course rules or startup configuration. A browser stores a random claim locally and receives an HttpOnly signed session cookie. A second browser cannot take the same registered roll without the claim/cookie or an organizer recovery link. False roll claims still need in-person resolution.

A returning player should first use the same browser/roll. If storage was lost, verify the participant in person and generate a private five-minute recovery link from `/admin`. This restores the entry and saved best. It does not extend the clock. Recovery issuance/redemption is recorded without the usable ticket.

The leaderboard includes registered zero-score players. The public page shows the top 20 and the player's own rank; CSVs include everyone. Live rankings may lag by roughly eight seconds. No prize decision should use the provisional table or the browser's current-run display.

If the backend is unavailable, the client retries an unchanged completed checkpoint and stops after bounded prediction. It cannot recover an unlimited offline run. Saved records stay in Data Store even if AppSail restarts. For a substantial outage, preserve the audit and conduct a new round under a new event ID; do not silently lengthen the existing round or award disputed browser scores.

## Freeze and preserve results

Wait at least 36 seconds after the game ends for the six-second input grace plus the documented AppSail request timeout. Confirm there is no unresolved provider outage/write backlog. Then click **Freeze results**. Repeated freeze requests return the same published snapshot. A killed finalizer leaves unpublished pages and can be retried without mixing snapshots.

Download **Final CSV** and **Full audit JSONL**. For a file-level SHA-256 sidecar and disk-synced page copies, use the export script. Run:

```sh
node scripts/verify-export.js exports/YOUR-AUDIT.jsonl
sha256sum -c exports/YOUR-AUDIT.sha256
```

The sidecar command applies to CLI exports; browser downloads have page checksums within JSONL. Keep two copies on independent storage. Check the participant count and supervised finalists before awarding prizes. Keep the original Data Store rows and secrets until disputes are resolved. There is no automatic deletion job in this app. Set the club's retention/deletion period and inform participants how their roll numbers and gameplay records are used.

Freezing is an application snapshot, not a cross-table Catalyst transaction or a provider backup. An unusually delayed/uncertain provider write can require investigation; do not freeze while a provider outage is ongoing. Offline verification flags missing sequences, damaged pages or a replay that disagrees with frozen results. Do not overwrite a failed verification with hand-edited scores.

## Diagnostic records

`DinoEvents` retains competition settings, readiness, start time, legacy scheduling, recovery records, result pages and the final manifest. `DinoEntries` retains claims and join times. `DinoCheckpoints` retains accepted input batches and resets with acceptance times and digests. These are the score audit and the basis for replay. Console/request errors do not form a durable score ledger; they intentionally omit cookies, keys and raw request bodies. Use Catalyst's platform logs for infrastructure errors. Rejected malformed/tampered requests do not earn ledger rows or scores.

Authenticated `GET /api/admin/audit?roll=AB12CD34&after=-1` returns up to 300 checkpoints for a player; continue using the last sequence as `after`. `GET /api/admin/archive?table=DinoCheckpoints&after=KEY` returns up to 300 rows and a continuation key. Full export tools follow every page. All export routes require the organizer bearer key; gameplay routes cannot export credentials or claim hashes.

For local recovery, keep `.env` and the complete `data/` directory. Stop the server before copying/restoring its journal. Only one local process may write that directory. Do not restore a live production event from a provisional JSONL without an intentional recovery procedure. The export is a forensic/replay archive, not an automatic import or subscription to future updates.
