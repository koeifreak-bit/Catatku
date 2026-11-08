import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG as cfg } from "../src/config";
import { FT_TO_M, scoreTouchdown, tdzEnd } from "../src/score";

const ft = (m: number) => m / FT_TO_M;
const LONG = ft(3000); // LDA 3000 m → 6 pairs → TDZ ends 922.5 m
const at = (m: number, ldaFt = LONG) => scoreTouchdown(ft(m), ldaFt, cfg);

describe("tdzEnd: end of the last ICAO TDZ marking", () => {
  it.each([
    [800, 1, 172.5],
    [899, 1, 172.5],
    [900, 2, 322.5],
    [1199, 2, 322.5],
    [1200, 3, 472.5],
    [1499, 3, 472.5],
    [1500, 4, 622.5],
    [2399, 4, 622.5],
    [2400, 6, 922.5],
    [4000, 6, 922.5],
  ])("LDA %d m → %d pairs, ends at %d m", (ldaM, pairs, endM) => {
    expect(tdzEnd(ft(ldaM), cfg)).toEqual({ pairs, endM });
  });

  it("uses the full 6-pair pattern when LDA is unknown", () => {
    expect(tdzEnd(null, cfg)).toEqual({ pairs: 6, endM: 922.5 });
    expect(tdzEnd(0, cfg)).toEqual({ pairs: 6, endM: 922.5 });
  });
});

describe("scoreTouchdown on a 6-pair runway (TRISTAN's revision, 8 Nov 2026)", () => {
  it.each([
    [0, 0, "none"],
    [299.9, 0, "none"],
    [300, 100, "none"],
    [399.9, 100, "none"],
    [400, 100, "none"], // aiming point marking itself
    [459.9, 100, "none"],
    [460, 50, "none"],
    [599.9, 50, "none"],
    [600, 0, "none"],
    [609.6, 0, "none"], // 2000 ft is NOT a reject
    [900, 0, "none"],
    [922.5, 0, "none"], // exactly at the end of the last marking
    [923, -200, "reject"],
    [1500, -200, "reject"],
  ])("%d m → %d pts (%s)", (m, points, action) => {
    expect(at(m)).toMatchObject({ points, action });
  });

  it("flags touchdowns before the threshold for review with no points", () => {
    expect(at(-5)).toMatchObject({ points: 0, action: "review" });
  });
});

describe("shorter runways reject once their markings run out", () => {
  it("4 pairs (1500–2400 m): −200 past 622.5 m, but no reject (runway < 2500 m)", () => {
    expect(scoreTouchdown(ft(620), ft(2000), cfg)).toMatchObject({ points: 0, action: "none" });
    expect(scoreTouchdown(ft(630), ft(2000), cfg)).toMatchObject({ points: -200, action: "none" });
  });
  it("3 pairs (1200–1500 m): 450 m is +100, 480 m is −200 without reject", () => {
    expect(scoreTouchdown(ft(450), ft(1400), cfg)).toMatchObject({ points: 100, action: "none" });
    expect(scoreTouchdown(ft(480), ft(1400), cfg)).toMatchObject({ points: -200, action: "none" });
  });
  it("2400–2500 m runway: 6 pairs, −200 past 922.5 m but no reject", () => {
    expect(scoreTouchdown(ft(950), ft(2450), cfg)).toMatchObject({ tdzEndM: 922.5, points: -200, action: "none" });
  });
  it("2500 m and longer: −200 and reject past 922.5 m", () => {
    expect(scoreTouchdown(ft(950), ft(2500), cfg)).toMatchObject({ points: -200, action: "reject" });
  });
  it("unknown runway length: long-runway rules (reject)", () => {
    expect(scoreTouchdown(ft(950), null, cfg)).toMatchObject({ points: -200, action: "reject" });
  });
});

describe("real IJV PIREPs (runway length = distance + vAMSYS lda)", () => {
  it.each([
    ["GIA162 WIEE RW33", 1954, 7888, 50, "none"], // 596 m on a 3000 m runway
    ["CTV970 RW16", 1196, 6185, 100, "none"], // 365 m
    ["GIA604 RW26", 968, 7754, 0, "none"], // 295 m
    ["GIA407 WIII RW06", 2087, 7754.4, 0, "none"], // 636 m on 3000 m: was wrongly rejected
    ["CTV350 WAAA RW21 (903 m)", 2963, 7208.9, 0, "none"], // inside the 922.5 m box
    ["CTV350 WAAA RW21 (995 m)", 3264, 6900, -200, "reject"], // past the last marking
  ])("%s", (_n, dist, lda, points, action) => {
    expect(scoreTouchdown(dist, dist + lda, cfg)).toMatchObject({ points, action });
  });
});
