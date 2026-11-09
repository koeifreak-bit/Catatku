import { DEFAULT_CONFIG } from "./config";
import { processPirep, runCycle, type Result } from "./process";
import { VamsysApi } from "./vamsys";
import { activeList, inMaintenance, onPirep, releaseDue, type MxEvent } from "./maintenance";
import { AOG_CONFIG, MX_CONFIG } from "./maintenance-config";
import { AdsbLol, aogState, loadTrackedAircraft, pollAog, type AogEvent, type TrackedAircraft } from "./aog";

export interface Env {
  TDZ_KV: KVNamespace;
  VAMSYS_CLIENT_ID: string;
  VAMSYS_CLIENT_SECRET: string;
  /** Protects the admin routes. */
  ADMIN_TOKEN: string;
  /** "false" turns on writing to vAMSYS. Anything else (default) = dry run. */
  DRY_RUN?: string;
  /** Maintenance module: "false" = really hide/show aircraft. Anything else (default) = dry run. */
  MX_DRY_RUN?: string;
  /** AOG module: "false" = really hide/show aircraft. Anything else (default) = dry run. */
  AOG_DRY_RUN?: string;
}

const isDryRun = (env: Env) => env.DRY_RUN !== "false";
const isMxDryRun = (env: Env) => env.MX_DRY_RUN !== "false";
const isAogDryRun = (env: Env) => env.AOG_DRY_RUN !== "false";

const heldByAog = (env: Env) => async (id: number) => Boolean((await aogState(env.TDZ_KV)).aog[String(id)]);

/** Aircraft list with hex codes, refreshed from vAMSYS once a day. */
async function trackedAircraft(env: Env, client: VamsysApi): Promise<TrackedAircraft[]> {
  const cached = await env.TDZ_KV.get("aog:aircraft");
  if (cached) {
    const c = JSON.parse(cached) as { at: string; list: TrackedAircraft[] };
    if (Date.now() - new Date(c.at).getTime() < 86_400_000) return c.list;
  }
  const list = await loadTrackedAircraft(client, AOG_CONFIG.excludedFleetIds);
  await env.TDZ_KV.put("aog:aircraft", JSON.stringify({ at: new Date().toISOString(), list }));
  return list;
}

async function rememberAog(env: Env, events: AogEvent[]) {
  if (!events.length) return;
  for (const e of events) console.log(JSON.stringify({ aog: e }));
  const prev = JSON.parse((await env.TDZ_KV.get("aog:log")) ?? "[]") as AogEvent[];
  await env.TDZ_KV.put("aog:log", JSON.stringify([...[...events].reverse(), ...prev].slice(0, 200)));
}

async function aogCycle(env: Env, client: VamsysApi) {
  const events = await pollAog(client, new AdsbLol(), env.TDZ_KV, AOG_CONFIG, await trackedAircraft(env, client), {
    dryRun: isAogDryRun(env),
    inMaintenance: (id) => inMaintenance(env.TDZ_KV, id),
  });
  await rememberAog(env, events);
  return events;
}

async function rememberMx(env: Env, events: MxEvent[]) {
  if (!events.length) return;
  for (const e of events) console.log(JSON.stringify({ mx: e }));
  const prev = JSON.parse((await env.TDZ_KV.get("mx:log")) ?? "[]") as MxEvent[];
  await env.TDZ_KV.put("mx:log", JSON.stringify([...[...events].reverse(), ...prev].slice(0, 200)));
}

/** One full cycle: TDZ scoring + maintenance (count new PIREPs, start/release checks). */
async function cycle(env: Env, forceAog = false) {
  const client = api(env);
  const mxEvents: MxEvent[] = [];
  const mxOpts = { dryRun: isMxDryRun(env), heldElsewhere: heldByAog(env) };
  const results = await runCycle(client, env.TDZ_KV, DEFAULT_CONFIG, { dryRun: isDryRun(env) }, 100, 1000, async (p) => {
    const e = await onPirep(client, env.TDZ_KV, MX_CONFIG, p, mxOpts);
    if (e) mxEvents.push(e);
  });
  try {
    mxEvents.push(...(await releaseDue(client, env.TDZ_KV, MX_CONFIG, mxOpts)));
  } catch (e) {
    console.log(JSON.stringify({ mxReleaseError: String(e) }));
  }
  await remember(env, results);
  await rememberMx(env, mxEvents);
  // ADS-B check every 15 minutes (cron runs every 5).
  let aogEvents: AogEvent[] = [];
  if (forceAog || Math.floor(new Date().getUTCMinutes() / 5) % 3 === 0) {
    try {
      aogEvents = await aogCycle(env, client);
    } catch (e) {
      console.log(JSON.stringify({ aogError: String(e) }));
    }
  }
  return { results, mxEvents, aogEvents };
}
const api = (env: Env) => new VamsysApi(env.VAMSYS_CLIENT_ID, env.VAMSYS_CLIENT_SECRET);

