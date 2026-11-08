# Spec: vAMSYS Touchdown Zone (TDZ) Bonus

Status: **DRAFT, awaiting approval** · Owner: VA staff (TRISTAN / VTSM)

## Objective

vAMSYS can't award points natively for landing inside the touchdown zone. Other VAs get around this by receiving
each PIREP through a **vAMSYS webhook** and judging the touchdown position with their own server code (PHP).

We'll build the same thing **without paid hosting**: a free Cloudflare Worker that receives the webhook, works out
where the aircraft touched down relative to the runway threshold, and awards a TDZ bonus.

**User stories**

- As a pilot, when I file a PIREP I want to know whether I landed in the TDZ and what bonus I earned.
- As staff, I want each verdict (distance from threshold, zone, points) logged so I can audit it and apply the bonus in vAMSYS.
- As staff, I want to change the zone length and the bonus tiers without redeploying code.

**Scoring rule (default, configurable)**

| Touchdown distance past the landing threshold | Result | Bonus |
|---|---|---|
| < 0 m (before the threshold) | Short landing | 0 (optionally a penalty) |
| 0–150 m | Early, but inside the TDZ | +X |
| 150–600 m (the aiming-point band) | **Ideal TDZ** | +Y (max) |
| 600 m to the TDZ end | Inside the TDZ | +X |
| Past the TDZ end | Long landing | 0 |

The TDZ end is the smaller of **900 m** and **⅓ of the runway's landing distance**, following the ICAO convention.
Lateral deviation from the centreline is recorded, and a touchdown more than half the runway width off the centreline gets no bonus.

## Assumptions (correct any that are wrong)

1. The vAMSYS webhook payload includes the touchdown **latitude/longitude**, and ideally the runway or arrival airport and
   the landing heading. THY confirmed it "states where the touchdown happened", but we haven't seen a sample yet (see Open Q1).
2. We can't write points back into vAMSYS automatically until we confirm an API exists for it (Open Q2). v1 therefore
   **records the verdict and notifies staff on Discord**, and staff apply the bonus by hand. Automatic write-back comes in v2 if the API allows it.
3. Hosting is the **Cloudflare Workers free tier**, the same account and pattern as the Catatku worker in this repo. There's no PHP and no server to rent.
4. Storage is **Cloudflare D1** (free SQLite) for verdicts and config, which avoids adding another external service.
5. Runway data comes from **OurAirports `runways.csv`** (public domain). It has threshold coordinates, headings, displaced
   thresholds, length and width, and gets imported into D1 once.
6. The code lives in this repo under `tdz/`, separate from the finance bot. (Is a separate repo better? See Open Q5.)

## Tech Stack

- TypeScript on Cloudflare Workers, using Hono for routing (already used in `worker/`)
- Cloudflare D1 for storage, Wrangler 4 for deploys, Vitest for tests
- Discord webhook for staff and pilot notifications (optional, configured through a secret)

## Architecture

```
vAMSYS ──POST PIREP webhook──► Cloudflare Worker  https://tdz.<you>.workers.dev
                               ├─ POST /webhook/vamsys   verify the secret → parse → judge → store → notify
                               ├─ GET  /pireps           staff list of verdicts (token protected)
                               └─ GET  /health
                                       │
                       D1: runways · verdicts · config        Discord webhook (optional)
```

**Judging algorithm (pure function, no I/O)**

1. Pick the runway: use the payload's runway ident if there is one. Otherwise pick the runway end at the arrival airport
   whose threshold is nearest the touchdown point and whose heading is within 30° of the landing track.
2. Find the landing threshold: start from the runway-end coordinate and move it by the displaced-threshold distance along the runway heading.
3. Along-track distance = the touchdown point projected onto the runway axis (great-circle bearing and distance).
   Cross-track distance = the perpendicular offset from that axis.
4. Classify the result with the configured bands, then return `{ runway, alongM, crossM, zone, points }`.

## Commands

