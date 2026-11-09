/** Public fleet status pages: /maintenance and /aog (HTML; add ?format=json for JSON). */
import type { AogConfig, AogState, TrackedAircraft } from "./aog";
import type { AircraftState, MxConfig } from "./maintenance";

export interface Row {
  registration: string;
  fleet: string;
  status: "Available" | "Maintenance" | "AOG" | "Maintenance + AOG";
  detail: string;
  until?: string;
  nextCheck: string;
  realLastFlown: string;
  tracked: boolean;
  /** For sorting: last real flight (0 = never seen). */
  lastTs: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (iso?: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") + "Z" : "–");
const ago = (iso: string, now: number) => {
  const h = (now - new Date(iso).getTime()) / 3600_000;
  return h < 1 ? "< 1 h ago" : h < 48 ? `${Math.round(h)} h ago` : `${(h / 24).toFixed(1)} days ago`;
};

export function buildRows(aircraft: TrackedAircraft[], mx: Map<number, AircraftState>, aog: AogState, mxCfg: MxConfig, aogCfg: AogConfig, now = Date.now()): Row[] {
  const a = mxCfg.checks[0]!;
  return aircraft
    .map((ac) => {
      const m = mx.get(ac.id);
      const g = aog.aog[String(ac.id)];
      const inMx = Boolean(m?.inMx);
      const status: Row["status"] = inMx && g ? "Maintenance + AOG" : inMx ? "Maintenance" : g ? "AOG" : "Available";
      const since = m?.since[a.name] ?? { hours: 0, cycles: 0 };
      const last = aog.lastAirborne[String(ac.id)];
      const details: string[] = [];
      if (inMx) details.push(m!.inMx!.reason);
      if (g) details.push(`Real aircraft not flown since ${g.lastFlown.slice(0, 10)}`);
      return {
        registration: ac.registration,
        fleet: ac.fleetCode ? `${ac.fleetCode} – ${ac.fleetName ?? ""}` : String(ac.fleetId),
        status,
        detail: details.join(" · "),
        until: m?.inMx?.until,
        nextCheck: `${a.name} in ${Math.max(0, a.everyHours - since.hours).toFixed(1)} h / ${Math.max(0, a.everyCycles - since.cycles)} cycles`,
        realLastFlown: !ac.hex
          ? "not tracked (no hex code)"
          : last && aog.seen?.[String(ac.id)]
            ? ago(last, now)
            : `not seen yet (tracking since ${fmt(last ?? aog.feedHealthySince)})`,
        lastTs: ac.hex && last && aog.seen?.[String(ac.id)] ? new Date(last).getTime() : 0,
        tracked: Boolean(ac.hex),
      };
    })
    .sort((x, y) => (x.status === y.status ? x.fleet.localeCompare(y.fleet) || x.registration.localeCompare(y.registration) : x.status === "Available" ? 1 : y.status === "Available" ? -1 : x.status.localeCompare(y.status)));
}

export function renderPage(title: string, rows: Row[], meta: { live: boolean; lastPoll: string | null; aogDays: number }, focus: "maintenance" | "aog"): string {
  const counts = { mx: rows.filter((r) => r.status.includes("Maintenance")).length, aog: rows.filter((r) => r.status.includes("AOG")).length };
  const badge = (s: Row["status"]) => `<span class="b ${s === "Available" ? "ok" : s === "AOG" ? "aog" : "mx"}">${esc(s)}</span>`;
  const body = rows
    .map(
      (r) => `<tr><td><b>${esc(r.registration)}</b></td><td>${esc(r.fleet)}</td><td>${badge(r.status)}</td><td>${esc(r.detail || "")}${r.until ? `<br><small>until ${fmt(r.until)}</small>` : ""}</td><td>${esc(focus === "aog" ? r.realLastFlown : r.nextCheck)}</td><td>${esc(focus === "aog" ? r.nextCheck : r.realLastFlown)}</td></tr>`,
    )
    .join("");
  const cols = focus === "aog" ? ["Real aircraft last seen flying", "Next check"] : ["Next check", "Real aircraft last seen flying"];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2433;--mut:#5c6578;--line:#e3e6ec;--ok:#1a7f45;--okb:#e5f5ec;--mx:#9a5b00;--mxb:#fff2dc;--aog:#b42318;--aogb:#fde8e7}
@media (prefers-color-scheme:dark){:root{--bg:#11151c;--card:#181d26;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2a313d;--ok:#4cc38a;--okb:#16301f;--mx:#f0b44c;--mxb:#3a2c12;--aog:#ff7b72;--aogb:#3d1a18}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px}h1{font-size:22px;margin:0 0 4px}p.m{color:var(--mut);margin:0 0 16px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}.c{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:130px}.c b{font-size:22px;display:block}
nav a{color:var(--mut);margin-right:14px}input{width:100%;max-width:320px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);margin-bottom:12px}
.t{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:720px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.b{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}.ok{color:var(--ok);background:var(--okb)}.mx{color:var(--mx);background:var(--mxb)}.aog{color:var(--aog);background:var(--aogb)}
small{color:var(--mut)}</style></head><body><main>
<nav><a href="/maintenance">Maintenance</a><a href="/aog">AOG</a></nav>
<h1>${esc(title)}</h1>
<p class="m">${meta.live ? "Live" : "Test mode (nothing is hidden)"} · ${rows.length} aircraft (historic fleets excluded) · ADS-B last checked ${fmt(meta.lastPoll)} · AOG after ${meta.aogDays} days without a real flight</p>
<div class="cards"><div class="c"><b>${rows.filter((r) => r.status === "Available").length}</b>available</div><div class="c"><b>${counts.mx}</b>in maintenance</div><div class="c"><b>${counts.aog}</b>AOG</div><div class="c"><b>${rows.filter((r) => !r.tracked).length}</b>without hex code</div></div>
<input id="q" placeholder="Filter: registration, type, status…" oninput="for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase())">
<div class="t"><table><thead><tr><th>Registration</th><th>Fleet</th><th>Status</th><th>Reason</th><th>${cols[0]}</th><th>${cols[1]}</th></tr></thead><tbody>${body}</tbody></table></div>
<p class="m" style="margin-top:12px">Real-world flight data © adsb.lol contributors (ODbL). Updated every 5–15 minutes.</p>
</main></body></html>`;
}
