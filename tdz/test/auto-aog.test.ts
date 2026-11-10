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

it("IJV's actual Orwell scorer names (all scoring groups, 10 Nov 2026)", () => {
  const aog = {
    "Tailstrike Potential (B737-800 Aircraft Geometry Limits) (Expect Debrief From Chief Pilot)": "Tail strike",
    "Tailstrike Potential (FCTM Aircraft Geometry Limits) (Expect Debrief From Chief Pilot)": "Tail strike",
    "Tailstrike Potential (B777-300ER Aircraft Geometry Limits ; Maximum pitch angle 7,5) (Expect Debrief From Chief Pilot)": "Tail strike",
    "Tailstrike Potential (A320-200 FCTM Aircraft Geometry Limit) (Expect Debrief From Chief Pilot)": "Tail strike",
    "Wing Strike Potential (Expect Debrief From Chief Pilot)": "Wing strike",
    "WIng Strike Potential (Expect Debrief From Chief Pilot)": "Wing strike",
    "Landing weight is outside MLW tolerance": "Overweight landing",
  };
  for (const [name, label] of Object.entries(aog)) expect(matchAutoAog([{ name, points: -50 }]).map((m) => m.label)).toEqual([label]);
  const notAog = [
    "Takeoff weight is outside MTOW tolerance",
    "Liftoff Pitch Attitude (Maximum 10 Degrees. Expect briefing with chief pilot)",
    "Landing with fuel below final reserve",
    "Stabilized Approach Not Achieved (OM-A GA 11.5 0.7 Stabilized Approach)",
    "Landing Flap Not Set Violation Of Stabilized Approach",
    "Non Compliance (B777 FCOM NP.21.25 | Flaps 1 T/O Prohibited)",
    "After Start Flow Not Completed PRO-NOR-SOP-09-A-00019960.0001001",
    "Single Engine Taxi Out Forbidden",
    "Taxi Overspeed",
    "Airbus Landing Rate Zone ΔVRTA & RALR",
  ];
  for (const name of notAog) expect(matchAutoAog([{ name, points: -25 }])).toEqual([]);
});
