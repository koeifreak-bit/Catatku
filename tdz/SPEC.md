# Spec: vAMSYS Touchdown Zone (TDZ) Scoring

Status: **APPROVED v5**, LIVE (8 Nov 2026) · Owner: VA staff (TRISTAN / VTSM)

## Objective

vAMSYS's own scoring rules can't score landings by **where** the aircraft touched down on the runway.
We'll add that with a free Cloudflare Worker. It reads new PIREPs (pilot reports) through the vAMSYS
**Operations API**, scores the touchdown position, and writes the result back into vAMSYS as a PIREP
bonus entry, which shows up in Orwell. Landings past the touchdown zone are rejected automatically.

No paid hosting, no PHP, and no Discord.

## Scoring rule (revision of 8 Nov 2026, from TRISTAN's runway drawing)

| Touchdown distance from runway start | Points | Action |
|---|---|---|
| 0 – 300 m | 0 | — |
| 300 – 400 m (aiming point) | **+100** | — |
| 400 – 600 m | **+50** | — |
| 600 m – end of last TDZ marking | 0 | — |
| past the last TDZ marking | **−200** | **PIREP rejected** |
| before the threshold | 0 | flagged for staff review |

The TDZ ends at the far end of the last ICAO touchdown-zone marking (Annex 14). The number of marking pairs depends on
runway length: < 900 m → 1 pair (ends 172.5 m) · 900–1200 → 2 (322.5 m) · 1200–1500 → 3 (472.5 m) ·
1500–2400 → 4 (622.5 m) · ≥ 2400 m → 6 (**922.5 m**). Runway length = `distance_from_start_ft + lda`, because vAMSYS's
`lda` is the runway *remaining* after touchdown.

Every limit and points value lives in a config file. Nothing is hard-coded.

## What vAMSYS already gives us (checked against the Operations API v3 OpenAPI spec)

- Base URL: `https://vamsys.io/api/v3/operations`. Authentication is OAuth2 client credentials:
  `POST https://vamsys.io/oauth/token` returns a Bearer token that lasts 24 h.
- `GET /pireps/{id}/touchdowns` returns, for each touchdown: `runway`, `lda` (ft), **`distance_from_start_ft`**, `rate`, and `time`.
  **vAMSYS already calculates the distance**, so we don't need runway or geometry data.
  For a PIREP with only one touchdown it returns an empty array. In that case the same data has to come from `pirep_data` on `GET /pireps/{id}` (see Open Q1).
- `PUT /pireps/{id}/bonus-points` replaces **all** bonus entries (event, activity and rank bonuses included).
  We must read the existing entries, drop any earlier TDZ entry, add ours, and send the whole list back.
- `POST /pireps/{id}/reject` rejects a PIREP. `POST /pireps/{id}/comments` adds a comment the pilot can see.
- `GET /pireps` is paginated and filterable, which lets us poll for new PIREPs.

## Architecture

```
Cloudflare Worker (free tier)
  Cron every 5 min ─► GET /pireps (new since last run, any status except rejected)
                      for each: get touchdown distance ─► score
                         ├─ PUT bonus-points  (existing entries + "TDZ: …")
                         ├─ POST comments     ("Touchdown 512 m past threshold RWY 25R: +50")
                         └─ POST reject       (only beyond 900 m)
                      store the PIREP id + result in KV (idempotent: never scores a PIREP twice)
  GET /health, GET /recent (token protected): last results, for staff
```

We poll instead of using a webhook: the API already has everything we need, so we don't have to guess at a webhook payload format.

## Tech stack

TypeScript, Cloudflare Workers + Cron Triggers, Workers KV, zod, Vitest, Wrangler 4. This is the same stack as Catatku's `worker/`.

## Commands

```
npm install
npm test            # vitest run
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev --test-scheduled
npm run deploy      # wrangler deploy  (or Cloudflare Workers Builds from GitHub)
wrangler secret put VAMSYS_CLIENT_ID
wrangler secret put VAMSYS_CLIENT_SECRET
```

## Project structure

