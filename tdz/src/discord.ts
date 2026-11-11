/**
 * Discord bot for the IJV fleet status, served by this Worker (no extra hosting):
 *  - Slash commands via Discord "Interactions endpoint URL" → POST /discord/interactions
 *    /aog, /maintenance, /fleet, /aircraft registration:PK-GFF
 *  - Automatic channel posts (Discord webhook) when aircraft are grounded or released.
 */
import type { Row } from "./status-page";

const PUBLIC_PAGE = "https://vamsys-tdz.koeifreak.workers.dev";
const RED = 0xd92d20, AMBER = 0xf79009, GREEN = 0x12b76a, BLUE = 0x2e90fa;

const hexToBytes = (hex: string) => new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

/** Verify Discord's Ed25519 request signature. */
export async function verifyDiscord(publicKeyHex: string, signatureHex: string | null, timestamp: string | null, body: string): Promise<boolean> {
  if (!signatureHex || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signatureHex), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

export const COMMANDS = [
  { name: "aog", description: "Aircraft currently AOG or parked (IJV fleet)", type: 1 },
  { name: "maintenance", description: "Aircraft currently in maintenance (IJV fleet)", type: 1 },
  { name: "fleet", description: "IJV fleet availability summary", type: 1 },
  {
    name: "aircraft",
    description: "Status of one aircraft",
    type: 1,
    options: [{ name: "registration", description: "e.g. PK-GFF or GFF", type: 3, required: true }],
  },
];

const fmt = (iso?: string) => (iso ? `<t:${Math.floor(Date.parse(iso) / 1000)}:f>` : "–");
const rel = (iso?: string) => (iso ? `<t:${Math.floor(Date.parse(iso) / 1000)}:R>` : "");
const norm = (r: string) => {
  const x = r.trim().toUpperCase().replace(/\s+/g, "");
  return x.startsWith("PK-") ? x : x.startsWith("PK") ? `PK-${x.slice(2)}` : `PK-${x}`;
};
const isAog = (r: Row) => r.status === "AOG" || r.status === "AOG (incident)" || r.status === "Parked (staff)" || r.status === "Maintenance + AOG";
const isMx = (r: Row) => r.status === "Maintenance" || r.status === "Maintenance + AOG";

function listEmbed(title: string, rows: Row[], color: number, empty: string, link: string) {
  const lines = rows.map((r) => `**${r.registration}** · ${r.fleet.split(" – ")[0]} · ${r.status}${r.detail ? ` — ${r.detail}` : ""}${r.until ? ` · until ${fmt(r.until)}` : ""}`);
  // Discord embed description limit: 4096 chars.
  let desc = "";
  let shown = 0;
  for (const l of lines) {
    if (desc.length + l.length + 1 > 3900) break;
    desc += (desc ? "\n" : "") + l;
    shown++;
  }
  if (shown < lines.length) desc += `\n… and ${lines.length - shown} more`;
  return { title: `${title} (${rows.length})`, description: rows.length ? desc : empty, color, url: link, footer: { text: "IJV fleet status · real-world data © adsb.lol (ODbL)" } };
}

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  url?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}
export interface Reply {
  content?: string;
  flags?: number;
  embeds?: Embed[];
}

