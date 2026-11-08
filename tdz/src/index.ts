import { DEFAULT_CONFIG } from "./config";
import { processPirep, runCycle, type Result } from "./process";
import { VamsysApi } from "./vamsys";

export interface Env {
  TDZ_KV: KVNamespace;
  VAMSYS_CLIENT_ID: string;
  VAMSYS_CLIENT_SECRET: string;
  /** Protects the admin routes. */
  ADMIN_TOKEN: string;
  /** "false" turns on writing to vAMSYS. Anything else (default) = dry run. */
  DRY_RUN?: string;
}

const isDryRun = (env: Env) => env.DRY_RUN !== "false";
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
        const results = await runCycle(api(env), env.TDZ_KV, DEFAULT_CONFIG, { dryRun: isDryRun(env) });
        for (const r of results) console.log(JSON.stringify(r));
        await remember(env, results);
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, dryRun: isDryRun(env) });
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);

    // GET /recent: the last 100 results (dry-run and live)
    if (req.method === "GET" && url.pathname === "/recent") {
      return json(JSON.parse((await env.TDZ_KV.get("recent")) ?? "[]"));
    }

    // POST /run: run one poll now
    if (req.method === "POST" && url.pathname === "/run") {
      const results = await runCycle(api(env), env.TDZ_KV, DEFAULT_CONFIG, { dryRun: isDryRun(env) });
      await remember(env, results);
      return json(results);
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
