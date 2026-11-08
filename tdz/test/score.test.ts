import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config";
import { FT_TO_M, scoreTouchdown } from "../src/score";

const LONG_RWY_FT = 12000; // LDA/3 ≈ 1219 m, so the TDZ end is 900 m
const ft = (m: number) => m / FT_TO_M;
const at = (m: number, lda = LONG_RWY_FT) => scoreTouchdown(ft(m), lda, cfg);

describe("scoreTouchdown on a long runway (TDZ end 900 m)", () => {
  it.each([
    [0, 50, "none"],
    [299.9, 50, "none"],
    [300, 100, "none"],
    [399.9, 100, "none"],
    [400, 50, "none"],
    [599.9, 50, "none"],
    [600, -100, "none"],
    [899.9, -100, "none"],
    [900, -100, "none"],
    [900.5, -200, "reject"],
    [1500, -200, "reject"],
  ])("%d m → %d pts (%s)", (m, points, action) => {
    const s = at(m);
    expect(s.points).toBe(points);
    expect(s.action).toBe(action);
    expect(s.tdzEndM).toBe(900);
  });

  it("flags touchdowns before the threshold for review with no points", () => {
    expect(at(-5)).toMatchObject({ points: 0, action: "review" });
  });
});

describe("short runway: TDZ end = LDA / 3", () => {
  // Real IJV example: RW16, LDA 6185 ft → 1885 m → TDZ end ≈ 628 m
  it("rejects a landing past LDA/3 even when it is under 900 m", () => {
    const s = scoreTouchdown(ft(650), 6185, cfg);
    expect(s.tdzEndM).toBeCloseTo(628.4, 1);
    expect(s).toMatchObject({ points: -200, action: "reject" });
  });
  it("still scores inside the shortened TDZ", () => {
    expect(scoreTouchdown(ft(620), 6185, cfg)).toMatchObject({ points: -100, action: "none" });
    expect(scoreTouchdown(1196, 6185, cfg)).toMatchObject({ points: 100, action: "none" }); // real: 365 m
  });
});

it("falls back to the 900 m TDZ end when LDA is unknown", () => {
  expect(scoreTouchdown(ft(850), null, cfg).tdzEndM).toBe(900);
});

it("matches a real IJV PIREP (GIA162, RW33, 1954 ft) → 596 m → +50", () => {
  expect(scoreTouchdown(1954, 7888, cfg)).toMatchObject({ points: 50, action: "none" });
});
