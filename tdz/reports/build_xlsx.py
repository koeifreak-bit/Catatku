import json
from collections import Counter
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.chart import BarChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.utils import get_column_letter

OUT = "/home/user/Catatku/tdz/reports/IJV-landing-stats-2026-09-16_2026-11-08.xlsx"
rows = [r for r in json.load(open("rows.json")) if "dist" in r]
_pid = {p["id"]: p["pilot_id"] for p in json.load(open("list.json"))}
_pil = {int(k): v for k, v in json.load(open("pilots.json")).items()}
def pilot_label(r):
    p = _pil.get(_pid.get(r["id"]), {})
    return f'{p.get("username") or "?"} {(p.get("name") or "").strip()}'.strip()
for r in rows: r["pilot"] = pilot_label(r)
F = "Arial"
H = Font(name=F, bold=True, color="FFFFFF"); HF = PatternFill("solid", fgColor="1F4E78")
B = Font(name=F); BB = Font(name=F, bold=True)
thin = Side(style="thin", color="BFBFBF"); BOX = Border(top=thin, bottom=thin, left=thin, right=thin)
def header(ws, r, vals):
    for i, v in enumerate(vals, 1):
        c = ws.cell(r, i, v); c.font = H; c.fill = HF; c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True); c.border = BOX
def body(ws, r1, r2, c2):
    for row in ws.iter_rows(min_row=r1, max_row=r2, max_col=c2):
        for c in row:
            if not c.font.bold: c.font = B
            c.border = BOX

wb = Workbook()
# ---------------- Data ----------------
d = wb.active; d.title = "Data"
cols = ["PIREP ID", "Fleet", "Type code", "Maker", "Period", "Touchdown (m from runway start)", "TDZ end (m)",
        "Within TDZ", "290–500 m", "Violation (past TDZ)", "Airbus flap data", "Airbus CONF 3", "Engine data", "Single-engine taxi-in", "Pilot", "300–400 m (aiming point)"]
header(d, 1, cols)
for i, r in enumerate(sorted(rows, key=lambda r: r["id"]), 2):
    ab = r["maker"] == "Airbus" and bool(r.get("flaps"))
    vals = [r["id"], r["fleet"], r["code"], r["maker"], r["period"], round(r["dist"], 1), r["end"],
            int(r["within"]), int(r["band"]), int(r["beyond"]), int(ab), int(ab and r["flaps"] == "3"),
            int(bool(r.get("has_engine_data")) and r["maker"] in ("Airbus", "Boeing")), int(bool(r.get("seti")) and r["maker"] in ("Airbus", "Boeing")), r["pilot"], int(300 <= r["dist"] < 400)]
    for j, v in enumerate(vals, 1): d.cell(i, j, v).font = B
N = len(rows) + 1
for j, w in enumerate([11, 30, 10, 9, 15, 16, 11, 10, 10, 12, 11, 11, 10, 13, 26, 12], 1): d.column_dimensions[get_column_letter(j)].width = w
d.freeze_panes = "A2"; d.auto_filter.ref = f"A1:P{N}"
rng = lambda col: f"Data!${col}$2:${col}${N}"

# ---------------- TDZ by Fleet ----------------
t = wb.create_sheet("TDZ by Fleet")
t["A1"] = "Touchdown zone performance by fleet, 16 Sep – 8 Nov 2026"; t["A1"].font = Font(name=F, bold=True, size=14)
t["A2"] = "Violation = touchdown past the last ICAO TDZ marking (−200 rule). Sorted by number of landings. All values are formulas over the Data sheet."; t["A2"].font = Font(name=F, italic=True, color="595959")
header(t, 4, ["Fleet", "Landings", "Within TDZ", "Within TDZ %", "290–500 m", "290–500 m %", "Violations", "Violation %"])
fleets = [f for f, _ in Counter(r["fleet"] for r in rows).most_common()]
for i, f in enumerate(fleets, 5):
    t.cell(i, 1, f)
    t.cell(i, 2, f'=COUNTIFS({rng("B")},$A{i})')
    t.cell(i, 3, f'=COUNTIFS({rng("B")},$A{i},{rng("H")},1)')
    t.cell(i, 4, f'=IFERROR(C{i}/B{i},0)')
    t.cell(i, 5, f'=COUNTIFS({rng("B")},$A{i},{rng("I")},1)')
    t.cell(i, 6, f'=IFERROR(E{i}/B{i},0)')
    t.cell(i, 7, f'=COUNTIFS({rng("B")},$A{i},{rng("J")},1)')
    t.cell(i, 8, f'=IFERROR(G{i}/B{i},0)')
