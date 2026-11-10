/**
 * Auto AOG from vAMSYS PIREP scoring (TRISTAN, 10 Nov 2026): when one of the airline's Orwell scoring rules for
 * tail strike, wing strike, liftoff pitch or overweight landing deducts points on a PIREP, the aircraft is declared AOG and stays hidden
 * until staff unpark it (damage needs a sign-off, not a timer).
 *
 * Rules are matched by name, so renaming a rule in Orwell keeps working as long as the wording is similar.
 */
export interface ScoreEntry {
  name: string;
  points: number;
}

export interface AutoAogRule {
  label: string;
  pattern: RegExp;
  /** Aircraft is released automatically after this inspection time. */
  durationH: number;
}

export const AUTO_AOG_RULES: AutoAogRule[] = [
  { label: "Tail strike", pattern: /tail\s*-?\s*strike/i, durationH: 72 },
  { label: "Wing strike", pattern: /(wing|wingtip|engine|pod)\s*-?\s*strike/i, durationH: 72 },
  // "Liftoff Pitch Attitude (Aircraft Geometry Limit ; Maximum 10 Degrees…)": tail-strike risk on takeoff (TRISTAN, 10 Nov 2026)
  { label: "Liftoff pitch (tail strike risk)", pattern: /lift\s*-?\s*off\s*pitch/i, durationH: 48 },
  // Seen live: "Landing weight is outside MLW tolerance" (-25)
  { label: "Overweight landing", pattern: /\bMLW\b|over\s*-?\s*weight/i, durationH: 24 },
];

export function matchAutoAog(scores: ScoreEntry[] | null | undefined, rules: AutoAogRule[] = AUTO_AOG_RULES) {
  const out: { label: string; rule: string; durationH: number }[] = [];
  for (const s of scores ?? []) {
    if (typeof s?.name !== "string") continue;
    if (!(Number(s.points) < 0)) continue; // only when the rule actually deducted points
    const r = rules.find((x) => x.pattern.test(s.name));
    if (r && !out.some((o) => o.label === r.label)) out.push({ label: r.label, rule: s.name, durationH: r.durationH });
  }
  return out;
}

/** Note written on the aircraft; also used to tell incident AOG apart from planespotters parking. */
export const AUTO_AOG_NOTE_PREFIX = "Auto AOG:";
export const autoAogNote = (labels: string[], callsign: string | null, pirepId: number) =>
  `${AUTO_AOG_NOTE_PREFIX} ${labels.join(" + ")} on ${callsign ?? "PIREP"} (PIREP ${pirepId}), inspection`;