/** Build the reply for a slash command. */
export function commandReply(name: string, options: { name: string; value: string }[] | undefined, rows: Row[]): Reply {
  if (name === "aog") {
    return { embeds: [listEmbed("✈️ Aircraft AOG / parked", rows.filter(isAog), RED, "No aircraft AOG. 🎉", `${PUBLIC_PAGE}/aog`)] };
  }
  if (name === "maintenance") {
    return { embeds: [listEmbed("🔧 Aircraft in maintenance", rows.filter(isMx), AMBER, "No aircraft in maintenance. 🎉", `${PUBLIC_PAGE}/maintenance`)] };
  }
  if (name === "fleet") {
    const by = new Map<string, { total: number; ok: number }>();
    for (const r of rows) {
      const t = r.fleet.split(" – ")[0]!;
      const e = by.get(t) ?? { total: 0, ok: 0 };
      e.total++;
      if (r.status === "Available") e.ok++;
      by.set(t, e);
    }
    const fields = [...by.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 25)
      .map(([t, e]) => ({ name: t, value: `${e.ok}/${e.total} available`, inline: true }));
    const ok = rows.filter((r) => r.status === "Available").length;
    return {
      embeds: [
        {
          title: "📊 IJV fleet availability",
          description: `**${ok}/${rows.length}** available · **${rows.filter(isMx).length}** in maintenance · **${rows.filter(isAog).length}** AOG / parked`,
          color: BLUE,
          fields,
          url: `${PUBLIC_PAGE}/aog`,
        },
      ],
    };
  }
  if (name === "aircraft") {
    const reg = norm(options?.find((o) => o.name === "registration")?.value ?? "");
    const r = rows.find((x) => x.registration.toUpperCase() === reg);
    if (!r) return { content: `No aircraft **${reg}** in the IJV fleet (historic fleets are not tracked).`, flags: 64 };
    const color = r.status === "Available" ? GREEN : isMx(r) && !isAog(r) ? AMBER : RED;
    const fields = [
      { name: "Status", value: r.status, inline: true },
      { name: "Fleet", value: r.fleet, inline: true },
      ...(r.detail ? [{ name: "Reason", value: r.detail.slice(0, 1000) }] : []),
      ...(r.until ? [{ name: "Until", value: `${fmt(r.until)} (${rel(r.until)})`, inline: true }] : []),
      { name: "Next check", value: r.nextCheck, inline: true },
      { name: "Real aircraft last seen flying", value: r.realLastFlown, inline: true },
    ];
    return { embeds: [{ title: `✈️ ${r.registration}`, color, fields, url: `${PUBLIC_PAGE}/aog` }] };
  }
  return { content: "Unknown command.", flags: 64 };
}

export interface FleetEvent {
  kind: "mx-start" | "mx-extend" | "mx-release" | "aog" | "aog-release";
  registration?: string;
  reason?: string;
  until?: string;
  lastFlown?: string;
}

/** One webhook message (max 10 embeds) for a batch of events. */
export function eventsMessage(events: FleetEvent[]) {
  const embeds = events.slice(0, 10).map((e) => {
    const reg = e.registration ?? "Aircraft";
    switch (e.kind) {
      case "mx-start":
        return { title: `🔧 ${reg} into maintenance`, description: `${e.reason ?? ""}\nBack ${fmt(e.until)} (${rel(e.until)})`, color: AMBER };
      case "mx-extend":
        return { title: `🔧 ${reg} maintenance extended`, description: `${e.reason ?? ""}\nNow until ${fmt(e.until)}`, color: AMBER };
      case "mx-release":
        return { title: `✅ ${reg} back from maintenance`, description: e.reason ? `Completed: ${e.reason}` : "", color: GREEN };
      case "aog":
        return { title: `⛔ ${reg} AOG`, description: e.reason ?? (e.lastFlown ? `Real aircraft not flown since ${e.lastFlown.slice(0, 10)}` : ""), color: RED };
      case "aog-release":
        return { title: `✅ ${reg} back in service`, description: "Released from AOG.", color: GREEN };
    }
  });
  if (events.length > 10) embeds[9] = { title: `… and ${events.length - 9} more`, description: `${PUBLIC_PAGE}/aog`, color: BLUE };
  return { username: "IJV Fleet Status", embeds, allowed_mentions: { parse: [] as string[] } };
}

export async function postWebhook(url: string | undefined, events: FleetEvent[], fetchFn: typeof fetch = (i, init) => fetch(i, init)) {
  if (!url || !events.length) return;
  for (let i = 0; i < events.length; i += 10) {
    await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(eventsMessage(events.slice(i, i + 10))) });
  }
}