last = 4 + len(fleets); tot = last + 1
t.cell(tot, 1, "All fleets").font = BB
for c, col in ((2, "B"), (3, "C"), (5, "E"), (7, "G")):
    t.cell(tot, c, f"=SUM({col}5:{col}{last})").font = BB
for c, (n, dnm) in ((4, ("C", "B")), (6, ("E", "B")), (8, ("G", "B"))):
    t.cell(tot, c, f"=IFERROR({n}{tot}/{dnm}{tot},0)").font = BB
body(t, 5, tot, 8)
for r in range(5, tot + 1):
    for c in (4, 6, 8): t.cell(r, c).number_format = "0.0%"
for c in range(1, 9): t.cell(tot, c).fill = PatternFill("solid", fgColor="DDEBF7")
t.column_dimensions["A"].width = 34
for c in "BCDEFGH": t.column_dimensions[c].width = 13
big = 4 + sum(1 for f in fleets if sum(r["fleet"] == f for r in rows) >= 20)  # fleets with >= 20 landings for charts
nb = tot + 2
t.cell(nb, 1, "Highlights (fleets with ≥ 20 landings)").font = BB
t.cell(nb + 1, 1, "Most violations (count)"); t.cell(nb + 1, 2, f"=INDEX($A$5:$A${last},MATCH(MAX($G$5:$G${last}),$G$5:$G${last},0))"); t.cell(nb + 1, 3, f"=MAX($G$5:$G${last})")
t.cell(nb + 2, 1, "Highest violation rate"); t.cell(nb + 2, 2, f"=INDEX($A$5:$A${big},MATCH(MAX($H$5:$H${big}),$H$5:$H${big},0))"); t.cell(nb + 2, 3, f"=MAX($H$5:$H${big})")
t.cell(nb + 3, 1, "Most compliant (highest Within TDZ %)"); t.cell(nb + 3, 2, f"=INDEX($A$5:$A${big},MATCH(MAX($D$5:$D${big}),$D$5:$D${big},0))"); t.cell(nb + 3, 3, f"=MAX($D$5:$D${big})")
t.cell(nb + 4, 1, "Most landings in 290–500 m"); t.cell(nb + 4, 2, f"=INDEX($A$5:$A${big},MATCH(MAX($F$5:$F${big}),$F$5:$F${big},0))"); t.cell(nb + 4, 3, f"=MAX($F$5:$F${big})")
for r in range(nb + 1, nb + 5):
    for c in (1, 2, 3): t.cell(r, c).font = B
    t.cell(r, 3).number_format = "0" if r == nb + 1 else "0.0%"

def bar(title, ytitle, cats, series, anchor, pct=False, horizontal=True, w=24, h=11, stacked=False):
    ch = BarChart(); ch.type = "bar" if horizontal else "col"; ch.title = title; ch.y_axis.title = ytitle
    ch.style = 10; ch.width = w; ch.height = h
    for ref in series: ch.add_data(ref, titles_from_data=True)
    ch.set_categories(cats)
    if pct: ch.y_axis.numFmt = "0%"; ch.y_axis.scaling.min = 0; ch.y_axis.scaling.max = 1
    if horizontal: ch.x_axis.scaling.orientation = "maxMin"
    ch.y_axis.majorGridlines = None if not pct else ch.y_axis.majorGridlines
    ch.x_axis.delete = False; ch.y_axis.delete = False
    ch.dataLabels = DataLabelList(); ch.dataLabels.showVal = True
    ch.dataLabels.showSerName = False; ch.dataLabels.showCatName = False; ch.dataLabels.showLegendKey = False; ch.dataLabels.showPercent = False
    if pct: ch.dataLabels.numFmt = "0%"
    ch.x_axis.tickLblPos = "low"
    ch.y_axis.scaling.min = 0
    ch.legend.position = "b"
    return ch
