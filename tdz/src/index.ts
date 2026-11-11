import { DEFAULT_CONFIG } from "./config";
import { processPirep, runCycle, type Result } from "./process";
import { VamsysApi } from "./vamsys";
import { inMaintenance, loadState, onPirep, releaseDue, type MxEvent } from "./maintenance";
import { AOG_CONFIG, MX_CONFIG } from "./maintenance-config";
import { buildRows, renderPage } from "./status-page";
import { park, unpark } from "./aog";
import { autoAogNote, matchAutoAog } from "./auto-aog";
import { commandReply, postWebhook, verifyDiscord, type FleetEvent } from "./discord";
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
  /** Discord application public key (slash commands). */
  DISCORD_PUBLIC_KEY?: string;
  /** Discord channel webhook for grounded/released posts (secret). */
  DISCORD_WEBHOOK_URL?: string;
}

const isDryRun = (env: Env) => env.DRY_RUN !== "false";
const isMxDryRun = (env: Env) => env.MX_DRY_RUN !== "false";
const isAogDryRun = (env: Env) => env.AOG_DRY_RUN !== "false";
const SKIP_AUTO_AOG = new Set(["rejected", "invalidated", "invalid"]);

const heldByAog = (env: Env) => async (id: number) => Boolean((await aogState(env.TDZ_KV)).aog[String(id)]);

/** Aircraft list with hex codes, refreshed from vAMSYS once a day. */
async function trackedAircraft(env: Env, client: VamsysApi, mayRefresh = true): Promise<TrackedAircraft[]> {
  const cached = await env.TDZ_KV.get("aog:aircraft:v2");
  if (cached) {
    const c = JSON.parse(cached) as { at: string; list: TrackedAircraft[] };
    if (!mayRefresh || Date.now() - new Date(c.at).getTime() < 86_400_000) return c.list;
  }
  const list = await loadTrackedAircraft(client, AOG_CONFIG.excludedFleetIds);
  await env.TDZ_KV.put("aog:aircraft:v2", JSON.stringify({ at: new Date().toISOString(), list }));
  return list;
}

async function rememberAog(env: Env, events: AogEvent[]) {
  if (!events.length) return;
  for (const e of events) console.log(JSON.stringify({ aog: e }));
  const prev = JSON.parse((await env.TDZ_KV.get("aog:log")) ?? "[]") as AogEvent[];
  await env.TDZ_KV.put("aog:log", JSON.stringify([...[...events].reverse(), ...prev].slice(0, 200)));
}

