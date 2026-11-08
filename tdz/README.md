# vamsys-tdz: touchdown zone scoring for vAMSYS

A free Cloudflare Worker. Every 5 minutes it reads new PIREPs from the vAMSYS Operations API, scores where the aircraft
touched down, and writes the result back to the PIREP as a bonus entry and a comment. It rejects the PIREP when the
landing was past the touchdown zone. See [SPEC.md](SPEC.md) for the rules.

| Touchdown distance from runway start | Points | Action |
|---|---|---|
| 0 – 300 m | 0 | — |
| 300 – 460 m (300 m marking pair through the end of the aiming point) | **+100** | — |
| 460 – 600 m | **+50** | — |
| 600 m – end of last TDZ marking | 0 | — |
| past the last TDZ marking, runway ≥ 2500 m | **−200** | **PIREP rejected** |
| past the last TDZ marking, runway < 2500 m | **−200** | not rejected |
| before the threshold | 0 | flagged for staff review |

The TDZ ends at the far end of the last ICAO touchdown-zone marking (Annex 14). The number of marking pairs depends on
runway length: < 900 m → 1 pair (ends 172.5 m) · 900–1200 → 2 (322.5 m) · 1200–1500 → 3 (472.5 m) ·
1500–2400 → 4 (622.5 m) · ≥ 2400 m → 6 (**922.5 m**). Runway length = `distance_from_start_ft + lda`, because vAMSYS's
`lda` is the runway *remaining* after touchdown.

Bands live in `src/config.ts`.

## Deploy (no install needed, free tier)

1. **vAMSYS:** in Orwell → Settings → API v3, create a *Client Credentials — Operations API* client
   with scopes `ops:read`, `ops:flights:write` and `ops:moderation:write`. Copy the ID and secret into step 3. Never paste them anywhere else.
2. **Cloudflare:** dashboard → Workers & Pages → Create → *Import a repository*, then pick this repo.
   Set the root directory to `tdz` and leave the deploy command as `npx wrangler deploy`.
3. In the Worker's **Settings → Variables and Secrets**, add these as **Secret**:
   - `VAMSYS_CLIENT_ID`
   - `VAMSYS_CLIENT_SECRET`
   - `ADMIN_TOKEN`: any long random password. It protects the admin URLs below.
4. Open `https://vamsys-tdz.<you>.workers.dev/health`. It should show `{"ok":true,"dryRun":true}`.

## Going live safely

Live since 8 Nov 2026 at https://vamsys-tdz.koeifreak.workers.dev (`DRY_RUN` = `false`). With `DRY_RUN` = `true` it scores PIREPs but writes nothing.

1. Leave it running for a day, then check `GET /recent?token=ADMIN_TOKEN` to see what it *would* have done.
2. Test one PIREP for real (it gets a bonus entry and a comment, and a reject if the landing was past the TDZ):
   `curl -X POST "https://vamsys-tdz.<you>.workers.dev/process/<PIREP_ID>?live=1&token=ADMIN_TOKEN"`
   In Orwell, check that the TDZ entry appears under Rewards **and that any other bonuses are still there**.
3. Set the variable `DRY_RUN` to `false` (in `wrangler.jsonc` or the dashboard) and redeploy.

The first run only records the newest PIREP id, so history is never rescored.
To rescore one PIREP, use `/process/<id>?live=1`. It replaces its own TDZ entry instead of adding a second one.

## Admin routes (`?token=ADMIN_TOKEN` or `Authorization: Bearer ADMIN_TOKEN`)

| Route | What |
|---|---|
| `GET /health` | status (no token) |
| `GET /recent` | the last 100 results |
| `POST /run` | poll now |
| `POST /process/:id` | rescore one PIREP (dry run unless `live=1`) |

## Develop

```bash
npm install
npm test
npm run typecheck
VAMSYS_CLIENT_ID=... VAMSYS_CLIENT_SECRET=... npx tsx scripts/dry-run.ts 20   # score recent PIREPs, no writes
```