cats = Reference(t, min_col=1, min_row=5, max_row=big)
t.add_chart(bar("Within TDZ % and 290–500 m % (fleets ≥ 20 landings)", "% of landings", cats,
                [Reference(t, min_col=4, min_row=4, max_row=big), Reference(t, min_col=6, min_row=4, max_row=big)], "J4", pct=True), "J4")
t.add_chart(bar("TDZ violations by fleet (count)", "Landings past the TDZ", cats,
                [Reference(t, min_col=7, min_row=4, max_row=big)], "J27"), "J27")
t.add_chart(bar("Violation rate by fleet (fleets ≥ 20 landings)", "% of landings", cats,
                [Reference(t, min_col=8, min_row=4, max_row=big)], "J50", pct=False), "J50")
t.freeze_panes = "B5"

# ---------------- Monthly ----------------
m = wb.create_sheet("Monthly")
m["A1"] = "Reduced flaps (Airbus) and single-engine taxi-in (Airbus + Boeing) per month"; m["A1"].font = Font(name=F, bold=True, size=14)
m["A2"] = "16 Sep – 7 Oct is partial: 8–15 Sep not downloaded. 8 Oct – 8 Nov is complete."; m["A2"].font = Font(name=F, italic=True, color="595959")
header(m, 4, ["Period", "Airbus landings (flap data)", "Reduced flaps (CONF 3)", "CONF 3 %", "Airbus + Boeing flights (engine data)", "Single-engine taxi-in", "SETI %",
              "Airbus SETI", "Airbus flights", "Airbus SETI %", "Boeing SETI", "Boeing flights", "Boeing SETI %"])
for i, p in enumerate(["16 Sep – 7 Oct", "8 Oct – 8 Nov"], 5):
    m.cell(i, 1, p)
    m.cell(i, 2, f'=COUNTIFS({rng("E")},$A{i},{rng("K")},1)')
    m.cell(i, 3, f'=COUNTIFS({rng("E")},$A{i},{rng("L")},1)')
    m.cell(i, 4, f"=IFERROR(C{i}/B{i},0)")
    m.cell(i, 5, f'=COUNTIFS({rng("E")},$A{i},{rng("M")},1)')
    m.cell(i, 6, f'=COUNTIFS({rng("E")},$A{i},{rng("N")},1)')
    m.cell(i, 7, f"=IFERROR(F{i}/E{i},0)")
    m.cell(i, 8, f'=COUNTIFS({rng("E")},$A{i},{rng("D")},"Airbus",{rng("N")},1)')
    m.cell(i, 9, f'=COUNTIFS({rng("E")},$A{i},{rng("D")},"Airbus",{rng("M")},1)')
    m.cell(i, 10, f"=IFERROR(H{i}/I{i},0)")
    m.cell(i, 11, f'=COUNTIFS({rng("E")},$A{i},{rng("D")},"Boeing",{rng("N")},1)')
    m.cell(i, 12, f'=COUNTIFS({rng("E")},$A{i},{rng("D")},"Boeing",{rng("M")},1)')
    m.cell(i, 13, f"=IFERROR(K{i}/L{i},0)")
    for c in (4, 7, 10, 13): m.cell(i, c).number_format = "0.0%"
body(m, 5, 6, 13)
m.column_dimensions["A"].width = 18
for c in range(2, 14): m.column_dimensions[get_column_letter(c)].width = 14
m.row_dimensions[4].height = 45
pcats = Reference(m, min_col=1, min_row=5, max_row=6)
m.add_chart(bar("Airbus landings vs reduced flaps (CONF 3)", "Flights", pcats,
                [Reference(m, min_col=2, min_row=4, max_row=6), Reference(m, min_col=3, min_row=4, max_row=6)], "A9", horizontal=False, w=16, h=9), "A9")
