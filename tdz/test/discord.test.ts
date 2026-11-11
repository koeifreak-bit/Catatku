import { describe, expect, it } from "vitest";
import { commandReply, eventsMessage, postWebhook, verifyDiscord } from "../src/discord";
import type { Row } from "../src/status-page";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("Discord request signature", () => {
  it("accepts Discord-signed requests and rejects tampered ones", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = hex((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
    const ts = "1794300000", body = '{"type":1}';
    const sig = hex(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(ts + body)));
    expect(await verifyDiscord(pub, sig, ts, body)).toBe(true);
    expect(await verifyDiscord(pub, sig, ts, '{"type":2}')).toBe(false);
    expect(await verifyDiscord(pub, null, ts, body)).toBe(false);
    expect(await verifyDiscord("", sig, ts, body)).toBe(false);
  });
});

const row = (registration: string, status: Row["status"], extra: Partial<Row> = {}): Row => ({
  id: 1, registration, fleet: "B738 – Boeing 737-8U3", status, detail: "", nextCheck: "A-check in 40.0 h / 30 cycles",
  realLastFlown: "2 h ago", tracked: true, lastTs: 0, ...extra,
});
const rows: Row[] = [
  row("PK-GFF", "Available"),
  row("PK-GQD", "AOG (incident)", { fleet: "A320 – Citilink Airbus A320-214", detail: "Overweight landing on CTV343", until: "2026-11-11T17:40:00Z" }),
  row("PK-GFH", "Parked (staff)", { detail: "Declared AOG by staff: planespotters" }),
  row("PK-GLV", "Maintenance", { fleet: "A320 – Citilink Airbus A320-214", detail: "Hard landing inspection", until: "2026-11-12T08:00:00Z" }),
];

describe("slash commands", () => {
  it("/aog lists AOG, incident and parked aircraft", () => {
    const e = commandReply("aog", undefined, rows).embeds![0]!;
    expect(e.title).toBe("✈️ Aircraft AOG / parked (2)");
    expect(e.description).toContain("**PK-GQD** · A320 · AOG (incident) — Overweight landing on CTV343 · until <t:1794418800:f>");
    expect(e.description).not.toContain("PK-GLV");
  });
  it("/maintenance lists aircraft in maintenance; empty list is friendly", () => {
    expect(commandReply("maintenance", undefined, rows).embeds![0]!.description).toContain("PK-GLV");
    expect(commandReply("maintenance", undefined, [row("PK-GFF", "Available")]).embeds![0]!.description).toBe("No aircraft in maintenance. 🎉");
  });
  it("/fleet summarises availability per type", () => {
    const e = commandReply("fleet", undefined, rows).embeds![0]! as { description: string; fields: { name: string; value: string }[] };
    expect(e.description).toBe("**1/4** available · **1** in maintenance · **2** AOG / parked");
    expect(e.fields).toEqual(expect.arrayContaining([{ name: "B738", value: "1/2 available", inline: true }]));
  });
  it("/aircraft accepts short registrations and explains unknown ones", () => {
    const r = commandReply("aircraft", [{ name: "registration", value: "gqd" }], rows).embeds![0]! as { title: string; fields: { name: string; value: string }[] };
    expect(r.title).toBe("✈️ PK-GQD");
    expect(r.fields.find((f) => f.name === "Status")!.value).toBe("AOG (incident)");
    expect(commandReply("aircraft", [{ name: "registration", value: "XYZ" }], rows)).toMatchObject({ flags: 64 });
  });
  it("long lists stay under Discord's embed limit", () => {
    const many = Array.from({ length: 300 }, (_, i) => row(`PK-X${i}`, "Parked (staff)", { detail: "planespotters: parked/stored long note".repeat(2) }));
    const d = commandReply("aog", undefined, many).embeds![0]!.description!;
    expect(d.length).toBeLessThan(4096);
    expect(d).toMatch(/… and \d+ more$/);
  });
});

describe("channel posts", () => {
  it("formats grounded / released events, max 10 embeds per message, no pings", async () => {
    const m = eventsMessage([
      { kind: "mx-start", registration: "PK-GLV", reason: "Hard landing inspection (-650 fpm / 1.3 g)", until: "2026-11-12T08:00:00Z" },
      { kind: "aog", registration: "PK-GQD", reason: "Overweight landing on CTV343 (PIREP 4121320), inspection" },
      { kind: "aog-release", registration: "PK-GFX" },
    ]);
    expect(m.embeds.map((e) => e!.title)).toEqual(["🔧 PK-GLV into maintenance", "⛔ PK-GQD AOG", "✅ PK-GFX back in service"]);
    expect(m.allowed_mentions).toEqual({ parse: [] });
    const sent: unknown[] = [];
    await postWebhook("https://discord.example/webhook", Array.from({ length: 23 }, () => ({ kind: "aog-release" as const, registration: "PK-A" })), async (_u, init) => {
      sent.push(JSON.parse(String(init!.body)));
      return new Response(null, { status: 204 });
    });
    expect(sent).toHaveLength(3);
    await postWebhook(undefined, [{ kind: "aog-release" }], async () => { throw new Error("must not post"); });
  });
});