```
src/index.ts      → fetch + scheduled handlers
src/score.ts      → pure scoring (distance → points/action); most tests target this
src/vamsys.ts     → API client: token cache, list, touchdowns, bonus-points, comments, reject
src/process.ts    → one PIREP end to end (idempotent)
src/config.ts     → bands, points, dry-run flag
test/             → vitest, plus fixtures/ (real PIREP JSON)
wrangler.jsonc
```

## Code style

```ts
export function scoreTouchdown(distM: number, cfg: TdzConfig): Score {
  if (distM < 0) return { points: 0, label: "Short of threshold", action: "review" };
  const band = cfg.bands.find(b => distM < b.untilM);
  return band ?? { points: cfg.beyondPoints, label: "Landed beyond TDZ", action: "reject" };
}
```

## Testing strategy

- Unit tests for `score.ts` at every boundary: −1, 0, 299, 300, 399, 400, 599, 600, 899, 900, 922.5, 923 m, every ICAO marking-pair band, plus feet → metres conversion.
- Tests for `process.ts` with a mocked API. They check that existing bonus entries are kept, that a re-run doesn't add a
  second TDZ entry, that reject is called only beyond 900 m, and that multi-touchdown PIREPs use the selected or last touchdown.
- **Dry-run mode** (on by default for the first deploy): it logs what it *would* do without writing to vAMSYS. Switch it off once results look right.

## Boundaries

- **Always:** keep existing bonus entries. Be idempotent per PIREP. Start in dry-run mode. Run tests and the typecheck before committing.
- **Ask first:** changing points or bands, turning off dry-run.
- **Never:** commit the vAMSYS client ID/secret (use Wrangler secrets only). Never accept PIREPs automatically. Never modify Catatku's code.

## Success criteria

1. Within 5 min of filing, a pending PIREP gets exactly one "TDZ" bonus entry with the right points and a comment showing the distance and runway.
2. Event, rank and activity bonuses already on the PIREP are still there afterwards.
3. A touchdown past the last TDZ marking gives −200 and status `rejected`, even if vAMSYS already auto-accepted it.
4. Running it twice on the same PIREP changes nothing the second time.
5. It costs $0 on the Cloudflare free tier.

## Verified against live data (IJV, 8 Nov 2026, API client 1355)

- **`lda` is the runway remaining after touchdown**, not the runway's LDA. For WIII, distance + lda ≈ 3000 m on every landing.
- `GET /pireps/{id}/touchdowns` **does** return single touchdowns too (the docs say otherwise). Example:
  `{"runway":"RW33","lda":7888,"distance_from_start_ft":1954, ...}`. The same values are in `pirep_data.touchdowns[]`.
  Some PIREPs have no touchdown data (runway/distance `null`). These are skipped, and no points are added.
- Regular points live in `pirep_data.scores[]` (`name`, `points`). None of the last 100 PIREPs had a bonus, so bonus storage
  is in `pirep_data.bonus_scores[]` (confirmed by the live test on PIREP 4111096). TRISTAN reports TDZ points under *Rewards*, alongside other bonuses rather than replacing them.
- Auth: OAuth client credentials with `client_id` / `client_secret` sent in the request body. Tokens last 24 h.
- **(v4, historical) What the v4 rule would have done to the last 40 PIREPs** (38 with data):

  | Band | Count |
  |---|---|
  | 0–300 m +50 | 2 |
  | 300–400 m +100 | 6 |
  | 400–600 m +50 | 14 |
  | 600 m–TDZ end −100 | 9 |
  | beyond TDZ end −200 + **reject** | **7** (only 3 are past 900 m; the other 4 are on short runways where LDA/3 ≈ 630 m) |

## Open questions

1. ~~Reject rate~~ **Superseded (v5):** reject past the last ICAO TDZ marking. The earlier LDA/3 analysis below was skewed by misreading `lda`. Under v5, 1 of the last 36 PIREPs would be rejected.
2. ~~Start vs threshold~~ **Decided:** use vAMSYS `distance_from_start_ft` as-is.
3. **First live write:** to confirm that bonus entries add to existing Rewards instead of replacing them, we test on one chosen PIREP before turning off dry-run.
4. **Repository:** it should live in its own repo (e.g. `koeifreak-bit/vamsys-tdz`). For now it's in `Catatku/tdz/`.
