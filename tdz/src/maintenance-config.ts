import type { MxConfig } from "./maintenance";

/**
 * Proposed values, scaled to VA utilisation (median aircraft: ~4 flights/month; busiest ~80).
 * Real-world intervals (A-check ~ 600 FH) would never trigger here.
 */
export const MX_CONFIG: MxConfig = {
  // vAMSYS landing G runs high (p95 1.71 g; 23 flights hit 1.8 g softer than -400 fpm), so G limits are 2.0 / 2.3.
  // Historic fleets (TRISTAN, 9 Nov 2026): MD-11, 747-200/-400, CRJ1000, all 737 Classics,
  // "Historical" A320-232 and 777-300ER, A300, F28, RJ85, ATR 42-500, ATR 72-500.
  excludedFleetIds: [
    26882, 26900, 26883, 27413, // MD11, B742, B744, CRJX
    27410, 26885, 30052, 27411, 30053, 27412, 19835, 29610, 29609, // B733/B734/B735 (incl. NAM Air, Sriwijaya)
    19594, 28616, // A320-232 Historical, B77W Historical
    26963, 28363, 26884, // A306, F28, RJ85
    23795, 23807, // AT45, AT75
  ],
  checks: [
    { name: "A-check", everyHours: 50, everyCycles: 40, durationH: 24 },
    { name: "C-check", everyHours: 500, everyCycles: 400, durationH: 5 * 24 },
  ],
  hardLanding: [
    { name: "Severe hard landing inspection", rateFpm: -800, g: 2.3, durationH: 72 },
    { name: "Hard landing inspection", rateFpm: -600, g: 2.0, durationH: 24 },
  ],
  tag: "[MX-AUTO]",
};