m.add_chart(bar("Single-engine taxi-in per month", "Flights", pcats,
                [Reference(m, min_col=8, min_row=4, max_row=6), Reference(m, min_col=11, min_row=4, max_row=6)], "H9", horizontal=False, w=16, h=9), "H9")
m.add_chart(bar("Rates per month", "% of flights", pcats,
                [Reference(m, min_col=4, min_row=4, max_row=6), Reference(m, min_col=10, min_row=4, max_row=6), Reference(m, min_col=13, min_row=4, max_row=6)], "A28", pct=True, horizontal=False, w=16, h=9), "A28")

# ---------------- Ops by Fleet ----------------
o = wb.create_sheet("Ops by Fleet")
o["A1"] = "Reduced flaps and single-engine taxi-in by fleet (Airbus + Boeing, ≥ 5 flights)"; o["A1"].font = Font(name=F, bold=True, size=14)
header(o, 3, ["Fleet", "Maker", "Airbus landings (flap data)", "CONF 3", "CONF 3 %", "Flights (engine data)", "Single-engine taxi-in", "SETI %"])
ofl = [f for f in fleets if next(r for r in rows if r["fleet"] == f)["maker"] in ("Airbus", "Boeing") and sum(r["fleet"] == f for r in rows) >= 5]
for i, f in enumerate(ofl, 4):
    o.cell(i, 1, f); o.cell(i, 2, next(r for r in rows if r["fleet"] == f)["maker"])
    o.cell(i, 3, f'=COUNTIFS({rng("B")},$A{i},{rng("K")},1)')
    o.cell(i, 4, f'=COUNTIFS({rng("B")},$A{i},{rng("L")},1)')
    o.cell(i, 5, f'=IF(C{i}=0,"–",D{i}/C{i})')
    o.cell(i, 6, f'=COUNTIFS({rng("B")},$A{i},{rng("M")},1)')
    o.cell(i, 7, f'=COUNTIFS({rng("B")},$A{i},{rng("N")},1)')
    o.cell(i, 8, f'=IFERROR(G{i}/F{i},0)')
    for c in (5, 8): o.cell(i, c).number_format = "0.0%"
olast = 3 + len(ofl)
body(o, 4, olast, 8)
o.column_dimensions["A"].width = 34
for c in "BCDEFGH": o.column_dimensions[c].width = 14
o.row_dimensions[3].height = 32
o.cell(olast + 2, 1, "B737-500 fleets mostly have no engine on/off events in their ACARS data, so their SETI numbers are not meaningful.").font = Font(name=F, italic=True, color="595959")
o.add_chart(bar("Single-engine taxi-in rate by fleet", "% of flights", Reference(o, min_col=1, min_row=4, max_row=olast),
                [Reference(o, min_col=8, min_row=3, max_row=olast)], "J3", pct=True), "J3")

