import { expect, it } from "vitest";
import { emptyState } from "../src/aog";
import { AOG_CONFIG, MX_CONFIG } from "../src/maintenance-config";
import { buildRows, renderPage } from "../src/status-page";

const now = Date.parse("2026-11-12T12:00:00Z");
const aircraft = [
  { id: 1, fleetId: 19438, registration: "PK-GFF", hex: "8a023e", fleetCode: "B738", fleetName: "Boeing 737-8U3" },
  { id: 2, fleetId: 19438, registration: "PK-GFG", hex: "8a023f", fleetCode: "B738", fleetName: "Boeing 737-8U3" },
  { id: 3, fleetId: 19512, registration: "PK-GLV", hex: "", fleetCode: "A320", fleetName: "Citilink A320-214" },
];

it("lists every aircraft with its status, problems first", () => {
  const st = emptyState();
  st.lastAirborne = { "1": "2026-11-12T10:00:00Z", "2": "2026-11-09T05:00:00Z" };
  st.seen = { "1": 1 };
  st.aog = { "2": { since: "2026-11-12T06:00:00Z", lastFlown: "2026-11-09T05:00:00Z", wasHidden: false, applied: true, registration: "PK-GFG", fleetId: 19438 } };
  const mx = new Map([[3, { id: 3, fleetId: 19512, since: { "A-check": { hours: 12, cycles: 8 } }, history: [], inMx: { reason: "Hard landing inspection (-650 fpm / 1.3 g)", from: "2026-11-12T08:00:00Z", until: "2026-11-13T08:00:00Z", wasHidden: false, applied: true } }]]);
  const rows = buildRows(aircraft, mx, st, MX_CONFIG, AOG_CONFIG, now);
  expect(rows.map((r) => [r.registration, r.status])).toEqual([["PK-GFG", "AOG"], ["PK-GLV", "Maintenance"], ["PK-GFF", "Available"]]);
  expect(rows[1]).toMatchObject({ nextCheck: "A-check in 38.0 h / 32 cycles", realLastFlown: "not tracked (no hex code)" });
  expect(rows[2]!.realLastFlown).toBe("2 h ago");
  expect(rows[0]!.realLastFlown).toBe("not seen yet (tracking since 2026-11-09 05:00Z)");
  const html = renderPage("t", rows, { live: true, lastPoll: "2026-11-12T11:45:00Z", aogDays: 3 }, "aog");
  expect(html).toContain("PK-GFF");
  expect(html).toContain("<b>1</b>available");
});