```
cd tdz
npm install
npm test                       # vitest run
npm run typecheck              # tsc --noEmit
npm run dev                    # wrangler dev (local)
npm run db:migrate             # wrangler d1 migrations apply tdz
npm run db:import-runways      # loads OurAirports runways.csv into D1
npm run deploy                 # wrangler deploy (or Cloudflare Workers Builds from GitHub, like Catatku)
```

## Project Structure

```
tdz/
  SPEC.md                 → this document
  src/index.ts            → Hono routes
  src/judge.ts            → pure TDZ geometry and scoring (most of the tests target this)
  src/geo.ts              → haversine, bearing, along/cross-track helpers
  src/payload.ts          → zod schema for the vAMSYS webhook (tolerant of unknown fields)
  src/notify.ts           → Discord message formatting
  migrations/             → D1 SQL (runways, verdicts, config)
  scripts/import-runways.mjs
  test/                   → vitest, plus fixtures/ with real sample payloads
  wrangler.jsonc
```

## Code Style

This follows `worker/`: ESM, strict TypeScript, small pure functions, and zod at the boundary.

```ts
export function judgeTouchdown(td: LatLon, rwy: RunwayEnd, cfg: TdzConfig): Verdict {
  const thr = offset(rwy.threshold, rwy.headingTrue, rwy.displacedM);
  const { alongM, crossM } = alongCrossTrack(thr, rwy.headingTrue, td);
  const tdzEndM = Math.min(cfg.tdzMaxM, rwy.ldaM / 3);
  return { runway: rwy.ident, alongM, crossM, ...classify(alongM, crossM, tdzEndM, rwy.widthM, cfg) };
}
```

## Testing Strategy

- **Unit tests (Vitest)** for `geo.ts` and `judge.ts` using known geometry. For example, a touchdown 400 m down
  WIII 25R should give `alongM ≈ 400 ± 5` and `zone = ideal`. Also covered: a short landing, a long landing,
  a displaced threshold, an off-centreline touchdown, and parallel-runway disambiguation.
- **Contract tests** that feed real captured vAMSYS payloads (`test/fixtures/*.json`) through `/webhook/vamsys` with D1 in local mode.
- **Manual check:** send one real PIREP after deploying and confirm the D1 row and the Discord message.

## Boundaries

- **Always:** verify the webhook secret or signature before processing. Make webhook handling idempotent per PIREP ID.
  Store the raw payload alongside the verdict for audits. Run `npm test` and the typecheck before every commit.
- **Ask first:** turning on automatic point write-back to vAMSYS, changing the scoring bands or penalties, adding paid services.
- **Never:** commit vAMSYS API keys, Discord webhook URLs, or other secrets (use `wrangler secret put`). Never touch the
  existing Catatku `worker/` or `web/`. Never post pilot data publicly beyond callsign, flight and verdict.

## Success Criteria

1. A test PIREP webhook from vAMSYS gets a `200` in under 2 s and creates exactly one verdict row. A retried webhook doesn't create a duplicate.
2. For fixture landings with known positions, the computed along-track distance is within **±10 m** and the zone is correct.
3. The runway is picked correctly at an airport with parallel runways (e.g. WIII 25L/25R) and at one with a displaced threshold.
4. A request with a missing or wrong secret gets `401` and nothing is stored.
5. Staff can see the verdict on Discord or at `/pireps`, with callsign, runway, distance from threshold, zone and points.
6. Running costs stay at $0 on the Cloudflare free tier.

## Open Questions

1. **Sample payload:** can you capture one real PIREP webhook payload (e.g. send it to webhook.site) and share it?
   We need the exact field names for touchdown position, runway, PIREP ID, and any signature header.
2. **Writing points back:** does your vAMSYS plan offer an Operations API endpoint that adjusts PIREP or pilot points?
   If it doesn't, v1 stays on "notify staff and apply the bonus manually". THY's VA may know how they do this.
3. **Bonus values:** what are X and Y? Should short landings get a penalty?
4. **Notifications:** a Discord channel for staff only, or one pilots can see too?
5. **Location:** keep this in the `Catatku` repo under `tdz/`, or put it in its own repo?
6. **Cloudflare:** do you already have the Cloudflare account used for Catatku, so we can reuse it?
