/**
 * Continuous Descent Arrival (CDA) check from vAMSYS position reports (one every ~4 s).
 *
 * Window: from top of descent (first report in the descent phase) down to `endAalFt` above the arrival field.
 * A "level segment" is any stretch where the altitude stays within ±`levelTolFt` for longer than `maxLevelSec`.
 * No level segment in the window = continuous descent.
 */
export interface PositionReport {
  altitude: number;
  phase: number;
  created_at: string;
}

export interface CdaConfig {
  /** vAMSYS phase numbers: 6 = descent, 9 = touchdown/rollout. */
  descentPhase: number;
  touchdownPhase: number;
  endAalFt: number;
  levelTolFt: number;
  maxLevelSec: number;
  points: number;
  label: string;
  entryPrefix: string;
}

export const CDA_CONFIG: CdaConfig = {
  descentPhase: 6,
  touchdownPhase: 9,
  endAalFt: 2000, // TRISTAN, 9 Nov 2026: like real-world CDO, judge down to ~2,000 ft above the airport
  levelTolFt: 100,
  maxLevelSec: 60,
  points: 50, // reward only, no penalty
  label: "Continuous descent",
  entryPrefix: "CDA:",
};

export interface LevelSegment {
  /** Altitude above the arrival field (ft), rounded to 100. */
  aalFt: number;
  seconds: number;
}

export interface CdaResult {
  continuous: boolean;
  levelSegments: LevelSegment[];
  todFt: number;
  fieldFt: number;
}

/** null when the reports don't contain a descent and a touchdown. */
export function analyzeCda(reports: PositionReport[], cfg: CdaConfig): CdaResult | null {
  const pts = [...reports].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const tod = pts.findIndex((p) => p.phase === cfg.descentPhase);
  if (tod < 0) return null;
  const td = pts.findIndex((p, i) => i > tod && p.phase >= cfg.touchdownPhase);
  if (td < 0) return null;

  // Field elevation = median altitude of the first reports after touchdown.
  const after = pts.slice(td, td + 5).map((p) => p.altitude).sort((a, b) => a - b);
  const fieldFt = after[Math.floor(after.length / 2)] ?? 0;

  const win = pts.slice(tod, td).filter((p) => p.altitude - fieldFt >= cfg.endAalFt);
  const t = (p: PositionReport) => Date.parse(p.created_at);
  const levelSegments: LevelSegment[] = [];
  let i = 0;
  while (i < win.length) {
    let j = i;
    let lo = win[i]!.altitude;
    let hi = lo;
    while (j + 1 < win.length) {
      const a = win[j + 1]!.altitude;
      if (Math.max(hi, a) - Math.min(lo, a) > 2 * cfg.levelTolFt) break;
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
      j++;
    }
    const seconds = (t(win[j]!) - t(win[i]!)) / 1000;
    if (seconds > cfg.maxLevelSec) {
      levelSegments.push({ aalFt: Math.round(((lo + hi) / 2 - fieldFt) / 100) * 100, seconds: Math.round(seconds) });
      i = j + 1;
    } else i++;
  }
  return { continuous: levelSegments.length === 0, levelSegments, todFt: pts[tod]!.altitude, fieldFt };
}

export function describeCda(r: CdaResult, cfg: CdaConfig): string {
  if (r.continuous) return `**Continuous descent:** no level-off longer than ${cfg.maxLevelSec} s from top of descent to ${cfg.endAalFt} ft AAL → +${cfg.points} pts.`;
  const segs = r.levelSegments.map((s) => `${s.aalFt.toLocaleString("en-US")} ft AAL for ${s.seconds} s`).join(", ");
  return `**Continuous descent:** not achieved (level at ${segs}).`;
}
