/** Public fleet status pages: /maintenance and /aog (HTML; add ?format=json for JSON). */
import type { AogConfig, AogState, TrackedAircraft } from "./aog";
import type { AircraftState, MxConfig } from "./maintenance";

export interface Row {
  id: number;
  registration: string;
  fleet: string;
  status: "Available" | "Maintenance" | "AOG" | "Parked (staff)" | "Maintenance + AOG";
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
      const status: Row["status"] = inMx && g ? "Maintenance + AOG" : inMx ? "Maintenance" : g?.manual ? "Parked (staff)" : g ? "AOG" : "Available";
      const since = m?.since[a.name] ?? { hours: 0, cycles: 0 };
      const last = aog.lastAirborne[String(ac.id)];
      const details: string[] = [];
      if (inMx) details.push(m!.inMx!.reason);
      if (g?.manual) {
        details.push(`Declared AOG by staff since ${g.since.slice(0, 10)}${g.note ? `: ${g.note}` : ""}`);
        if (g.seenFlyingAt) details.push(`⚠ real aircraft seen flying ${fmt(g.seenFlyingAt)}, consider unparking`);
      } else if (g) details.push(`Real aircraft not flown since ${g.lastFlown.slice(0, 10)}`);
      return {
        id: ac.id,
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
  const counts = { mx: rows.filter((r) => r.status.includes("Maintenance")).length, aog: rows.filter((r) => r.status.includes("AOG") || r.status === "Parked (staff)").length };
  const action = (r: Row) => {
    if (focus === "aog") {
      if (r.status === "Parked (staff)") return `<button class="btn" data-act="unpark" data-reg="${esc(r.registration)}">Unpark</button>`;
      if (r.status === "AOG" || r.status === "Maintenance + AOG") return `<small>lifts when the real aircraft flies</small>`;
      return `<button class="btn" data-act="park" data-reg="${esc(r.registration)}">Park (AOG)</button>`;
    }
    if (r.status === "Maintenance" || r.status === "Maintenance + AOG")
      return `<button class="btn" data-act="release" data-id="${r.id}" data-reg="${esc(r.registration)}">End maintenance</button>`;
    return "";
  };
  const badge = (s: Row["status"]) => `<span class="b ${s === "Available" ? "ok" : s === "AOG" || s === "Parked (staff)" ? "aog" : "mx"}">${esc(s)}</span>`;
  const body = rows
    .map(
      (r) => `<tr><td><b>${esc(r.registration)}</b></td><td>${esc(r.fleet)}</td><td>${badge(r.status)}</td><td>${esc(r.detail || "")}${r.until ? `<br><small>until ${fmt(r.until)}</small>` : ""}</td><td>${esc(focus === "aog" ? r.realLastFlown : r.nextCheck)}</td><td>${esc(focus === "aog" ? r.nextCheck : r.realLastFlown)}</td><td>${action(r)}</td></tr>`,
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
small{color:var(--mut)}
.btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;white-space:nowrap}.btn:hover{border-color:var(--mut)}.btn:disabled{opacity:.5;cursor:wait}
.bulk{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin-bottom:12px}.bulk summary{cursor:pointer;font-weight:600}
textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
#note{max-width:360px;margin:0}</style></head><body><main>
<nav><a href="/maintenance">Maintenance</a><a href="/aog">AOG</a></nav>
<h1>${esc(title)}</h1>
<p class="m">${meta.live ? "Live" : "Test mode (nothing is hidden)"} · ${rows.length} aircraft (historic fleets excluded) · ADS-B last checked ${fmt(meta.lastPoll)} · AOG after ${meta.aogDays} days without a real flight</p>
<div class="cards"><div class="c"><b>${rows.filter((r) => r.status === "Available").length}</b>available</div><div class="c"><b>${counts.mx}</b>in maintenance</div><div class="c"><b>${counts.aog}</b>AOG / parked</div><div class="c"><b>${rows.filter((r) => !r.tracked).length}</b>without hex code</div></div>
${
    focus === "aog"
      ? `<details class="bulk"><summary>Park several aircraft (AOG)</summary><p><textarea id="bulk" rows="3" placeholder="PK-GFH PK-GFG GTD GTE …"></textarea></p><p><input id="note" placeholder="Note (optional), e.g. planespotters: stored"> <button class="btn" id="bulkpark">Park all</button></p></details>`
      : ""
  }
<p id="msg" class="m"></p>
<input id="q" placeholder="Filter: registration, type, status…" oninput="for(const r of document.querySelectorAll('tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase())">
<div class="t"><table><thead><tr><th>Registration</th><th>Fleet</th><th>Status</th><th>Reason</th><th>${cols[0]}</th><th>${cols[1]}</th><th>Action</th></tr></thead><tbody>${body}</tbody></table></div>
<p class="m" style="margin-top:12px">Real-world flight data © adsb.lol contributors (ODbL). Updated every 5–15 minutes.</p>
</main>
<script>
const msg = document.getElementById("msg");
async function call(path, regs, note) {
  // Park/unpark do at most 12 per request; repeat until nothing is left.
  let left = regs, done = [], problems = [];
  for (let i = 0; i < 10 && left.length; i++) {
    const q = new URLSearchParams({ regs: left.join(",") });
    if (note) q.set("note", note);
    const r = await fetch(path + "?" + q, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.status);
    done.push(...(j.parked || j.released || []));
    problems.push(...(j.notFound || []).map((x) => x + " (not found)"), ...(j.notParked || []).map((x) => x + " (not parked)"));
    left = j.remaining || [];
  }
  return { done, problems };
}
async function run(btn, fn) {
  btn.disabled = true; msg.textContent = "Working…";
  try { const t = await fn(); msg.textContent = t + " Reloading…"; setTimeout(() => location.reload(), 900); }
  catch (e) { msg.textContent = "Failed: " + e.message; btn.disabled = false; }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (b) {
    const reg = b.dataset.reg, act = b.dataset.act;
    if (act === "park") {
      const note = prompt("Park " + reg + " (declare AOG). Optional note:", "");
      if (note === null) return;
      run(b, async () => { const r = await call("/aog/park", [reg], note); return "Parked " + (r.done.join(", ") || "nothing") + ". " + r.problems.join(", "); });
    } else if (act === "unpark") {
      if (!confirm("Unpark " + reg + "? It becomes bookable again (unless staff hid it before).")) return;
      run(b, async () => { const r = await call("/aog/unpark", [reg]); return "Unparked " + (r.done.join(", ") || "nothing") + "."; });
    } else if (act === "release") {
      if (!confirm("End maintenance for " + reg + " now?")) return;
      run(b, async () => { const r = await fetch("/maintenance/" + b.dataset.id + "/release", { method: "POST" }); if (!r.ok) throw new Error(r.status); return reg + " released."; });
    }
  }
  if (e.target.id === "bulkpark") {
    const regs = document.getElementById("bulk").value.split(/[\s,;]+/).filter(Boolean);
    if (!regs.length) { msg.textContent = "Type one or more registrations first."; return; }
    run(e.target, async () => { const r = await call("/aog/park", regs, document.getElementById("note").value); return "Parked " + r.done.length + ": " + r.done.join(", ") + ". " + r.problems.join(", "); });
  }
});
</script>
</body></html>`;
}
