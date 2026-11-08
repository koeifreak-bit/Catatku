import type { TdzConfig } from "./config";

export const FT_TO_M = 0.3048;

export type Action = "none" | "reject" | "review";

export interface Score {
  distM: number;
  /** Far end of the last TDZ marking for this runway. */
  tdzEndM: number;
  pairs: number;
  points: number;
  label: string;
  action: Action;
}

/** End of the last TDZ marking for a runway of this length (unknown → longest pattern). */
export function tdzEnd(runwayFt: number | null, cfg: TdzConfig): { pairs: number; endM: number } {
  const ldaM = runwayFt && runwayFt > 0 ? runwayFt * FT_TO_M : Infinity;
  const rule = cfg.markings.find((r) => ldaM < r.ldaBelowM) ?? cfg.markings[cfg.markings.length - 1]!;
  return { pairs: rule.pairs, endM: rule.pairs * cfg.pairSpacingM + cfg.stripeLengthM };
}

/**
 * Scores a touchdown. `distanceFt` = vAMSYS `distance_from_start_ft`;
 * `runwayFt` = full runway length (vAMSYS `distance_from_start_ft + lda`, since its `lda` is the remainder).
 */
export function scoreTouchdown(distanceFt: number, runwayFt: number | null, cfg: TdzConfig): Score {
  const distM = distanceFt * FT_TO_M;
  const { pairs, endM: tdzEndM } = tdzEnd(runwayFt, cfg);
  const base = { distM, tdzEndM, pairs };

  if (distM < 0) return { ...base, points: 0, label: "Short of threshold", action: "review" };
  if (distM > tdzEndM) {
    // Short runways: keep the penalty but don't reject (TRISTAN, 8 Nov 2026). Unknown length → long-runway rules.
    const shortRunway = runwayFt != null && runwayFt > 0 && runwayFt * FT_TO_M < cfg.noRejectBelowRunwayM;
    return { ...base, ...cfg.beyond, action: shortRunway ? "none" : "reject" };
  }

  const band = cfg.bands.find((b) => distM < b.untilM);
  return { ...base, ...(band ?? cfg.long), action: "none" };
}
