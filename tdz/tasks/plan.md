# Plan: vAMSYS TDZ scoring Worker

Implements `tdz/SPEC.md` (approved v4).

## Components (in dependency order)
1. `score.ts`: a pure function (touchdown distance + LDA → points/action). No dependencies.
2. `vamsys.ts`: Operations API client (token cache, list, touchdowns, detail, bonus-points, comment, reject). Injectable `fetch`.
3. `process.ts`: handles one PIREP end to end. Idempotent through KV, and does no writes in dry-run.
4. `index.ts`: Cron poller (new PIREPs since the last seen id) plus admin routes (`/health`, `/recent`, `/run`, `/process/:id`).
5. `wrangler.jsonc` + README: deploy on the Cloudflare free tier using secrets.

## Risks
- **Bonus replace-all:** we keep any `pirep_data.bonus_scores` entries we find. A single-PIREP live test (`/process/:id?live=1`) confirms the behaviour before the global dry-run is switched off.
- **Backfill:** on its first run the poller only records the newest PIREP id, so it never scores history unless asked.
- **Token expiry (24 h):** the token is cached in memory and in KV, and refreshed 5 min before it expires or after a 401.

## Checkpoints
- After 1: unit tests green at every band boundary.
- After 3: process tests green with a mocked API (bonus entries kept, idempotent, reject only past the TDZ end, skip when there's no data).
- After 4: run a local dry-run against the live API and compare the output with the impact table in the spec.