async function aogCycle(env: Env, client: VamsysApi, mayRefreshList = true) {
  const events = await pollAog(client, new AdsbLol(), env.TDZ_KV, AOG_CONFIG, await trackedAircraft(env, client, mayRefreshList), {
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

/** Post grounded/released events to the Discord channel (if a webhook is configured). */
async function notifyDiscord(env: Env, mx: MxEvent[], aog: AogEvent[]) {
  const events: FleetEvent[] = [
    ...mx.filter((e) => !e.dryRun).map((e) => ({
      kind: e.kind === "start" ? ("mx-start" as const) : e.kind === "extend" ? ("mx-extend" as const) : ("mx-release" as const),
      registration: e.registration,
      reason: e.reason,
      until: e.until,
    })),
    ...aog.filter((e) => !e.dryRun).map((e) => ({
      kind: e.kind === "aog" ? ("aog" as const) : ("aog-release" as const),
      registration: e.registration,
      reason: e.reason,
      lastFlown: e.lastFlown,
    })),
  ];
  try {
    await postWebhook(env.DISCORD_WEBHOOK_URL, events);
  } catch (e) {
    console.log(JSON.stringify({ discordError: String(e) }));
  }
}

/** Status rows for every non-historic aircraft (pages + Discord). */
async function statusRows(env: Env, mayRefreshList = true) {
  const client = api(env);
  const aircraft = await trackedAircraft(env, client, mayRefreshList);
  const st = await aogState(env.TDZ_KV);
  const mx = new Map<number, Awaited<ReturnType<typeof loadState>> & object>();
  await Promise.all(
    aircraft.map(async (a) => {
      const m = await loadState(env.TDZ_KV, a.id);
      if (m) mx.set(a.id, m);
    }),
  );
  return { rows: buildRows(aircraft, mx, st, MX_CONFIG, AOG_CONFIG), st };
}

/** One full cycle: TDZ scoring + maintenance (count new PIREPs, start/release checks). */
async function cycle(env: Env, forceAog = false) {
  const client = api(env);
  const mxEvents: MxEvent[] = [];
  const mxOpts = { dryRun: isMxDryRun(env), heldElsewhere: heldByAog(env) };
  // Cloudflare free plan: 50 outgoing requests per run. A PIREP costs up to ~8 (TDZ + CDA + maintenance), so take at
  // most 4 per run; the rest are picked up 5 minutes later.
  const incidentAog: AogEvent[] = [];
  const results = await runCycle(client, env.TDZ_KV, DEFAULT_CONFIG, { dryRun: isDryRun(env) }, 4, 1000, async (p, r) => {
    const e = await onPirep(client, env.TDZ_KV, MX_CONFIG, p, mxOpts);
    if (e) mxEvents.push(e);
    // Auto AOG when the airline's scoring rules flag a wing strike, tail strike or overweight landing.
    if (SKIP_AUTO_AOG.has(p.status) || !p.aircraft_id) return;
    const scores = r.scores ?? ((await client.getPirep(p.id)).pirep_data?.["scores"] as { name: string; points: number }[] | undefined);
    const hits = matchAutoAog(scores);
    if (!hits.length) return;
    const list = await trackedAircraft(env, client, false);
    const ac = list.find((a) => a.id === p.aircraft_id); // historic fleets aren't in the list → never auto-AOG
    if (!ac) return;
    const res = await park(client, env.TDZ_KV, AOG_CONFIG, list, [ac.registration], {
      dryRun: isAogDryRun(env),
      note: autoAogNote(hits.map((h) => h.label), p.callsign, p.id),
      until: new Date(Date.now() + Math.max(...hits.map((h) => h.durationH)) * 3600_000),
      inMaintenance: (id) => inMaintenance(env.TDZ_KV, id),
    });
    incidentAog.push(...res.events);
  });
  await rememberAog(env, incidentAog);
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
      // The daily aircraft-list refresh costs ~20 requests: only do it on a quiet run.
      aogEvents = await aogCycle(env, client, results.length === 0);
    } catch (e) {
      console.log(JSON.stringify({ aogError: String(e) }));
    }
  }
  await notifyDiscord(env, mxEvents, [...incidentAog, ...aogEvents]);
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

    // GET /maintenance and /aog: public fleet status pages (HTML; ?format=json for JSON)
    if (req.method === "GET" && (url.pathname === "/maintenance" || url.pathname === "/aog")) {
      const { rows: allRows, st } = await statusRows(env);
      const focus = url.pathname === "/aog" ? "aog" : "maintenance";
      let rows = allRows;
      if (focus === "aog") {
        // Problems first, then the longest-idle tracked aircraft, untracked last.
        const rank = (r: (typeof rows)[number]) => (r.status !== "Available" ? 0 : r.tracked ? 1 : 2);
        rows = [...rows].sort((a, b) => rank(a) - rank(b) || a.lastTs - b.lastTs);
      }
      if (url.searchParams.get("format") === "json") {
        return json({ live: focus === "aog" ? !isAogDryRun(env) : !isMxDryRun(env), lastPoll: st.lastPoll, aircraft: rows });
      }
      const html = renderPage(
        focus === "aog" ? "IJV fleet: AOG (real-world aircraft movement)" : "IJV fleet: maintenance status",
        rows,
        { live: focus === "aog" ? !isAogDryRun(env) : !isMxDryRun(env), lastPoll: st.lastPoll, aogDays: AOG_CONFIG.aogAfterDays },
        focus,
      );
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    // POST /discord/interactions: Discord slash commands (signed by Discord; no admin token)
    if (req.method === "POST" && url.pathname === "/discord/interactions") {
      const body = await req.text();
      const ok = await verifyDiscord(env.DISCORD_PUBLIC_KEY ?? "", req.headers.get("x-signature-ed25519"), req.headers.get("x-signature-timestamp"), body);
      if (!ok) return new Response("invalid request signature", { status: 401 });
      const i = JSON.parse(body) as { type: number; data?: { name: string; options?: { name: string; value: string }[] } };
      if (i.type === 1) return json({ type: 1 }); // PING
      if (i.type === 2 && i.data) {
        // Must answer within 3 s: use the cached aircraft list only.
        const { rows } = await statusRows(env, false);
        return json({ type: 4, data: commandReply(i.data.name, i.data.options, rows) });
      }
      return json({ type: 4, data: { content: "Unsupported interaction.", flags: 64 } });
    }

    // Open (no login, by TRISTAN's choice): park/unpark and ending maintenance, used by the status-page buttons.
    // POST /aog/park?regs=PK-GFH,GFG,...[&note=planespotters: stored]  and  POST /aog/unpark?regs=...
    const pk = url.pathname.match(/^\/aog\/(park|unpark)$/);
    if (req.method === "POST" && pk) {
      // Registrations from ?regs=… or the body; a JSON body may also carry {regs, note, wasHidden: {"PK-X": true}}.
      const bodyText = url.searchParams.get("regs") ? "" : await req.text();
      let body: { regs?: string[] | string; note?: string; wasHidden?: Record<string, boolean> } = {};
      try {
        body = bodyText.trim().startsWith("{") ? JSON.parse(bodyText) : { regs: bodyText };
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const rawRegs = url.searchParams.get("regs") ?? (Array.isArray(body.regs) ? body.regs.join(",") : body.regs ?? "");
      const regs = rawRegs.split(/[\s,;]+/).filter(Boolean);
      if (!regs.length) return json({ error: "give registrations as ?regs=PK-AAA,PK-BBB or in the body" }, 400);
      const client = api(env);
      const list = await trackedAircraft(env, client);
      const common = { dryRun: isAogDryRun(env), inMaintenance: (id: number) => inMaintenance(env.TDZ_KV, id) };
      const r =
        pk[1] === "park"
          ? await park(client, env.TDZ_KV, AOG_CONFIG, list, regs, {
              ...common,
              note: url.searchParams.get("note") ?? body.note,
              wasHiddenOverride: body.wasHidden,
            })
          : await unpark(client, env.TDZ_KV, AOG_CONFIG, list, regs, common);
      await rememberAog(env, r.events);
      await notifyDiscord(env, [], r.events);
      const { events: _e, ...summary } = r;
      return json(summary);
    }

    // POST /maintenance/:aircraftId/release: end a check early (staff)
    const rel = url.pathname.match(/^\/maintenance\/(\d+)\/release$/);
    if (req.method === "POST" && rel) {
      const events = await releaseDue(api(env), env.TDZ_KV, MX_CONFIG, { dryRun: isMxDryRun(env), force: [Number(rel[1])], heldElsewhere: heldByAog(env) });
      await rememberMx(env, events);
      await notifyDiscord(env, events, []);
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

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
