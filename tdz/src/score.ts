import type { TdzConfig } from "./config";

export const FT_TO_M = 0.3048;

export type Action = "none" | "reject" | "review";

export interface Score {
  distM: number;
  tdzEndM: number;
  points: number;
  label: string;
  action: Action;
}

/**
 * Scores a touchdown from vAMSYS's `distance_from_start_ft` and `lda` (both in feet).
 * The TDZ ends at min(cfg.tdzMaxM, LDA / cfg.ldaDivisor). Past it: penalty + reject.
 */
export function scoreTouchdown(distanceFt: number, ldaFt: number | null, cfg: TdzConfig): Score {
  const distM = distanceFt * FT_TO_M;
  const tdzEndM = ldaFt && ldaFt > 0 ? Math.min(cfg.tdzMaxM, (ldaFt * FT_TO_M) / cfg.ldaDivisor) : cfg.tdzMaxM;

  if (distM < 0) return { distM, tdzEndM, points: 0, label: "Short of threshold", action: "review" };
  if (distM > tdzEndM) return { distM, tdzEndM, ...cfg.beyond, action: "reject" };

  const band = cfg.bands.find((b) => distM < b.untilM);
  // distM <= tdzEndM <= tdzMaxM, and the last band ends at tdzMaxM; landing exactly on it uses the last band.
  const { points, label } = band ?? cfg.bands[cfg.bands.length - 1]!;
  return { distM, tdzEndM, points, label, action: "none" };
}
