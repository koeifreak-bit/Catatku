import { describe, expect, it } from "vitest";
import { dayBounds, fromLocal, isZoneName, monthBounds, parseAiDateTime } from "../src/lib/dates";
import { correctUnitError, findAmounts, formatMoney, parseAmount, toNumber } from "../src/lib/money";

describe("money parsing", () => {
  it.each([
    ["Beli makan siang 50rb", 50_000],
    ["Gaji masuk 10jt", 10_000_000],
    ["Beli bensin 35k kemarin", 35_000],
    ["Utang ke Budi 100rb", 100_000],
    ["bayar kos 1,5jt", 1_500_000],
    ["bayar kos 1.5 juta", 1_500_000],
    ["Rp 1.250.000", 1_250_000],
    ["parkir 2 ribu", 2_000],
    ["beli rumah 1,2M", 1_200_000_000],
    ["25000", 25_000],
  ])("%s -> %d", (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });

  it("does not treat words as suffixes", () => {
    expect(findAmounts("beli 5 mangga 20rb")).toEqual([5, 20_000]);
    expect(findAmounts("5 kopi")).toEqual([5]);
  });

  it("handles Indonesian decimal format", () => {
    expect(toNumber("1.250.000,50")).toBe(1_250_000.5);
    expect(toNumber("12.5")).toBe(12.5);
  });

  it("fixes dropped multipliers from the model", () => {
    expect(correctUnitError(50, "Beli makan siang 50rb")).toBe(50_000);
    expect(correctUnitError(10, "Gaji masuk 10jt")).toBe(10_000_000);
    expect(correctUnitError(30_000, "kopi 15rb x2")).toBe(30_000); // not a unit error
    expect(correctUnitError(35_000, "kopi 20rb dan roti 15rb")).toBe(35_000);
  });

  it("formats rupiah", () => {
    expect(formatMoney(1_250_000)).toBe("Rp 1.250.000");
    expect(formatMoney(-5000)).toBe("-Rp 5.000");
  });
});

describe("timezones", () => {
  it("converts Jakarta wall-clock to UTC", () => {
    expect(fromLocal("Asia/Jakarta", 2026, 9, 25, 9, 0).toISOString()).toBe("2026-09-25T02:00:00.000Z");
  });

  it("parses naive AI datetimes in the user's timezone", () => {
    expect(parseAiDateTime("2026-09-25T09:00:00", "Asia/Jakarta").toISOString()).toBe("2026-09-25T02:00:00.000Z");
    expect(parseAiDateTime("2026-09-25T09:00:00+00:00", "Asia/Jakarta").toISOString()).toBe("2026-09-25T09:00:00.000Z");
  });

  it("computes month and day bounds", () => {
    const [s, e] = monthBounds(2026, 12, "Asia/Jakarta");
    expect(s.toISOString()).toBe("2026-11-30T17:00:00.000Z");
    expect(e.toISOString()).toBe("2026-12-31T17:00:00.000Z");
    const [ds, de] = dayBounds("2026-02-28", "Asia/Jakarta")!;
    expect(ds.toISOString()).toBe("2026-02-27T17:00:00.000Z");
    expect(de.toISOString()).toBe("2026-02-28T17:00:00.000Z");
  });

  it("accepts only IANA zone names", () => {
    for (const ok of ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "America/Argentina/Buenos_Aires", "UTC"]) expect(isZoneName(ok)).toBe(true);
    // Offsets mean UTC+7 in JavaScript but UTC-7 in Postgres, so they must be rejected.
    for (const bad of ["+07:00", "+07", "-05:00", "WIB", "Asia/Nowhere", ""]) expect(isZoneName(bad)).toBe(false);
  });

  it("handles DST zones", () => {
    // 2026-03-08 02:30 does not exist in New York; 09:00 that day is EDT (UTC-4).
    expect(fromLocal("America/New_York", 2026, 3, 8, 9, 0).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
});
