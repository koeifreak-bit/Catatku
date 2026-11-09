import { DEFAULT_CONFIG } from "./config";
import { processPirep, runCycle, type Result } from "./process";
import { VamsysApi } from "./vamsys";
import { activeList, onPirep, releaseDue, type MxEvent } from "./maintenance";
import { MX_CONFIG } from "./maintenance-config";

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
}

const isDryRun = (env: Env) => env.DRY_RUN !== "false";
const isMxDryRun = (env: Env) => env.MX_DRY_RUN !== "false";

async function rememberMx(env: Env, events: MxEvent[]) {
  if (!events.length) return;
  for (const e of events) console.log(JSON.stringify({ mx: e }));
  const prev = JSON.parse((await env.TDZ_KV.get("mx:log")) ?? "[]") as MxEvent[];
  await env.TDZ_KV.put("mx:log", JSON.stringify([...[...events].reverse(), ...prev].slice(0, 200)));
}

/** One full cycle: TDZ scoring + maintenance (count new PIREPs, start/release checks). */
async function cycle(env: Env) {
  const client = api(env);
  const mxEvents: MxEvent[] = [];
  const mxOpts = { dryRun: isMxDryRun(env) };
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
  return { results, mxEvents };
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
    if (url.pathname === "/health") return json({ ok: true, dryRun: isDryRun(env), maintenanceDryRun: isMxDryRun(env) });

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
    if (req.method === "POST" && url.pathname === "/run") return json(await cycle(env));

    // GET /maintenance/log: last 200 maintenance events
    if (req.method === "GET" && url.pathname === "/maintenance/log") {
      return json(JSON.parse((await env.TDZ_KV.get("mx:log")) ?? "[]"));
    }

    // POST /maintenance/:aircraftId/release: end a check early (staff)
    const rel = url.pathname.match(/^\/maintenance\/(\d+)\/release$/);
    if (req.method === "POST" && rel) {
      const events = await releaseDue(api(env), env.TDZ_KV, MX_CONFIG, { dryRun: isMxDryRun(env), force: [Number(rel[1])] });
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
