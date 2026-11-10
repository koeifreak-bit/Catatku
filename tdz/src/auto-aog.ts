/**
 * Auto AOG from vAMSYS PIREP scoring (TRISTAN, 10 Nov 2026): when one of the airline's Orwell scoring rules for
 * wing strike, tail strike or overweight landing fires on a PIREP, the aircraft is declared AOG and stays hidden
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
}

export const AUTO_AOG_RULES: AutoAogRule[] = [
  { label: "Tail strike", pattern: /tail\s*-?\s*strike/i },
  { label: "Wing strike", pattern: /(wing|wingtip|engine|pod)\s*-?\s*strike/i },
  // Seen live: "Landing weight is outside MLW tolerance" (-25)
  { label: "Overweight landing", pattern: /\bMLW\b|over\s*-?\s*weight/i },
];

export function matchAutoAog(scores: ScoreEntry[] | null | undefined, rules: AutoAogRule[] = AUTO_AOG_RULES) {
  const out: { label: string; rule: string }[] = [];
  for (const s of scores ?? []) {
    if (typeof s?.name !== "string") continue;
    const r = rules.find((x) => x.pattern.test(s.name));
    if (r && !out.some((o) => o.label === r.label)) out.push({ label: r.label, rule: s.name });
  }
  return out;
}

/** Note written on the aircraft; also used to tell incident AOG apart from planespotters parking. */
export const AUTO_AOG_NOTE_PREFIX = "Auto AOG:";
export const autoAogNote = (labels: string[], callsign: string | null, pirepId: number) =>
  `${AUTO_AOG_NOTE_PREFIX} ${labels.join(" + ")} on ${callsign ?? "PIREP"} (PIREP ${pirepId}), staff inspection required`;