async function remember(env: Env, results: Result[]) {
  if (!results.length) return;
  const prev = JSON.parse((await env.TDZ_KV.get("recent")) ?? "[]") as Result[];
  await env.TDZ_KV.put("recent", JSON.stringify([...[...results].reverse(), ...prev].slice(0, 100)));
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

function authorized(req: Request, env: Env) {
  const url = new URL(req.url);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token");
  return Boolean(env.ADMIN_TOKEN) && given === env.ADMIN_TOKEN;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const { results } = await cycle(env);
        for (const r of results) console.log(JSON.stringify(r));
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, dryRun: isDryRun(env), maintenanceDryRun: isMxDryRun(env), aogDryRun: isAogDryRun(env) });

    // GET /aog: public list of aircraft declared AOG (real aircraft not flown for 3 days)
    if (req.method === "GET" && url.pathname === "/aog") {
      const st = await aogState(env.TDZ_KV);
      const now = Date.now();
      return json({
        dryRun: isAogDryRun(env),
        lastPoll: st.lastPoll,
        feedHealthySince: st.feedHealthySince,
        tracked: Object.keys(st.lastAirborne).length,
        aog: Object.values(st.aog).map((a) => ({ registration: a.registration, since: a.since, realAircraftLastFlown: a.lastFlown })),
        idleOver2Days: Object.entries(st.lastAirborne).filter(([id, t]) => !st.aog[id] && now - new Date(t).getTime() > 2 * 86_400_000).length,
      });
    }

    // GET /maintenance: public list of aircraft currently in maintenance
    if (req.method === "GET" && url.pathname === "/maintenance") {
      const list = await activeList(env.TDZ_KV);
      return json({
        dryRun: isMxDryRun(env),
        inMaintenance: list.map((a) => ({ registration: a.registration, reason: a.inMx!.reason, since: a.inMx!.from, until: a.inMx!.until })),
      });
    }
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);

    // GET /recent: the last 100 results (dry-run and live)
    if (req.method === "GET" && url.pathname === "/recent") {
      return json(JSON.parse((await env.TDZ_KV.get("recent")) ?? "[]"));
    }

    // POST /run: run one poll now
    if (req.method === "POST" && url.pathname === "/run") return json(await cycle(env, url.searchParams.get("aog") === "1"));

    // GET /aog/log: last 200 AOG events
    if (req.method === "GET" && url.pathname === "/aog/log") return json(JSON.parse((await env.TDZ_KV.get("aog:log")) ?? "[]"));

    // GET /maintenance/log: last 200 maintenance events
    if (req.method === "GET" && url.pathname === "/maintenance/log") {
      return json(JSON.parse((await env.TDZ_KV.get("mx:log")) ?? "[]"));
    }

    // POST /maintenance/:aircraftId/release: end a check early (staff)
    const rel = url.pathname.match(/^\/maintenance\/(\d+)\/release$/);
    if (req.method === "POST" && rel) {
      const events = await releaseDue(api(env), env.TDZ_KV, MX_CONFIG, { dryRun: isMxDryRun(env), force: [Number(rel[1])], heldElsewhere: heldByAog(env) });
      await rememberMx(env, events);
      return json(events);
    }

    // POST /process/:id[?live=1]: (re)score one PIREP. Live only when live=1 is given explicitly.
    const m = url.pathname.match(/^\/process\/(\d+)$/);
    if (req.method === "POST" && m) {
      const client = api(env);
      const pirep = await client.getPirep(Number(m[1]));
      const live = url.searchParams.get("live") === "1";
      const r = await processPirep(client, env.TDZ_KV, pirep, DEFAULT_CONFIG, { dryRun: !live, force: true });
      await remember(env, [r]);
      return json(r);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