# ---------------- Pilots ----------------
pp = wb.create_sheet("Pilots")
pp["A1"] = "Pilot leaderboard: touchdown zone and green ops, 16 Sep – 8 Nov 2026"; pp["A1"].font = Font(name=F, bold=True, size=14)
pp["A2"] = "Sorted by number of landings. Use the filter arrows to sort by any column. Small samples (few landings) swing percentages a lot."; pp["A2"].font = Font(name=F, italic=True, color="595959")
header(pp, 4, ["Pilot", "Landings", "290–500 m", "290–500 m %", "300–400 m (aiming pt)", "TDZ violations", "Airbus landings", "CONF 3", "CONF 3 %", "Flights (engine data)", "Single-engine taxi-in", "SETI %"])
plist = [p for p, _ in Counter(r["pilot"] for r in rows).most_common()]
for i, pname in enumerate(plist, 5):
    pp.cell(i, 1, pname)
    pp.cell(i, 2, f'=COUNTIFS({rng("O")},$A{i})')
    pp.cell(i, 3, f'=COUNTIFS({rng("O")},$A{i},{rng("I")},1)')
    pp.cell(i, 4, f'=IFERROR(C{i}/B{i},0)')
    pp.cell(i, 5, f'=COUNTIFS({rng("O")},$A{i},{rng("P")},1)')
    pp.cell(i, 6, f'=COUNTIFS({rng("O")},$A{i},{rng("J")},1)')
    pp.cell(i, 7, f'=COUNTIFS({rng("O")},$A{i},{rng("K")},1)')
    pp.cell(i, 8, f'=COUNTIFS({rng("O")},$A{i},{rng("L")},1)')
    pp.cell(i, 9, f'=IF(G{i}=0,"–",H{i}/G{i})')
    pp.cell(i, 10, f'=COUNTIFS({rng("O")},$A{i},{rng("M")},1)')
    pp.cell(i, 11, f'=COUNTIFS({rng("O")},$A{i},{rng("N")},1)')
    pp.cell(i, 12, f'=IF(J{i}=0,"–",K{i}/J{i})')
    for c in (4, 9, 12): pp.cell(i, c).number_format = "0%"
plast = 4 + len(plist)
body(pp, 5, plast, 12)
pp.column_dimensions["A"].width = 30
for c in range(2, 13): pp.column_dimensions[get_column_letter(c)].width = 12
pp.row_dimensions[4].height = 32
pp.freeze_panes = "B5"; pp.auto_filter.ref = f"A4:L{plast}"

# ---------------- Notes ----------------
n = wb.create_sheet("Notes")
notes = [
    ("IJV landing statistics, 16 Sep – 8 Nov 2026", True),
    ("Source: vAMSYS Operations API v3, raw ACARS data (pirep_data) per PIREP; pulled 8 Nov 2026.", False),
    ("Coverage: 1,329 of 1,635 PIREPs filed 8 Sep – 8 Nov. 8 Oct – 8 Nov is complete; 16 Sep – 7 Oct is partial (8–15 Sep not downloaded).", False),
    ("Excluded: rejected PIREPs, claims, and PIREPs without touchdown data. Remaining: {} landings (Data sheet).".format(len(rows)), False),
    ("", False),
    ("Definitions", True),
    ("Touchdown distance: vAMSYS distance_from_start_ft of the final touchdown, in metres. Runway length = distance + vAMSYS lda (lda is runway remaining).", False),
    ("Within TDZ: touchdown between the threshold and the far end of the last ICAO Annex 14 TDZ marking (pairs every 150 m, stripe 22.5 m; 6 pairs → 922.5 m on runways ≥ 2400 m, fewer on shorter runways).", False),
    ("290–500 m: touchdown 290–500 m from runway start.", False),
    ("Violation: touchdown past the last TDZ marking (the −200 rule). Only TDZ violations are counted.", False),
    ("Reduced flaps: Airbus only (A320 family, A330). Flap setting CONF 3 (not FULL) at the final touchdown. ATR 72 is not counted as Airbus.", False),
    ("Single-engine taxi-in: Airbus + Boeing. After touchdown, the first engine shut down ≥ 60 s before the last one (at the gate both normally stop within 10 s).", False),
    ("Months: 30-day periods, 16 Sep – 7 Oct (partial) and 8 Oct – 8 Nov.", False),
]
for i, (txt, bold) in enumerate(notes, 1):
    c = n.cell(i, 1, txt); c.font = Font(name=F, bold=bold, size=14 if i == 1 else 11); c.alignment = Alignment(wrap_text=True, vertical="top")
n.column_dimensions["A"].width = 130
for ws in (t, m, o):
    ws.page_setup.orientation = "landscape"; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
wb.move_sheet("Notes", offset=-5)
wb.active = 1
wb.save(OUT); print(OUT, "fleets", len(fleets), "big", big - 4)
