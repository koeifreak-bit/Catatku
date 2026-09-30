import { describe, expect, it } from "vitest";
import { FinancialInsight, MessageAnalysis, ReceiptData, VoiceAnalysis, schemaFor } from "../src/services/ai";

type S = Record<string, any>;

/** Every node must use Gemini's OpenAPI-style types and never JSON-Schema-only keywords. */
function assertGeminiShape(node: S, path = "$") {
  expect(["OBJECT", "ARRAY", "STRING", "NUMBER", "INTEGER", "BOOLEAN"], path).toContain(node.type);
  for (const bad of ["anyOf", "$schema", "additionalProperties", "oneOf", "const"]) expect(node, `${path} has ${bad}`).not.toHaveProperty(bad);
  if (node.type === "OBJECT") {
    expect(node.propertyOrdering, path).toEqual(Object.keys(node.properties));
    for (const [k, v] of Object.entries(node.properties as S)) assertGeminiShape(v as S, `${path}.${k}`);
  }
  if (node.type === "ARRAY") assertGeminiShape(node.items, `${path}[]`);
}

describe("Gemini response schemas", () => {
  it.each([
    ["MessageAnalysis", MessageAnalysis],
    ["VoiceAnalysis", VoiceAnalysis],
    ["ReceiptData", ReceiptData],
    ["FinancialInsight", FinancialInsight],
  ])("%s converts to Gemini's schema format", (_name, schema) => {
    assertGeminiShape(schemaFor(schema));
  });

  it("keeps enums, nullability, required fields and descriptions", () => {
    const s = schemaFor(MessageAnalysis) as S;
    expect(s.required).toEqual(["intent", "transactions", "reminder", "reply"]);
    expect(s.properties.intent).toMatchObject({ type: "STRING", format: "enum", enum: ["transaction", "reminder", "question", "other"] });
    expect(s.properties.reminder).toMatchObject({ type: "OBJECT", nullable: true });
    const tx = s.properties.transactions.items;
    expect(tx.properties.debt_direction).toMatchObject({ type: "STRING", nullable: true, enum: ["borrow", "repay", "lend", "collect"] });
    expect(tx.properties.merchant).toMatchObject({ type: "STRING", nullable: true });
    expect(tx.properties.amount.description).toMatch(/50rb/);
  });

  it("adds the transcript field for voice notes", () => {
    const s = schemaFor(VoiceAnalysis) as S;
    expect(s.properties.transcript).toMatchObject({ type: "STRING" });
    expect(s.required).toContain("transcript");
  });
});
