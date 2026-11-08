/**
 * Score the most recent PIREPs against the live API without writing anything.
 *   VAMSYS_CLIENT_ID=... VAMSYS_CLIENT_SECRET=... npx tsx scripts/dry-run.ts [count]
 */
import { DEFAULT_CONFIG } from "../src/config";
import { processPirep, type Store } from "../src/process";
import { VamsysApi } from "../src/vamsys";

const { VAMSYS_CLIENT_ID: id, VAMSYS_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) throw new Error("set VAMSYS_CLIENT_ID and VAMSYS_CLIENT_SECRET");

const mem = new Map<string, string>();
const store: Store = { get: async (k) => mem.get(k) ?? null, put: async (k, v) => void mem.set(k, v) };
const api = new VamsysApi(id, secret);
const { data } = await api.listPireps(Number(process.argv[2] ?? 20));

for (const p of data) {
  const r = await processPirep(api, store, p, DEFAULT_CONFIG, { dryRun: true });
  const s = r.score;
  console.log(
    [p.id, p.callsign, p.status, r.outcome, r.runway ?? "", s ? `${Math.round(s.distM)}m/${Math.round(s.tdzEndM)}m` : "", s ? s.points : "", r.rejected ? "REJECT" : "", r.reason ?? ""].join("\t"),
  );
}
