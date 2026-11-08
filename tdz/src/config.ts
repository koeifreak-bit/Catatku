/** One scoring band: applies when distance-past-threshold is < `untilM`. */
export interface Band {
  untilM: number;
  points: number;
  label: string;
}

export interface TdzConfig {
  /** Bands in ascending order. Distances beyond the TDZ end never reach a band. */
  bands: Band[];
  /** The TDZ ends at min(tdzMaxM, LDA / ldaDivisor). */
  tdzMaxM: number;
  ldaDivisor: number;
  beyond: { points: number; label: string };
  /** Prefix that marks our bonus entry, so re-runs replace it instead of stacking. */
  entryPrefix: string;
}

export const DEFAULT_CONFIG: TdzConfig = {
  bands: [
    { untilM: 300, points: 50, label: "TDZ landing" },
    { untilM: 400, points: 100, label: "Aiming point landing" },
    { untilM: 600, points: 50, label: "TDZ landing" },
    { untilM: 900, points: -100, label: "Long landing" },
  ],
  tdzMaxM: 900,
  ldaDivisor: 3,
  beyond: { points: -200, label: "Landed beyond TDZ" },
  entryPrefix: "TDZ:",
};
