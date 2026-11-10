import { expect, it } from "vitest";
import { autoAogNote, matchAutoAog } from "../src/auto-aog";

it("matches IJV's live overweight rule and common strike wordings", () => {
  expect(matchAutoAog([{ name: "Landing weight is outside MLW tolerance", points: -25 }])).toEqual([
    { label: "Overweight landing", rule: "Landing weight is outside MLW tolerance" },
  ]);
  for (const name of ["Tail Strike", "Tailstrike detected", "Tail-strike on landing"]) expect(matchAutoAog([{ name, points: -100 }])[0]!.label).toBe("Tail strike");
  for (const name of ["Wing Strike", "Wingstrike", "Wingtip strike", "Engine pod strike"]) expect(matchAutoAog([{ name, points: -100 }])[0]!.label).toBe("Wing strike");
  expect(matchAutoAog([{ name: "Overweight Landing", points: -50 }])[0]!.label).toBe("Overweight landing");
});

it("ignores IJV's other scoring rules", () => {
  const normal = [
    "Aircraft Shut Down and Secured", "Liftoff Pitch Attitude (Maximum 10 Degrees. Expect briefing with chief pilot)",
    "Taxi Overspeed Detected", "Stabilized Approach", "Flaps Config 3 Landing (Airbus Green Operation Procedure)",
    "Single Engine Taxi in", "Non Compliance Of Engine Cool Down Time (3 Minute)",
  ].map((name) => ({ name, points: -10 }));
  expect(matchAutoAog(normal)).toEqual([]);
  expect(matchAutoAog(null)).toEqual([]);
});

it("several hits on one flight are combined once each", () => {
  const m = matchAutoAog([{ name: "Tail strike", points: -100 }, { name: "Tailstrike (landing)", points: -50 }, { name: "Landing weight is outside MLW tolerance", points: -25 }]);
  expect(m.map((x) => x.label)).toEqual(["Tail strike", "Overweight landing"]);
  expect(autoAogNote(m.map((x) => x.label), "CTV343", 4121320)).toBe("Auto AOG: Tail strike + Overweight landing on CTV343 (PIREP 4121320), staff inspection required");
});
