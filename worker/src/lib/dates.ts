/** Timezone helpers built on Intl (no dependencies; works in the Workers runtime). */

export const ID_DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
export const ID_DAYS_LONG = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
export const ID_MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
export const ID_MONTHS_LONG = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function safeTz(tz: string | null | undefined, fallback = "Asia/Jakarta"): string {
  if (!tz) return fallback;
  try {
    dtf(tz);
    return tz;
  } catch {
    return fallback;
  }
}

/**
 * True only for IANA zone names ("Asia/Jakarta", "UTC"). Offset strings like "+07:00" are rejected:
 * JavaScript reads them as UTC+7 but Postgres reads them POSIX-style as UTC−7, so the two sides would disagree.
 */
export function isZoneName(tz: string): boolean {
  if (tz !== "UTC" && !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz)) return false;
  return safeTz(tz, "") === tz;
}

const WEEKDAYS =["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function toLocal(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

/** Offset of `tz` from UTC at instant `date`, in minutes (e.g. +420 for Asia/Jakarta). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = toLocal(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Convert a wall-clock time in `tz` to a UTC Date. */
export function fromLocal(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = tzOffsetMinutes(new Date(guess), tz);
  let result = guess - offset * 60000;
  // Second pass handles instants near DST transitions.
  const offset2 = tzOffsetMinutes(new Date(result), tz);
  if (offset2 !== offset) {
    offset = offset2;
    result = guess - offset * 60000;
  }
  return new Date(result);
}

/** Parse an ISO-8601 string from the model. Values without an offset are wall-clock time in `tz`. */
export function parseAiDateTime(value: string | null | undefined, tz: string, fallback = new Date()): Date {
  if (!value) return fallback;
  const s = value.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  const [, y, mo, d, h, mi, sec, zone] = m;
  if (zone) {
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }
  if (h === undefined) {
    // Date only: keep the current local time of day so ordering within the day stays natural.
    const now = toLocal(new Date(), tz);
    return fromLocal(tz, Number(y), Number(mo), Number(d), now.hour, now.minute, now.second);
  }
  return fromLocal(tz, Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(sec ?? 0));
}

/** UTC [start, end) of a calendar month in `tz`. */
export function monthBounds(year: number, month: number, tz: string): [Date, Date] {
  const start = fromLocal(tz, year, month, 1);
  const end = month === 12 ? fromLocal(tz, year + 1, 1, 1) : fromLocal(tz, year, month + 1, 1);
  return [start, end];
}

/** UTC [start, end) of a local calendar day given as YYYY-MM-DD. */
export function dayBounds(isoDate: string, tz: string): [Date, Date] | null {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = fromLocal(tz, y, mo, d);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = fromLocal(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return [start, end];
}

/** "2026-09" -> {year, month}; defaults to the current month in `tz`. */
export function parsePeriod(period: string | null | undefined, tz: string): { year: number; month: number } {
  const m = period?.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const month = Number(m[2]);
    if (month >= 1 && month <= 12) return { year: Number(m[1]), month };
  }
  const now = toLocal(new Date(), tz);
  return { year: now.year, month: now.month };
}

export function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function formatLocal(date: Date | string, tz: string, withTime = true): string {
  const p = toLocal(new Date(date), tz);
  const base = `${ID_DAYS[p.weekday]}, ${p.day} ${ID_MONTHS[p.month - 1]} ${p.year}`;
  return withTime ? `${base} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` : base;
}

export function monthLabel(year: number, month: number): string {
  return `${ID_MONTHS_LONG[month - 1]} ${year}`;
}

/** Current time description handed to the model so it can resolve "kemarin", "tanggal 25", "jam 9 pagi". */
export function aiNowContext(tz: string): string {
  const now = new Date();
  const p = toLocal(now, tz);
  const offset = tzOffsetMinutes(now, tz);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${off}`;
  return `${iso} (${ID_DAYS_LONG[p.weekday]}, ${p.day} ${ID_MONTHS_LONG[p.month - 1]} ${p.year}, zona waktu ${tz})`;
}
