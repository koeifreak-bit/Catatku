import { describe, expect, it } from "vitest";
import { analyzeCda, CDA_CONFIG as cfg, type PositionReport } from "../src/cda";
import gia176 from "./fixtures/positions-4114066.json";
import pas931 from "./fixtures/positions-4114085.json";

/** Synthetic flight: list of [seconds, altitude, phase]. */
const flight = (pts: [number, number, number][]): PositionReport[] =>
  pts.map(([s, alt, phase]) => ({ altitude: alt, phase, created_at: new Date(Date.UTC(2026, 10, 9) + s * 1000).toISOString() }));
/** Descent from `from` to `to` ft at 1,500 ft/min, a report every 4 s. */
const descend = (t0: number, from: number, to: number, phase = 6): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let s = 0, a = from; a > to; s += 4, a -= 100) out.push([t0 + s, a, phase]);
  return out;
};
const level = (t0: number, alt: number, seconds: number, phase = 6): [number, number, number][] =>
  Array.from({ length: Math.floor(seconds / 4) + 1 }, (_, i) => [t0 + i * 4, alt + (i % 2 ? 30 : -30), phase] as [number, number, number]);
const touchdown = (t0: number, field = 30): [number, number, number][] => [[t0, field, 9], [t0 + 4, field, 9], [t0 + 8, field, 10]];

describe("analyzeCda", () => {
  it("smooth descent from cruise to touchdown is continuous", () => {
    const r = analyzeCda(flight([[0, 35000, 5], ...descend(4, 35000, 30), ...touchdown(1400)]), cfg);
    expect(r).toMatchObject({ continuous: true, levelSegments: [], fieldFt: 30 });
  });

  it("a 2-minute level-off at 5,000 ft breaks it", () => {
    const r = analyzeCda(flight([...descend(0, 35000, 5000), ...level(1200, 5000, 120), ...descend(1324, 5000, 30), ...touchdown(1600)]), cfg);
    expect(r!.continuous).toBe(false);
    expect(r!.levelSegments).toHaveLength(1);
    expect(r!.levelSegments[0]!.aalFt).toBe(5000);
    // The ±100 ft band also catches the last/first descent reports around the level-off (~8–12 s).
    expect(r!.levelSegments[0]!.seconds).toBeGreaterThanOrEqual(120);
    expect(r!.levelSegments[0]!.seconds).toBeLessThanOrEqual(140);
  });

  it("short level-offs (≤ 60 s including the transition) are fine", () => {
    const r = analyzeCda(flight([...descend(0, 35000, 5000), ...level(1200, 5000, 44), ...descend(1248, 5000, 30), ...touchdown(1600)]), cfg);
    expect(r!.continuous).toBe(true);
  });

  it("level flight below 2,000 ft AAL (glideslope intercept) doesn't count", () => {
    const r = analyzeCda(flight([...descend(0, 35000, 1800), ...level(1300, 1800, 180, 8), ...descend(1484, 1800, 30, 8), ...touchdown(1600)]), cfg);
    expect(r!.continuous).toBe(true);
  });

  it("uses height above the field, so high airports are fair", () => {
    // Field at 3,000 ft: a level-off at 4,500 ft MSL is only 1,500 ft AAL → allowed.
    const r = analyzeCda(flight([...descend(0, 35000, 4500), ...level(1200, 4500, 180), ...descend(1384, 4500, 3000), ...touchdown(1500, 3000)]), cfg);
    expect(r).toMatchObject({ continuous: true, fieldFt: 3000 });
  });

  it("no descent phase or no touchdown → no verdict", () => {
    expect(analyzeCda(flight([[0, 35000, 5], [4, 35000, 5]]), cfg)).toBeNull();
    expect(analyzeCda(flight(descend(0, 35000, 1000)), cfg)).toBeNull();
    expect(analyzeCda([], cfg)).toBeNull();
  });
});

describe("real IJV flights (vAMSYS position reports)", () => {
  const load = (id: number) => (id === 4114066 ? gia176 : pas931) as PositionReport[];
  it("GIA176 (4114066): continuous", () => {
    expect(analyzeCda(load(4114066), cfg)!.continuous).toBe(true);
  });
  it("PAS931 (4114085): 20 minutes level at 4,600 ft → not continuous", () => {
    const r = analyzeCda(load(4114085), cfg)!;
    expect(r.continuous).toBe(false);
    expect(r.levelSegments[0]).toMatchObject({ aalFt: 4600 });
    expect(r.levelSegments[0]!.seconds).toBeGreaterThan(1100);
  });
});
