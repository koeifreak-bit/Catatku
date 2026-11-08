/** One scoring band: applies when distance-past-threshold is < `untilM`. */
export interface Band {
  untilM: number;
  points: number;
  label: string;
}

/** ICAO Annex 14 TDZ marking pairs by landing distance available. */
export interface MarkingRule {
  /** Applies when LDA (m) is below this. */
  ldaBelowM: number;
  pairs: number;
}

export interface TdzConfig {
  /** Bands in ascending order, all inside the TDZ. */
  bands: Band[];
  /** From the last band to the end of the TDZ markings. */
  long: { points: number; label: string };
  /** Past the last TDZ marking: penalty + reject. */
  beyond: { points: number; label: string };
  /** Runways shorter than this (m) still get the `beyond` penalty, but the PIREP is not rejected. */
  noRejectBelowRunwayM: number;
  /** Pairs of TDZ markings by LDA; the last entry should use Infinity. */
  markings: MarkingRule[];
  /** Longitudinal spacing of the marking pairs from the threshold. */
  pairSpacingM: number;
  /** Length of one marking stripe; the TDZ ends at the far end of the last stripe. */
  stripeLengthM: number;
  /** Prefix that marks our bonus entry, so re-runs replace it instead of stacking. */
  entryPrefix: string;
}

/** TRISTAN's revision of 8 Nov 2026 (runway drawing). */
export const DEFAULT_CONFIG: TdzConfig = {
  bands: [
    { untilM: 300, points: 0, label: "Early touchdown" },
    // 300 m TDZ marking pair through the end of the aiming point (starts 400 m, up to 60 m long). TRISTAN, 8 Nov 2026.
    { untilM: 460, points: 100, label: "Aiming point landing" },
    { untilM: 600, points: 50, label: "TDZ landing" },
  ],
  long: { points: 0, label: "Long landing" },
  beyond: { points: -200, label: "Landed beyond TDZ" },
  noRejectBelowRunwayM: 2500,
  markings: [
    { ldaBelowM: 900, pairs: 1 },
    { ldaBelowM: 1200, pairs: 2 },
    { ldaBelowM: 1500, pairs: 3 },
    { ldaBelowM: 2400, pairs: 4 },
    { ldaBelowM: Infinity, pairs: 6 },
  ],
  pairSpacingM: 150,
  stripeLengthM: 22.5,
  entryPrefix: "TDZ:",
};
