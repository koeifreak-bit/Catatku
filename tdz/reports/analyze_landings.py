import json, glob, sys
from datetime import datetime
from collections import defaultdict
FT = 0.3048
def ts(s):
    if not s: return None
    s = s.replace("T", " ").replace("Z", "").split("+")[0]
    for f in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try: return datetime.strptime(s, f)
        except ValueError: pass
def tdz_end(runway_m):
    if runway_m is None: return 922.5
    pairs = 1 if runway_m < 900 else 2 if runway_m < 1200 else 3 if runway_m < 1500 else 4 if runway_m < 2400 else 6
    return pairs * 150 + 22.5
def period(created):
    return "16 Sep – 7 Oct" if created < "2026-10-08" else "8 Oct – 8 Nov"

rows = []
for f in glob.glob("d/*.json"):
    d = json.load(open(f)); pd = d["pd"]
    if d["status"] in ("rejected", "invalidated", "invalid") or d.get("type") == "claim": continue
    code = d["fleet_code"] or "?"
    maker = "Other" if code.startswith("AT") else "Airbus" if code.startswith("A") else "Boeing" if code.startswith("B") else "Other"
    r = {"id": d["id"], "fleet": d["fleet"], "code": code, "maker": maker, "period": period(d["created_at"])}
    tds = [t for t in (pd.get("touchdowns") or []) if t.get("distance_from_start_ft") not in (None, "")]
    if tds:
        t = tds[-1]
        dist = float(t["distance_from_start_ft"]) * FT
        lda = t.get("lda")
        rwy = dist + float(lda) * FT if lda not in (None, "") else None
        end = tdz_end(rwy)
        r.update(dist=dist, end=end, within=0 <= dist <= end, band=290 <= dist <= 500, beyond=dist > end, short=dist < 0)
        td_time = ts(t.get("time"))
        # flaps at touchdown
        fl = [x for x in (pd.get("flap_changes") or []) if ts(x.get("time")) and td_time and ts(x["time"]) <= td_time]
        r["flaps"] = fl[-1]["human"] if fl else None
        # single-engine taxi-in: after touchdown, first engine off >= 60 s before the last engine off
        offs = sorted(ts(e["time"]) for e in (pd.get("engines") or []) if e.get("status") == "off" and ts(e.get("time")) and td_time and ts(e["time"]) > td_time)
        engines = {e.get("engine") for e in (pd.get("engines") or [])}
        r["seti"] = len(engines) >= 2 and len(offs) >= 2 and (offs[-1] - offs[0]).total_seconds() >= 60
        r["has_engine_data"] = len(offs) >= 1
    rows.append(r)
json.dump(rows, open("rows.json", "w"))

def pct(a, b): return f"{100*a/b:.1f}%" if b else "–"
withd = [r for r in rows if "dist" in r]
print(f"PIREPs analysed: {len(rows)} (excl. rejected/claims); with touchdown data: {len(withd)}\n")

fleets = defaultdict(list)
for r in withd: fleets[(r["fleet"], r["code"])].append(r)
print("| Fleet | Landings | Within TDZ | 290–500 m | Beyond TDZ (violations) | Short of threshold |")
print("|---|---|---|---|---|---|")
stats = []
for (name, code), rs in sorted(fleets.items(), key=lambda kv: -len(kv[1])):
    n = len(rs); w = sum(r["within"] for r in rs); b = sum(r["band"] for r in rs); v = sum(r["beyond"] for r in rs); s = sum(r["short"] for r in rs)
    stats.append((name, code, n, w, b, v))
    print(f"| {name} ({code}) | {n} | {pct(w,n)} | {pct(b,n)} | {v} ({pct(v,n)}) | {s} |")
N = len(withd); print(f"| **All fleets** | **{N}** | **{pct(sum(r['within'] for r in withd),N)}** | **{pct(sum(r['band'] for r in withd),N)}** | **{sum(r['beyond'] for r in withd)} ({pct(sum(r['beyond'] for r in withd),N)})** | {sum(r['short'] for r in withd)} |")
print()
MIN = 20
big = [s for s in stats if s[2] >= MIN]
print("Most violations (count):", max(stats, key=lambda s: s[5])[:3], max(stats, key=lambda s: s[5])[5])
print(f"Highest violation rate (>= {MIN} landings):", max(big, key=lambda s: s[5]/s[2])[:3], pct(max(big, key=lambda s: s[5]/s[2])[5], max(big, key=lambda s: s[5]/s[2])[2]))
print(f"Most compliant (>= {MIN} landings, % within):", [(s[0], s[2], pct(s[3], s[2])) for s in sorted(big, key=lambda s: -s[3]/s[2])][:3])
print(f"Most 290–500 m (>= {MIN}):", [(s[0], s[2], pct(s[4], s[2])) for s in sorted(big, key=lambda s: -s[4]/s[2])][:3])
print()
print("| Period | Airbus landings | Reduced flaps (CONF 3) | Airbus + Boeing flights | Single-engine taxi-in |")
print("|---|---|---|---|---|")
for p in ("16 Sep – 7 Oct", "8 Oct – 8 Nov"):
    ab = [r for r in withd if r["period"] == p and r["maker"] == "Airbus" and r.get("flaps")]
    rf = sum(r["flaps"] == "3" for r in ab)
    ae = [r for r in withd if r["period"] == p and r["maker"] in ("Airbus", "Boeing") and r.get("has_engine_data")]
    se = sum(r["seti"] for r in ae)
    print(f"| {p} | {len(ab)} | {rf} ({pct(rf,len(ab))}) | {len(ae)} | {se} ({pct(se,len(ae))}) |")
print()
print("SETI by maker/period:")
for p in ("16 Sep – 7 Oct", "8 Oct – 8 Nov"):
    for m in ("Airbus","Boeing"):
        ae=[r for r in withd if r["period"]==p and r["maker"]==m and r.get("has_engine_data")]; se=sum(r["seti"] for r in ae)
        print(f"  {p} {m}: {se}/{len(ae)} ({pct(se,len(ae))})")
from collections import Counter
print("Airbus flaps at touchdown:", Counter(r.get("flaps") for r in withd if r["maker"]=="Airbus").most_common())

print()
print("| Fleet | Airbus landings | CONF 3 | Flights w/ engine data | Single-engine taxi-in |")
print("|---|---|---|---|---|")
for (name, code), rs in sorted(fleets.items(), key=lambda kv: -len(kv[1])):
    if rs[0]["maker"] not in ("Airbus","Boeing"): continue
    ab=[r for r in rs if r["maker"]=="Airbus" and r.get("flaps")]; rf=sum(r["flaps"]=="3" for r in ab)
    ae=[r for r in rs if r.get("has_engine_data")]; se=sum(r["seti"] for r in ae)
    if len(rs) < 5: continue
    print(f"| {name} ({code}) | {len(ab) if ab else '–'} | {f'{rf} ({pct(rf,len(ab))})' if ab else '–'} | {len(ae)} | {se} ({pct(se,len(ae))}) |")
